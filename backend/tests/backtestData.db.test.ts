/**
 * A backtest's bars against a real TimescaleDB: finding the contract they
 * are stored under, what a range is missing, and loading them with a hash.
 * Runs only with DB_TESTS=1 (see marketDataStorage.db.test.ts); otherwise skipped.
 */
import { dbService } from '../src/services/database.js';
import { marketDataService, type CandlestickBar } from '../src/services/marketDataService.js';
import { BacktestData } from '../src/services/backtestData.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const tag = Date.now().toString(36).slice(-6).toUpperCase();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 2, 3); // a Monday

function hourly(fromMs: number, count: number): CandlestickBar[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(fromMs + i * HOUR),
    open: 1.1,
    high: 1.2,
    low: 1.0,
    close: 1.15 + i / 1000,
    volume: 10 + i,
  }));
}

run('backtest data (real database)', () => {
  jest.setTimeout(60000);
  const fetched: Array<[string | undefined, string | undefined]> = [];
  const data = new BacktestData({
    db: dbService,
    getOrCreateContract: (c) => marketDataService.getOrCreateContract(c),
    // The broker has bars for the first hours of any day asked for.
    fetchHistory: async (req) => {
      fetched.push([req.startDate, req.endDate]);
      const from = Date.parse(`${req.startDate}T00:00:00Z`);
      return hourly(from, 6).map((b) => ({
        timestamp: b.timestamp.getTime() / 1000,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));
    },
    storeCandlestickData: (id, tf, bars) => marketDataService.storeCandlestickData(id, tf, bars),
    chunkDays: () => 30,
  });
  const symbol = `BT${tag}`;
  const inst = { broker: 'oanda', symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' };
  const range = { start: new Date(T0), end: new Date(T0 + 30 * DAY) };

  afterAll(async () => {
    await dbService.close();
  });

  it('reports a range with nothing stored as wholly missing', async () => {
    const c = await data.coverage(inst, '1hour', range);
    expect(c).toMatchObject({ contract_id: null, bars: 0, complete: false });
    expect(c.missing).toEqual([{ from: range.start.toISOString(), to: range.end.toISOString() }]);
  });

  it('finds the contract whatever type the form gave, and names what is missing', async () => {
    // Stored the way the collection table stores an OANDA pair: CASH, no exchange.
    const id = await marketDataService.getOrCreateContract({
      broker: 'oanda',
      symbol,
      secType: 'CASH',
    });
    // A week from day 7, then nothing for 9 days, then two days: holes at the
    // start, in the middle and at the end. The weekend-sized hole is not one.
    await marketDataService.storeCandlestickData(id, '1hour', [
      ...hourly(T0 + 7 * DAY, 5 * 24),
      ...hourly(T0 + 14 * DAY, 24),
      ...hourly(T0 + 23 * DAY, 2 * 24),
    ]);
    const c = await data.coverage(inst, '1hour', range);
    expect(c).toMatchObject({ contract_id: id, bars: 8 * 24, complete: false });
    expect(c.missing.map((m) => [m.from.slice(0, 10), m.to.slice(0, 10)])).toEqual([
      ['2025-03-03', '2025-03-10'],
      ['2025-03-17', '2025-03-26'],
      ['2025-03-27', '2025-04-02'],
    ]);
    // The same symbol at another broker is another instrument.
    expect((await data.coverage({ ...inst, broker: 'ib' }, '1hour', range)).contract_id).toBeNull();
  });

  it('loads the bars oldest first with a hash that follows the data', async () => {
    const { contract_id } = await data.coverage(inst, '1hour', range);
    const first = await data.load(contract_id!, '1hour', range);
    expect(first.count).toBe(8 * 24);
    expect(first.first_bar).toBe(new Date(T0 + 7 * DAY).toISOString());
    expect(first.bars.t[0]).toBe((T0 + 7 * DAY) / 1000);
    expect(first.bars.c[1]).toBeCloseTo(1.151);
    expect(first.bars.v[1]).toBe(11);
    expect([...first.bars.t].sort((a, b) => a - b)).toEqual(first.bars.t);
    expect((await data.load(contract_id!, '1hour', range)).hash).toBe(first.hash);

    // One bar changes; so does the hash.
    await marketDataService.storeCandlestickData(contract_id!, '1hour', [
      { ...hourly(T0 + 7 * DAY, 1)[0], close: 9 },
    ]);
    expect((await data.load(contract_id!, '1hour', range)).hash).not.toBe(first.hash);
  });

  it('fetches each missing stretch, stores it under the same contract, and reports again', async () => {
    const before = await data.coverage(inst, '1hour', range);
    const after = await data.fetchMissing(inst, '1hour', range);
    expect(fetched).toEqual([
      ['2025-03-03', '2025-03-10'],
      ['2025-03-17', '2025-03-26'],
      ['2025-03-27', '2025-04-02'],
    ]);
    expect(after.contract_id).toBe(before.contract_id);
    // Six new bars at the start; the other two fetches began on days already stored.
    expect(after.bars).toBe(before.bars + 6);
    // The start is now covered; what the broker did not have is still missing.
    expect(after.first_bar).toBe(range.start.toISOString());
  });
});
