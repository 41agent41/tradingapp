/** Loading older bars on scroll-back (E-23): the range asked for and the merge. */
import { describe, expect, it } from 'vitest';

import { olderRange, prependOlder } from '../app/lib/olderBars';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('olderRange', () => {
  it('asks for as long a range as is loaded, ending the day after the first bar', () => {
    expect(olderRange(at('2026-08-11T09:00:00Z'), at('2026-11-11T09:00:00Z'))).toEqual({
      start_date: '2026-05-11',
      end_date: '2026-08-12',
    });
  });

  it('asks for a week at least, so a weekend is not taken for the end', () => {
    expect(olderRange(at('2026-11-09T00:00:00Z'), at('2026-11-09T06:00:00Z'))).toEqual({
      start_date: '2026-11-02',
      end_date: '2026-11-10',
    });
  });

  it('asks for a year at most', () => {
    const range = olderRange(at('2024-01-01T00:00:00Z'), at('2026-11-11T00:00:00Z'));
    expect(range).toEqual({ start_date: '2023-01-01', end_date: '2024-01-02' });
  });
});

describe('prependOlder', () => {
  const bars = [{ time: 300 }, { time: 400 }];

  it('puts strictly older bars in front, oldest first, once each', () => {
    const merged = prependOlder(bars, [
      { time: 200 },
      { time: 100 },
      { time: 200 },
      { time: 300 },
      { time: 350 },
    ]);
    expect(merged.map((b) => b.time)).toEqual([100, 200, 300, 400]);
  });

  it('returns the same bars when nothing is older', () => {
    expect(prependOlder(bars, [{ time: 300 }, { time: 400 }])).toBe(bars);
    expect(prependOlder(bars, [])).toBe(bars);
  });

  it('leaves an empty chart alone', () => {
    const empty: Array<{ time: number }> = [];
    expect(prependOlder(empty, [{ time: 1 }])).toBe(empty);
  });
});
