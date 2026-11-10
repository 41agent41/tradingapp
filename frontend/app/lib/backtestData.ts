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
