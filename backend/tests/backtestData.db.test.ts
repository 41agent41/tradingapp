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

  describe('bars built from 1-minute bars', () => {
    const MIN = 60_000;
    const built = { ...inst, symbol: `BB${tag}` };
    const two = { start: new Date(T0), end: new Date(T0 + 2 * DAY) };
    let id: number;

    // Minute i opens at 100 + i and closes half a point higher.
    function minutes(fromMs: number, count: number): CandlestickBar[] {
      return Array.from({ length: count }, (_, k) => {
        const i = Math.round((fromMs - T0) / MIN) + k;
        return {
          timestamp: new Date(T0 + i * MIN),
          open: 100 + i,
          high: 101 + i,
          low: 99 + i,
          close: 100.5 + i,
          volume: 2,
        };
      });
    }

    beforeAll(async () => {
      id = await marketDataService.getOrCreateContract({
        broker: 'oanda',
        symbol: built.symbol,
        secType: 'CASH',
      });
      await marketDataService.storeCandlestickData(id, '1min', minutes(T0, 2 * 24 * 60));
    });

    it('covers a timeframe that was never collected', async () => {
      const c = await data.coverage(built, '1hour', two);
      expect(c).toMatchObject({
        contract_id: id,
        timeframe: '1hour',
        built_from: '1min',
        complete: true,
        bars: 2 * 24 * 60,
      });
    });

    it('builds each bar from the minutes inside it', async () => {
      const hours = await data.load(id, '1hour', two, '1min');
      expect(hours.count).toBe(48);
      expect(hours.bars.t[1]).toBe((T0 + HOUR) / 1000);
      // The second hour is minutes 60 to 119.
      expect(hours.bars.o[1]).toBe(160);
      expect(hours.bars.h[1]).toBe(220);
      expect(hours.bars.l[1]).toBe(159);
      expect(hours.bars.c[1]).toBe(219.5);
      expect(hours.bars.v[1]).toBe(120);

      const fives = await data.load(id, '5min', two, '1min');
      expect(fives.count).toBe(48 * 12);
      expect(fives.bars.o[1]).toBe(105);
      expect(fives.bars.c[1]).toBe(109.5);
    });

    it('shows a 1-minute bar replaced after the bars were built', async () => {
      const before = await data.load(id, '1hour', two, '1min');
      await marketDataService.storeCandlestickData(id, '1min', [
        { ...minutes(T0 + 90 * MIN, 1)[0], high: 5000 },
      ]);
      const after = await data.load(id, '1hour', two, '1min');
      expect(after.bars.h[1]).toBe(5000);
      expect(after.hash).not.toBe(before.hash);
    });

    it("uses the broker's own bars when they cover the range, unless built bars are preferred", async () => {
      await marketDataService.storeCandlestickData(id, '1hour', hourly(T0, 48));
      const own = await data.coverage(built, '1hour', two);
      expect(own.built_from).toBeUndefined();
      expect(own).toMatchObject({ complete: true, bars: 48 });
      expect((await data.coverage(built, '1hour', two, 'built')).built_from).toBe('1min');
    });

    it('loads the 1-minute bars themselves for stop fills', async () => {
      const minuteBars = await data.minutes(built, two);
      expect(minuteBars?.count).toBe(2 * 24 * 60);
      expect(minuteBars?.bars.t[1]).toBe((T0 + MIN) / 1000);
      expect(await data.minutes({ ...built, symbol: `NO${tag}` }, two)).toBeNull();
    });

    it('gives a replay its 1-minute bars and the built bars before them', async () => {
      // Asked for 01:20 on the second day at 1 hour: starts at 01:00.
      const start = new Date(T0 + DAY + 80 * MIN);
      const r = await data.replay(built, '1hour', start, 90);
      expect(r.contract_id).toBe(id);
      expect(r.start).toBe(new Date(T0 + DAY + HOUR).toISOString());
      expect(r.minutes.t).toHaveLength(90);
      expect(r.minutes.t[0]).toBe((T0 + DAY + HOUR) / 1000);
      expect(r.more).toBe(true);
      expect(r.stored).toEqual({
        first: new Date(T0).toISOString(),
        last: new Date(T0 + 2 * DAY - MIN).toISOString(),
      });
      // The 25 hours before it, oldest first, built from the minutes.
      expect(r.history.t).toHaveLength(25);
      expect(r.history.t[0]).toBe(T0 / 1000);
      expect(r.history.t[24]).toBe((T0 + DAY) / 1000);
      expect(r.history.o[24]).toBe(100 + 24 * 60);
      expect(r.history.c[24]).toBe(100.5 + 24 * 60 + 59);

      // To the end of what is stored; at 1 minute the history is the minutes.
      const tail = await data.replay(built, '1min', new Date(T0 + 2 * DAY - 10 * MIN));
      expect(tail.minutes.t).toHaveLength(10);
      expect(tail.more).toBe(false);
      expect(tail.history.t).toHaveLength(300);
      expect(tail.history.t[299]).toBe((T0 + 2 * DAY - 11 * MIN) / 1000);
    });

    it('says what is stored when a replay starts past it, or nothing is', async () => {
      await expect(data.replay(built, '5min', new Date(T0 + 3 * DAY))).rejects.toMatchObject({
        status: 404,
        message: expect.stringContaining('They are stored from 2025-03-03 to 2025-03-04'),
      });
      await expect(
        data.replay({ ...built, symbol: `NO${tag}` }, '5min', new Date(T0))
      ).rejects.toMatchObject({ status: 404 });
      await expect(data.replay(built, '8hour', new Date(T0))).rejects.toMatchObject({
        status: 400,
      });
    });

    it('never substitutes a 4-hour or daily bar', async () => {
      for (const timeframe of ['4hour', '1day']) {
        const c = await data.coverage(built, timeframe, two);
        expect(c.built_from).toBeUndefined();
        expect(c.complete).toBe(false);
      }
      // The views exist all the same, on UTC boundaries.
      const days = await data.load(id, '1day', two, '1min');
      expect(days.bars.t).toEqual([T0 / 1000, (T0 + DAY) / 1000]);
      expect(days.bars.o[1]).toBe(100 + 24 * 60);
    });
  });
});
