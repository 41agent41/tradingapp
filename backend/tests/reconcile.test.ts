/**
 * The nightly reconcile with a fake database and broker. Its SQL runs against
 * a real database in reconcile.db.test.ts.
 */
import { Reconciler, type ReconcileDeps } from '../src/services/reconcile.js';
import type { RecordTarget } from '../src/services/liveRecorder.js';
import type { RawBar } from '../src/services/backfillScheduler.js';

const NOW = Date.parse('2026-11-10T02:30:00Z');
const MIN = 60;
const T = Date.parse('2026-11-09T10:00:00Z') / 1000;

const EUR: RecordTarget = {
  contractId: 7,
  platform: 'oanda',
  account: 'default',
  symbol: 'EUR_USD',
  secType: 'CASH',
  ticks: false,
};

const raw = (minute: number, close: number): RawBar => ({
  timestamp: T + minute * MIN,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** A database of 1-minute bars the fake store upserts into, broker winning. */
function world(recorded: Array<[number, number]>, broker: RawBar[] | Error) {
  const bars = new Map<number, { close: number; source: string }>(
    recorded.map(([minute, close]) => [(T + minute * MIN) * 1000, { close, source: 'stream' }])
  );
  const deps: ReconcileDeps = {
    db: {
      query: jest.fn(async () => ({
        rows: [...bars.entries()]
          .filter(([, b]) => b.source === 'stream')
          .map(([minute, b]) => ({ minute, close: b.close })),
      })),
    },
    targets: jest.fn(async () => [EUR]),
    fetchHistory: jest.fn(async () => {
      if (broker instanceof Error) throw broker;
      return broker;
    }),
    storeCandlestickData: jest.fn(async (_id, _tf, stored) => {
      let inserted = 0;
      for (const b of stored) {
        const key = b.timestamp.getTime();
        if (!bars.has(key)) inserted++;
        bars.set(key, { close: b.close, source: 'broker' });
      }
      return { inserted, updated: stored.length - inserted, errors: 0 };
    }),
    recordDataQuality: jest.fn(async () => undefined),
    now: () => NOW,
  };
  return { deps, bars };
}

describe('Reconciler', () => {
  it('replaces recorded bars, fills gaps, and reports how far closes moved', async () => {
    // Recorded minutes 0, 1 and 3; the broker has 0 to 2, so 2 is a gap filled
    // and 3 stays as recorded.
    const w = world(
      [
        [0, 1.1],
        [1, 1.2],
        [3, 1.3],
      ],
      [raw(0, 1.1), raw(1, 1.2012), raw(2, 1.25)]
    );
    const reconciler = new Reconciler(w.deps);
    const [result] = await reconciler.run();

    expect(result).toMatchObject({
      contract_id: 7,
      symbol: 'EUR_USD',
      fetched: 3,
      replaced: 2,
      filled: 1,
      left: 1,
      error: null,
    });
    // (0 + 0.0012 / 1.2) / 2 = 5 basis points.
    expect(result.mean_move_bps).toBeCloseTo(5, 1);

    // Two whole days back through the end of today, 1-minute, from its own broker.
    expect(w.deps.fetchHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        broker: 'oanda',
        brokerAccount: 'default',
        symbol: 'EUR_USD',
        timeframe: '1min',
        startDate: '2026-11-08',
        endDate: '2026-11-11',
      })
    );
    expect(w.deps.recordDataQuality).toHaveBeenCalledWith(7, '1min', expect.any(Array));
    expect(reconciler.status()).toMatchObject({
      running: false,
      last_run: '2026-11-10T02:30:00.000Z',
      last_error: null,
      results: [expect.objectContaining({ replaced: 2 })],
    });
  });

  it('reports a broker that fails for one instrument and still finishes', async () => {
    const w = world([[0, 1.1]], new Error('oanda is down'));
    const [result] = await new Reconciler(w.deps).run();
    expect(result).toMatchObject({ error: 'oanda is down', replaced: 0, filled: 0 });
    expect(w.deps.storeCandlestickData).not.toHaveBeenCalled();
  });

  it('stores nothing when the broker has no bars for the range', async () => {
    const w = world([[0, 1.1]], []);
    const [result] = await new Reconciler(w.deps).run();
    expect(result).toMatchObject({ fetched: 0, replaced: 0, left: 1, mean_move_bps: null });
    expect(w.deps.storeCandlestickData).not.toHaveBeenCalled();
  });

  it('does not start a second pass while one runs', async () => {
    const w = world([], []);
    const reconciler = new Reconciler(w.deps);
    await Promise.all([reconciler.run(), reconciler.run()]);
    expect(w.deps.targets).toHaveBeenCalledTimes(1);
  });
});
