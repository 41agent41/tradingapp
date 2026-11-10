/**
 * Live candles (E-20) and the live chart's address (E-21).
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_LIVE, applyTick, bucketStart, timeframeSeconds } from '../app/lib/liveCandles';
import { instrumentFromParams, paramsFromInstrument } from '../app/lib/liveInstrument';
import type { TickPayload } from '../app/lib/useRealtimeStream';

const T0 = 1_700_000_040; // 00:54 past a whole hour, so 1min buckets are clear

function tick(type: string, price: number, timestamp: number): TickPayload {
  return {
    symbol: 'EURUSD',
    type: 'tick',
    tick_type: type,
    tick_type_code: 0,
    price,
    size: null,
    value: price,
    timestamp,
  };
}

describe('liveCandles', () => {
  it('buckets by timeframe and knows which timeframes ticks can build', () => {
    expect(timeframeSeconds('5min')).toBe(300);
    expect(timeframeSeconds('tick')).toBeNull();
    expect(bucketStart(T0 + 59.9, 60)).toBe(T0);
  });

  it('extends the last stored bar, then starts the next one', () => {
    const last = { time: T0, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 7 };
    let s = applyTick(EMPTY_LIVE, tick('LAST', 1.25, T0 + 10), '1min', last);
    expect(s.bar).toEqual({ ...last, high: 1.25, close: 1.25 });
    s = applyTick(s, tick('LAST', 0.95, T0 + 20), '1min', last);
    expect(s.bar).toMatchObject({ open: 1.1, high: 1.25, low: 0.95, close: 0.95, volume: 7 });
    s = applyTick(s, tick('LAST', 1.3, T0 + 61), '1min', last);
    expect(s.bar).toEqual({
      time: T0 + 60,
      open: 1.3,
      high: 1.3,
      low: 1.3,
      close: 1.3,
      volume: 0,
    });
  });

  it('follows the mid of bid and ask until a trade is seen', () => {
    let s = applyTick(EMPTY_LIVE, tick('BID', 1.1, T0), '1min', null);
    expect(s.bar).toBeNull();
    s = applyTick(s, tick('ASK', 1.2, T0 + 1), '1min', null);
    expect(s.bar?.close).toBeCloseTo(1.15);
    s = applyTick(s, tick('LAST', 1.18, T0 + 2), '1min', null);
    expect(s.bar?.close).toBe(1.18);
    s = applyTick(s, tick('BID', 1.0, T0 + 3), '1min', null);
    expect(s.bar?.close).toBe(1.18);
  });

  it('ignores stale ticks, bad prices and timeframes it cannot build', () => {
    const last = { time: T0 + 60, open: 1, high: 1, low: 1, close: 1 };
    expect(applyTick(EMPTY_LIVE, tick('LAST', 2, T0), '1min', last).bar).toBeNull();
    expect(applyTick(EMPTY_LIVE, tick('LAST', NaN, T0), '1min', null)).toBe(EMPTY_LIVE);
    expect(applyTick(EMPTY_LIVE, tick('LAST', 2, T0), 'tick', null)).toBe(EMPTY_LIVE);
  });
});

describe('live chart address', () => {
  it('round-trips an instrument, leaving defaults out', () => {
    const i = {
      symbol: 'EURUSD',
      source: 'oanda',
      account: 'practice',
      secType: 'CASH',
      exchange: '',
      currency: 'USD',
    };
    const query = paramsFromInstrument(i);
    expect(query).toBe('symbol=EURUSD&source=oanda&account=practice&secType=CASH&currency=USD');
    expect(instrumentFromParams(new URLSearchParams(query))).toEqual(i);
    expect(instrumentFromParams(new URLSearchParams(''))).toMatchObject({
      symbol: 'MSFT',
      secType: 'STK',
    });
  });
});
