'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useWatchlist, type WatchlistItem } from '../lib/useWatchlist';
import { usePriceAlerts, type AlertCondition, type PriceAlert } from '../lib/usePriceAlerts';
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

function fmt(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

/** Inline "add an alert" control + the row's active-alert pills. There is
 *  no server-side price watcher: the parent row hands us its already-polled
 *  quote and we compare it to each active alert on every tick, calling
 *  `trigger` ourselves the moment one crosses. */
function AlertControls({
  item,
  price,
  onTriggered,
}: {
  item: WatchlistItem;
  price: number | null;
  onTriggered: (alert: PriceAlert, item: WatchlistItem) => void;
}) {
  const { alerts, add, trigger, remove } = usePriceAlerts({ watchlistItemId: item.id });
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState<AlertCondition>('above');
  const [targetPrice, setTargetPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<Set<number>>(new Set());

  const activeAlerts = alerts.filter((a) => a.status === 'active');

  // Check the row's live price against every active alert on each tick.
  useEffect(() => {
    if (price == null) return;
    for (const alert of activeAlerts) {
      if (inFlight.current.has(alert.id)) continue;
      const target = Number(alert.target_price);
      const crossed = alert.condition === 'above' ? price >= target : price <= target;
      if (!crossed) continue;
      inFlight.current.add(alert.id);
      trigger(alert.id, price)
        .then((row) => {
          if (row) onTriggered(row, item);
        })
        .finally(() => inFlight.current.delete(alert.id));
    }
    // activeAlerts is derived fresh each render; keying off `alerts` avoids
    // re-running this effect on every unrelated re-render while still
    // reacting to new/removed alerts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, alerts, trigger, onTriggered, item]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(targetPrice);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setSubmitting(true);
    const ok = await add({ watchlist_item_id: item.id, condition, target_price: parsed });
    setSubmitting(false);
    if (ok) {
      setTargetPrice('');
      setOpen(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1">
        {activeAlerts.map((a) => (
          <span
            key={a.id}
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-800"
            title={`Alert when ${item.symbol} goes ${a.condition} ${fmt(a.target_price)}`}
          >
            {a.condition === 'above' ? '≥' : '≤'} {fmt(a.target_price)}
            <button
              type="button"
              onClick={() => remove(a.id)}
              aria-label="Remove alert"
              className="text-blue-600 hover:text-blue-900"
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-gray-500 hover:text-gray-800"
        >
          {open ? 'Cancel' : '+ Alert'}
        </button>
      </div>
      {open && (
        <form onSubmit={handleAdd} className="flex items-center gap-1">
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as AlertCondition)}
            className="border rounded px-1 py-0.5 text-xs"
          >
            <option value="above">Above</option>
            <option value="below">Below</option>
          </select>
          <input
            type="number"
            step="0.01"
            min="0"
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            placeholder="Price"
            className="border rounded px-1 py-0.5 text-xs w-20"
          />
          <button
            type="submit"
            disabled={submitting || !targetPrice}
            className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            Set
          </button>
        </form>
      )}
    </div>
  );
}

function WatchlistRow({
  item,
  accountMode,
  onRemove,
  onAlertTriggered,
  busy,
}: {
  item: WatchlistItem;
  accountMode: 'paper' | 'live';
  onRemove: (id: number) => void;
  onAlertTriggered: (alert: PriceAlert, item: WatchlistItem) => void;
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
      <td className="py-2 px-3 text-right tabular-nums text-gray-500">{fmt(quote?.bid)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-gray-500">{fmt(quote?.ask)}</td>
      <td className="py-2 px-3">
        <AlertControls item={item} price={price} onTriggered={onAlertTriggered} />
      </td>
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
 *
 * Price alerts are in-app-only (Watchlist-scoped roadmap item): each row
 * compares its polled quote against its own active alerts and flips them
 * to 'triggered' itself — there is no backend price watcher or external
 * delivery channel. Triggered alerts surface in the banner below (backed
 * by the same `/api/alerts` table, so they survive a refresh) and, when
 * permitted, as a browser Notification.
 */
export default function Watchlist() {
  const { accountMode } = useTradingAccount();
  const { items, loading, error, add, remove } = useWatchlist();
  const {
    alerts: triggeredAlerts,
    dismiss: dismissTriggeredAlert,
    refresh: refreshTriggeredAlerts,
  } = usePriceAlerts({ status: 'triggered' });
  const [symbolInput, setSymbolInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  const requestNotifPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  }, []);

  const symbolFor = useCallback(
    (watchlistItemId: number) => items.find((i) => i.id === watchlistItemId)?.symbol ?? '—',
    [items]
  );

  const handleAlertTriggered = useCallback(
    (alert: PriceAlert, item: WatchlistItem) => {
      refreshTriggeredAlerts();
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        new Notification(`${item.symbol} price alert`, {
          body: `${item.symbol} crossed ${alert.condition} ${fmt(alert.target_price)}`,
        });
      }
    },
    [refreshTriggeredAlerts]
  );

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
        <div className="flex items-center gap-3">
          {notifPermission === 'default' && (
            <button
              type="button"
              onClick={requestNotifPermission}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              Enable browser notifications
            </button>
          )}
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
      </div>

      {triggeredAlerts.length > 0 && (
        <div className="mx-4 mt-3 space-y-2" aria-label="Triggered alerts">
          {triggeredAlerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between text-sm bg-amber-50 border border-amber-300 text-amber-900 rounded p-2"
            >
              <span>
                🔔 <strong>{symbolFor(a.watchlist_item_id)}</strong> crossed {a.condition}{' '}
                {fmt(a.target_price)}
                {a.triggered_price != null && ` — last ${fmt(a.triggered_price)}`}
              </span>
              <button
                type="button"
                onClick={() => dismissTriggeredAlert(a.id)}
                className="text-xs text-amber-700 hover:text-amber-900 ml-3"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

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
                <th className="py-2 px-3 font-medium">Alerts</th>
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
                  onAlertTriggered={handleAlertTriggered}
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
