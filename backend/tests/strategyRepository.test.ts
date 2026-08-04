/**
 * StrategyRepository tests.
 *
 * A fake `Querier` records the SQL + params and returns canned rows, so the
 * SQL generation is verified without Postgres (mirrors
 * backtestRunRepository.test.ts).
 */
import { StrategyRepository, type Querier } from '../src/services/strategyRepository.js';

interface Call {
  text: string;
  params: unknown[];
}

function fakeDb(rowsFor: (call: Call) => any[]) {
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

describe('StrategyRepository.createDefinition', () => {
  it('inserts an uppercased symbol and serialised rule_set', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1 }]);
    const repo = new StrategyRepository(db);
    await repo.createDefinition({
      name: 'MA',
      symbol: 'msft',
      timeframe: '5min',
      rule_set: { entry: { all: [] } },
    });
    expect(calls[0].text).toMatch(/INSERT INTO strategy_definitions/);
    expect(calls[0].params[2]).toBe('MSFT'); // symbol uppercased
    expect(calls[0].params[1]).toBe('ib'); // broker defaults
    expect(JSON.parse(calls[0].params[4] as string)).toEqual({ entry: { all: [] } });
  });
});

describe('StrategyRepository.createRun', () => {
  it('defaults broker=ib and account_mode=paper and serialises sizing/risk', async () => {
    const { db, calls } = fakeDb(() => [{ id: 7 }]);
    const repo = new StrategyRepository(db);
    await repo.createRun({ definition_id: 3, sizing: { size: 100 }, risk: { max: 4 } });
    expect(calls[0].text).toMatch(/INSERT INTO strategy_runs/);
    expect(calls[0].params[0]).toBe(3);
    expect(calls[0].params[1]).toBe('ib');
    expect(calls[0].params[2]).toBe('paper');
    expect(JSON.parse(calls[0].params[3] as string)).toEqual({ size: 100 });
  });
});

describe('StrategyRepository.listActiveRuns', () => {
  it('joins the definition and filters to running', async () => {
    const { db, calls } = fakeDb(() => [
      { id: 1, definition_id: 2, symbol: 'MSFT', timeframe: '5min', rule_set: {} },
    ]);
    const repo = new StrategyRepository(db);
    const rows = await repo.listActiveRuns();
    expect(calls[0].text).toMatch(/JOIN strategy_definitions/);
    expect(calls[0].text).toMatch(/status = 'running'/);
    expect(rows[0].symbol).toBe('MSFT');
  });
});

describe('StrategyRepository.updateRunStatus', () => {
  it('sets stopped_at only when leaving running', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, status: 'stopped' }]);
    const repo = new StrategyRepository(db);
    await repo.updateRunStatus(1, 'stopped');
    expect(calls[0].text).toMatch(/stopped_at = CASE WHEN \$2 <> 'running'/);
    expect(calls[0].params).toEqual([1, 'stopped']);
  });

  it('returns null when the run does not exist', async () => {
    const { db } = fakeDb(() => []);
    const repo = new StrategyRepository(db);
    expect(await repo.updateRunStatus(999, 'stopped')).toBeNull();
  });
});

describe('StrategyRepository.insertSignal', () => {
  it('uses ON CONFLICT DO NOTHING and reports inserted=true when a row returns', async () => {
    const { db, calls } = fakeDb(() => [{ id: 5, run_id: 1, signal: 'buy' }]);
    const repo = new StrategyRepository(db);
    const res = await repo.insertSignal({
      run_id: 1,
      bar_time: '2024-06-03T14:00:00Z',
      signal: 'buy',
      entry: true,
    });
    expect(calls[0].text).toMatch(/ON CONFLICT \(run_id, bar_time\) DO NOTHING/);
    expect(res.inserted).toBe(true);
    expect(res.row?.id).toBe(5);
  });

  it('reports inserted=false when the conflict suppressed the write', async () => {
    const { db } = fakeDb(() => []); // ON CONFLICT DO NOTHING returns no row
    const repo = new StrategyRepository(db);
    const res = await repo.insertSignal({
      run_id: 1,
      bar_time: '2024-06-03T14:00:00Z',
      signal: 'none',
    });
    expect(res.inserted).toBe(false);
    expect(res.row).toBeNull();
  });
});

describe('StrategyRepository.latestSignalBarTime', () => {
  it('returns the newest bar_time or null', async () => {
    const withRow = fakeDb(() => [{ bar_time: '2024-06-03T14:00:00Z' }]);
    expect(await new StrategyRepository(withRow.db).latestSignalBarTime(1)).toBe(
      '2024-06-03T14:00:00Z'
    );
    const empty = fakeDb(() => []);
    expect(await new StrategyRepository(empty.db).latestSignalBarTime(1)).toBeNull();
  });
});

describe('StrategyRepository.listSignals', () => {
  it('clamps an over-large limit into range', async () => {
    const { db, calls } = fakeDb(() => []);
    const repo = new StrategyRepository(db);
    await repo.listSignals(1, 100000);
    expect(calls[0].params[1]).toBe(200); // MAX_LIMIT
  });
});

describe('StrategyRepository.listActiveRuns (A3 fields)', () => {
  it('selects the run-level sizing/risk blocks', async () => {
    const { db, calls } = fakeDb(() => []);
    await new StrategyRepository(db).listActiveRuns();
    expect(calls[0].text).toMatch(/r\.sizing, r\.risk/);
  });
});

describe('StrategyRepository.markSignalActed', () => {
  it('flips acted only for a row that has not already acted', async () => {
    const { db, calls } = fakeDb(() => [{ id: 5 }]);
    const res = await new StrategyRepository(db).markSignalActed(5, 900);
    expect(calls[0].text).toMatch(/SET acted = TRUE, order_audit_id = \$2/);
    expect(calls[0].text).toMatch(/acted = FALSE/);
    expect(calls[0].params).toEqual([5, 900]);
    expect(res.updated).toBe(true);
  });

  it('reports updated=false when the row already acted', async () => {
    const { db } = fakeDb(() => []);
    expect((await new StrategyRepository(db).markSignalActed(5, 900)).updated).toBe(false);
  });
});

describe('StrategyRepository order counters', () => {
  it('counts acted signals today for a run', async () => {
    const { db, calls } = fakeDb(() => [{ n: 3 }]);
    const n = await new StrategyRepository(db).countActedSignalsToday(1);
    expect(calls[0].text).toMatch(/acted = TRUE/);
    expect(calls[0].text).toMatch(/date_trunc\('day', NOW\(\)\)/);
    expect(calls[0].params).toEqual([1]);
    expect(n).toBe(3);
  });

  it('counts acted signals today across all runs', async () => {
    const { db, calls } = fakeDb(() => [{ n: 12 }]);
    const n = await new StrategyRepository(db).countActedSignalsTodayAllRuns();
    expect(calls[0].text).not.toMatch(/run_id/);
    expect(n).toBe(12);
  });
});

describe('StrategyRepository.getRunStatus', () => {
  it('returns the run status or null', async () => {
    const withRow = fakeDb(() => [{ status: 'running' }]);
    expect(await new StrategyRepository(withRow.db).getRunStatus(1)).toBe('running');
    const empty = fakeDb(() => []);
    expect(await new StrategyRepository(empty.db).getRunStatus(1)).toBeNull();
  });
});
