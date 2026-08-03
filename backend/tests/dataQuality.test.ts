/**
 * Data-quality metric tests.
 *
 * MarketDataService.computeDailyQualityMetrics is pure (no DB), so it is
 * exercised directly with hand-built bars.
 */
import { MarketDataService, type CandlestickBar } from '../src/services/marketDataService.js';

function bar(iso: string, partial: Partial<CandlestickBar> = {}): CandlestickBar {
  return {
    timestamp: new Date(iso),
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
    ...partial,
  };
}

describe('MarketDataService.timeframeSeconds', () => {
  it('maps known timeframes to seconds', () => {
    expect(MarketDataService.timeframeSeconds('1min')).toBe(60);
    expect(MarketDataService.timeframeSeconds('1hour')).toBe(3600);
    expect(MarketDataService.timeframeSeconds('1day')).toBe(86400);
  });

  it('returns 0 for tick / unknown timeframes', () => {
    expect(MarketDataService.timeframeSeconds('tick')).toBe(0);
    expect(MarketDataService.timeframeSeconds('bogus')).toBe(0);
  });
});

describe('MarketDataService.isInvalidBar', () => {
  it('accepts a sane OHLCV bar', () => {
    expect(MarketDataService.isInvalidBar(bar('2026-01-02T14:00:00Z'))).toBe(false);
  });

  it('flags high < low', () => {
    expect(MarketDataService.isInvalidBar(bar('2026-01-02T14:00:00Z', { high: 5, low: 20 }))).toBe(
      true
    );
  });

  it('flags non-positive prices', () => {
    expect(MarketDataService.isInvalidBar(bar('2026-01-02T14:00:00Z', { low: 0 }))).toBe(true);
    expect(
      MarketDataService.isInvalidBar(bar('2026-01-02T14:00:00Z', { close: -1, low: -2 }))
    ).toBe(true);
  });

  it('flags a high below the open/close body', () => {
    expect(
      MarketDataService.isInvalidBar(
        bar('2026-01-02T14:00:00Z', { open: 10, close: 12, high: 11, low: 9 })
      )
    ).toBe(true);
  });

  it('flags negative volume', () => {
    expect(MarketDataService.isInvalidBar(bar('2026-01-02T14:00:00Z', { volume: -5 }))).toBe(true);
  });
});

describe('MarketDataService.computeDailyQualityMetrics', () => {
  it('returns nothing for an empty batch', () => {
    expect(MarketDataService.computeDailyQualityMetrics([], '1hour')).toEqual([]);
  });

  it('counts duplicates, an interior gap and an invalid bar within a day', () => {
    const bars: CandlestickBar[] = [
      bar('2026-01-02T14:00:00Z'),
      bar('2026-01-02T15:00:00Z'),
      bar('2026-01-02T15:00:00Z'), // duplicate timestamp
      bar('2026-01-02T17:00:00Z'), // 16:00 missing → 1 interior gap
      bar('2026-01-02T18:00:00Z', { high: 5, low: 20 }), // invalid
    ];

    const metrics = MarketDataService.computeDailyQualityMetrics(bars, '1hour');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      totalBars: 4, // distinct timestamps: 14,15,17,18
      duplicateBars: 1,
      missingBars: 1,
      invalidBars: 1,
    });
    expect(metrics[0].date.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('does not invent missing bars for daily data spanning multiple days', () => {
    const bars: CandlestickBar[] = [
      bar('2026-01-02T00:00:00Z'),
      bar('2026-01-05T00:00:00Z'), // 3-day gap (weekend) — must NOT count as missing
      bar('2026-01-06T00:00:00Z'),
    ];

    const metrics = MarketDataService.computeDailyQualityMetrics(bars, '1day');
    expect(metrics).toHaveLength(3);
    for (const m of metrics) {
      expect(m.totalBars).toBe(1);
      expect(m.missingBars).toBe(0);
      expect(m.duplicateBars).toBe(0);
      expect(m.invalidBars).toBe(0);
    }
    // Sorted ascending by day.
    expect(metrics.map((m) => m.date.toISOString())).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z',
    ]);
  });

  it('does no gap analysis for tick data (interval unknown)', () => {
    const bars: CandlestickBar[] = [
      bar('2026-01-02T14:00:00Z'),
      bar('2026-01-02T14:05:23Z'),
      bar('2026-01-02T19:31:00Z'),
    ];
    const metrics = MarketDataService.computeDailyQualityMetrics(bars, 'tick');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].missingBars).toBe(0);
    expect(metrics[0].totalBars).toBe(3);
  });
});
