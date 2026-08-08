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
  normaliseSignal,
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
    broker_account: 'default',
    native_symbol: null,
    run_group_id: null,
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
    expect(deps.accountEquity).toHaveBeenCalledWith({ broker: 'ib', brokerAccount: 'default' });
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

describe('ExecutionEngine — broker-native sizing', () => {
  const lotSpec = { unit: 'lots', minSize: 0.01, sizeStep: 0.01, contractSize: 100_000 };
  const fxBar = { ...lastBar, close: 1.1 };
  const mt5Run = (sizing: Record<string, unknown>) =>
    run({ broker: 'mt5', symbol: 'EURUSD', sizing });

  it('sizes a notional block in lots, honouring the contract size', async () => {
    const deps = makeDeps({ instrumentSpec: jest.fn().mockResolvedValue(lotSpec) });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: mt5Run({ type: 'notional', size: 110_000 }), lastBar: fxBar })
    );

    // 110_000 / (1.1 x 100_000) = 1.0 lots. Sized as shares this would have
    // been 100_000 — five orders of magnitude of extra exposure.
    expect(result).toEqual(expect.objectContaining({ placed: true, quantity: 1 }));
    expect(deps.instrumentSpec).toHaveBeenCalledWith(
      { broker: 'mt5', brokerAccount: 'default' },
      'EURUSD'
    );
  });

  it('refuses a size below the venue minimum instead of rounding it up', async () => {
    const deps = makeDeps({ instrumentSpec: jest.fn().mockResolvedValue(lotSpec) });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: mt5Run({ type: 'fixed', size: 0.005 }), lastBar: fxBar })
    );

    expect(result.placed).toBe(false);
    if (!result.placed) expect(result.reason).toMatch(/minimum/);
    expect(deps.submitOrder).not.toHaveBeenCalled();
  });

  it('falls back to whole shares when the venue spec is unavailable', async () => {
    // The safe fallback: a fixed size still has to clear the minimum, so a
    // wrong guess errs toward refusing rather than toward an oversized order.
    const deps = makeDeps({
      instrumentSpec: jest.fn().mockRejectedValue(new Error('venue unreachable')),
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ run: mt5Run({ type: 'fixed', size: 2 }), lastBar: fxBar })
    );

    expect(result).toEqual(expect.objectContaining({ placed: true, quantity: 2 }));
  });

  it('closes a fractional position exactly, not floored to a whole number', async () => {
    // Flooring 0.07 lots to 0 would strand the position open forever.
    const deps = makeDeps({ instrumentSpec: jest.fn().mockResolvedValue(lotSpec) });

    const result = await new ExecutionEngine(deps).execute(
      ctx({
        run: mt5Run({ type: 'fixed', size: 0.07 }),
        signal: 'sell',
        position: { size: 0.07, avg_price: 1.05 },
        lastBar: fxBar,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({ placed: true, action: 'SELL', quantity: 0.07 })
    );
  });
});

// --------------------------------------------------------------------------- //
// Connection- and portfolio-level caps (C-4)
// --------------------------------------------------------------------------- //
describe('ExecutionEngine — connection-level caps', () => {
  it('blocks an entry once the connection order cap is reached', async () => {
    // Not a duplicate of the per-run cap: a connection hosting several runs can
    // breach an account-level limit while each run sits inside its own.
    const deps = makeDeps({
      connectionLimits: jest.fn().mockResolvedValue({ max_orders_per_day: 3 }),
      countOrdersTodayForConnection: jest.fn().mockResolvedValue(3),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('connection max_orders_per_day (3) reached'),
    });
  });

  it('blocks an entry once the connection loss cap is reached', async () => {
    const deps = makeDeps({
      connectionLimits: jest.fn().mockResolvedValue({ max_daily_loss: 500 }),
      realisedPnlTodayForConnection: jest.fn().mockResolvedValue(-500),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('connection max_daily_loss (500) reached'),
    });
  });

  it('still allows an EXIT after the connection loss cap is breached', async () => {
    // Blocking exits would strand the position in the trade that caused the
    // loss — the opposite of what a loss limit is for.
    const deps = makeDeps({
      connectionLimits: jest.fn().mockResolvedValue({ max_daily_loss: 500 }),
      realisedPnlTodayForConnection: jest.fn().mockResolvedValue(-900),
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'sell', position: { size: 100, avg_price: 10 } })
    );

    expect(result).toEqual(expect.objectContaining({ placed: true, action: 'SELL' }));
  });

  it('fails closed when the connection limits cannot be read', async () => {
    const deps = makeDeps({
      connectionLimits: jest.fn().mockRejectedValue(new Error('db down')),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('connection limits unavailable'),
    });
  });

  it('fails closed when a declared cap cannot be measured', async () => {
    // A cap accepted by config and enforced nowhere is the silent no-op this
    // codebase already had to fix once for max_daily_loss.
    const deps = makeDeps({
      connectionLimits: jest.fn().mockResolvedValue({ max_daily_loss: 500 }),
      realisedPnlTodayForConnection: undefined,
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('not measurable'),
    });
  });

  it('places normally when the connection is inside its caps', async () => {
    const deps = makeDeps({
      connectionLimits: jest.fn().mockResolvedValue({ max_orders_per_day: 5, max_daily_loss: 500 }),
      countOrdersTodayForConnection: jest.fn().mockResolvedValue(1),
      realisedPnlTodayForConnection: jest.fn().mockResolvedValue(-100),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result).toEqual(expect.objectContaining({ placed: true }));
  });
});

describe('ExecutionEngine — portfolio cap', () => {
  const consistent = { max_daily_loss: 1000, currency_consistent: true, currencies: ['USD'] };

  it('blocks an entry once the fleet-wide loss cap is reached', async () => {
    // One strategy across accounts means no diversification — every leg takes
    // the same trade at once, so the fleet's risk is N times one account's.
    const deps = makeDeps({
      portfolioLimits: jest.fn().mockResolvedValue(consistent),
      realisedPnlTodayPortfolio: jest.fn().mockResolvedValue(-1200),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('portfolio max_daily_loss (1000) reached'),
    });
  });

  it('refuses to aggregate across mixed currencies rather than summing them', async () => {
    // Summing USD and AUD gives a number that adds up and means nothing.
    const deps = makeDeps({
      portfolioLimits: jest.fn().mockResolvedValue({
        max_daily_loss: 1000,
        currency_consistent: false,
        currencies: ['USD', 'AUD'],
      }),
      realisedPnlTodayPortfolio: jest.fn().mockResolvedValue(-10),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('different currencies'),
    });
  });

  it('does not gate exits on the portfolio cap', async () => {
    const deps = makeDeps({
      portfolioLimits: jest.fn().mockResolvedValue(consistent),
      realisedPnlTodayPortfolio: jest.fn().mockResolvedValue(-5000),
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'sell', position: { size: 100, avg_price: 10 } })
    );

    expect(result).toEqual(expect.objectContaining({ placed: true }));
  });

  it('fails closed when the portfolio figure cannot be read', async () => {
    const deps = makeDeps({
      portfolioLimits: jest.fn().mockResolvedValue(consistent),
      realisedPnlTodayPortfolio: jest.fn().mockRejectedValue(new Error('db down')),
    });

    const result = await new ExecutionEngine(deps).execute(ctx());

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('portfolio loss check failed'),
    });
  });

  it('is inert when no portfolio cap is configured', async () => {
    const deps = makeDeps({ portfolioLimits: jest.fn().mockResolvedValue(null) });
    const result = await new ExecutionEngine(deps).execute(ctx());
    expect(result).toEqual(expect.objectContaining({ placed: true }));
  });
});

// --------------------------------------------------------------------------- //
// Direction — long, short and the reversal refusal (E1)
// --------------------------------------------------------------------------- //
describe('ExecutionEngine — shorts', () => {
  it('opens a short with a SELL from flat', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(ctx({ signal: 'short' }));
    expect(result).toEqual(expect.objectContaining({ placed: true, action: 'SELL' }));
  });

  it('closes a short with a BUY', async () => {
    // Reading direction from the position's sign rather than assuming long is
    // the whole of E1 on the exit side.
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'flat', position: { size: -3, avg_price: 1.1 } })
    );
    expect(result).toEqual(expect.objectContaining({ placed: true, action: 'BUY', quantity: 3 }));
  });

  it('closes a long with a SELL', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'flat', position: { size: 3, avg_price: 1.1 } })
    );
    expect(result).toEqual(expect.objectContaining({ placed: true, action: 'SELL', quantity: 3 }));
  });

  it('refuses to reverse a long into a short (E12)', async () => {
    // Silently reversing would double the traded size and take a position the
    // rules never asked for on this bar.
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'short', position: { size: 5, avg_price: 1.1 } })
    );
    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('reversal is not supported'),
    });
  });

  it('refuses to reverse a short into a long', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', position: { size: -5, avg_price: 1.1 } })
    );
    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('reversal is not supported'),
    });
  });

  it('refuses an exit with nothing open', async () => {
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'flat', position: { size: 0, avg_price: 0 } })
    );
    expect(result).toEqual({
      placed: false,
      reason: 'exit signal but no open position to close',
    });
  });

  it('gates a short entry on the loss caps, like a long', async () => {
    // A short is an entry: it takes on new risk, so a breached daily loss cap
    // must stop it exactly as it stops a long.
    const deps = makeDeps({
      realisedPnlToday: jest.fn().mockResolvedValue(-1000),
    });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'short', run: run({ risk: { max_daily_loss: 500 } }) })
    );
    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('max_daily_loss'),
    });
  });
});

describe('normaliseSignal', () => {
  it('accepts the E1 vocabulary', () => {
    expect(normaliseSignal('long')).toBe('long');
    expect(normaliseSignal('short')).toBe('short');
    expect(normaliseSignal('flat')).toBe('flat');
  });

  it('still accepts pre-E1 buy/sell, because stored signals outlive a deploy', () => {
    expect(normaliseSignal('buy')).toBe('long');
    expect(normaliseSignal('sell')).toBe('flat');
  });

  it('rejects anything else', () => {
    expect(normaliseSignal('none')).toBeNull();
    expect(normaliseSignal('')).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Protective stops at entry (E-2)
// --------------------------------------------------------------------------- //
describe('ExecutionEngine — protective stops', () => {
  it('attaches a resolved stop to the entry order', async () => {
    const submitOrder = jest.fn().mockResolvedValue(okOutcome);
    const deps = makeDeps({ submitOrder });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', hasStopRule: true, stopPrice: 95 })
    );

    expect(result).toEqual(expect.objectContaining({ placed: true }));
    expect(submitOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ stop_loss: 95 }));
  });

  it('refuses the entry when a declared stop could not be resolved', async () => {
    // An unprotected position is never an acceptable resting state, and
    // placing one the operator believes is protected is the worst version.
    const submitOrder = jest.fn();
    const deps = makeDeps({ submitOrder });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', hasStopRule: true, stopError: 'no usable ATR' })
    );

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('stop rule failed to resolve'),
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it('refuses the entry when a stop rule yields no price at all', async () => {
    const deps = makeDeps({ submitOrder: jest.fn() });
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', hasStopRule: true, stopPrice: null })
    );
    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('refusing to open unprotected'),
    });
  });

  it('places without a stop when the strategy declares none', async () => {
    // Unchanged behaviour for the strategies that never had one.
    const submitOrder = jest.fn().mockResolvedValue(okOutcome);
    const deps = makeDeps({ submitOrder });

    const result = await new ExecutionEngine(deps).execute(ctx({ signal: 'long' }));

    expect(result).toEqual(expect.objectContaining({ placed: true }));
    expect(submitOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ stop_loss: null }));
  });

  it("refuses a stop inside the venue's minimum distance", async () => {
    // The venue would bounce it; a refused entry with a clear reason beats an
    // order we already knew would fail.
    const deps = makeDeps({
      instrumentSpec: jest.fn().mockResolvedValue({
        unit: 'lots',
        minSize: 0.01,
        sizeStep: 0.01,
        contractSize: 100000,
        stopsLevel: 50,
        point: 0.0001,
      }),
      submitOrder: jest.fn(),
    });

    const result = await new ExecutionEngine(deps).execute(
      // Close is 100; a stop at 99.999 is 0.001 away, well inside the
      // 50-point (0.005) band.
      ctx({ signal: 'long', hasStopRule: true, stopPrice: 99.999 })
    );

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('minimum distance'),
    });
  });

  it('does not apply a minimum-distance check the venue never reported', async () => {
    // Refusing entries against a limit we do not actually know would be worse
    // than letting the venue reject the rare order that breaches it.
    const submitOrder = jest.fn().mockResolvedValue(okOutcome);
    const deps = makeDeps({
      instrumentSpec: jest.fn().mockResolvedValue({
        unit: 'lots',
        minSize: 0.01,
        sizeStep: 0.01,
        contractSize: 100000,
      }),
      submitOrder,
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', hasStopRule: true, stopPrice: 99.999 })
    );

    expect(result).toEqual(expect.objectContaining({ placed: true }));
  });

  it('does not require a stop on an exit', async () => {
    // Closing a position needs no protection of its own.
    const deps = makeDeps();
    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'flat', hasStopRule: true, position: { size: 5, avg_price: 10 } })
    );
    expect(result).toEqual(expect.objectContaining({ placed: true, action: 'SELL' }));
  });
});

describe('ExecutionEngine — risk_pct sizing (E-4)', () => {
  const fxSpec = {
    unit: 'lots',
    minSize: 0.01,
    sizeStep: 0.01,
    contractSize: 100000,
    tickValue: 1,
    tickSize: 0.00001,
  };

  it('sizes the entry from the distance to the resolved stop', async () => {
    const submitOrder = jest.fn().mockResolvedValue(okOutcome);
    const deps = makeDeps({
      accountEquity: jest.fn().mockResolvedValue(100_000),
      instrumentSpec: jest.fn().mockResolvedValue(fxSpec),
      submitOrder,
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({
        signal: 'long',
        hasStopRule: true,
        stopPrice: 99.5,
        run: run({ sizing: { type: 'risk_pct', size: 1 } }),
        lastBar: { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      })
    );

    // $1,000 of risk; a 0.5 move costs $50,000 per lot at this tick value, so
    // the position is 0.02 lots.
    expect(result).toEqual(expect.objectContaining({ placed: true, quantity: 0.02 }));
    expect(submitOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ stop_loss: 99.5 }));
  });

  it('refuses risk_pct when the rule-set declares no stop', async () => {
    // Falling back to another sizing type would silently change how much the
    // strategy risks.
    const deps = makeDeps({
      accountEquity: jest.fn().mockResolvedValue(100_000),
      instrumentSpec: jest.fn().mockResolvedValue(fxSpec),
      submitOrder: jest.fn(),
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({ signal: 'long', run: run({ sizing: { type: 'risk_pct', size: 1 } }) })
    );

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('requires a `stop` block'),
    });
  });

  it('fetches equity for risk_pct, not only for pct_equity', async () => {
    const accountEquity = jest.fn().mockResolvedValue(100_000);
    const deps = makeDeps({
      accountEquity,
      instrumentSpec: jest.fn().mockResolvedValue(fxSpec),
    });

    await new ExecutionEngine(deps).execute(
      ctx({
        signal: 'long',
        hasStopRule: true,
        stopPrice: 99.5,
        run: run({ sizing: { type: 'risk_pct', size: 1 } }),
        lastBar: { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      })
    );

    expect(accountEquity).toHaveBeenCalled();
  });

  it('keeps the ORDER_MAX_* caps binding on a tight stop', async () => {
    // As stop distance approaches zero, risk_pct size approaches infinity.
    // The fat-finger caps are not waived for risk-sized orders.
    const deps = makeDeps({
      accountEquity: jest.fn().mockResolvedValue(100_000_000),
      instrumentSpec: jest.fn().mockResolvedValue({ ...fxSpec, maxSize: null }),
      submitOrder: jest.fn(),
    });

    const result = await new ExecutionEngine(deps).execute(
      ctx({
        signal: 'long',
        hasStopRule: true,
        stopPrice: 99.99999,
        run: run({ sizing: { type: 'risk_pct', size: 50 } }),
        lastBar: { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      })
    );

    expect(result).toEqual({
      placed: false,
      reason: expect.stringContaining('ORDER_MAX_QUANTITY'),
    });
  });
});
