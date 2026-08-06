'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

export type AlertCondition = 'above' | 'below';
export type AlertStatus = 'active' | 'triggered' | 'dismissed';

export interface PriceAlert {
  id: number;
  watchlist_item_id: number;
  condition: AlertCondition;
  target_price: string;
  status: AlertStatus;
  triggered_at: string | null;
  triggered_price: string | null;
  created_at: string;
}

export interface PriceAlertFilter {
  watchlistItemId?: number;
  status?: AlertStatus;
}

export interface AddAlertInput {
  watchlist_item_id: number;
  condition: AlertCondition;
  target_price: number;
}

export interface UsePriceAlertsResult {
  alerts: PriceAlert[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: AddAlertInput) => Promise<boolean>;
  /** Flip an active alert to 'triggered'. Returns the updated row, or null
   *  if the call failed (already triggered elsewhere is not a failure —
   *  the backend returns the current row with 200 in that case). */
  trigger: (id: number, triggeredPrice: number) => Promise<PriceAlert | null>;
  dismiss: (id: number) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
}

/**
 * Owns the `/api/alerts` data flow for in-app-only price alerts. There is
 * no server-side price watcher: callers evaluate `condition`/
 * `target_price` against a quote they already have (e.g. the watchlist
 * row's polled realtime price) and call `trigger` themselves.
 */
export function usePriceAlerts(filter: PriceAlertFilter = {}): UsePriceAlertsResult {
  const { watchlistItemId, status } = filter;
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (watchlistItemId != null) qs.set('watchlist_item_id', String(watchlistItemId));
      if (status) qs.set('status', status);
      const res = await apiFetch(`/api/alerts?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { alerts: PriceAlert[] };
      setAlerts(body.alerts ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, [watchlistItemId, status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (input: AddAlertInput) => {
      try {
        const res = await apiFetch('/api/alerts', {
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
        setError(e instanceof Error ? e.message : 'Failed to add alert');
        return false;
      }
    },
    [refresh]
  );

  const trigger = useCallback(async (id: number, triggeredPrice: number) => {
    try {
      const res = await apiFetch(`/api/alerts/${id}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggered_price: triggeredPrice }),
      });
      if (!res.ok) return null;
      const row = (await res.json()) as PriceAlert;
      setAlerts((prev) => prev.map((a) => (a.id === id ? row : a)));
      return row;
    } catch {
      return null;
    }
  }, []);

  const dismiss = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/alerts/${id}/dismiss`, { method: 'POST' });
      if (!res.ok) return false;
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  const remove = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/alerts/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) return false;
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { alerts, loading, error, refresh, add, trigger, dismiss, remove };
}
