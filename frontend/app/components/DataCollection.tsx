'use client';

import React, { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';

/**
 * Settings > Schedulers and data: which instruments the app collects bars for
 * on its own. The backfill scheduler fetches each enabled entry's recent bars
 * whenever its newest stored bar is older than the entry's interval, and keeps
 * them for its retention period. Removing an entry stops collection; bars
 * already stored stay.
 */

export type CollectionEntry = {
  id: number;
  broker: string;
  account: string;
  symbol: string;
  sec_type: string;
  exchange: string | null;
  currency: string | null;
  timeframe: string;
  enabled: boolean;
  auto_collect: boolean;
  collection_interval_minutes: number;
  retention_days: number;
  latest_bar: string | null;
};

type Payload = { entries: CollectionEntry[]; brokers: string[]; timeframes: string[] };

const BUTTON =
  'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50';
const INPUT = 'w-full px-2 py-1 text-sm border border-gray-300 rounded-md';

const EMPTY = {
  broker: 'oanda',
  account: '',
  symbol: '',
  sec_type: '',
  exchange: '',
  currency: '',
  timeframe: '1hour',
  collection_interval_minutes: '60',
  retention_days: '365',
};

async function readJson(r: Response) {
  if (r.status === 204) return {};
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || body?.detail || `HTTP ${r.status}`);
  return body;
}

function newest(latest: string | null): string {
  return latest ? new Date(latest).toLocaleString() : 'none yet';
}

export default function DataCollection() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPayload(await readJson(await apiFetch('/api/market-data/collection')));
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (path: string, method: string, body?: unknown, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await readJson(
        await apiFetch(`/api/market-data/collection${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      );
      if (done) setMessage({ kind: 'ok', text: done });
      await load();
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const ok = await send(
      '',
      'POST',
      {
        ...form,
        collection_interval_minutes: form.collection_interval_minutes || undefined,
        retention_days: form.retention_days || undefined,
      },
      `${form.symbol.toUpperCase()} ${form.timeframe} added.`
    );
    if (ok) setForm({ ...EMPTY, broker: form.broker, timeframe: form.timeframe });
  };

  const set = (patch: Partial<typeof EMPTY>) => setForm({ ...form, ...patch });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Data collection</h2>
        <p className="text-sm text-gray-600">
          Instruments whose bars are fetched and stored automatically while the backfill scheduler
          is on (below). Each is fetched when its newest bar is older than its interval.
        </p>
      </div>

      {message && (
        <div
          role="status"
          className={`p-2 text-sm rounded-md border ${
            message.kind === 'ok'
              ? 'text-green-800 bg-green-50 border-green-200'
              : 'text-red-800 bg-red-50 border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {payload && payload.entries.length === 0 && (
        <p className="text-sm text-gray-500">Nothing is collected yet. Add an instrument below.</p>
      )}
      {payload && payload.entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-3">Instrument</th>
                <th className="py-1 pr-3">Broker</th>
                <th className="py-1 pr-3">Timeframe</th>
                <th className="py-1 pr-3">Every (min)</th>
                <th className="py-1 pr-3">Keep (days)</th>
                <th className="py-1 pr-3">Newest bar</th>
                <th className="py-1 pr-3">Collect</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {payload.entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-1 pr-3 font-medium">{e.symbol}</td>
                  <td className="py-1 pr-3">
                    {e.broker}
                    {e.account !== 'default' ? `:${e.account}` : ''}
                  </td>
                  <td className="py-1 pr-3">{e.timeframe}</td>
                  <td className="py-1 pr-3">{e.collection_interval_minutes}</td>
                  <td className="py-1 pr-3">{e.retention_days}</td>
                  <td className="py-1 pr-3">{newest(e.latest_bar)}</td>
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Collect ${e.symbol} ${e.timeframe}`}
                      checked={e.enabled && e.auto_collect}
                      disabled={busy}
                      onChange={(ev) =>
                        void send(`/${e.id}`, 'PUT', {
                          enabled: true,
                          auto_collect: ev.target.checked,
                        })
                      }
                    />
                  </td>
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      onClick={() =>
                        void send(
                          `/${e.id}`,
                          'DELETE',
                          undefined,
                          `${e.symbol} ${e.timeframe} removed; its stored bars are kept.`
                        )
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {payload && (
        <form
          aria-label="Add an instrument to collect"
          className="p-3 border rounded-md bg-gray-50 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-sm text-gray-700">
              Broker
              <select
                className={INPUT}
                value={form.broker}
                onChange={(e) => set({ broker: e.target.value })}
              >
                {payload.brokers.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              Symbol *
              <input
                className={INPUT}
                value={form.symbol}
                placeholder={form.broker === 'oanda' ? 'EUR_USD' : 'MSFT'}
                onChange={(e) => set({ symbol: e.target.value })}
              />
            </label>
            <label className="text-sm text-gray-700">
              Timeframe
              <select
                className={INPUT}
                value={form.timeframe}
                onChange={(e) => set({ timeframe: e.target.value })}
              >
                {payload.timeframes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              Account
              <input
                className={INPUT}
                value={form.account}
                placeholder="default"
                onChange={(e) => set({ account: e.target.value })}
              />
            </label>
            <label className="text-sm text-gray-700">
              Every (minutes)
              <input
                className={INPUT}
                type="number"
                min={1}
                value={form.collection_interval_minutes}
                onChange={(e) => set({ collection_interval_minutes: e.target.value })}
              />
            </label>
            <label className="text-sm text-gray-700">
              Keep (days)
              <input
                className={INPUT}
                type="number"
                min={1}
                value={form.retention_days}
                onChange={(e) => set({ retention_days: e.target.value })}
              />
            </label>
            <label className="text-sm text-gray-700">
              Type
              <input
                className={INPUT}
                value={form.sec_type}
                placeholder={form.broker === 'ib' ? 'STK' : 'CASH'}
                onChange={(e) => set({ sec_type: e.target.value })}
              />
            </label>
            <label className="text-sm text-gray-700">
              Exchange / currency
              <div className="flex gap-1">
                <input
                  className={INPUT}
                  value={form.exchange}
                  placeholder="exchange"
                  onChange={(e) => set({ exchange: e.target.value })}
                />
                <input
                  className={INPUT}
                  value={form.currency}
                  placeholder="USD"
                  maxLength={3}
                  onChange={(e) => set({ currency: e.target.value })}
                />
              </div>
            </label>
          </div>
          <button type="submit" className={BUTTON} disabled={busy || !form.symbol.trim()}>
            {busy ? 'Saving…' : 'Add'}
          </button>
        </form>
      )}
    </div>
  );
}
