/**
 * The range a backtest asks for and the hash of the bars it ran on. The SQL
 * (finding the contract, coverage, loading) runs against a real database in
 * backtestData.db.test.ts.
 */
import {
  BacktestData,
  BacktestDataError,
  MAX_BARS,
  barsHash,
  resolveRange,
  type BacktestDataDeps,
} from '../src/services/backtestData.js';

const NOW = new Date('2026-11-10T12:00:00Z');

describe('resolveRange', () => {
  it('counts a period back from now', () => {
    expect(resolveRange({ period: '5D' }, NOW)).toEqual({
      start: new Date('2026-11-05T12:00:00Z'),
      end: NOW,
    });
    const twoYears = resolveRange({ period: '2y' }, NOW);
    expect(Math.round((NOW.getTime() - twoYears.start.getTime()) / 86_400_000)).toBe(731);
    // No period at all is a year.
    expect(resolveRange({}, NOW).start.toISOString().slice(0, 10)).toBe('2025-11-10');
  });

  it('takes two dates, end exclusive, and never runs past now', () => {
    expect(resolveRange({ start_date: '2026-01-05', end_date: '2026-02-01' }, NOW)).toEqual({
      start: new Date('2026-01-05T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
    expect(resolveRange({ start_date: '2026-11-01', end_date: '2027-01-01' }, NOW).end).toEqual(
      NOW
    );
  });

  it.each([
    [{ period: '0D' }],
    [{ period: 'ages' }],
    [{ start_date: '2026-01-05' }],
    [{ start_date: '05/01/2026', end_date: '2026-02-01' }],
    [{ start_date: '2026-02-01', end_date: '2026-02-01' }],
    [{ start_date: '2026-13-45', end_date: '2026-12-01' }],
  ])('refuses %j', (input) => {
    expect(() => resolveRange(input, NOW)).toThrow(BacktestDataError);
  });
});

describe('barsHash', () => {
  const bars = { t: [1, 2], o: [1.1, 1.2], h: [1.3, 1.4], l: [1.0, 1.1], c: [1.2, 1.3], v: [5, 6] };

  it('is the same for the same bars and changes with any field of any bar', () => {
    const hash = barsHash(bars);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(barsHash(JSON.parse(JSON.stringify(bars)))).toBe(hash);
    expect(barsHash({ ...bars, c: [1.2, 1.30001] })).not.toBe(hash);
    expect(barsHash({ ...bars, v: [5, 7] })).not.toBe(hash);
    expect(barsHash({ ...bars, t: [1, 3] })).not.toBe(hash);
  });
});

describe('BacktestData', () => {
  function deps(over: Partial<BacktestDataDeps> = {}): BacktestDataDeps {
    return {
      db: { query: jest.fn().mockResolvedValue({ rows: [] }) },
      getOrCreateContract: jest.fn().mockResolvedValue(5),
      fetchHistory: jest.fn().mockResolvedValue([]),
      storeCandlestickData: jest.fn().mockResolvedValue({ inserted: 0, updated: 0, errors: 0 }),
      chunkDays: () => 10,
      ...over,
    };
  }
  const range = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-26T00:00:00Z') };

  it('creates the contract as the collection table would, and fetches a range in chunks', async () => {
    const d = deps();
    const data = new BacktestData(d);
    await data.fetchMissing(
      { broker: 'oanda', symbol: 'eur_usd', secType: 'CASH', exchange: 'SMART', currency: 'USD' },
      '5min',
      range
    );
    // No exchange for a broker that has none; the default account.
    expect(d.getOrCreateContract).toHaveBeenCalledWith({
      broker: 'oanda',
      brokerAccount: 'default',
      symbol: 'EUR_USD',
      secType: 'CASH',
      exchange: undefined,
      currency: 'USD',
    });
    const asked = (d.fetchHistory as jest.Mock).mock.calls.map(([r]) => [r.startDate, r.endDate]);
    expect(asked).toEqual([
      ['2026-01-01', '2026-01-11'],
      ['2026-01-11', '2026-01-21'],
      ['2026-01-21', '2026-01-26'],
    ]);
    // Nothing came back, so nothing was stored.
    expect(d.storeCandlestickData).not.toHaveBeenCalled();
  });

  it('refuses to load more bars than one run may hold', async () => {
    const rows = { length: MAX_BARS + 1 } as unknown as any[];
    const data = new BacktestData(deps({ db: { query: jest.fn().mockResolvedValue({ rows }) } }));
    await expect(data.load(1, '1min', range)).rejects.toThrow(/Shorten the range/);
  });
});
