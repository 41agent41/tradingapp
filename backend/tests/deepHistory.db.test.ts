/**
 * Deep history against a real TimescaleDB: an entry with a history start a
 * year back is walked back by the backfill scheduler until a year of
 * 5-minute bars is stored, retention keeps them, and the collection list
 * reports it complete. The broker service is stood in for by a function that
 * answers date ranges the way the paged OANDA adapter does (FX: no bars from
 * Friday 21:00 to Sunday 21:00 UTC). Runs only with DB_TESTS=1 (see
 * marketDataStorage.db.test.ts); otherwise skipped.
 */
import { BackfillScheduler, type HistoryRequest } from '../src/services/backfillScheduler.js';
import { CollectionConfigRepository } from '../src/services/collectionConfig.js';
import { dbService } from '../src/services/database.js';
import { marketDataService } from '../src/services/marketDataService.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const tag = Date.now().toString(36).slice(-6).toUpperCase();
const DAY = 86_400_000;
const STEP = 300_000;

/** OANDA-style 5-minute FX bars from start (inclusive) to end (exclusive). */
function fxBars(startMs: number, endMs: number) {
  const bars = [];
  for (let t = Math.ceil(startMs / STEP) * STEP; t < endMs; t += STEP) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const h = d.getUTCHours();
    const closed = dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 21);
    if (closed) continue;
    bars.push({ timestamp: t / 1000, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 10 });
  }
  return bars;
}

run('deep history (real database)', () => {
  jest.setTimeout(300_000);
  const repo = new CollectionConfigRepository(dbService, marketDataService);

  afterAll(async () => {
    await dbService.close();
  });

  it('walks back a year of 5-minute OANDA bars into candlestick_data', async () => {
    const now = Date.now();
    const historyStart = new Date(now - 365 * DAY).toISOString().slice(0, 10);
    const entry = await repo.add({
      broker: 'oanda',
      symbol: `EUR_USD${tag}`,
      timeframe: '5min',
      history_start: historyStart,
      retention_days: 30,
    });
    expect(entry.history_start).toBe(historyStart);

    const requests: HistoryRequest[] = [];
    const scheduler = new BackfillScheduler({
      enabled: true,
      period: '5D',
      initialDelayMs: 0,
      deps: {
        // Only this test's entry, so other rows in the database are left alone.
        listConfigs: async () =>
          (await marketDataService.getActiveCollectionConfigs({ autoCollectOnly: true })).filter(
            (c) => c.contractId === entry.contract_id
          ),
        fetchHistory: async (req) => {
          requests.push(req);
          if (!req.startDate) return fxBars(now - 5 * DAY, now);
          return fxBars(
            Date.parse(`${req.startDate}T00:00:00Z`),
            Date.parse(`${req.endDate}T00:00:00Z`)
          );
        },
        recordDataQuality: async () => undefined,
        startSession: async () => null,
      },
    });

    for (let i = 0; i < 5; i++) {
      await scheduler.runOnce();
      const [row] = (await repo.list()).filter((r) => r.id === entry.id);
      if (row.backfilled_to && row.backfilled_to.slice(0, 10) <= historyStart) break;
    }

    const { rows } = await dbService.query(
      `SELECT COUNT(*)::int AS n, MIN(timestamp) AS oldest, MAX(timestamp) AS newest
         FROM candlestick_data WHERE contract_id = $1 AND timeframe = '5min'`,
      [entry.contract_id]
    );
    const expected = fxBars(Date.parse(`${historyStart}T00:00:00Z`), now).length;
    // About 74,000 bars: a year of 5-minute bars less the FX weekends.
    expect(rows[0].n).toBeGreaterThan(70_000);
    expect(Math.abs(rows[0].n - expected)).toBeLessThan(5);
    expect(new Date(rows[0].oldest).getTime()).toBeLessThan(
      Date.parse(`${historyStart}T00:00:00Z`) + 3 * DAY
    );
    // Two runs: five 69-day chunks per run.
    expect(requests.filter((r) => r.startDate)).toHaveLength(6);

    const [row] = (await repo.list()).filter((r) => r.id === entry.id);
    expect(row.backfilled_to?.slice(0, 10)).toBe(historyStart);

    // Retention (30 days here) keeps everything from the history start on.
    await marketDataService.cleanOldData();
    const after = await dbService.query(
      `SELECT COUNT(*)::int AS n FROM candlestick_data WHERE contract_id = $1 AND timeframe = '5min'`,
      [entry.contract_id]
    );
    expect(after.rows[0].n).toBe(rows[0].n);

    await repo.remove(entry.id);
  });
});
