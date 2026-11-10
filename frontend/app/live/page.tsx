'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import BackToHome from '../components/BackToHome';
import LiveChart, { type LiveInstrument } from '../components/LiveChart';
import { instrumentFromParams, paramsFromInstrument } from '../lib/liveInstrument';
import { apiFetch } from '../lib/api';
import { platformName, type LiveConnection } from '../lib/brokerConnections';

const SEC_TYPES = [
  { value: 'STK', label: 'Stock' },
  { value: 'CASH', label: 'FX' },
  { value: 'CFD', label: 'CFD' },
  { value: 'FUT', label: 'Future' },
  { value: 'CRYPTO', label: 'Crypto' },
];

const INPUT = 'w-full px-2 py-1 text-sm border border-gray-300 rounded-md';

function LivePage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const instrument = instrumentFromParams(new URLSearchParams(params.toString()));
  const [draft, setDraft] = useState<LiveInstrument>(instrument);
  const [connections, setConnections] = useState<LiveConnection[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/brokers/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.connections)) setConnections(body.connections);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const connection = draft.source ? `${draft.source}:${draft.account ?? ''}` : '';
  const show = (e: React.FormEvent) => {
    e.preventDefault();
    const symbol = draft.symbol.trim().toUpperCase();
    if (!symbol) return;
    router.push(`${pathname}?${paramsFromInstrument({ ...draft, symbol })}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-4">
          <BackToHome />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Live chart</h1>
            <p className="text-xs sm:text-sm text-gray-600">
              Any symbol on any broker connection; the last candle moves with each tick.
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4">
        <form
          aria-label="Choose the instrument"
          onSubmit={show}
          className="bg-white rounded-lg shadow-sm border p-3 grid grid-cols-2 sm:grid-cols-6 gap-3 items-end"
        >
          <label className="text-sm text-gray-700 col-span-2 sm:col-span-1">
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
                  {c.account_mode ? ` (${c.account_mode})` : ''}
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
            Currency
            <input
              className={INPUT}
              value={draft.currency}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
              placeholder="Optional"
            />
          </label>
          <button
            type="submit"
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            Show
          </button>
        </form>

        <LiveChart key={paramsFromInstrument(instrument)} instrument={instrument} />
      </main>
    </div>
  );
}

export default function LivePageWithParams() {
  return (
    <Suspense fallback={null}>
      <LivePage />
    </Suspense>
  );
}
