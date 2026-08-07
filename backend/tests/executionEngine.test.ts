/**
 * ExecutionEngine tests (Systematic Trading roadmap — A3).
 *
 * Every dependency is injected, so the whole guard tree — the gate, the kill
 * switch, the per-run and global daily caps, sizing, dedupe — is exercised
 * with no DB, IB service or env. Each guard is asserted to fail closed (no
 * order) and the happy path is asserted to place + link.
 */
import {
  ExecutionEngine,
  type ExecutionContext,
  type ExecutionEngineDeps,
} from '../src/services/executionEngine.js';
import type { SubmitCreateOutcome } from '../src/services/orderService.js';
import type { ActiveRun } from '../src/services/strategyRepository.js';
import type { RawBar } from '../src/services/strategyRunner.js';

const lastBar: RawBar = {
  timestamp: 1_700_000_300,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100,
};

function run(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    id: 1,
    definition_id: 2,
    broker: 'ib',
    account_mode: 'paper',
    symbol: 'MSFT',
    sec_type: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    timeframe: '5min',
    rule_set: {},
    sizing: { type: 'fixed', size: 100 },
    risk: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    run: run(),
    signalId: 55,
    signal: 'buy',
    barTime: '2024-06-03T14:00:00Z',
    position: { size: 0, avg_price: 0 },
    lastBar,
    ...overrides,
  };
}

const okOutcome: SubmitCreateOutcome = { ok: true, auditId: 900, ibBody: { order_id: 42 } };

function makeDeps(overrides: Partial<ExecutionEngineDeps> = {}): ExecutionEngineDeps {
  return {
    executionEnabled: () => true,
    globalMaxOrdersPerDay: () => 0,
    getRunStatus: jest.fn().mockResolvedValue('running'),
    countOrdersToday: jest.fn().mockResolvedValue(0),
    countOrdersTodayAllRuns: jest.fn().mockResolvedValue(0),
    submitOrder: jest.fn().mockResolvedValue(okOutcome),
    markActed: jest.fn().mockResolvedValue({ updated: true }),
    ...overrides,
  };
}

describe('ExecutionEngine — happy path', () => {
  it('places a BUY sized from the sizing block and links the signal', async () => {
    const deps = makeDeps();
    const engine = new ExecutionEngine(deps);

    const result = await engine.execute(ctx());

    expect(result).toEqual(
      expect.objectContaining({ placed: true, action: 'BUY', quantity: 100, orderAuditId: 900 })
    );
    expect(deps.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', action: 'BUY', quantity: 100, order_type: 'MKT' }),
      'sys:run1:sig55'
    );
    expect(deps.markActed).toHaveBeenCalledWith(55, 900);
  });

  it('closes the open long on a sell (quantity = current position size)', async () => {
    const deps = makeDeps();
    const engine = new ExecutionEngine(deps);

    const result = await engine.execute(
      ctx({ signal: 'sell', position: { size: 250, avg_price: 90 } })
    );

    expect(result).toEqual(
      expect.objectContaining({ placed: true, action: 'SELL', quantity: 250 })
    );
  });
});

describe('ExecutionEngine — gates & kill switch', () => {
  it('places nothing when execution is disabled (global kill)', async () => {
    const deps = makeDeps({ executionEnabled: () => false });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('refuses a non-actionable signal', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(ctx({ signal: 'none' }));
    expect(result.placed).toBe(false);
    expect(deps.getRunStatus).not.toHaveBeenCalled();
  });

  it('kill switch: refuses when the run is no longer running', async () => {
    const deps = makeDeps({ getRunStatus: jest.fn().mockResolvedValue('stopped') });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/stopped/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('refuses to place an order for an unpersisted signal', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(ctx({ signalId: null }));
    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });
});

describe('ExecutionEngine — risk caps (fail closed)', () => {
  it('enforces the per-run max_orders_per_day', async () => {
    const deps = makeDeps({ countOrdersToday: jest.fn().mockResolvedValue(4) });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: run({ risk: { max_orders_per_day: 4 } }) })
    );
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/per-run max_orders_per_day/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('allows an order below the per-run cap', async () => {
    const deps = makeDeps({ countOrdersToday: jest.fn().mockResolvedValue(3) });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: run({ risk: { max_orders_per_day: 4 } }) })
    );
    expect(result.placed).toBe(true);
  });

  it('enforces the global SYSTEMATIC_MAX_ORDERS_PER_DAY backstop', async () => {
    const deps = makeDeps({
      globalMaxOrdersPerDay: () => 10,
      countOrdersTodayAllRuns: jest.fn().mockResolvedValue(10),
    });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/global/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });
});

describe('ExecutionEngine — sizing & submit failures', () => {
  it('skips (no order) when sizing cannot be resolved', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: run({ sizing: { type: 'pct_equity', size: 10 } }) })
    );
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/sizing/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('refuses a sell with no open position', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'sell', position: { size: 0, avg_price: 0 } })
    );
    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('does not mark the signal acted when the submit is rejected', async () => {
    const deps = makeDeps({
      submitOrder: jest
        .fn()
        .mockResolvedValue({ ok: false, kind: 'ib_error', error: {}, auditId: 1 }),
    });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result.placed).toBe(false);
    expect(deps.markActed).not.toHaveBeenCalled();
  });
});

describe('ExecutionEngine — max_daily_loss (realised P&L from fills)', () => {
  const lossRun = () => run({ risk: { max_daily_loss: 500 } });

  it('is inert when no cap is declared', async () => {
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(-10_000) });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result.placed).toBe(true);
    expect(deps.realisedPnlToday).not.toHaveBeenCalled();
  });

  it('allows an entry while the day is still inside the cap', async () => {
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(-499.99) });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: lossRun() }));
    expect(result.placed).toBe(true);
  });

  it('blocks a new entry once the realised loss reaches the cap', async () => {
    // The regression this closes: `max_daily_loss` was accepted by the schema
    // and the rule builder and enforced nowhere at all.
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(-500) });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: lossRun() }));
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/max_daily_loss/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('reads the cap as a magnitude however it is written', async () => {
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(-600) });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: run({ risk: { max_daily_loss: -500 } }) })
    );
    expect(result.placed).toBe(false);
  });

  it('still lets the run EXIT after breaching the cap', async () => {
    // Blocking an exit would strand the position in the very trade that caused
    // the loss — the opposite of what a loss limit is for.
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(-5_000) });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: lossRun(), signal: 'sell', position: { size: 100, avg_price: 90 } })
    );
    expect(result.placed).toBe(true);
    expect(deps.realisedPnlToday).not.toHaveBeenCalled();
  });

  it('fails closed when realised P&L cannot be computed', async () => {
    const deps = makeDeps({
      realisedPnlToday: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: lossRun() }));
    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/db down/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('fails closed when a cap is declared but no P&L source is wired', async () => {
    const deps = makeDeps();
    delete (deps as { realisedPnlToday?: unknown }).realisedPnlToday;
    const result = await new ExecutionEngine(deps).execute(ctx({ run: lossRun() }));
    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('fails closed on a non-finite P&L', async () => {
    const deps = makeDeps({ realisedPnlToday: jest.fn().mockResolvedValue(Number.NaN) });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: lossRun() }));
    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });
});

describe('ExecutionEngine — pct_equity sizing', () => {
  const pctRun = () => run({ sizing: { type: 'pct_equity', size: 10 } });

  it('sizes from the venue-reported equity', async () => {
    // Previously unreachable: every pct_equity size was rejected outright
    // because no equity source was wired.
    const deps = makeDeps({ accountEquity: jest.fn().mockResolvedValue(100_000) });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: pctRun() }));

    // 10% of 100_000 = 10_000 at a close of 100 -> 100 shares.
    expect(result).toEqual(expect.objectContaining({ placed: true, quantity: 100 }));
    expect(deps.accountEquity).toHaveBeenCalledWith('ib');
  });

  it('does not spend a venue round-trip on other sizing types', async () => {
    const deps = makeDeps({ accountEquity: jest.fn().mockResolvedValue(100_000) });
    await new ExecutionEngine(deps).execute(ctx());
    expect(deps.accountEquity).not.toHaveBeenCalled();
  });

  it('refuses rather than guessing when the venue reports no equity', async () => {
    const deps = makeDeps({ accountEquity: jest.fn().mockResolvedValue(null) });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: pctRun() }));

    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/equity/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('refuses when the equity lookup throws', async () => {
    const deps = makeDeps({
      accountEquity: jest.fn().mockRejectedValue(new Error('venue unreachable')),
    });
    const result = await new ExecutionEngine(deps).execute(ctx({ run: pctRun() }));

    expect(result.placed).toBe(false);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });
});
