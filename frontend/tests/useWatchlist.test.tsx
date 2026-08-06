/**
 * Tests for useWatchlist — load/add/remove against `/api/watchlist`.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWatchlist } from '../app/lib/useWatchlist';

function mockFetchOk(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = fn as any;
  return fn;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWatchlist', () => {
  it('loads items on mount', async () => {
    mockFetchOk({ items: [{ id: 1, symbol: 'MSFT' }], count: 1 });
    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([{ id: 1, symbol: 'MSFT' }]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error when the load fails', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as any;
    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/500/);
  });

  it('add() posts the symbol and refreshes the list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, symbol: 'AAPL' }), { status: 201 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 1, symbol: 'AAPL' }], count: 1 }), {
          status: 200,
        })
      );
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.add({ symbol: 'AAPL' });
    });
    expect(ok).toBe(true);
    expect(result.current.items).toEqual([{ id: 1, symbol: 'AAPL' }]);

    const [, postCall] = fetchMock.mock.calls;
    expect(postCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(postCall[1].body)).toEqual({ symbol: 'AAPL' });
  });

  it('remove() deletes and drops the item from state optimistically', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 1, symbol: 'AAPL' }], count: 1 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.remove(1);
    });
    expect(ok).toBe(true);
    expect(result.current.items).toEqual([]);
  });
});
