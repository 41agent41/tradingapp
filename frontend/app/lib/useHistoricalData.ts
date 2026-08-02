'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from './api';
import type { ChartBar } from '../components/Chart';

export interface HistoricalDataState {
  bars: ChartBar[];
  loading: boolean;
  error: string | null;
  source: string | null;
  refresh: () => void;
}

interface RawBar {
  timestamp: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface UseHistoricalDataInput {
  symbol: string;
  timeframe: string;
  period: string;
  secType?: string;
  exchange?: string;
  currency?: string;
  accountMode?: 'paper' | 'live';
  /** When false, the hook stays idle (no fetch) — handy for query-disabled UIs. */
  enabled?: boolean;
}

function toChartBar(raw: RawBar): ChartBar | null {
  const ts = typeof raw.timestamp === 'number' ? raw.timestamp : Number(raw.timestamp);
  if (!Number.isFinite(ts)) return null;
  // Heuristic: if it's bigger than 1e12, the value is already in ms.
  const time = ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
  return {
    time,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
  };
}

/**
 * Fetches historical OHLCV bars from /api/market-data/history and projects
 * them into the ChartBar shape Chart.tsx consumes. The hook owns its own
 * loading and error state and exposes `refresh()` so the caller can retry
 * without remounting.
 */
export function useHistoricalData({
  symbol,
  timeframe,
  period,
  secType = 'STK',
  exchange = 'SMART',
  currency = 'USD',
  accountMode = 'paper',
  enabled = true,
}: UseHistoricalDataInput): HistoricalDataState {
  const [bars, setBars] = useState<ChartBar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          symbol: symbol.toUpperCase(),
          timeframe,
          period,
          secType,
          exchange,
          currency,
          account_mode: accountMode,
        });
        const res = await apiFetch(`/api/market-data/history?${qs.toString()}`, { signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        }
        const projected: ChartBar[] = [];
        for (const raw of (body.bars ?? []) as RawBar[]) {
          const out = toChartBar(raw);
          if (out) projected.push(out);
        }
        setBars(projected);
        setSource(body.source ?? null);
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Failed to load history');
      } finally {
        setLoading(false);
      }
    },
    [symbol, timeframe, period, secType, exchange, currency, accountMode]
  );

  useEffect(() => {
    if (!enabled || !symbol) return;
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [enabled, symbol, fetchData]);

  const refresh = useCallback(() => {
    if (!symbol) return;
    const controller = new AbortController();
    void fetchData(controller.signal);
  }, [symbol, fetchData]);

  return { bars, loading, error, source, refresh };
}
