/**
 * The bars a backtest ran on, as the backend reports them (`BacktestRunData`
 * in backend/src/services/backtestRunRepository.ts).
 */

export interface RunData {
  source: 'stored' | 'broker';
  bars?: number | null;
  first_bar?: string | null;
  last_bar?: string | null;
  hash?: string | null;
  complete?: boolean | null;
  /** Set when the bars were built from stored 1-minute bars. */
  built_from?: '1min' | null;
  /** How many bars carried the broker's spread. */
  spread_bars?: number | null;
  /** True when the bars' broker reports a spread with its bars. */
  spread_source?: boolean;
}

/** One line on the bars a run used, for the results header. */
export function describeRunData(data: RunData | null | undefined): string | null {
  if (!data) return null;
  if (data.source !== 'stored') return 'Bars fetched from the broker for this run (not stored).';
  const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '?');
  return (
    `${data.built_from ? 'Bars built from stored 1 minute bars' : 'Stored bars'}, ${day(data.first_bar)} to ${day(data.last_bar)}` +
    (data.complete === false ? ' (the range is not fully covered)' : '') +
    (data.hash ? `. Data hash ${data.hash.slice(0, 12)}` : '')
  );
}

/** How a run filled its protective stop (`results.fills` from the engine). */
export interface RunFills {
  stop?: boolean;
  model?: '1min' | 'bar';
  bars?: number;
  bars_with_minutes?: number;
  stop_exits?: number;
  entries_refused?: number;
}

/** One line on how stops were filled; null for a strategy without a stop. */
export function describeFills(fills: RunFills | null | undefined): string | null {
  if (!fills?.stop) return null;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const exits = fills.stop_exits ?? 0;
  const refused = fills.entries_refused ?? 0;
  return (
    (fills.model === '1min'
      ? `Stops filled along stored 1 minute bars (${fills.bars_with_minutes ?? 0} of ${fills.bars ?? 0} bars had them)`
      : "Stops filled on each bar's own range (no 1 minute bars are stored for this range)") +
    `. ${count(exits, 'trade', 'trades')} closed on the stop` +
    (refused
      ? `. ${count(refused, 'entry was', 'entries were')} refused because the stop could not be set`
      : '') +
    '.'
  );
}

/** What the spread cost a run (`results.spread` from the engine). */
export interface RunSpread {
  applied?: boolean;
  bars?: number;
  bars_with_spread?: number;
  fills?: number;
  cost?: number;
  average?: number;
}

/** One line on what the spread cost; null when no bar carried a spread. */
export function describeSpread(spread: RunSpread | null | undefined): string | null {
  if (!spread?.applied) return null;
  const cost = (spread.cost ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const withSpread = spread.bars_with_spread ?? 0;
  const bars = spread.bars ?? 0;
  return (
    `Buys filled at the ask and sells at the bid, using the broker's spread on each bar. ` +
    `The spread cost ${cost} over ${spread.fills ?? 0} ${spread.fills === 1 ? 'fill' : 'fills'}` +
    (withSpread < bars
      ? `. ${withSpread} of ${bars} bars carried a spread; the rest filled at the bar's own price`
      : '') +
    '.'
  );
}

/**
 * Whether a run's bars could gain spreads by downloading the range again:
 * their broker reports one, and some of the stored bars have none (they were
 * stored before spreads were kept).
 */
export function spreadsMissing(data: RunData | null | undefined): boolean {
  if (!data || data.source !== 'stored' || !data.spread_source) return false;
  return (data.spread_bars ?? 0) < (data.bars ?? 0);
}
