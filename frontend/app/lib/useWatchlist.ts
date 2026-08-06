'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

export interface WatchlistItem {
  id: number;
  broker: string;
  symbol: string;
  sec_type: string;
  exchange: string;
  currency: string;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export interface AddWatchlistInput {
  symbol: string;
  broker?: string;
  sec_type?: string;
  exchange?: string;
  currency?: string;
  notes?: string;
}

export interface UseWatchlistResult {
  items: WatchlistItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: AddWatchlistInput) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
}

/** Owns the `/api/watchlist` data flow: load, add, remove. */
export function useWatchlist(): UseWatchlistResult {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/watchlist');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { items: WatchlistItem[] };
      setItems(body.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load watchlist');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (input: AddWatchlistInput) => {
      try {
        const res = await apiFetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        }
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to add symbol');
        return false;
      }
    },
    [refresh]
  );

  const remove = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/watchlist/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove symbol');
      return false;
    }
  }, []);

  return { items, loading, error, refresh, add, remove };
}
