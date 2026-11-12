'use client';

import React, { useState } from 'react';
import { apiFetch } from '../lib/api';

export interface DepthLevel {
  price: number;
  /** Size offered at this price, in units. */
  size: number;
}

export interface DepthBook {
  symbol: string;
  timestamp?: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface DepthOfMarketProps {
  symbol: string;
  /** The connection to ask: its platform and account. */
  platform: string;
  account: string;
  levels?: number;
}

const size = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The order book of one instrument, read on request from a broker that
 * publishes one (cTrader). It is a snapshot: nothing refreshes until asked.
 */
export default function DepthOfMarket({
  symbol,
  platform,
  account,
  levels = 10,
}: DepthOfMarketProps) {
  const [book, setBook] = useState<DepthBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = symbol.trim();

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        symbol: wanted,
        source: platform,
        account,
        levels: String(levels),
      });
      const res = await apiFetch(`/api/market-data/depth?${query}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setBook({ ...body, bids: body.bids ?? [], asks: body.asks ?? [] });
    } catch (err) {
      setBook(null);
      setError(err instanceof Error ? err.message : 'Depth of market failed');
    } finally {
      setBusy(false);
    }
  };

  const rows = book ? Math.max(book.bids.length, book.asks.length) : 0;
  // A book shown for one symbol says so, in case the ticket has moved on.
  const stale = book !== null && book.symbol.toUpperCase() !== wanted.toUpperCase();

  return (
    <section className="mt-4 border-t pt-3" aria-label="Depth of market">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-gray-900">
          Depth of market{book ? `: ${book.symbol}` : ''}
        </h4>
        <button
          type="button"
          onClick={load}
          disabled={busy || !wanted}
          className="px-3 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:text-gray-400"
        >
          {busy ? 'Reading…' : book ? 'Refresh' : 'Show depth'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {book && (
        <>
          <table className="mt-2 w-full text-xs tabular-nums">
            <thead>
              <tr className="text-gray-500">
                <th className="text-right font-medium py-1">Bid size</th>
                <th className="text-right font-medium py-1">Bid</th>
                <th className="text-right font-medium py-1">Ask</th>
                <th className="text-right font-medium py-1">Ask size</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="text-right py-1">{book.bids[i] ? size(book.bids[i].size) : ''}</td>
                  <td className="text-right py-1 text-green-700">{book.bids[i]?.price ?? ''}</td>
                  <td className="text-right py-1 text-red-700">{book.asks[i]?.price ?? ''}</td>
                  <td className="text-right py-1">{book.asks[i] ? size(book.asks[i].size) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-gray-500">
            Sizes are in units. A snapshot
            {book.timestamp ? ` from ${new Date(book.timestamp).toLocaleTimeString()}` : ''}; it
            does not update by itself.
            {stale ? ' The symbol above has changed since.' : ''}
          </p>
        </>
      )}
    </section>
  );
}
