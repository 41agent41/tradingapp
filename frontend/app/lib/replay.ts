/**
 * Bar replay (E-04): stored 1-minute bars played back one at a time, forming
 * the candles of a longer timeframe as they would have formed.
 *
 * The replay's position is a cursor: how many 1-minute bars have been shown.
 * Everything drawn follows from the cursor alone, so play, step, seek and
 * rewind are all the same operation, and a replay never shows a bar from
 * after its clock.
 */
import type { ChartBar } from '../components/Chart';

/** Bars as the backend sends them: one array per field, oldest first. */
export interface BarColumns {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v?: number[];
}

/** `GET /api/market-data/replay`. */
export interface ReplayResponse {
  contract_id: number;
  timeframe: string;
  start: string;
  history: BarColumns;
  minutes: BarColumns;
  more: boolean;
  stored: { first: string | null; last: string | null };
}

/** Timeframes a replay can show, and the seconds in one bar of each. */
export const REPLAY_TIMEFRAMES: Array<{ value: string; label: string; seconds: number }> = [
  { value: '1min', label: '1 minute', seconds: 60 },
  { value: '5min', label: '5 minutes', seconds: 300 },
  { value: '15min', label: '15 minutes', seconds: 900 },
  { value: '30min', label: '30 minutes', seconds: 1800 },
  { value: '1hour', label: '1 hour', seconds: 3600 },
  { value: '4hour', label: '4 hours', seconds: 14_400 },
  { value: '1day', label: '1 day', seconds: 86_400 },
];

/** 1x plays one minute of market each second. */
export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 100];

export function replaySeconds(timeframe: string): number {
  return REPLAY_TIMEFRAMES.find((t) => t.value === timeframe)?.seconds ?? 300;
}

export function columnsToBars(c: BarColumns | null | undefined): ChartBar[] {
  if (!c?.t) return [];
  return c.t.map((time, i) => ({
    time,
    open: c.o[i],
    high: c.h[i],
    low: c.l[i],
    close: c.c[i],
    volume: c.v?.[i] ?? 0,
  }));
}

/** A replay's minutes, grouped once into the bars they form. */
export interface PreparedReplay {
  minutes: ChartBar[];
  seconds: number;
  /** Every bar of the timeframe, complete. */
  bars: ChartBar[];
  /** For each bar, the index of its first minute; one extra entry at the end. */
  starts: number[];
  /** For each minute, the index of the bar it belongs to. */
  barOf: number[];
}

function merge(into: ChartBar, m: ChartBar): void {
  into.high = Math.max(into.high, m.high);
  into.low = Math.min(into.low, m.low);
  into.close = m.close;
  into.volume = (into.volume ?? 0) + (m.volume ?? 0);
}

/** Groups minutes into bars that start on UTC multiples of `seconds`. */
export function prepareReplay(minutes: ChartBar[], seconds: number): PreparedReplay {
  const bars: ChartBar[] = [];
  const starts: number[] = [];
  const barOf: number[] = [];
  minutes.forEach((m, i) => {
    const time = Math.floor(m.time / seconds) * seconds;
    const last = bars[bars.length - 1];
    if (last && last.time === time) {
      merge(last, m);
    } else {
      bars.push({ ...m, time, volume: m.volume ?? 0 });
      starts.push(i);
    }
    barOf.push(bars.length - 1);
  });
  starts.push(minutes.length);
  return { minutes, seconds, bars, starts, barOf };
}

export interface ReplayFrame {
  /** How many of `bars` are complete and behind the forming one. */
  done: number;
  /** The candle as it stood at the cursor; null before the first minute. */
  forming: ChartBar | null;
  /** The replay's "now": the end of the last minute shown, unix seconds. */
  clock: number | null;
}

/** What the chart shows once `cursor` minutes have played. */
export function frameAt(p: PreparedReplay, cursor: number): ReplayFrame {
  const n = Math.max(0, Math.min(p.minutes.length, Math.floor(cursor)));
  if (n === 0) return { done: 0, forming: null, clock: null };
  const bar = p.barOf[n - 1];
  const first = p.starts[bar];
  const forming: ChartBar = { ...p.minutes[first], time: p.bars[bar].time };
  forming.volume = forming.volume ?? 0;
  for (let i = first + 1; i < n; i++) merge(forming, p.minutes[i]);
  return { done: bar, forming, clock: p.minutes[n - 1].time + 60 };
}

/** The cursor that completes the bar now forming, or the next one when the
 *  forming bar is already complete. */
export function nextBarCursor(p: PreparedReplay, cursor: number): number {
  const n = Math.max(0, Math.min(p.minutes.length, Math.floor(cursor)));
  if (n >= p.minutes.length) return p.minutes.length;
  // The minute about to play belongs to this bar; go to that bar's end.
  return p.starts[p.barOf[n] + 1];
}

/** The cursor at the end of the bar before the one now forming. */
export function previousBarCursor(p: PreparedReplay, cursor: number): number {
  const n = Math.max(0, Math.min(p.minutes.length, Math.floor(cursor)));
  if (n === 0) return 0;
  return p.starts[p.barOf[n - 1]];
}

/** `2026-01-05 08:00` for a unix time, in UTC. */
export function formatClock(seconds: number | null): string {
  if (seconds === null) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** A trade from a backtest of the same bars (`results.trades_summary`). */
export interface ReplayTrade {
  entry_time: string;
  exit_time: string | null;
  entry_price: number;
  exit_price: number | null;
  order_type: string;
  pnl: number;
  exit_reason: string | null;
}

export interface ReplayMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text: string;
}

/** Backtest times are UTC without a zone; read them as UTC. */
function utcSeconds(iso: string): number {
  const zoned = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  return Math.floor(Date.parse(zoned) / 1000);
}

/**
 * The entries and exits a strategy had made by the replay's clock. A rule
 * decides at the close of its bar, so its marker appears when that bar has
 * finished playing, on that bar. A stop fills inside a bar, and shows once
 * the minute it filled on has played.
 */
export function tradeMarkers(
  trades: ReplayTrade[],
  seconds: number,
  clock: number | null
): ReplayMarker[] {
  if (clock === null) return [];
  const bar = (t: number) => Math.floor(t / seconds) * seconds;
  const markers: ReplayMarker[] = [];
  for (const t of trades) {
    const entry = utcSeconds(t.entry_time);
    if (!Number.isFinite(entry) || bar(entry) + seconds > clock) continue;
    const short = t.order_type.toUpperCase() === 'SELL';
    markers.push({
      time: bar(entry),
      position: short ? 'aboveBar' : 'belowBar',
      shape: short ? 'arrowDown' : 'arrowUp',
      color: short ? '#dc2626' : '#16a34a',
      text: `${short ? 'Short' : 'Buy'} ${t.entry_price}`,
    });
    if (!t.exit_time || t.exit_price === null) continue;
    const exit = utcSeconds(t.exit_time);
    const stopped = (t.exit_reason ?? '').startsWith('Stop');
    const known = stopped ? exit + 60 : bar(exit) + seconds;
    if (!Number.isFinite(exit) || known > clock) continue;
    markers.push({
      time: bar(exit),
      position: short ? 'belowBar' : 'aboveBar',
      shape: 'circle',
      color: t.pnl >= 0 ? '#16a34a' : '#dc2626',
      text: `${stopped ? 'Stop' : 'Exit'} ${t.exit_price}`,
    });
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** What the replay page's address names. `start` is `YYYY-MM-DDTHH:mm`, UTC. */
export interface ReplayTarget {
  symbol: string;
  source: string;
  account: string;
  secType: string;
  timeframe: string;
  start: string;
}

/** The query of `GET /api/market-data/replay` for a target. */
export function replayRequest(t: ReplayTarget): string {
  const p = new URLSearchParams({
    symbol: t.symbol,
    timeframe: t.timeframe,
    // The page's start has no zone and means UTC.
    start: /[zZ]$/.test(t.start)
      ? t.start
      : `${t.start.length === 16 ? `${t.start}:00` : t.start}Z`,
  });
  if (t.source) p.set('source', t.source);
  if (t.account) p.set('account', t.account);
  if (t.secType) p.set('secType', t.secType);
  return p.toString();
}

const DAY = 86_400;
/** Bars a strategy is given before the replay starts, to warm its indicators. */
const WARMUP_BARS = 300;

/**
 * The backtest that finds a saved strategy's trades over a replay's bars
 * (`POST /api/backtesting/run`). It starts early enough to warm the
 * indicators up before the replay's first bar, runs on whatever is stored,
 * and uses the replay's own candle size so its trades land on the candles.
 */
export function signalsRequest(
  t: ReplayTarget,
  replay: ReplayResponse,
  definitionId: number
): Record<string, unknown> {
  const seconds = replaySeconds(replay.timeframe);
  const first = Math.floor(Date.parse(replay.start) / 1000);
  const minutes = replay.minutes.t;
  const last = minutes.length ? minutes[minutes.length - 1] : first;
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  const warmup = Math.max(7 * DAY, WARMUP_BARS * seconds);
  return {
    definition_id: definitionId,
    symbol: t.symbol,
    timeframe: replay.timeframe,
    ...(t.source ? { source: t.source } : {}),
    ...(t.account ? { account: t.account } : {}),
    ...(t.secType ? { sec_type: t.secType } : {}),
    start_date: day(first - warmup),
    // End dates are exclusive: the day after the last minute.
    end_date: day((Math.floor(last / DAY) + 1) * DAY),
    on_missing: 'use_stored',
    // A look at a few days is not a result to keep beside real backtests.
    save: false,
  };
}
