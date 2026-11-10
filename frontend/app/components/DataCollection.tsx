'use client';

import React, { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';

/**
 * Settings > Schedulers and data: which instruments the app collects bars for
 * on its own. The backfill scheduler fetches each enabled entry's recent bars
 * whenever its newest stored bar is older than the entry's interval, and keeps
 * them for its retention period. With "History from" set it also walks back
 * to that date, a chunk at a time, for backtests. Removing an entry stops
 * collection; bars already stored stay.
 *
 * "Record live" has the live recorder store 1-minute bars from the
 * instrument's price stream as they form, and "Store ticks" has it keep each
 * quote too. Both belong to the instrument, so they apply to every timeframe
 * row of it. The Live feed column shows what the recorder is receiving.
 */

export type CollectionEntry = {
  id: number;
  contract_id: number;
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
  history_start: string | null;
  oldest_bar: string | null;
  backfilled_to: string | null;
  record_live: boolean;
  record_ticks: boolean;
};

export type RecordedContract = {
  contract_id: number;
  /** 'streamed' when the broker pushes prices, 'polled' when they are fetched. */
  mode: string | null;
  last_quote: string | null;
  last_bar: string | null;
  quotes_last_minute: number;
  error: string | null;
};

export type RecorderStatus = {
  enabled: boolean;
  running: boolean;
  degraded: boolean;
  lag_seconds: number;
  waiting: number;
  last_error: string | null;
  poll_seconds: number | null;
  contracts: RecordedContract[];
  /** The nightly replacement of recorded bars with the broker's own. */
  reconcile?: {
    running: boolean;
    last_run: string | null;
    last_error: string | null;
    results: { replaced: number; filled: number; left: number; error: string | null }[];
  };
};

const STATUS_REFRESH_MS = 15_000;

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
  history_start: '',
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

/** How far the walk back to the history start has got. */
export function historyProgress(e: CollectionEntry): string {
  if (!e.history_start) return 'recent only';
  const oldest = e.oldest_bar ? e.oldest_bar.slice(0, 10) : null;
  if (e.backfilled_to && e.backfilled_to.slice(0, 10) <= e.history_start) {
    return `from ${e.history_start}: complete${oldest ? ` (oldest bar ${oldest})` : ''}`;
  }
  return `from ${e.history_start}: ${oldest ? `back to ${oldest} so far` : 'starting'}`;
}

/** One line on the recorder as a whole. */
export function recorderSummary(status: RecorderStatus | null): string {
  if (!status) return '';
  if (!status.enabled) return 'Live recorder: off (turn it on below).';
  if (!status.running) {
    return `Live recorder: not running${status.last_error ? ` (${status.last_error})` : ''}.`;
  }
  const behind = `${Math.round(status.lag_seconds)} s behind the stream`;
  if (status.degraded) {
    return `Live recorder: falling behind, ${behind}${status.last_error ? ` (${status.last_error})` : ''}.`;
  }
  return `Live recorder: on, recording ${status.contracts.length}, ${behind}.`;
}

/** One line on the last reconcile with broker history. */
export function reconcileSummary(status: RecorderStatus | null): string {
  const r = status?.reconcile;
  if (!r || !status?.enabled) return '';
  if (r.running) return 'Reconcile with broker history: running.';
  if (!r.last_run) {
    return 'Reconcile with broker history: runs nightly at 02:30 UTC; not run since the last restart.';
  }
  const sum = (pick: (x: { replaced: number; filled: number }) => number) =>
    r.results.reduce((n, x) => n + pick(x), 0);
  const failed = r.results.filter((x) => x.error).length;
  return (
    `Reconcile with broker history: last run ${new Date(r.last_run).toLocaleString()}, ` +
    `${sum((x) => x.replaced)} recorded bars replaced, ${sum((x) => x.filled)} missing minutes filled` +
    (failed ? `, ${failed} instrument${failed === 1 ? '' : 's'} failed` : '') +
    '.'
  );
}

/** What the recorder is receiving for one entry. */
export function liveFeed(e: CollectionEntry, status: RecorderStatus | null): string {
  if (!e.record_live) return 'not recorded';
  if (!e.enabled) return 'paused (entry disabled)';
  if (!status) return '';
  if (!status.enabled) return 'recorder is off';
  const c = status.contracts.find((x) => x.contract_id === e.contract_id);
  if (!c) return 'starting';
  if (c.error) return `not streaming: ${c.error}`;
  const mode =
    c.mode === 'polled'
      ? `polled every ${status.poll_seconds ?? 2} s`
      : c.mode === 'streamed'
        ? 'streamed'
        : 'starting';
  if (!c.last_quote) return `${mode}, no quote yet`;
  return `${mode}, ${c.quotes_last_minute} quotes in the last minute, last at ${new Date(
    c.last_quote
  ).toLocaleTimeString()}`;
}

export default function DataCollection() {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
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

  const loadStatus = useCallback(async () => {
    try {
      const body = await readJson(await apiFetch('/api/market-data/recorder/status'));
      setStatus(Array.isArray(body?.contracts) ? (body as RecorderStatus) : null);
    } catch {
      // The table still works without it; the next refresh tries again.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, loadStatus]);

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
      void loadStatus();
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Replaces the last two days of recorded bars with the broker's own, now.
  const reconcileNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const body = await readJson(
        await apiFetch('/api/market-data/recorder/reconcile', { method: 'POST' })
      );
      const results: { replaced: number; filled: number; error: string | null }[] =
        body?.results ?? [];
      const failed = results.filter((r) => r.error);
      setMessage(
        failed.length
          ? { kind: 'error', text: `Reconcile failed for ${failed.length}: ${failed[0].error}` }
          : {
              kind: 'ok',
              text: `Reconciled ${results.length} instrument${results.length === 1 ? '' : 's'}.`,
            }
      );
      await loadStatus();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
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
        history_start: form.history_start || undefined,
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
          is on (below). Each is fetched when its newest bar is older than its interval. Set History
          from to also collect older bars back to that date, for backtests. Bars from that date on
          are kept whatever the entry&apos;s retention.
        </p>
        <p className="mt-1 text-sm text-gray-600">
          Tick Record live to store 1-minute bars from the instrument&apos;s live prices as they
          form, with no chart open. Tick Store ticks to keep each quote as well. Both apply to the
          instrument, so they change on every timeframe row of it.
        </p>
        {status && (
          <p
            data-testid="recorder-summary"
            className={`mt-1 text-sm ${
              status.enabled && (status.degraded || !status.running)
                ? 'text-amber-700'
                : 'text-gray-600'
            }`}
          >
            {recorderSummary(status)}
          </p>
        )}
        {reconcileSummary(status) && (
          <p data-testid="reconcile-summary" className="mt-1 text-sm text-gray-600">
            {reconcileSummary(status)}{' '}
            <button
              type="button"
              className="underline text-blue-700 disabled:opacity-50"
              disabled={busy || status?.reconcile?.running}
              onClick={() => void reconcileNow()}
            >
              Reconcile now
            </button>
          </p>
        )}
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
                <th className="py-1 pr-3">History</th>
                <th className="py-1 pr-3">Collect</th>
                <th className="py-1 pr-3">Record live</th>
                <th className="py-1 pr-3">Store ticks</th>
                <th className="py-1 pr-3">Live feed</th>
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
                  <td className="py-1 pr-3">{historyProgress(e)}</td>
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
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Record ${e.symbol} live`}
                      checked={e.record_live}
                      disabled={busy}
                      onChange={(ev) =>
                        void send(`/${e.id}`, 'PUT', { record_live: ev.target.checked })
                      }
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Store ${e.symbol} ticks`}
                      checked={e.record_ticks}
                      disabled={busy}
                      onChange={(ev) =>
                        void send(`/${e.id}`, 'PUT', { record_ticks: ev.target.checked })
                      }
                    />
                  </td>
                  <td className="py-1 pr-3 text-gray-600">{liveFeed(e, status)}</td>
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
              History from
              <input
                className={INPUT}
                type="date"
                value={form.history_start}
                onChange={(e) => set({ history_start: e.target.value })}
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
