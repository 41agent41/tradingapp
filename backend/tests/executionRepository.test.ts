/**
 * ExecutionRepository tests. A fake Querier records SQL + params, so the SQL
 * generation is verified without Postgres (mirrors orderAuditRepository.test.ts).
 *
 * The invariants worth pinning here are the ones that make the fills feed safe
 * to run on a timer: an idempotent upsert that lets late-arriving values fill a
 * NULL but never blank one already recorded, and the attribution chain from a
 * venue order id back to the strategy run that caused it.
 */
import { ExecutionRepository } from '../src/services/executionRepository.js';
import type { Querier } from '../src/services/backtestRunRepository.js';

interface Call {
  text: string;
  params: unknown[];
}

function fakeDb(rowsFor: (call: Call) => any[] = () => []) {
  const calls: Call[] = [];
  const db: Querier = {
    query: async (text: string, params: unknown[] = []) => {
      const call = { text, params };
      calls.push(call);
      return { rows: rowsFor(call) };
    },
  };
  return { db, calls };
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    broker: 'ib',
    account_mode: 'paper',
    exec_id: '0000e1a7.68f2c0a1.01.01',
    broker_order_id: '42',
    symbol: 'msft',
    side: 'buy',
    quantity: 100,
    price: 410.25,
    commission: 1.0,
    realized_pnl: null,
    currency: 'usd',
    executed_at: '2026-08-07T13:30:00Z',
    ...overrides,
  };
}

describe('ExecutionRepository.upsert', () => {
  it('normalises symbol / side / currency and takes the quantity magnitude', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, inserted: true }]);
    await new ExecutionRepository(db).upsert(execution({ quantity: -100 }));

    // $5 symbol, $6 side, $7 quantity, $11 currency.
    expect(calls[0].params[4]).toBe('MSFT');
    expect(calls[0].params[5]).toBe('BUY');
    expect(calls[0].params[6]).toBe(100);
    expect(calls[0].params[10]).toBe('USD');
  });

  it('is idempotent on (broker, exec_id)', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, inserted: false }]);
    const result = await new ExecutionRepository(db).upsert(execution());

    expect(calls[0].text).toMatch(/ON CONFLICT \(broker, exec_id\) DO UPDATE/);
    expect(result.inserted).toBe(false);
  });

  it('lets a late commission fill a NULL but never blank a recorded one', async () => {
    // IB delivers a fill's commission on a callback separate from the fill, so
    // it can legitimately arrive a poll later — and a later poll that has lost
    // the value must not erase it.
    const { db, calls } = fakeDb(() => [{ id: 1, inserted: false }]);
    await new ExecutionRepository(db).upsert(execution());

    expect(calls[0].text).toMatch(
      /commission\s*=\s*COALESCE\(EXCLUDED\.commission, order_executions\.commission\)/
    );
    expect(calls[0].text).toMatch(
      /realized_pnl\s*=\s*COALESCE\(EXCLUDED\.realized_pnl, order_executions\.realized_pnl\)/
    );
  });

  it('resolves the run attribution from the venue order id', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, inserted: true }]);
    await new ExecutionRepository(db).upsert(execution());

    expect(calls[0].text).toMatch(/ib_order_id::text = \$4/);
    expect(calls[0].text).toMatch(/FROM strategy_signals s/);
    expect(calls[0].params[3]).toBe('42');
  });

  it('takes account_mode from the linked order, falling back to the default', async () => {
    // A venue reports fills without saying which account mode they belong to.
    const { db, calls } = fakeDb(() => [{ id: 1, inserted: true }]);
    await new ExecutionRepository(db).upsert(execution({ account_mode: 'live' }));

    expect(calls[0].text).toMatch(/COALESCE\(\(SELECT account_mode FROM attribution\), \$2\)/);
    expect(calls[0].params[1]).toBe('live');
  });

  it('reports whether the row was new (xmax discriminates insert from update)', async () => {
    const { db } = fakeDb(() => [{ id: 1, inserted: true }]);
    const result = await new ExecutionRepository(db).upsert(execution());
    expect(result.inserted).toBe(true);
  });
});

describe('ExecutionRepository.relinkOrphans', () => {
  it('only touches unattributed fills that carry a venue order id', async () => {
    const { db, calls } = fakeDb(() => []);
    await new ExecutionRepository(db).relinkOrphans(24);

    expect(calls[0].text).toMatch(/UPDATE order_executions/);
    expect(calls[0].text).toMatch(/e\.order_audit_id IS NULL/);
    expect(calls[0].text).toMatch(/e\.broker_order_id IS NOT NULL/);
    expect(calls[0].text).toMatch(/a\.broker = e\.broker/);
    expect(calls[0].params[0]).toBe(24);
  });
});

describe('ExecutionRepository.listForPnl', () => {
  it('returns fills in execution order (what the reducer requires)', async () => {
    const { db, calls } = fakeDb(() => []);
    await new ExecutionRepository(db).listForPnl({ broker: 'ib', symbol: 'msft' });

    expect(calls[0].text).toMatch(/ORDER BY executed_at ASC, id ASC/);
    expect(calls[0].params).toEqual(['ib', 'MSFT']);
  });

  it('scopes by run when asked', async () => {
    const { db, calls } = fakeDb(() => []);
    await new ExecutionRepository(db).listForPnl({ run_id: 7, since: '2026-08-07T00:00:00Z' });

    expect(calls[0].text).toMatch(/run_id = \$1/);
    expect(calls[0].text).toMatch(/executed_at >= \$2/);
  });
});

describe('ExecutionRepository.realisedPnlTodayForRun', () => {
  it('scopes to the run and to today, and reduces the fills', async () => {
    const { db, calls } = fakeDb(() => [
      { symbol: 'MSFT', side: 'BUY', quantity: '100', price: '50', commission: '1' },
      { symbol: 'MSFT', side: 'SELL', quantity: '100', price: '45', commission: '1' },
    ]);

    const result = await new ExecutionRepository(db).realisedPnlTodayForRun(7);

    expect(calls[0].text).toMatch(/run_id = \$1/);
    expect(calls[0].text).toMatch(/date_trunc\('day', NOW\(\)\)/);
    expect(result.realised).toBe(-502);
  });
});

describe('ExecutionRepository.netPosition', () => {
  it('nets the venue-reported fills for one instrument', async () => {
    const { db } = fakeDb(() => [
      { symbol: 'MSFT', side: 'BUY', quantity: '100', price: '50' },
      { symbol: 'MSFT', side: 'SELL', quantity: '40', price: '55' },
    ]);

    // 100 bought, 40 sold: the partial the submitted-order estimate misses.
    expect(await new ExecutionRepository(db).netPosition('ib', 'msft', 'paper')).toBe(60);
  });
});

describe('ExecutionRepository.activeBrokers', () => {
  it('unions the venues traded at with the venues running strategies', async () => {
    const { db, calls } = fakeDb(() => [{ broker: 'ib' }, { broker: 'alpaca' }]);
    const brokers = await new ExecutionRepository(db).activeBrokers();

    expect(calls[0].text).toMatch(/FROM order_audit/);
    expect(calls[0].text).toMatch(/FROM strategy_runs WHERE status = 'running'/);
    expect(brokers).toEqual(['ib', 'alpaca']);
  });
});
