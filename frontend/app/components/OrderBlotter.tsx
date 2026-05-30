'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

interface OrderAuditRow {
  id: number;
  submitted_at: string;
  account_mode: string;
  action: string;
  symbol: string;
  quantity: string;
  order_type: string;
  tif: string;
  limit_price: string | null;
  stop_price: string | null;
  operation: string;
  ib_order_id: number | null;
  status: string;
  last_error: string | null;
}

export interface OrderBlotterProps {
  /** Poll interval in ms. 0 disables polling. Defaults to 10s. */
  pollMs?: number;
  /** Show the cancel column. Defaults to true. */
  allowCancel?: boolean;
  /** Optional filter — show only one symbol. */
  symbolFilter?: string;
}

function statusColor(s: string): string {
  if (s === 'rejected') return 'text-red-600';
  if (s === 'cancel_requested') return 'text-amber-600';
  if (s === 'filled') return 'text-green-700';
  return 'text-gray-700';
}

export default function OrderBlotter({
  pollMs = 10_000,
  allowCancel = true,
  symbolFilter,
}: OrderBlotterProps) {
  const [rows, setRows] = useState<OrderAuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (symbolFilter) qs.set('symbol', symbolFilter);
      const res = await apiFetch(`/api/orders/audit?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { orders: OrderAuditRow[] };
      setRows(body.orders ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load blotter');
    }
  }, [symbolFilter]);

  useEffect(() => {
    load();
    if (pollMs <= 0) return;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  const cancel = useCallback(
    async (ibOrderId: number | null) => {
      if (ibOrderId == null) return;
      setBusyId(ibOrderId);
      try {
        const res = await apiFetch(`/api/orders/${ibOrderId}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Cancel failed');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="bg-white rounded-lg shadow-sm border" aria-label="Order blotter">
      <div className="p-4 border-b flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Order Blotter</h3>
        <button
          type="button"
          onClick={load}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>
      {error && (
        <div className="mx-4 mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">
          No orders yet. Submit one from the Order Ticket above to populate this list.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-gray-600 border-b bg-gray-50">
              <tr>
                <th className="py-2 px-3 font-medium">Submitted</th>
                <th className="py-2 px-3 font-medium">Mode</th>
                <th className="py-2 px-3 font-medium">Side</th>
                <th className="py-2 px-3 font-medium">Symbol</th>
                <th className="py-2 px-3 font-medium text-right">Qty</th>
                <th className="py-2 px-3 font-medium">Type</th>
                <th className="py-2 px-3 font-medium">TIF</th>
                <th className="py-2 px-3 font-medium text-right">Limit</th>
                <th className="py-2 px-3 font-medium text-right">Stop</th>
                <th className="py-2 px-3 font-medium">IB ID</th>
                <th className="py-2 px-3 font-medium">Status</th>
                {allowCancel && <th className="py-2 px-3 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="py-2 px-3 whitespace-nowrap text-gray-700">
                    {new Date(r.submitted_at).toLocaleString()}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        r.account_mode === 'live'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-blue-50 text-blue-700'
                      }`}
                    >
                      {r.account_mode}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-medium">{r.action}</td>
                  <td className="py-2 px-3">{r.symbol}</td>
                  <td className="py-2 px-3 text-right">{r.quantity}</td>
                  <td className="py-2 px-3">{r.order_type}</td>
                  <td className="py-2 px-3">{r.tif}</td>
                  <td className="py-2 px-3 text-right">{r.limit_price ?? '—'}</td>
                  <td className="py-2 px-3 text-right">{r.stop_price ?? '—'}</td>
                  <td className="py-2 px-3">{r.ib_order_id ?? '—'}</td>
                  <td className={`py-2 px-3 ${statusColor(r.status)}`} title={r.last_error ?? undefined}>
                    {r.status}
                  </td>
                  {allowCancel && (
                    <td className="py-2 px-3 text-right">
                      {r.ib_order_id != null && r.status === 'submitted' ? (
                        <button
                          type="button"
                          onClick={() => cancel(r.ib_order_id)}
                          disabled={busyId === r.ib_order_id}
                          className="text-xs text-red-600 hover:text-red-800 disabled:text-gray-400"
                        >
                          Cancel
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
