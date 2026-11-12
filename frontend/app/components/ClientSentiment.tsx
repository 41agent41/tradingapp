'use client';

import React, { useState } from 'react';
import { apiFetch } from '../lib/api';

export interface Sentiment {
  symbol: string;
  /** Percent of the broker's clients with a position who are long, and short. */
  long_pct: number;
  short_pct: number;
  timestamp?: string;
}

export interface ClientSentimentProps {
  symbol: string;
  /** The connection to ask: its platform and account. */
  platform: string;
  account: string;
}

const pct = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

/**
 * How a broker's own clients are positioned in one instrument, read on
 * request from a broker that publishes it (IG). Nothing refreshes until asked.
 */
export default function ClientSentiment({ symbol, platform, account }: ClientSentimentProps) {
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = symbol.trim();

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ symbol: wanted, source: platform, account });
      const res = await apiFetch(`/api/market-data/sentiment?${query}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      if (typeof body.long_pct !== 'number' || typeof body.short_pct !== 'number') {
        throw new Error('The broker sent no client sentiment');
      }
      setSentiment(body);
    } catch (err) {
      setSentiment(null);
      setError(err instanceof Error ? err.message : 'Client sentiment failed');
    } finally {
      setBusy(false);
    }
  };

  // An answer shown for one symbol says so, in case the ticket has moved on.
  const stale = sentiment !== null && sentiment.symbol.toUpperCase() !== wanted.toUpperCase();

  return (
    <section className="mt-4 border-t pt-3" aria-label="Client sentiment">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-gray-900">
          Client sentiment{sentiment ? `: ${sentiment.symbol}` : ''}
        </h4>
        <button
          type="button"
          onClick={load}
          disabled={busy || !wanted}
          className="px-3 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:text-gray-400"
        >
          {busy ? 'Reading…' : sentiment ? 'Refresh' : 'Show sentiment'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {sentiment && (
        <>
          <div className="mt-2 flex justify-between text-xs tabular-nums">
            <span className="text-green-700">{pct(sentiment.long_pct)} long</span>
            <span className="text-red-700">{pct(sentiment.short_pct)} short</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded bg-red-200" aria-hidden="true">
            <div
              className="h-full bg-green-600"
              style={{ width: `${Math.min(100, Math.max(0, sentiment.long_pct))}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            The share of this broker&apos;s clients with a position who are long and short. Read
            {sentiment.timestamp ? ` at ${new Date(sentiment.timestamp).toLocaleTimeString()}` : ''}
            ; it does not update by itself.
            {stale ? ' The symbol above has changed since.' : ''}
          </p>
        </>
      )}
    </section>
  );
}
