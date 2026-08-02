'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';

export type OrderAction = 'BUY' | 'SELL';
export type OrderType = 'MKT' | 'LMT' | 'STP' | 'STP_LMT';
export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK';
export type AccountMode = 'paper' | 'live';

interface OrderConfig {
  live_trading_enabled: boolean;
  backend_live_enabled: boolean;
  ib_live_enabled: boolean;
  order_types: OrderType[];
  tif: TimeInForce[];
  actions: OrderAction[];
}

const DEFAULT_CONFIG: OrderConfig = {
  live_trading_enabled: false,
  backend_live_enabled: false,
  ib_live_enabled: false,
  order_types: ['MKT', 'LMT', 'STP', 'STP_LMT'],
  tif: ['DAY', 'GTC', 'IOC', 'FOK'],
  actions: ['BUY', 'SELL'],
};

export interface OrderTicketProps {
  /** Optional preselected symbol — handy when launched from a chart context. */
  defaultSymbol?: string;
  /** Called after a successful submission so the parent can refresh a blotter. */
  onPlaced?: (response: unknown) => void;
  /** Compact mode hides the explanatory copy and reduces vertical padding. */
  compact?: boolean;
}

/**
 * Order ticket — the only mutating-trade UI surface in the app. Renders
 * the validation fields IB expects and gates the LIVE option on a config
 * probe of `/api/orders/config`. A confirmation modal protects every
 * live submission.
 */
export default function OrderTicket({
  defaultSymbol = '',
  onPlaced,
  compact = false,
}: OrderTicketProps) {
  const [config, setConfig] = useState<OrderConfig>(DEFAULT_CONFIG);
  const [configError, setConfigError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState(defaultSymbol);
  const [action, setAction] = useState<OrderAction>('BUY');
  const [quantity, setQuantity] = useState('1');
  const [orderType, setOrderType] = useState<OrderType>('MKT');
  const [tif, setTif] = useState<TimeInForce>('DAY');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [accountMode, setAccountMode] = useState<AccountMode>('paper');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/orders/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as OrderConfig;
        if (!cancelled) setConfig(body);
      } catch (e) {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : 'config probe failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const needsLimit = orderType === 'LMT' || orderType === 'STP_LMT';
  const needsStop = orderType === 'STP' || orderType === 'STP_LMT';

  const payload = useMemo(
    () => ({
      symbol: symbol.trim().toUpperCase(),
      action,
      quantity: Number(quantity),
      order_type: orderType,
      tif,
      limit_price: needsLimit ? Number(limitPrice) : undefined,
      stop_price: needsStop ? Number(stopPrice) : undefined,
      account_mode: accountMode,
    }),
    [
      symbol,
      action,
      quantity,
      orderType,
      tif,
      limitPrice,
      stopPrice,
      needsLimit,
      needsStop,
      accountMode,
    ]
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      setSuccess(
        `Order submitted (audit #${body.audit_id ?? '?'}${body.order_id ? `, IB id ${body.order_id}` : ''})`
      );
      if (onPlaced) onPlaced(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to place order');
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (accountMode === 'live') {
      setConfirmOpen(true);
      return;
    }
    void submit();
  };

  const liveAvailable = config.live_trading_enabled;

  return (
    <div
      className={`bg-white rounded-lg shadow-sm border ${compact ? 'p-4' : 'p-6'}`}
      aria-label="Order ticket"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-gray-900">Order Ticket</h3>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            accountMode === 'live'
              ? 'bg-red-100 text-red-800 border border-red-200'
              : 'bg-blue-50 text-blue-700 border border-blue-100'
          }`}
        >
          {accountMode === 'live' ? 'LIVE TRADING' : 'PAPER'}
        </span>
      </div>

      {!compact && (
        <p className="text-xs text-gray-600 mb-3">
          Submitting an order sends it to Interactive Brokers via the configured account. Validation
          runs both here and on the backend before anything reaches IB.
          {configError && (
            <span className="block mt-1 text-amber-700">
              Config probe failed ({configError}) — live mode disabled until that recovers.
            </span>
          )}
        </p>
      )}

      <form onSubmit={onSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Symbol</span>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="MSFT"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
            required
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Side</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as OrderAction)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {config.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Quantity</span>
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
            required
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Order type</span>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as OrderType)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {config.order_types.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Time in force</span>
          <select
            value={tif}
            onChange={(e) => setTif(e.target.value as TimeInForce)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {config.tif.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Account</span>
          <select
            value={accountMode}
            onChange={(e) => setAccountMode(e.target.value as AccountMode)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            <option value="paper">Paper</option>
            <option value="live" disabled={!liveAvailable}>
              Live {liveAvailable ? '' : '(disabled)'}
            </option>
          </select>
        </label>

        {needsLimit && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Limit price</span>
            <input
              type="number"
              min="0"
              step="any"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
              required={needsLimit}
            />
          </label>
        )}

        {needsStop && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Stop price</span>
            <input
              type="number"
              min="0"
              step="any"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
              required={needsStop}
            />
          </label>
        )}

        <div className="sm:col-span-2 flex flex-col gap-2">
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}
          {success && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-2">
              {success}
            </div>
          )}
          <button
            type="submit"
            disabled={busy}
            className={`px-4 py-2 rounded font-medium text-white transition-colors ${
              accountMode === 'live'
                ? 'bg-red-600 hover:bg-red-700 disabled:bg-gray-400'
                : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400'
            }`}
          >
            {busy
              ? 'Submitting…'
              : accountMode === 'live'
                ? 'Review live order'
                : 'Place paper order'}
          </button>
        </div>
      </form>

      {confirmOpen && (
        <div
          role="dialog"
          aria-label="Confirm live order"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full mx-4">
            <h4 className="text-lg font-semibold text-red-700 mb-2">Confirm LIVE order</h4>
            <p className="text-sm text-gray-700 mb-3">
              This will send a real order to Interactive Brokers. Double-check every field:
            </p>
            <dl className="text-sm space-y-1 mb-4">
              <div>
                <span className="font-medium">Side:</span> {payload.action}
              </div>
              <div>
                <span className="font-medium">Symbol:</span> {payload.symbol}
              </div>
              <div>
                <span className="font-medium">Quantity:</span> {payload.quantity}
              </div>
              <div>
                <span className="font-medium">Order type:</span> {payload.order_type}
              </div>
              <div>
                <span className="font-medium">TIF:</span> {payload.tif}
              </div>
              {payload.limit_price !== undefined && (
                <div>
                  <span className="font-medium">Limit:</span> {payload.limit_price}
                </div>
              )}
              {payload.stop_price !== undefined && (
                <div>
                  <span className="font-medium">Stop:</span> {payload.stop_price}
                </div>
              )}
            </dl>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400"
              >
                {busy ? 'Submitting…' : 'Send LIVE order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
