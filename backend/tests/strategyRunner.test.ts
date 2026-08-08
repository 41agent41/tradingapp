/**
 * StrategyRunner tests.
 *
 * Every dependency (active-run listing, history fetch, position lookup,
 * evaluate call, signal persistence, emit) is injected, so the suite is
 * hermetic — no DB, no IB service, no timers fired in real time
 * (mirrors backfillScheduler.test.ts).
 */
import {
  StrategyRunner,
  historyPeriodFor,
  runSymbol,
  type StrategyRunnerDeps,
  type RawBar,
  type EvaluateResult,
} from '../src/services/strategyRunner.js';
import type { ActiveRun } from '../src/services/strategyRepository.js';

const NOW = Date.parse('2026-01-10T00:00:00Z');

function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    id: 1,
    definition_id: 2,
    broker: 'ib',
    broker_account: 'default',
    native_symbol: null,
    account_mode: 'paper',
    symbol: 'MSFT',
    sec_type: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    timeframe: '5min',
    rule_set: { entry: { all: [] } },
    sizing: { type: 'fixed', size: 100 },
    risk: {},
    ...overrides,
  };
}

const bars: RawBar[] = [
  { timestamp: 1_700_000_000, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { timestamp: 1_700_000_300, open: 10.5, high: 12, low: 10, close: 11, volume: 120 },
];

const buyResult: EvaluateResult = {
  signal: 'buy',
  entry: true,
  exit: false,
  entry_reason: 'entry rules met',
  in_session: true,
  bar_time: '2024-06-03T14:00:00Z',
};

function makeDeps(overrides: Partial<StrategyRunnerDeps> = {}): StrategyRunnerDeps {
  return {
    listActiveRuns: jest.fn().mockResolvedValue([activeRun()]),
    fetchHistory: jest.fn().mockResolvedValue(bars),
    getPosition: jest.fn().mockResolvedValue({ size: 0, avg_price: 0 }),
    evaluate: jest.fn().mockResolvedValue(buyResult),
    latestSignalBarTime: jest.fn().mockResolvedValue(null),
    insertSignal: jest.fn().mockResolvedValue({ inserted: true }),
    markEvaluated: jest.fn().mockResolvedValue(undefined),
    markError: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    now: () => NOW,
    ...overrides,
  };
}

function makeRunner(deps: StrategyRunnerDeps) {
  return new StrategyRunner({ enabled: true, deps, intervalSeconds: 60, initialDelayMs: 0 });
}

describe('StrategyRunner.runOnce', () => {
  it('evaluates a run, persists the signal and emits it', async () => {
    const deps = makeDeps();
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.fetchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', timeframe: '5min', broker: 'ib' })
    );
    expect(deps.evaluate).toHaveBeenCalledWith(
      bars,
      { entry: { all: [] } },
      {
        size: 0,
        avg_price: 0,
      }
    );
    expect(deps.insertSignal).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 1, signal: 'buy', bar_time: '2024-06-03T14:00:00Z' })
    );
    expect(deps.emit).toHaveBeenCalledWith(1, expect.objectContaining({ signal: 'buy' }));
    expect(deps.markEvaluated).toHaveBeenCalled();

    const status = runner.status();
    expect(status.totals.signals_recorded).toBe(1);
    expect(status.totals.errors).toBe(0);
  });

  it('dedupes: does not re-insert or emit when the latest bar is unchanged', async () => {
    const deps = makeDeps({
      latestSignalBarTime: jest.fn().mockResolvedValue('2024-06-03T14:00:00Z'),
    });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.insertSignal).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.markEvaluated).toHaveBeenCalled(); // still marks the run as evaluated
    expect(runner.status().totals.signals_recorded).toBe(0);
  });

  it('does not emit when the insert was suppressed by the dedupe constraint', async () => {
    const deps = makeDeps({ insertSignal: jest.fn().mockResolvedValue({ inserted: false }) });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.emit).not.toHaveBeenCalled();
    expect(runner.status().totals.signals_recorded).toBe(0);
  });

  it('skips a run with no bars', async () => {
    const deps = makeDeps({ fetchHistory: jest.fn().mockResolvedValue([]) });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.insertSignal).not.toHaveBeenCalled();
  });

  it('isolates a per-run failure, records it on the run and keeps going', async () => {
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([activeRun({ id: 1 }), activeRun({ id: 2 })]),
      evaluate: jest
        .fn()
        .mockRejectedValueOnce(new Error('ib down'))
        .mockResolvedValueOnce(buyResult),
    });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.markError).toHaveBeenCalledWith(1, 'ib down');
    // The second run still recorded its signal despite the first failing.
    expect(deps.insertSignal).toHaveBeenCalledTimes(1);
    expect(runner.status().totals.errors).toBe(1);
    expect(runner.status().totals.signals_recorded).toBe(1);
  });

  it('threads the run position into the evaluate call', async () => {
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue({ size: 100, avg_price: 42 }),
    });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.evaluate).toHaveBeenCalledWith(bars, expect.anything(), {
      size: 100,
      avg_price: 42,
    });
    expect(deps.insertSignal).toHaveBeenCalledWith(expect.objectContaining({ position_size: 100 }));
  });
});

describe('StrategyRunner — A3 execution wiring', () => {
  it('hands a newly-recorded actionable signal to executeSignal and emits the outcome', async () => {
    const executeSignal = jest.fn().mockResolvedValue({
      placed: true,
      orderAuditId: 900,
      action: 'BUY',
      quantity: 100,
      ibBody: {},
    });
    const deps = makeDeps({
      insertSignal: jest.fn().mockResolvedValue({ inserted: true, id: 55 }),
      executeSignal,
    });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(executeSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signalId: 55,
        signal: 'buy',
        run: expect.objectContaining({ id: 1 }),
      })
    );
    expect(deps.emit).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ acted: true, order_audit_id: 900 })
    );
    expect(runner.status().totals.orders_placed).toBe(1);
  });

  it('does not execute a non-actionable (none) signal', async () => {
    const executeSignal = jest.fn();
    const deps = makeDeps({
      evaluate: jest.fn().mockResolvedValue({ ...buyResult, signal: 'none', entry: false }),
      insertSignal: jest.fn().mockResolvedValue({ inserted: true, id: 55 }),
      executeSignal,
    });
    await makeRunner(deps).runOnce();
    expect(executeSignal).not.toHaveBeenCalled();
  });

  it('does not execute when the signal was suppressed by dedupe (not inserted)', async () => {
    const executeSignal = jest.fn();
    const deps = makeDeps({
      insertSignal: jest.fn().mockResolvedValue({ inserted: false, id: null }),
      executeSignal,
    });
    await makeRunner(deps).runOnce();
    expect(executeSignal).not.toHaveBeenCalled();
  });

  it('isolates an execution failure, counts it and still emits the signal', async () => {
    const deps = makeDeps({
      insertSignal: jest.fn().mockResolvedValue({ inserted: true, id: 55 }),
      executeSignal: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const runner = makeRunner(deps);

    await runner.runOnce();

    expect(deps.emit).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ acted: false, execution_reason: expect.stringMatching(/boom/) })
    );
    expect(runner.status().totals.errors).toBe(1);
    expect(runner.status().totals.signals_recorded).toBe(1);
  });
});

describe('StrategyRunner disabled', () => {
  it('start() is a no-op when not enabled', () => {
    const deps = makeDeps();
    const runner = new StrategyRunner({ enabled: false, deps });
    runner.start();
    expect(runner.status().enabled).toBe(false);
  });
});

describe('historyPeriodFor', () => {
  it('sizes the window to the timeframe', () => {
    expect(historyPeriodFor('1day')).toBe('1Y');
    expect(historyPeriodFor('1hour')).toBe('1M');
    expect(historyPeriodFor('5min')).toBe('10D');
    expect(historyPeriodFor('tick')).toBe('1D');
  });
});

describe('runSymbol — canonical vs native (C-2)', () => {
  it('prefers the connection-resolved native symbol', () => {
    // The same definition on two accounts trades two differently-named
    // instruments; the run records which, so it is never re-derived.
    expect(runSymbol({ symbol: 'EURUSD', native_symbol: 'EURUSD.a' })).toBe('EURUSD.a');
    expect(runSymbol({ symbol: 'EURUSD', native_symbol: 'EURUSD_i' })).toBe('EURUSD_i');
  });

  it('falls back to the definition symbol for pre-C-2 runs', () => {
    // Runs created before resolution existed have no native symbol, and the
    // definition's own is exactly what they were created to trade.
    expect(runSymbol({ symbol: 'MSFT', native_symbol: null })).toBe('MSFT');
  });

  it('treats a blank native symbol as absent rather than trading ""', () => {
    expect(runSymbol({ symbol: 'MSFT', native_symbol: '   ' })).toBe('MSFT');
  });
});

describe('StrategyRunner — native symbol reaches the venue', () => {
  it('fetches history for the native symbol, not the canonical one', async () => {
    const fetchHistory = jest.fn().mockResolvedValue(bars);
    const runner = makeRunner(
      makeDeps({
        listActiveRuns: jest
          .fn()
          .mockResolvedValue([activeRun({ symbol: 'EURUSD', native_symbol: 'EURUSD.a' })]),
        fetchHistory,
      })
    );

    await runner.runOnce();

    // The runner hands the whole run to fetchHistory; the default dep is what
    // maps it to a query param, so assert the run it was given carries the
    // resolved symbol.
    expect(runSymbol(fetchHistory.mock.calls[0][0])).toBe('EURUSD.a');
  });
});
