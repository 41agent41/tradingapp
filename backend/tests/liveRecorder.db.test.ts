/**
 * The live recorder's SQL against a real TimescaleDB: what a flush stores,
 * which bar wins between the stream and the broker, the recording flags, and
 * quote retention. Runs only with DB_TESTS=1 (see marketDataStorage.db.test.ts);
 * otherwise skipped.
 */
import { dbService } from '../src/services/database.js';
import { marketDataService } from '../src/services/marketDataService.js';
import { CollectionConfigRepository } from '../src/services/collectionConfig.js';
import { TARGETS_SQL, storeFlush, type BarRow } from '../src/services/liveRecorder.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const tag = Date.now().toString(36).slice(-6).toUpperCase();
const MIN = 60_000;
// A finished minute a few minutes back, so the backfill may store it too.
const T = Math.floor(Date.now() / MIN) * MIN - 5 * MIN;

function bar(contractId: number, minute: number, close: number): BarRow {
  return { contractId, minute, open: 1.1, high: 1.3, low: 1.0, close, volume: 0, count: 3 };
}

async function stored(contractId: number, minute: number) {
  const { rows } = await dbService.query(
    `SELECT close::float8 AS close, count, source FROM candlestick_data
      WHERE contract_id = $1 AND timeframe = '1min' AND timestamp = to_timestamp($2 / 1000.0)`,
    [contractId, minute]
  );
  return rows[0];
}

run('live recorder (real database)', () => {
  jest.setTimeout(60000);
  const repo = new CollectionConfigRepository(dbService, marketDataService);
  const contract = (symbol: string) =>
    marketDataService.getOrCreateContract({ broker: 'oanda', symbol, secType: 'CASH' });

  afterAll(async () => {
    await dbService.close();
  });

  it('stores bars, quotes and the cursor in one flush, and updates a bar still forming', async () => {
    const id = await contract(`REC${tag}`);
    await storeFlush({
      bars: [bar(id, T, 1.2)],
      ticks: [
        {
          contractId: id,
          ts: T + 1000,
          bid: 1.1,
          ask: 1.3,
          last: null,
          lastSize: null,
          recvTs: T + 1005,
        },
        {
          contractId: id,
          ts: T + 1000,
          bid: 1.1,
          ask: 1.31,
          last: null,
          lastSize: null,
          recvTs: T + 1006,
        },
      ],
      cursor: `${T}-1`,
    });
    expect(await stored(id, T)).toEqual({ close: 1.2, count: 3, source: 'stream' });

    await storeFlush({ bars: [{ ...bar(id, T, 1.25), count: 4 }], ticks: [], cursor: `${T}-2` });
    expect(await stored(id, T)).toEqual({ close: 1.25, count: 4, source: 'stream' });

    // Two quotes at one instant are both kept.
    const ticks = await dbService.query(
      `SELECT bid, ask, last FROM quote_ticks WHERE contract_id = $1 ORDER BY recv_ts`,
      [id]
    );
    expect(ticks.rows).toEqual([
      { bid: 1.1, ask: 1.3, last: null },
      { bid: 1.1, ask: 1.31, last: null },
    ]);
    const cursor = await dbService.query(`SELECT last_entry_id FROM recorder_cursor`);
    expect(cursor.rows).toEqual([{ last_entry_id: `${T}-2` }]);
  });

  it('stores nothing, cursor included, when any part of a flush fails', async () => {
    const id = await contract(`ATOM${tag}`);
    await storeFlush({ bars: [], ticks: [], cursor: 'before' });
    await expect(
      storeFlush({
        bars: [bar(id, T, 1.2)],
        // A quote with no contract breaks the NOT NULL rule.
        ticks: [
          {
            contractId: null as unknown as number,
            ts: T,
            bid: 1,
            ask: 1,
            last: null,
            lastSize: null,
            recvTs: T,
          },
        ],
        cursor: 'after',
      })
    ).rejects.toThrow();
    expect(await stored(id, T)).toBeUndefined();
    const cursor = await dbService.query(`SELECT last_entry_id FROM recorder_cursor`);
    expect(cursor.rows[0].last_entry_id).toBe('before');
  });

  it('lets a broker bar replace a stream bar, and never the other way round', async () => {
    const id = await contract(`WIN${tag}`);
    await storeFlush({ bars: [bar(id, T, 1.2)], ticks: [], cursor: `${T}-3` });
    await marketDataService.storeCandlestickData(id, '1min', [
      { timestamp: new Date(T), open: 2, high: 2, low: 2, close: 2, volume: 10 },
    ]);
    expect(await stored(id, T)).toMatchObject({ close: 2, source: 'broker' });

    await storeFlush({ bars: [bar(id, T, 1.3)], ticks: [], cursor: `${T}-4` });
    expect(await stored(id, T)).toMatchObject({ close: 2, source: 'broker' });
  });

  it('leaves the minute still forming to the recorder', async () => {
    const id = await contract(`FORM${tag}`);
    const forming = Math.floor(Date.now() / MIN) * MIN;
    const result = await marketDataService.storeCandlestickData(id, '1min', [
      { timestamp: new Date(forming - MIN), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: new Date(forming), open: 2, high: 2, low: 2, close: 2, volume: 1 },
    ]);
    expect(result).toMatchObject({ inserted: 1, errors: 0 });
    expect(await stored(id, forming)).toBeUndefined();
  });

  it('keeps the recording flags the same on every row of a contract', async () => {
    const symbol = `FLAG${tag}`;
    const five = await repo.add({ broker: 'oanda', symbol, timeframe: '5min' });
    expect(five).toMatchObject({ record_live: false, record_ticks: false });

    // Storing ticks turns Record live on, for both rows.
    await repo.update(five.id, { record_ticks: true });
    const hour = await repo.add({ broker: 'oanda', symbol, timeframe: '1hour' });
    expect(hour).toMatchObject({ record_live: true, record_ticks: true });

    const targets = await dbService.query(TARGETS_SQL);
    const mine = targets.rows.filter((r) => r.symbol === symbol);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ broker: 'oanda', broker_account: 'default', ticks: true });

    // Turning Record live off stops both, on both rows.
    await repo.update(hour.id, { record_live: false });
    const rows = (await repo.list()).filter((r) => r.symbol === symbol);
    expect(rows.map((r) => [r.record_live, r.record_ticks])).toEqual([
      [false, false],
      [false, false],
    ]);
    for (const r of rows) await repo.remove(r.id);
  });

  it('takes a late quote into a day already compressed', async () => {
    const id = await contract(`COMP${tag}`);
    const old = Date.now() - 3 * 86_400_000;
    const tick = (ts: number) => ({
      contractId: id,
      ts,
      bid: 1,
      ask: 1.1,
      last: null,
      lastSize: null,
      recvTs: ts,
    });
    await storeFlush({ bars: [], ticks: [tick(old)], cursor: `${T}-5` });
    await dbService.query(
      `SELECT compress_chunk(c, if_not_compressed => true)
         FROM show_chunks('quote_ticks', older_than => INTERVAL '2 days') c`
    );
    await storeFlush({ bars: [], ticks: [tick(old + 1000)], cursor: `${T}-6` });
    const n = await dbService.query(
      `SELECT count(*)::int AS n FROM quote_ticks WHERE contract_id = $1`,
      [id]
    );
    expect(n.rows[0].n).toBe(2);
  });

  it('drops stored quotes older than TICK_RETENTION_DAYS in the cleanup', async () => {
    const id = await contract(`KEEP${tag}`);
    const day = 86_400_000;
    const tick = (ts: number) => ({
      contractId: id,
      ts,
      bid: 1,
      ask: 1.1,
      last: null,
      lastSize: null,
      recvTs: ts,
    });
    await storeFlush({
      bars: [],
      ticks: [tick(Date.now() - 40 * day), tick(Date.now() - 2 * day)],
      cursor: `${T}-7`,
    });
    const result = await marketDataService.cleanOldData();
    expect(result.tickChunksDropped).toBeGreaterThanOrEqual(1);
    const left = await dbService.query(
      `SELECT count(*)::int AS n FROM quote_ticks WHERE contract_id = $1`,
      [id]
    );
    expect(left.rows[0].n).toBe(1);
  });
});
