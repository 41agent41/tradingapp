/**
 * Loading older bars when a chart is scrolled back to its first bar (E-23).
 */

const DAY_SECONDS = 86_400;
/** A week at least, so a weekend or holiday never looks like the end. */
const MIN_DAYS = 7;
const MAX_DAYS = 365;

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * The date range to ask for before `earliest`: as long as the range already
 * loaded, between a week and a year. The history API takes whole dates, so
 * the range ends on the day after the earliest bar and overlaps it;
 * {@link prependOlder} drops the overlap.
 */
export function olderRange(
  earliest: number,
  latest: number
): { start_date: string; end_date: string } {
  const loadedDays = Math.ceil(Math.max(0, latest - earliest) / DAY_SECONDS);
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, loadedDays));
  return {
    start_date: isoDate(earliest - days * DAY_SECONDS),
    end_date: isoDate(earliest + DAY_SECONDS),
  };
}

/**
 * `older` bars put in front of `bars`, oldest first, keeping only those
 * before the first bar already there. Returns `bars` itself when nothing is
 * older, which is how the caller knows the history has run out.
 */
export function prependOlder<T extends { time: unknown }>(bars: T[], older: T[]): T[] {
  if (!bars.length) return bars;
  const first = Number(bars[0].time);
  const seen = new Set<number>();
  const fresh = older
    .filter((bar) => {
      const time = Number(bar.time);
      if (!Number.isFinite(time) || time >= first || seen.has(time)) return false;
      seen.add(time);
      return true;
    })
    .sort((a, b) => Number(a.time) - Number(b.time));
  return fresh.length ? [...fresh, ...bars] : bars;
}
