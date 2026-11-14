'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { LiveConnection } from '../lib/brokerConnections';

export interface HistoryTick {
  /** Unix milliseconds. */
  time: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

/** The ticks as a CSV file: one row each, the time in ISO 8601 (UTC). */
export function ticksToCsv(ticks: HistoryTick[]): string {
  const cell = (v: number | null) => (v === null || v === undefined ? '' : String(v));
  const rows = ticks.map(
    (t) => `${new Date(t.time).toISOString()},${cell(t.bid)},${cell(t.ask)},${cell(t.last)}`
  );
  return ['time,bid,ask,last', ...rows].join('\n') + '\n';
}

function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const LIMITS = [5000, 20000, 50000];

/**
 * Past ticks straight from a broker that keeps them (cTrader, MT5), saved as
 * a CSV file. Shown only when a connection has them. Nothing is stored in
 * the database.
 */
export default function TickHistoryDownload() {
  const [connections, setConnections] = useState<LiveConnection[]>([]);
  const [label, setLabel] = useState('');
  const [symbol, setSymbol] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [limit, setLimit] = useState(LIMITS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/brokers/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !Array.isArray(body?.connections)) return;
        const able = body.connections.filter((c: LiveConnection) => c.capabilities?.tick_history);
        setConnections(able);
        if (able.length) setLabel(able[0].label);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!connections.length) return null;
  const connection = connections.find((c) => c.label === label) ?? connections[0];
  const wanted = symbol.trim();

  const download = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const query = new URLSearchParams({
        symbol: wanted,
        source: connection.platform,
        account: connection.account,
        // The fields hold local time; the API takes an instant.
        start: new Date(start).toISOString(),
        limit: String(limit),
      });
      if (end) query.set('end', new Date(end).toISOString());
      const res = await apiFetch(`/api/market-data/ticks?${query}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const ticks: HistoryTick[] = Array.isArray(body.ticks) ? body.ticks : [];
      if (!ticks.length) {
        setNote('The broker has no ticks in that window.');
        return;
      }
      const first = new Date(ticks[0].time);
      save(
        `${wanted.replace(/[^A-Za-z0-9]+/g, '_')}_ticks_${first.toISOString()}.csv`,
        ticksToCsv(ticks)
      );
      const count = `${ticks.length.toLocaleString('en-US')} ${ticks.length === 1 ? 'tick' : 'ticks'}`;
      setNote(
        body.complete === false
          ? `Saved the most recent ${count}. Earlier ones were left out: set "To" to ${first.toLocaleString()} and download again to get them.`
          : `Saved ${count}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tick history failed');
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm';
  return (
    <section
      className="mt-6 bg-white rounded-lg shadow-sm border p-4 sm:p-6"
      aria-label="Tick history"
    >
      <h2 className="text-lg font-medium text-gray-900">Tick history</h2>
      <p className="mt-1 text-sm text-gray-600">
        Past ticks from the broker itself, saved as a CSV file. Nothing is stored in the database.
      </p>
      <form onSubmit={download} className="mt-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
        <label className="text-xs text-gray-700">
          Connection
          <select
            value={connection.label}
            onChange={(e) => setLabel(e.target.value)}
            className={field}
          >
            {connections.map((c) => (
              <option key={c.label} value={c.label}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-700">
          Symbol
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="EURUSD"
            className={field}
          />
        </label>
        <label className="text-xs text-gray-700">
          From
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={field}
          />
        </label>
        <label className="text-xs text-gray-700">
          To (now if empty)
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={field}
          />
        </label>
        <label className="text-xs text-gray-700">
          At most
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className={field}
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString('en-US')} ticks
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-5">
          <button
            type="submit"
            disabled={busy || !wanted || !start}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {busy ? 'Reading…' : 'Download ticks (CSV)'}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {note && <p className="mt-2 text-sm text-gray-700">{note}</p>}
    </section>
  );
}
