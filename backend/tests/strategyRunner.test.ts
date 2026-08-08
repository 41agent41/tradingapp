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
    run_group_id: null,
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
    // The runner merges injected deps over the real ones, so a fake dep set
    // must be complete — an omitted dep silently reaches the live DB.
    listStagingGroups: jest.fn().mockResolvedValue([]),
    admitGroup: jest.fn().mockResolvedValue(0),
    abandonGroup: jest.fn().mockResolvedValue(0),
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

describe('StrategyRunner — per-connection isolation (C-3)', () => {
  function runOn(id: number, account: string): ActiveRun {
    return activeRun({ id, broker: 'mt5', broker_account: account });
  }

  it('does not let one stalled connection block another', async () => {
    // The failure this exists for: a sidecar that is powered on but not
    // answering used to cost its timeout per run per tick, with every other
    // account queued behind it.
    let releaseStuck!: () => void;
    const stuck = new Promise<RawBar[]>((resolve) => {
      releaseStuck = () => resolve(bars);
    });
    const order: string[] = [];

    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([runOn(1, 'stalled'), runOn(2, 'healthy')]),
      fetchHistory: jest.fn().mockImplementation((run: ActiveRun) => {
        if (run.broker_account === 'stalled') return stuck;
        order.push('healthy');
        return Promise.resolve(bars);
      }),
    });

    const runner = new StrategyRunner({ enabled: true, deps, maxConnectionConcurrency: 4 });
    const pass = runner.runOnce();
    // The healthy connection completes while the other is still hanging.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['healthy']);

    releaseStuck();
    await pass;
  });

  it('processes runs on one connection sequentially', async () => {
    // One sidecar is one terminal; parallelism against it buys nothing.
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = makeDeps({
      listActiveRuns: jest
        .fn()
        .mockResolvedValue([runOn(1, 'same'), runOn(2, 'same'), runOn(3, 'same')]),
      fetchHistory: jest.fn().mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return bars;
      }),
    });

    await new StrategyRunner({ enabled: true, deps }).runOnce();
    expect(maxInFlight).toBe(1);
  });

  it('opens a breaker after repeated failures and skips that connection', async () => {
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([runOn(1, 'broken')]),
      fetchHistory: jest.fn().mockRejectedValue(new Error('bridge unreachable')),
    });
    const runner = new StrategyRunner({
      enabled: true,
      deps,
      breakerThreshold: 2,
      breakerCooldownSeconds: 600,
    });

    await runner.runOnce();
    await runner.runOnce(); // threshold reached — breaker opens
    const callsBeforeSkip = (deps.fetchHistory as jest.Mock).mock.calls.length;
    await runner.runOnce(); // skipped entirely

    expect(callsBeforeSkip).toBe(2);
    expect((deps.fetchHistory as jest.Mock).mock.calls.length).toBe(2);
    expect(runner.status().totals.skipped).toBe(1);
    expect(runner.status().breakers['mt5:broken'].open).toBe(true);
  });

  it('closes the breaker once the connection recovers', async () => {
    const fetchHistory = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(bars);
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([runOn(1, 'flaky')]),
      fetchHistory,
    });
    const runner = new StrategyRunner({ enabled: true, deps, breakerThreshold: 2 });

    await runner.runOnce();
    await runner.runOnce();

    expect(runner.status().breakers['mt5:flaky']).toBeUndefined();
  });
});

describe('StrategyRunner — staged group admission (C-3)', () => {
  const STARTED = new Date(NOW - 600_000).toISOString();

  function stagingGroup(overrides = {}) {
    return {
      id: 7,
      settle_seconds: 300,
      canary_run_id: 1,
      canary_status: 'running',
      canary_started_at: STARTED,
      canary_last_evaluated_at: new Date(NOW - 60_000).toISOString(),
      canary_last_error: null,
      pending_legs: 2,
      ...overrides,
    };
  }

  it('admits the siblings once the canary has settled', async () => {
    const admitGroup = jest.fn().mockResolvedValue(2);
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest.fn().mockResolvedValue([stagingGroup()]),
      admitGroup,
    });

    const runner = new StrategyRunner({ enabled: true, deps });
    await runner.runOnce();

    expect(admitGroup).toHaveBeenCalledWith(7);
    expect(runner.status().totals.groups_admitted).toBe(1);
  });

  it('waits while the settle period has not elapsed', async () => {
    const admitGroup = jest.fn();
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest
        .fn()
        .mockResolvedValue([
          stagingGroup({ canary_started_at: new Date(NOW - 10_000).toISOString() }),
        ]),
      admitGroup,
    });

    await new StrategyRunner({ enabled: true, deps }).runOnce();
    expect(admitGroup).not.toHaveBeenCalled();
  });

  it('waits until the canary has actually evaluated, not merely started', async () => {
    // Elapsed time alone would admit a leg that started and did nothing.
    const admitGroup = jest.fn();
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest
        .fn()
        .mockResolvedValue([stagingGroup({ canary_last_evaluated_at: null })]),
      admitGroup,
    });

    await new StrategyRunner({ enabled: true, deps }).runOnce();
    expect(admitGroup).not.toHaveBeenCalled();
  });

  it('abandons the group when the canary errored — never falls through to admit', async () => {
    // Catching a bad edit before it reaches every account is the whole point.
    const admitGroup = jest.fn();
    const abandonGroup = jest.fn().mockResolvedValue(2);
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest
        .fn()
        .mockResolvedValue([stagingGroup({ canary_last_error: 'rule-set failed to compile' })]),
      admitGroup,
      abandonGroup,
    });

    const runner = new StrategyRunner({ enabled: true, deps });
    await runner.runOnce();

    expect(admitGroup).not.toHaveBeenCalled();
    expect(abandonGroup).toHaveBeenCalledWith(7, expect.stringContaining('canary failed'));
    expect(runner.status().totals.groups_abandoned).toBe(1);
  });

  it('abandons the group when the canary is no longer running', async () => {
    const abandonGroup = jest.fn().mockResolvedValue(2);
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest.fn().mockResolvedValue([stagingGroup({ canary_status: 'stopped' })]),
      abandonGroup,
    });

    await new StrategyRunner({ enabled: true, deps }).runOnce();
    expect(abandonGroup).toHaveBeenCalled();
  });

  it('a failure admitting one group does not block the next', async () => {
    const admitGroup = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(2);
    const deps = makeDeps({
      listActiveRuns: jest.fn().mockResolvedValue([]),
      listStagingGroups: jest
        .fn()
        .mockResolvedValue([stagingGroup({ id: 7 }), stagingGroup({ id: 8 })]),
      admitGroup,
    });

    const runner = new StrategyRunner({ enabled: true, deps });
    await runner.runOnce();

    expect(admitGroup).toHaveBeenCalledTimes(2);
    expect(runner.status().totals.groups_admitted).toBe(1);
  });
});

describe('StrategyRunner — venue position is the source of truth (E-0)', () => {
  it('evaluates against the position the venue reports', async () => {
    const evaluate = jest.fn().mockResolvedValue(buyResult);
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue({ size: -2, avg_price: 1.085, derived_size: -2 }),
      evaluate,
    });

    await makeRunner(deps).runOnce();

    // Signed: shorts are a negative size, not an absent one.
    expect(evaluate.mock.calls[0][2]).toEqual(
      expect.objectContaining({ size: -2, avg_price: 1.085 })
    );
  });

  it('does NOT treat an unreachable venue as a flat position', async () => {
    // The whole point of E-0's fail-closed read. Reporting flat when the
    // position is merely unknown lets a strategy open a second position on
    // top of one it already holds.
    const evaluate = jest.fn();
    const markError = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getPosition: jest.fn().mockRejectedValue(new Error('bridge unreachable')),
      evaluate,
      markError,
    });

    const runner = makeRunner(deps);
    await runner.runOnce();

    expect(evaluate).not.toHaveBeenCalled();
    expect(markError).toHaveBeenCalledWith(1, expect.stringContaining('bridge unreachable'));
    expect(runner.status().totals.errors).toBe(1);
  });

  it('counts a position-read failure against the connection breaker', async () => {
    // An unreadable position is almost always the venue being unreachable,
    // which is a property of the connection rather than of this strategy.
    const deps = makeDeps({
      getPosition: jest.fn().mockRejectedValue(new Error('bridge unreachable')),
    });
    const runner = new StrategyRunner({ enabled: true, deps, breakerThreshold: 1 });

    await runner.runOnce();

    expect(runner.status().breakers['ib:default'].open).toBe(true);
  });
});

describe('StrategyRunner — position reconciliation (E-0)', () => {
  it('reports a venue/fills mismatch without changing the position used', async () => {
    const evaluate = jest.fn().mockResolvedValue(buyResult);
    const deps = makeDeps({
      // The venue says flat; the app's fills still think it is long — the
      // shape a broker-side stop produces, since the app placed no exit.
      getPosition: jest.fn().mockResolvedValue({ size: 0, avg_price: 0, derived_size: 1 }),
      evaluate,
    });

    const runner = makeRunner(deps);
    await runner.runOnce();

    expect(runner.status().totals.position_divergences).toBe(1);
    expect(runner.status().divergent_runs[1]).toEqual(
      expect.objectContaining({ venue: 0, derived: 1 })
    );
    // Authoritative: the decision still used the venue's figure.
    expect(evaluate.mock.calls[0][2]).toEqual(expect.objectContaining({ size: 0 }));
  });

  it('does not flag agreement', async () => {
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue({ size: 1, avg_price: 1.1, derived_size: 1 }),
    });
    const runner = makeRunner(deps);
    await runner.runOnce();
    expect(runner.status().totals.position_divergences).toBe(0);
  });

  it('tolerates fractional-lot rounding rather than flagging every bar', async () => {
    const deps = makeDeps({
      getPosition: jest
        .fn()
        .mockResolvedValue({ size: 0.01, avg_price: 1.1, derived_size: 0.010000001 }),
    });
    const runner = makeRunner(deps);
    await runner.runOnce();
    expect(runner.status().totals.position_divergences).toBe(0);
  });

  it('clears a run from the divergent list once it agrees again', async () => {
    const getPosition = jest
      .fn()
      .mockResolvedValueOnce({ size: 0, avg_price: 0, derived_size: 1 })
      .mockResolvedValue({ size: 1, avg_price: 1.1, derived_size: 1 });
    const deps = makeDeps({ getPosition, latestSignalBarTime: jest.fn().mockResolvedValue(null) });

    const runner = makeRunner(deps);
    await runner.runOnce();
    expect(runner.status().divergent_runs[1]).toBeDefined();

    await runner.runOnce();
    expect(runner.status().divergent_runs[1]).toBeUndefined();
  });

  it('skips the check when the fills-derived figure is unavailable', async () => {
    // Losing the check must not stop trading on a position the venue
    // reported perfectly well.
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue({ size: 1, avg_price: 1.1, derived_size: null }),
    });
    const runner = makeRunner(deps);
    await runner.runOnce();
    expect(runner.status().totals.position_divergences).toBe(0);
    expect(runner.status().totals.errors).toBe(0);
  });
});

describe('StrategyRunner — trailing stops (E-3)', () => {
  const openLong = { size: 1, avg_price: 1.1, stop_loss: 1.09, derived_size: 1 };

  function resultWithTrail(stopPrice: number | null, error: string | null = null) {
    return {
      ...buyResult,
      signal: 'none',
      trail: { stop_price: stopPrice, direction: 'long', error },
    };
  }

  it('tightens the venue stop on a bar with no signal at all', async () => {
    // Trailing is not a signal: it happens on every bar a position is open,
    // including bars the rules say nothing about.
    const modifyStop = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue(openLong),
      evaluate: jest.fn().mockResolvedValue(resultWithTrail(1.095)),
      modifyStop,
    });

    const runner = makeRunner(deps);
    await runner.runOnce();

    expect(modifyStop).toHaveBeenCalledWith(expect.anything(), 'MSFT', 1.095);
    expect(runner.status().totals.stops_tightened).toBe(1);
  });

  it('does not move a stop that would loosen', async () => {
    const modifyStop = jest.fn();
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue(openLong),
      evaluate: jest.fn().mockResolvedValue(resultWithTrail(1.05)),
      modifyStop,
    });

    await makeRunner(deps).runOnce();
    expect(modifyStop).not.toHaveBeenCalled();
  });

  it('does nothing when flat', async () => {
    const modifyStop = jest.fn();
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue({ size: 0, avg_price: 0, derived_size: 0 }),
      evaluate: jest.fn().mockResolvedValue(resultWithTrail(1.095)),
      modifyStop,
    });

    await makeRunner(deps).runOnce();
    expect(modifyStop).not.toHaveBeenCalled();
  });

  it('leaves the existing stop alone when the trail cannot be resolved', async () => {
    const modifyStop = jest.fn();
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue(openLong),
      evaluate: jest.fn().mockResolvedValue(resultWithTrail(null, 'no usable ATR')),
      modifyStop,
    });

    await makeRunner(deps).runOnce();
    expect(modifyStop).not.toHaveBeenCalled();
  });

  it('a failed modify is counted but does not stop the evaluation', async () => {
    // The previous stop remains in place — degraded but protected.
    const deps = makeDeps({
      getPosition: jest.fn().mockResolvedValue(openLong),
      evaluate: jest.fn().mockResolvedValue(resultWithTrail(1.095)),
      modifyStop: jest.fn().mockRejectedValue(new Error('market closed')),
    });

    const runner = makeRunner(deps);
    await runner.runOnce();

    expect(runner.status().totals.errors).toBe(1);
    // The signal still got recorded: the trail failing must not abort the bar.
    expect(runner.status().totals.runs_evaluated).toBe(1);
  });
});
