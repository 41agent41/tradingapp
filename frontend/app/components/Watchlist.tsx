'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useWatchlist, type WatchlistItem } from '../lib/useWatchlist';
import { useTradingAccount } from '../contexts/TradingAccountContext';

interface RealtimeQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  timestamp: string;
}

/** One row's live quote — polls independently so a slow/failing symbol
 *  doesn't block the rest of the list. */
function useQuote(symbol: string, accountMode: 'paper' | 'live', pollMs: number) {
  const [quote, setQuote] = useState<RealtimeQuote | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch(
          `/api/market-data/realtime?symbol=${encodeURIComponent(symbol)}&account_mode=${accountMode}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as RealtimeQuote;
        if (!cancelled) {
          setQuote(body);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    load();
    const t = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbol, accountMode, pollMs]);

  return { quote, error };
}

function WatchlistRow({
  item,
  accountMode,
  onRemove,
  busy,
}: {
  item: WatchlistItem;
  accountMode: 'paper' | 'live';
  onRemove: (id: number) => void;
  busy: boolean;
}) {
  const { quote, error } = useQuote(item.symbol, accountMode, 15_000);
  const price = quote?.last ?? quote?.bid ?? quote?.ask ?? null;

  return (
    <tr className="hover:bg-gray-50">
      <td className="py-2 px-3 font-medium text-gray-900">{item.symbol}</td>
      <td className="py-2 px-3 text-gray-600">{item.exchange}</td>
      <td className="py-2 px-3 text-gray-600">
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{item.broker}</span>
      </td>
      <td className="py-2 px-3 text-right tabular-nums">
        {price != null ? price.toFixed(2) : error ? '—' : '…'}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-500">{quote?.bid ?? '—'}</td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-500">{quote?.ask ?? '—'}</td>
      <td className="py-2 px-3 text-right">
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          disabled={busy}
          className="text-xs text-red-600 hover:text-red-800 disabled:text-gray-400"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

/**
 * A flat, single-list watchlist. Quotes are polled per-row from the
 * existing `/api/market-data/realtime` endpoint (already Redis-cached
 * server-side), so adding a symbol here costs nothing new on the IB side.
 */
export default function Watchlist() {
  const { accountMode } = useTradingAccount();
  const { items, loading, error, add, remove } = useWatchlist();
  const [symbolInput, setSymbolInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const symbol = symbolInput.trim();
    if (!symbol) return;
    setAdding(true);
    const ok = await add({ symbol });
    setAdding(false);
    if (ok) setSymbolInput('');
  };

  const handleRemove = async (id: number) => {
    setBusyId(id);
    await remove(id);
    setBusyId(null);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border" aria-label="Watchlist">
      <div className="p-4 border-b flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-base font-semibold text-gray-900">Watchlist</h3>
        <form onSubmit={handleAdd} className="flex items-center gap-2">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="Add symbol (e.g. AAPL)"
            className="border rounded px-2 py-1 text-sm w-40"
            maxLength={20}
          />
          <button
            type="submit"
            disabled={adding || !symbolInput.trim()}
            className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      </div>

      {error && (
        <div className="mx-4 mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">
          No symbols yet. Add one above to start tracking its price.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-gray-600 border-b bg-gray-50">
              <tr>
                <th className="py-2 px-3 font-medium">Symbol</th>
                <th className="py-2 px-3 font-medium">Exchange</th>
                <th className="py-2 px-3 font-medium">Broker</th>
                <th className="py-2 px-3 font-medium text-right">Last</th>
                <th className="py-2 px-3 font-medium text-right">Bid</th>
                <th className="py-2 px-3 font-medium text-right">Ask</th>
                <th className="py-2 px-3 font-medium text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <WatchlistRow
                  key={item.id}
                  item={item}
                  accountMode={accountMode}
                  onRemove={handleRemove}
                  busy={busyId === item.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
