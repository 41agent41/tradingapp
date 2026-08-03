/**
 * Tests for useContractSearch — the data hook behind the home-page market
 * data filter (extracted from MarketDataFilter during the §3.4 split).
 * Covers the basic/advanced search dispatch, the empty-symbol validation,
 * search-history capture, per-contract quote fetch, and reset.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useContractSearch } from '../app/lib/useContractSearch';

const HEALTH = '/api/health';
const SEARCH = '/api/market-data/search';
const ADVANCED = '/api/market-data/advanced-search';
const REALTIME = '/api/market-data/realtime';

/** Route the mocked fetch by URL substring. Unmatched URLs 404. */
function routeFetch(routes: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    const match = Object.keys(routes).find((key) => String(url).includes(key));
    if (!match) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  });
  global.fetch = fn as any;
  return fn;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => vi.restoreAllMocks());

const basicParams = {
  symbol: 'AAPL',
  secType: 'STK',
  exchange: 'SMART',
  currency: 'USD',
  searchByName: false,
};

describe('useContractSearch', () => {
  it('probes /api/health on mount and reports the connection status', async () => {
    routeFetch({ [HEALTH]: { status: 'ok' } });
    const { result } = renderHook(() => useContractSearch('paper'));
    await waitFor(() => expect(result.current.connectionStatus).toBe('Connected'));
  });

  it('runs a basic search and records it in the history', async () => {
    const fetchMock = routeFetch({
      [HEALTH]: { ok: true },
      [SEARCH]: { results: [{ conid: '1', symbol: 'AAPL', companyName: 'Apple', secType: 'STK' }] },
    });
    const { result } = renderHook(() => useContractSearch('paper'));

    await act(async () => {
      await result.current.search(basicParams);
    });

    expect(result.current.searchResults).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.searchHistory).toEqual(['AAPL']);
    // The basic endpoint (not the advanced one) was hit.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes(SEARCH))).toBe(true);
    expect(calledUrls.some((u) => u.includes(ADVANCED))).toBe(false);
  });

  it('rejects a basic search with an empty symbol without hitting the API', async () => {
    const fetchMock = routeFetch({ [HEALTH]: { ok: true } });
    const { result } = renderHook(() => useContractSearch('paper'));

    await act(async () => {
      await result.current.search({ ...basicParams, symbol: '   ' });
    });

    expect(result.current.error).toBe('Please enter a symbol to search');
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes(SEARCH))).toBe(false);
  });

  it('allows an empty symbol for advanced search and hits the advanced endpoint', async () => {
    const fetchMock = routeFetch({
      [HEALTH]: { ok: true },
      [ADVANCED]: {
        results: [{ conid: '9', symbol: 'ES', companyName: 'E-mini', secType: 'FUT' }],
      },
    });
    const { result } = renderHook(() => useContractSearch('paper'));

    await act(async () => {
      await result.current.search({
        ...basicParams,
        symbol: '',
        advanced: { expiry: '', strike: '', right: '', multiplier: '', includeExpired: false },
      });
    });

    expect(result.current.searchResults).toHaveLength(1);
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes(ADVANCED))).toBe(true);
  });

  it('selectContract fetches the quote and reset clears results', async () => {
    routeFetch({
      [HEALTH]: { ok: true },
      [SEARCH]: { results: [{ conid: '1', symbol: 'AAPL', companyName: 'Apple', secType: 'STK' }] },
      [REALTIME]: { symbol: 'AAPL', last: 123.45 },
    });
    const { result } = renderHook(() => useContractSearch('paper'));

    await act(async () => {
      await result.current.search(basicParams);
    });
    await act(async () => {
      await result.current.selectContract(result.current.searchResults[0]);
    });

    expect(result.current.selectedContract?.symbol).toBe('AAPL');
    expect(result.current.marketData?.last).toBe(123.45);

    act(() => result.current.reset());
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.selectedContract).toBeNull();
    expect(result.current.marketData).toBeNull();
  });
});
