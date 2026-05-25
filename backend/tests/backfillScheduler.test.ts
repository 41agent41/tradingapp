/**
 * BackfillScheduler tests.
 *
 * The scheduler's dependencies (config listing, latest-timestamp lookup, IB
 * history fetch, store, quality, sessions) are all injected, so the suite is
 * hermetic — no DB, no IB Gateway, no timers fired in real time.
 */
import {
  BackfillScheduler,
  type BackfillDeps,
  type RawBar,
} from '../src/services/backfillScheduler.js';
import type { CollectionConfig } from '../src/services/marketDataService.js';

const NOW = Date.parse('2026-01-10T00:00:00Z');

function config(overrides: Partial<CollectionConfig> = {}): CollectionConfig {
  return {
    contractId: 1,
    timeframe: '1hour',
    enabled: true,
    autoCollect: true,
    collectionIntervalMinutes: 60,
    retentionDays: 365,
    symbol: 'MSFT',
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    ...overrides,
  };
}

const sampleRawBars: RawBar[] = [
  { timestamp: 1736431200, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { timestamp: 1736434800, open: 10.5, high: 12, low: 10, close: 11, volume: 120 },
];

function makeDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    listConfigs: jest.fn().mockResolvedValue([config()]),
    getLatestStoredTimestamp: jest.fn().mockResolvedValue(null),
    fetchHistory: jest.fn().mockResolvedValue(sampleRawBars),
    storeCandlestickData: jest
      .fn()
      .mockResolvedValue({ inserted: 2, updated: 0, errors: 0 }),
    recordDataQuality: jest.fn().mockResolvedValue(undefined),
    startSession: jest.fn().mockResolvedValue(42),
    endSession: jest.fn().mockResolvedValue(undefined),
    now: () => NOW,
    ...overrides,
  };
}

function makeScheduler(deps: BackfillDeps) {
  return new BackfillScheduler({
    enabled: true,
    deps,
    intervalMinutes: 15,
    period: '5D',
    initialDelayMs: 0,
  });
}

describe('BackfillScheduler.runOnce', () => {
  it('fetches, stores, records quality and closes a session for each config', async () => {
    const deps = makeDeps();
    const scheduler = makeScheduler(deps);

    await scheduler.runOnce();

    expect(deps.fetchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', timeframe: '1hour', period: '5D' })
    );
    expect(deps.storeCandlestickData).toHaveBeenCalledTimes(1);
    const [, , storedBars] = (deps.storeCandlestickData as jest.Mock).mock.calls[0];
    expect(storedBars).toHaveLength(2);
    expect(storedBars[0].timestamp).toBeInstanceOf(Date);
    expect(deps.recordDataQuality).toHaveBeenCalledTimes(1);
    expect(deps.startSession).toHaveBeenCalledWith(1, '1hour');
    expect(deps.endSession).toHaveBeenCalledWith(42, 'completed', 2);

    const status = scheduler.status();
    expect(status.totals.bars_stored).toBe(2);
    expect(status.totals.configs_processed).toBe(1);
    expect(status.totals.errors).toBe(0);
  });

  it('skips a config whose latest bar is fresher than its collection interval', async () => {
    const deps = makeDeps({
      // 10 minutes old, interval is 60 minutes → fresh → skip.
      getLatestStoredTimestamp: jest.fn().mockResolvedValue(new Date(NOW - 10 * 60_000)),
    });
    const scheduler = makeScheduler(deps);

    await scheduler.runOnce();

    expect(deps.fetchHistory).not.toHaveBeenCalled();
    expect(deps.storeCandlestickData).not.toHaveBeenCalled();
    expect(scheduler.status().totals.configs_skipped).toBe(1);
  });

  it('fetches when the latest bar is older than the collection interval', async () => {
    const deps = makeDeps({
      // 120 minutes old, interval 60 → stale → fetch.
      getLatestStoredTimestamp: jest.fn().mockResolvedValue(new Date(NOW - 120 * 60_000)),
    });
    const scheduler = makeScheduler(deps);

    await scheduler.runOnce();

    expect(deps.fetchHistory).toHaveBeenCalledTimes(1);
    expect(scheduler.status().totals.configs_processed).toBe(1);
  });

  it('isolates a per-config failure, marks the session failed and keeps going', async () => {
    const deps = makeDeps({
      listConfigs: jest
        .fn()
        .mockResolvedValue([config({ symbol: 'MSFT' }), config({ symbol: 'AAPL', contractId: 2 })]),
      fetchHistory: jest
        .fn()
        .mockRejectedValueOnce(new Error('IB timeout'))
        .mockResolvedValueOnce(sampleRawBars),
    });
    const scheduler = makeScheduler(deps);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();

    // First config failed → session closed as failed; second still stored.
    expect(deps.endSession).toHaveBeenCalledWith(42, 'failed', 0, 'IB timeout');
    expect(deps.storeCandlestickData).toHaveBeenCalledTimes(1);
    expect(scheduler.status().totals.errors).toBe(1);
    expect(scheduler.status().totals.bars_stored).toBe(2);
  });

  it('does nothing gracefully when no configs are enabled', async () => {
    const deps = makeDeps({
      listConfigs: jest.fn().mockResolvedValue([]),
    });
    const scheduler = makeScheduler(deps);

    await scheduler.runOnce();

    expect(deps.fetchHistory).not.toHaveBeenCalled();
    expect(scheduler.status().totals.runs).toBe(1);
  });

  it('does not overlap a run that is already in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      fetchHistory: jest.fn().mockImplementation(async () => {
        await gate;
        return sampleRawBars;
      }),
    });
    const scheduler = makeScheduler(deps);

    const first = scheduler.runOnce();
    // Second call while the first is mid-fetch must be a no-op.
    await scheduler.runOnce();
    expect(deps.listConfigs).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(deps.fetchHistory).toHaveBeenCalledTimes(1);
  });
});

describe('BackfillScheduler lifecycle', () => {
  it('start() is a no-op when disabled', () => {
    const deps = makeDeps();
    const scheduler = new BackfillScheduler({ enabled: false, deps });
    scheduler.start();
    expect(scheduler.status().enabled).toBe(false);
    // No work was scheduled or run.
    expect(deps.listConfigs).not.toHaveBeenCalled();
    scheduler.stop(); // safe to call even though nothing started
  });

  it('reports a diagnostic status shape', () => {
    const scheduler = makeScheduler(makeDeps());
    const status = scheduler.status();
    expect(status).toMatchObject({
      enabled: true,
      running: false,
      interval_minutes: 15,
      period: '5D',
      last_run: null,
    });
    expect(status.totals).toMatchObject({
      runs: 0,
      configs_processed: 0,
      configs_skipped: 0,
      bars_stored: 0,
      errors: 0,
    });
  });
});
