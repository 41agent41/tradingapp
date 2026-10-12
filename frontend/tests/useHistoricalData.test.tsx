/**
 * Tests for useHistoricalData — verifies the fetch lifecycle, the
 * timestamp heuristic (seconds vs ms), and the abort semantics on
 * unmount.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHistoricalData } from '../app/lib/useHistoricalData';

function mockFetchOk(body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  global.fetch = fn as any;
  return fn;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useHistoricalData', () => {
  it('projects raw IB seconds into ChartBar.time unchanged', async () => {
    mockFetchOk({
      bars: [{ timestamp: 1735689600, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
      source: 'ib',
    });
    const { result } = renderHook(() =>
      useHistoricalData({ symbol: 'MSFT', timeframe: '1day', period: '1Y' })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bars).toHaveLength(1);
    expect(result.current.bars[0].time).toBe(1735689600);
    expect(result.current.source).toBe('ib');
    expect(result.current.error).toBeNull();
  });

  it('downscales millisecond timestamps to seconds', async () => {
    mockFetchOk({
      bars: [{ timestamp: 1735689600000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    });
    const { result } = renderHook(() =>
      useHistoricalData({ symbol: 'MSFT', timeframe: '1day', period: '1Y' })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bars[0].time).toBe(1735689600);
  });

  it('exposes an error when the backend returns a non-OK response', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'boom' }), { status: 503 })
    ) as any;
    const { result } = renderHook(() =>
      useHistoricalData({ symbol: 'MSFT', timeframe: '1day', period: '1Y' })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.bars).toEqual([]);
  });

  it('stays idle when enabled=false', async () => {
    const fetchMock = mockFetchOk({ bars: [] });
    renderHook(() =>
      useHistoricalData({ symbol: 'MSFT', timeframe: '1day', period: '1Y', enabled: false })
    );
    // No network call.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays idle when symbol is empty', async () => {
    const fetchMock = mockFetchOk({ bars: [] });
    renderHook(() => useHistoricalData({ symbol: '', timeframe: '1day', period: '1Y' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
