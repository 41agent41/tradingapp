'use client';

import { useEffect } from 'react';
import type { IChartApi } from 'lightweight-charts';

/**
 * Keeps a lightweight-charts instance sized to its container.
 *
 * The pre-existing pattern wired only `window.addEventListener('resize')`,
 * which misses the cases that matter most in practice: a sibling panel
 * collapsing, a flex layout reflowing, the viewport rotating on mobile, or
 * the chart being remounted in a new container. ResizeObserver fires on
 * every one of those. We keep a `window.resize` fallback for browsers that
 * don't honour ResizeObserver inside detached subtrees.
 */
export function useChartResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  chartRef: React.MutableRefObject<IChartApi | null>,
  options: { observeHeight?: boolean } = {},
): void {
  const { observeHeight = false } = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fit = () => {
      const chart = chartRef.current;
      const el = containerRef.current;
      if (!chart || !el) return;
      const next: { width: number; height?: number } = { width: el.clientWidth };
      if (observeHeight) next.height = el.clientHeight;
      chart.applyOptions(next);
    };

    fit();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(fit);
      observer.observe(container);
    }

    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [containerRef, chartRef, observeHeight]);
}
