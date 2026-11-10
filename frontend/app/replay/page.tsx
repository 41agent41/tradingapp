'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import BackToHome from '../components/BackToHome';
import ReplayPlayer from '../components/ReplayPlayer';
import { apiFetch } from '../lib/api';
import { platformName, type LiveConnection } from '../lib/brokerConnections';
import {
  REPLAY_TIMEFRAMES,
  formatClock,
  replayRequest,
  replaySeconds,
  signalsRequest,
  type ReplayResponse,
  type ReplayTrade,
  type ReplayTarget,
} from '../lib/replay';

const SEC_TYPES = [
  { value: 'STK', label: 'Stock' },
  { value: 'CASH', label: 'FX' },
  { value: 'CFD', label: 'CFD' },
  { value: 'FUT', label: 'Future' },
  { value: 'CRYPTO', label: 'Crypto' },
];

const INPUT = 'w-full px-2 py-1 text-sm border border-gray-300 rounded-md';

interface Definition {
  id: number;
  name: string;
}

/** Two days ago at midnight UTC, as a `datetime-local` value. */
function defaultStart(): string {
  const d = new Date(Date.now() - 2 * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T00:00`;
}

function targetFromParams(params: URLSearchParams): ReplayTarget {
  return {
    symbol: (params.get('symbol') ?? '').trim().toUpperCase(),
    source: params.get('source') ?? '',
    account: params.get('account') ?? '',
    secType: params.get('secType') ?? 'CASH',
    timeframe: params.get('timeframe') ?? '5min',
    start: params.get('start') ?? '',
  };
}

function ReplayPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const target = targetFromParams(new URLSearchParams(query));

  const [draft, setDraft] = useState<ReplayTarget>({
    ...target,
    start: target.start || defaultStart(),
  });
  const [connections, setConnections] = useState<LiveConnection[]>([]);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [definitionId, setDefinitionId] = useState('');
  const [trades, setTrades] = useState<ReplayTrade[] | null>(null);
  const [signalsNote, setSignalsNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/brokers/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.connections)) setConnections(body.connections);
      })
      .catch(() => {});
    apiFetch('/api/strategies/definitions?limit=50')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.definitions)) setDefinitions(body.definitions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the bars whenever the address names a replay.
  useEffect(() => {
    const wanted = targetFromParams(new URLSearchParams(query));
    setReplay(null);
    setTrades(null);
    setSignalsNote(null);
    setError(null);
    if (!wanted.symbol || !wanted.start) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/market-data/replay?${replayRequest(wanted)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) setError(body?.error ?? `The bars could not be loaded (${r.status}).`);
        else setReplay(body as ReplayResponse);
      })
      .catch(() => {
        if (!cancelled) setError('The bars could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // A chosen strategy is backtested over the same bars; its trades then
  // appear on the chart as the replay reaches them.
  useEffect(() => {
    setTrades(null);
    setSignalsNote(null);
    if (!replay || !definitionId) return;
    const wanted = targetFromParams(new URLSearchParams(query));
    let cancelled = false;
    setSignalsNote('Working out the strategy’s trades…');
    apiFetch('/api/backtesting/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signalsRequest(wanted, replay, Number(definitionId))),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setSignalsNote(
            `The strategy’s trades could not be worked out: ${body?.detail ?? body?.error ?? r.status}`
          );
          return;
        }
        const list = (body?.results?.trades_summary ?? []) as ReplayTrade[];
        setTrades(list);
        setSignalsNote(
          list.length
            ? `${list.length} ${list.length === 1 ? 'trade' : 'trades'} from a backtest of these bars; each shows when the replay reaches it.`
            : 'The strategy made no trades over these bars.'
        );
      })
      .catch(() => {
        if (!cancelled) setSignalsNote('The strategy’s trades could not be worked out.');
      });
    return () => {
      cancelled = true;
    };
    // `query` is covered by `replay`, which is reloaded when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay, definitionId]);

  const open = (next: ReplayTarget) => {
    const symbol = next.symbol.trim().toUpperCase();
    if (!symbol || !next.start) return;
    const p = new URLSearchParams({ symbol, timeframe: next.timeframe, start: next.start });
    if (next.source) p.set('source', next.source);
    if (next.account) p.set('account', next.account);
    if (next.secType) p.set('secType', next.secType);
    router.push(`${pathname}?${p.toString()}`);
  };

  const connection = draft.source ? `${draft.source}:${draft.account ?? ''}` : '';
  const minutes = replay?.minutes.t ?? [];
  const lastMinute = minutes.length ? minutes[minutes.length - 1] : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-4">
          <BackToHome />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Bar replay</h1>
            <p className="text-xs sm:text-sm text-gray-600">
              Play stored 1 minute bars back and watch each candle form as it did.
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4">
        <form
          aria-label="Choose what to replay"
          onSubmit={(e) => {
            e.preventDefault();
            open(draft);
          }}
          className="bg-white rounded-lg shadow-sm border p-3 grid grid-cols-2 sm:grid-cols-7 gap-3 items-end"
        >
          <label className="text-sm text-gray-700">
            Symbol
            <input
              className={INPUT}
              value={draft.symbol}
              onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
              placeholder="EURUSD"
            />
          </label>
          <label className="text-sm text-gray-700 col-span-2">
            Connection
            <select
              className={INPUT}
              value={connection}
              onChange={(e) => {
                const [source = '', account = ''] = e.target.value.split(':');
                setDraft({ ...draft, source, account });
              }}
            >
              <option value="">By broker priority</option>
              {connections.map((c) => (
                <option key={c.label} value={`${c.platform}:${c.account}`}>
                  {platformName(c.platform)} {c.account}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            Type
            <select
              className={INPUT}
              value={draft.secType}
              onChange={(e) => setDraft({ ...draft, secType: e.target.value })}
            >
              {SEC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            Candles
            <select
              className={INPUT}
              value={draft.timeframe}
              onChange={(e) => setDraft({ ...draft, timeframe: e.target.value })}
            >
              {REPLAY_TIMEFRAMES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            Start (UTC)
            <input
              type="datetime-local"
              className={INPUT}
              value={draft.start}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            />
          </label>
          <button
            type="submit"
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            Load
          </button>
        </form>

        {!target.symbol && (
          <p className="text-sm text-gray-600">
            Choose an instrument that has 1 minute bars stored (recorded live, or collected at 1
            minute), a candle size and a start time, then Load.
          </p>
        )}
        {loading && <p className="text-sm text-gray-600">Loading the stored bars…</p>}
        {error && (
          <p
            role="alert"
            className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-md"
          >
            {error}
          </p>
        )}

        {replay && (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-600">
              <span data-testid="replay-range">
                {minutes.length} stored 1 minute bars, {formatClock(minutes[0] ?? null)} to{' '}
                {formatClock(lastMinute)} UTC.
              </span>
              {replay.more && lastMinute !== null && (
                <button
                  type="button"
                  className="text-blue-700 underline"
                  onClick={() => {
                    const seconds = replaySeconds(replay.timeframe);
                    const next = Math.ceil((lastMinute + 60) / seconds) * seconds;
                    const start = new Date(next * 1000).toISOString().slice(0, 16);
                    setDraft({ ...draft, ...target, start });
                    open({ ...target, start });
                  }}
                >
                  More is stored after this. Continue from there
                </button>
              )}
              <label className="flex items-center gap-2">
                Show a strategy’s trades
                <select
                  className="px-2 py-1 text-sm border border-gray-300 rounded-md"
                  value={definitionId}
                  onChange={(e) => setDefinitionId(e.target.value)}
                >
                  <option value="">None</option>
                  {definitions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {signalsNote && (
              <p className="text-sm text-gray-600" data-testid="replay-signals">
                {signalsNote}
              </p>
            )}
            <ReplayPlayer key={`${query}`} replay={replay} trades={trades ?? undefined} />
          </>
        )}
      </main>
    </div>
  );
}

export default function ReplayPageWithParams() {
  return (
    <Suspense fallback={null}>
      <ReplayPage />
    </Suspense>
  );
}
