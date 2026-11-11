/**
 * The chart's time zone (E-23): which zone an instrument trades in, and how
 * the axis and crosshair labels read in a zone.
 */
import { describe, expect, it } from 'vitest';

import {
  chartTimeZone,
  exchangeTimeZone,
  formatChartTime,
  formatTick,
  isChartZone,
} from '../app/lib/chartTime';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('exchangeTimeZone', () => {
  it('follows a named exchange', () => {
    expect(exchangeTimeZone({ secType: 'STK', exchange: 'LSE', currency: 'USD' })).toBe(
      'Europe/London'
    );
    expect(exchangeTimeZone({ secType: 'FUT', exchange: 'cme' })).toBe('America/Chicago');
  });

  it('uses New York for FX, CFDs and crypto, which have no one exchange', () => {
    expect(exchangeTimeZone({ secType: 'CASH', currency: 'JPY' })).toBe('America/New_York');
    expect(exchangeTimeZone({ secType: 'CFD' })).toBe('America/New_York');
  });

  it("falls back to a stock's currency, then New York", () => {
    expect(exchangeTimeZone({ secType: 'STK', exchange: 'SMART', currency: 'AUD' })).toBe(
      'Australia/Sydney'
    );
    expect(exchangeTimeZone({ secType: 'STK', exchange: 'SMART', currency: 'USD' })).toBe(
      'America/New_York'
    );
    expect(exchangeTimeZone({})).toBe('America/New_York');
  });
});

describe('chartTimeZone', () => {
  const fx = { secType: 'CASH' };

  it('gives the zone for the choice', () => {
    expect(chartTimeZone('utc', fx, '1hour')).toBe('UTC');
    expect(chartTimeZone('exchange', fx, '1hour')).toBe('America/New_York');
    expect(chartTimeZone('local', fx, '1hour')).toBe('local');
  });

  it('keeps daily bars in UTC, because they are dated, not timed', () => {
    expect(chartTimeZone('exchange', fx, '1day')).toBe('UTC');
    expect(chartTimeZone('local', fx, '1day')).toBe('UTC');
  });

  it('knows its own choices', () => {
    expect(isChartZone('exchange')).toBe(true);
    expect(isChartZone('mars')).toBe(false);
  });
});

describe('formatChartTime', () => {
  it('shows the time in the zone, across a date change', () => {
    const t = at('2026-11-11T02:30:00Z');
    expect(formatChartTime(t, 'UTC')).toBe('11 Nov 2026 02:30');
    expect(formatChartTime(t, 'America/New_York')).toBe('10 Nov 2026 21:30');
    expect(formatChartTime(t, 'Australia/Sydney')).toBe('11 Nov 2026 13:30');
  });

  it('follows daylight saving', () => {
    // New York is UTC-4 in July and UTC-5 in January.
    expect(formatChartTime(at('2026-07-01T14:00:00Z'), 'America/New_York')).toBe(
      '1 Jul 2026 10:00'
    );
    expect(formatChartTime(at('2026-01-05T14:00:00Z'), 'America/New_York')).toBe(
      '5 Jan 2026 09:00'
    );
  });
});

describe('formatTick', () => {
  const NY = 'America/New_York';
  const DAY = 2;
  const TIME = 3;

  it('shows the time on an ordinary mark', () => {
    expect(formatTick(at('2026-11-11T15:00:00Z'), TIME, NY)).toBe('10:00');
    expect(formatTick(at('2026-11-11T15:00:05Z'), 4, NY)).toBe('10:00:05');
  });

  it('shows the time, not a date, on a day mark that is mid-day in the zone', () => {
    // The library's day mark sits at UTC midnight: 19:00 the day before in New York.
    expect(formatTick(at('2026-11-11T00:00:00Z'), DAY, NY)).toBe('19:00');
  });

  it("shows the date where the zone's own day starts", () => {
    // 05:00 UTC is midnight in New York in November.
    expect(formatTick(at('2026-11-11T05:00:00Z'), TIME, NY)).toBe('11 Nov');
    expect(formatTick(at('2026-11-11T05:00:00Z'), DAY, NY)).toBe('11');
    expect(formatTick(at('2026-12-01T05:00:00Z'), TIME, NY)).toBe('Dec');
    expect(formatTick(at('2027-01-01T05:00:00Z'), TIME, NY)).toBe('2027');
  });
});
