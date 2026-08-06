/**
 * Tests for usePriceAlerts — load/add/trigger/dismiss/remove against
 * `/api/alerts`.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePriceAlerts } from '../app/lib/usePriceAlerts';

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePriceAlerts', () => {
  it('loads alerts scoped to a watchlist item', async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ alerts: [{ id: 1, status: 'active' }] }), { status: 200 })
    );
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePriceAlerts({ watchlistItemId: 5 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.alerts).toEqual([{ id: 1, status: 'active' }]);

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('watchlist_item_id=5');
  });

  it('add() posts the alert and refreshes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ alerts: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, status: 'active' }), { status: 201 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ alerts: [{ id: 1, status: 'active' }] }), { status: 200 })
      );
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePriceAlerts({ watchlistItemId: 5 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.add({
        watchlist_item_id: 5,
        condition: 'above',
        target_price: 210,
      });
    });
    expect(ok).toBe(true);
    expect(result.current.alerts).toEqual([{ id: 1, status: 'active' }]);

    const [, postCall] = fetchMock.mock.calls;
    expect(postCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(postCall[1].body)).toEqual({
      watchlist_item_id: 5,
      condition: 'above',
      target_price: 210,
    });
  });

  it('trigger() posts triggered_price and updates the row in place', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ alerts: [{ id: 1, status: 'active' }] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, status: 'triggered', triggered_price: '211' }), {
          status: 200,
        })
      );
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePriceAlerts({ watchlistItemId: 5 }));
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    let row: any = null;
    await act(async () => {
      row = await result.current.trigger(1, 211);
    });
    expect(row?.status).toBe('triggered');
    expect(result.current.alerts[0].status).toBe('triggered');

    const [, triggerCall] = fetchMock.mock.calls;
    expect(triggerCall[0]).toContain('/api/alerts/1/trigger');
    expect(JSON.parse(triggerCall[1].body)).toEqual({ triggered_price: 211 });
  });

  it('dismiss() removes the alert from the current (status-filtered) list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ alerts: [{ id: 1, status: 'triggered' }] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, status: 'dismissed' }), { status: 200 })
      );
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePriceAlerts({ status: 'triggered' }));
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.dismiss(1);
    });
    expect(ok).toBe(true);
    expect(result.current.alerts).toEqual([]);
  });

  it('remove() deletes and drops the item from state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ alerts: [{ id: 1, status: 'active' }] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePriceAlerts({ watchlistItemId: 5 }));
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.remove(1);
    });
    expect(ok).toBe(true);
    expect(result.current.alerts).toEqual([]);
  });
});
