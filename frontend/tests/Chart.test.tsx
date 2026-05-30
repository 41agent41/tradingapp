/**
 * Tests for the shared <Chart> primitive.
 *
 * Covers the pure helper (sortAndDedupe) that owns the strict-time-order
 * invariant lightweight-charts requires. The component itself is exercised
 * with a tiny smoke render — jsdom can't paint a canvas, so we only verify
 * the wrapper element is in the document.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Chart, { __test, type ChartBar } from '../app/components/Chart';

const { sortAndDedupe } = __test;

describe('sortAndDedupe', () => {
  it('orders rows by time ascending', () => {
    const out = sortAndDedupe([
      { time: 3 as any, x: 'c' },
      { time: 1 as any, x: 'a' },
      { time: 2 as any, x: 'b' },
    ]);
    expect(out.map((r) => r.x)).toEqual(['a', 'b', 'c']);
  });

  it('drops duplicates by time, keeping the first occurrence in sorted order', () => {
    const out = sortAndDedupe([
      { time: 1 as any, x: 'a' },
      { time: 1 as any, x: 'a2' },
      { time: 2 as any, x: 'b' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].x).toBe('a');
  });

  it('drops rows missing a numeric time', () => {
    const out = sortAndDedupe([
      { time: NaN as any, x: 'bad' },
      { time: 1 as any, x: 'good' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe('good');
  });
});

describe('<Chart> smoke render', () => {
  it('renders a labelled container without throwing', () => {
    const bars: ChartBar[] = [
      { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ];
    const { getByLabelText } = render(<Chart data={bars} />);
    expect(getByLabelText('Chart')).toBeInTheDocument();
  });
});
