/**
 * The data collection list against a real TimescaleDB: adding an instrument
 * creates its contract once, the scheduler sees what the page saved, and
 * removing an entry keeps its bars. Runs only with DB_TESTS=1 (see
 * marketDataStorage.db.test.ts); otherwise skipped.
 */
import { dbService } from '../src/services/database.js';
import { marketDataService } from '../src/services/marketDataService.js';
import { CollectionConfigRepository } from '../src/services/collectionConfig.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const tag = Date.now().toString(36).slice(-6).toUpperCase();

run('data collection list (real database)', () => {
  jest.setTimeout(60000);
  const repo = new CollectionConfigRepository(dbService, marketDataService);

  afterAll(async () => {
    await dbService.close();
  });

  it('adds, re-adds, edits and removes an entry the scheduler reads', async () => {
    const symbol = `EUR_USD${tag}`;
    const added = await repo.add({ broker: 'oanda', symbol, timeframe: '5min', currency: 'usd' });
    expect(added).toMatchObject({
      broker: 'oanda',
      account: 'default',
      symbol,
      sec_type: 'CASH',
      currency: 'USD',
      timeframe: '5min',
      enabled: true,
      auto_collect: true,
      collection_interval_minutes: 5,
      retention_days: 365,
      latest_bar: null,
    });

    // The same instrument and timeframe again updates rather than duplicates.
    const again = await repo.add({
      broker: 'oanda',
      symbol,
      timeframe: '5min',
      currency: 'USD',
      retention_days: 30,
    });
    expect(again.id).toBe(added.id);
    expect(again.retention_days).toBe(30);

    await marketDataService.storeCandlestickData(added.contract_id, '5min', [
      {
        timestamp: new Date(Date.UTC(2026, 0, 5, 10)),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
    ]);
    const scheduled = await marketDataService.getActiveCollectionConfigs({ autoCollectOnly: true });
    expect(scheduled.find((c) => c.contractId === added.contract_id)).toMatchObject({
      broker: 'oanda',
      symbol,
      timeframe: '5min',
      retentionDays: 30,
    });
    const listed = (await repo.list()).find((r) => r.id === added.id);
    expect(listed?.latest_bar).toBe('2026-01-05T10:00:00.000Z');

    const paused = await repo.update(added.id, { auto_collect: false });
    expect(paused.auto_collect).toBe(false);
    const after = await marketDataService.getActiveCollectionConfigs({ autoCollectOnly: true });
    expect(after.some((c) => c.contractId === added.contract_id)).toBe(false);

    await repo.remove(added.id);
    expect((await repo.list()).some((r) => r.id === added.id)).toBe(false);
    const bars = await dbService.query(
      'SELECT count(*)::int AS n FROM candlestick_data WHERE contract_id = $1',
      [added.contract_id]
    );
    expect(bars.rows[0].n).toBe(1);
  });
});
