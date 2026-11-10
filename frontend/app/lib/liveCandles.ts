/**
 * Live candles from the tick stream (E-20): each tick moves the last candle,
 * or starts a new one when its time falls in the next bucket.
 *
 * Ticks arrive one tick type at a time (BID, ASK, LAST, sizes). The candle
 * follows LAST when the feed sends trades; a feed with quotes only (FX on IB)
 * follows the mid of the latest bid and ask. Volume is not built here: tick
 * sizes from polled brokers are not trade volume.
 */
import type { ChartBar } from '../components/Chart';
import type { TickPayload } from './useRealtimeStream';

/** Seconds per bucket for each chart timeframe; null where ticks cannot build one. */
const TIMEFRAME_SECONDS: Record<string, number> = {
  '1min': 60,
  '5min': 300,
  '15min': 900,
  '30min': 1800,
  '1hour': 3600,
  '4hour': 14400,
  '8hour': 28800,
  '1day': 86400,
};

export function timeframeSeconds(timeframe: string): number | null {
  return TIMEFRAME_SECONDS[timeframe] ?? null;
}

/** The start of the UTC bucket holding `time` (unix seconds). */
export function bucketStart(time: number, seconds: number): number {
  return Math.floor(time / seconds) * seconds;
}

export interface LiveState {
  /** The candle being formed, or null before the first priced tick. */
  bar: ChartBar | null;
  bid: number | null;
  ask: number | null;
  /** True once a LAST tick has been seen: the candle then follows trades. */
  hasTrades: boolean;
}

export const EMPTY_LIVE: LiveState = { bar: null, bid: null, ask: null, hasTrades: false };

/**
 * The state after `tick`. `last` is the last history bar, which a tick in the
 * same bucket extends (so the live candle continues the stored one rather
 * than restarting it). Ticks older than the current candle are ignored.
 */
export function applyTick(
  state: LiveState,
  tick: TickPayload,
  timeframe: string,
  last: ChartBar | null
): LiveState {
  const seconds = timeframeSeconds(timeframe);
  const value = tick.price ?? tick.value;
  if (seconds === null || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return state;
  }
  const next: LiveState = { ...state };
  let price: number | null = null;
  if (tick.tick_type === 'LAST') {
    next.hasTrades = true;
    price = value;
  } else if (tick.tick_type === 'BID' || tick.tick_type === 'ASK') {
    if (tick.tick_type === 'BID') next.bid = value;
    else next.ask = value;
    if (!next.hasTrades && next.bid !== null && next.ask !== null) {
      price = (next.bid + next.ask) / 2;
    }
  }
  if (price === null) return next;

  const time = bucketStart(tick.timestamp, seconds);
  const current = state.bar ?? (last && last.time === time ? last : null);
  if (state.bar && time < state.bar.time) return next;
  if (last && time < last.time) return next;

  next.bar =
    current && current.time === time
      ? {
          ...current,
          high: Math.max(current.high, price),
          low: Math.min(current.low, price),
          close: price,
        }
      : { time, open: price, high: price, low: price, close: price, volume: 0 };
  return next;
}
