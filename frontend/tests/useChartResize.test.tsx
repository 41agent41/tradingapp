/**
 * Unit tests for `useChartResize`.
 *
 * Verifies the hook calls `chart.applyOptions({ width })` whenever the
 * container's ResizeObserver fires, and that it tears down both the
 * observer and the window listener on unmount.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';

import { useChartResize } from '../app/lib/useChartResize';

class FakeResizeObserver {
  static lastInstance: FakeResizeObserver | null = null;
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    FakeResizeObserver.lastInstance = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  fire() {
    this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

describe('useChartResize', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.lastInstance = null;
  });

  it('observes the container and re-fits on ResizeObserver fire', () => {
    const applyOptions = vi.fn();
    const chartFake: Partial<IChartApi> = { applyOptions };

    const containerEl = document.createElement('div');
    Object.defineProperty(containerEl, 'clientWidth', { value: 640, configurable: true });

    const { rerender } = renderHook(() => {
      const containerRef = useRef<HTMLDivElement | null>(containerEl);
      const chartRef = useRef<IChartApi | null>(chartFake as IChartApi);
      useChartResize(containerRef, chartRef);
      return null;
    });

    expect(applyOptions).toHaveBeenCalledWith({ width: 640 });

    Object.defineProperty(containerEl, 'clientWidth', { value: 900, configurable: true });
    FakeResizeObserver.lastInstance?.fire();
    expect(applyOptions).toHaveBeenLastCalledWith({ width: 900 });

    rerender();
  });

  it('tears down observer and listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const containerEl = document.createElement('div');
    Object.defineProperty(containerEl, 'clientWidth', { value: 100, configurable: true });

    const chartFake: Partial<IChartApi> = { applyOptions: vi.fn() };

    const { unmount } = renderHook(() => {
      const containerRef = useRef<HTMLDivElement | null>(containerEl);
      const chartRef = useRef<IChartApi | null>(chartFake as IChartApi);
      useChartResize(containerRef, chartRef);
      return null;
    });

    unmount();
    expect(FakeResizeObserver.lastInstance?.disconnected).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('honours observeHeight when set', () => {
    const applyOptions = vi.fn();
    const chartFake: Partial<IChartApi> = { applyOptions };
    const containerEl = document.createElement('div');
    Object.defineProperty(containerEl, 'clientWidth', { value: 320, configurable: true });
    Object.defineProperty(containerEl, 'clientHeight', { value: 240, configurable: true });

    renderHook(() => {
      const containerRef = useRef<HTMLDivElement | null>(containerEl);
      const chartRef = useRef<IChartApi | null>(chartFake as IChartApi);
      useChartResize(containerRef, chartRef, { observeHeight: true });
      return null;
    });

    expect(applyOptions).toHaveBeenCalledWith({ width: 320, height: 240 });
  });
});
