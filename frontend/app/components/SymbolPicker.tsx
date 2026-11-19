'use client';

/**
 * Pick a symbol from the chosen broker connection's own list, grouped by
 * market. The list is the backend's catalogue (GET /api/market-data/symbols),
 * kept in the database and fetched from the broker once a day.
 *
 * Picking a listed symbol also fills in the security type and currency that
 * broker needs for it, so a data request goes out the way the broker expects
 * (OANDA's AU200.AUD is a CFD, not a stock). A symbol that is not on a
 * complete list is flagged before it is sent.
 *
 * Interactive Brokers and IG have no list of everything: for them the list
 * grows from searches, so typing two letters asks the broker.
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { apiFetch } from '../lib/api';
import { platformName } from '../lib/brokerConnections';

export interface CatalogueSymbol {
  symbol: string;
  name: string;
  market: string;
  sec_type: string;
  currency: string;
  exchange: string;
  venue_id: string;
}

interface Catalogue {
  platform: string;
  account: string;
  complete: boolean;
  refreshed_at: string | null;
  stale: boolean;
  markets: Array<{ market: string; count: number }>;
  symbols: CatalogueSymbol[];
  error?: string;
  message?: string;
}

export const MARKET_LABELS: Record<string, string> = {
  FX: 'FX',
  INDEX: 'Indices',
  COMMODITY: 'Commodities',
  METAL: 'Metals',
  BOND: 'Bonds',
  STOCK: 'Stocks',
  ETF: 'ETFs',
  CRYPTO: 'Crypto',
  FUTURE: 'Futures',
  OPTION: 'Options',
  OTHER: 'Other',
};

/** What a search-only broker can be searched in. */
const SEARCH_MARKETS = ['STOCK', 'FX', 'INDEX', 'FUTURE', 'CRYPTO', 'COMMODITY', 'BOND'];

/** `EURUSD`, `eur.usd` and `EUR_USD` compare equal. */
export const bare = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export interface SymbolChoice {
  symbol: string;
  /** Set when the symbol is one from the list. */
  secType?: string;
  currency?: string;
  exchange?: string;
}

interface Props {
  /** Platform; empty for the broker priority's first. */
  source?: string;
  /** Account on it; empty for its default. */
  account?: string;
  accountMode?: 'paper' | 'live';
  symbol: string;
  onChange: (choice: SymbolChoice) => void;
  inputClassName?: string;
}

function age(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export default function SymbolPicker({
  source = '',
  account = '',
  accountMode = 'paper',
  symbol,
  onChange,
  inputClassName = 'w-full px-2 py-1 text-sm border border-gray-300 rounded-md',
}: Props) {
  const listId = useId();
  // The market chosen, kept with the connection it was chosen on: a new
  // connection has its own markets, so it starts from all of them.
  const connection = `${source}:${account}`;
  const [picked, setPicked] = useState({ connection, market: '' });
  const market = picked.connection === connection ? picked.market : '';
  const setMarket = (value: string) => setPicked({ connection, market: value });
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: '200', account_mode: accountMode });
    if (source) params.set('source', source);
    if (account) params.set('account', account);
    if (market) params.set('market', market);
    if (symbol.trim()) params.set('q', symbol.trim());
    return params.toString();
  }, [source, account, accountMode, market, symbol]);

  useEffect(() => {
    let cancelled = false;
    // Wait for typing to pause; a search-only broker is asked on each search.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/market-data/symbols?${query}`);
        const body = (await res.json().catch(() => null)) as Catalogue | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setFailure(
            body?.message || body?.error || `The symbol list could not be read (${res.status})`
          );
          setCatalogue(null);
        } else {
          setFailure(null);
          setCatalogue(body);
        }
      } catch {
        if (!cancelled) setFailure('The symbol list could not be read');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const symbols = useMemo(() => catalogue?.symbols ?? [], [catalogue]);
  const match = useMemo(() => {
    const wanted = bare(symbol);
    return wanted ? (symbols.find((s) => bare(s.symbol) === wanted) ?? null) : null;
  }, [symbols, symbol]);

  const choose = useCallback(
    (typed: string) => {
      const wanted = bare(typed);
      const found = wanted ? symbols.find((s) => bare(s.symbol) === wanted) : undefined;
      onChange(
        found
          ? {
              symbol: found.symbol,
              secType: found.sec_type,
              currency: found.currency,
              exchange: found.exchange,
            }
          : { symbol: typed }
      );
    },
    [symbols, onChange]
  );

  // A search answered after the symbol was typed: fill in its details.
  useEffect(() => {
    if (match) {
      onChange({
        symbol: match.symbol,
        secType: match.sec_type,
        currency: match.currency,
        exchange: match.exchange,
      });
    }
    // Only when the match itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await apiFetch('/api/market-data/symbols/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, account }),
      });
      const res = await apiFetch(`/api/market-data/symbols?${query}`);
      if (res.ok) setCatalogue(await res.json());
    } finally {
      setRefreshing(false);
    }
  };

  const broker = catalogue ? platformName(catalogue.platform) : source ? platformName(source) : '';
  const total = (catalogue?.markets ?? []).reduce((n, m) => n + m.count, 0);
  const marketOptions = catalogue?.complete
    ? (catalogue?.markets ?? []).map((m) => ({
        value: m.market,
        label: `${MARKET_LABELS[m.market] ?? m.market} (${m.count})`,
      }))
    : SEARCH_MARKETS.map((m) => ({ value: m, label: MARKET_LABELS[m] }));

  let note: React.ReactNode = null;
  if (failure) {
    note = <span className="text-red-700">{failure}</span>;
  } else if (catalogue?.complete) {
    const missing = symbol.trim() && !loading && !match;
    note = (
      <>
        {missing ? (
          <span className="text-amber-700">
            {symbol.trim().toUpperCase()} is not on {broker}&apos;s list
            {market ? ` of ${MARKET_LABELS[market] ?? market}` : ''}.{' '}
          </span>
        ) : null}
        {total} symbols from {broker}, updated {age(catalogue.refreshed_at)}
        {catalogue.stale ? ` (${broker} not reachable: ${catalogue.error})` : ''}.{' '}
      </>
    );
  } else if (catalogue) {
    note = (
      <>
        {broker} has no list of everything: type two letters to search it
        {total ? `; ${total} found so far` : ''}.{' '}
        {catalogue.error ? <span className="text-red-700">{catalogue.error} </span> : null}
      </>
    );
  }

  return (
    <div className="col-span-2 grid grid-cols-2 gap-3">
      <label className="text-sm text-gray-700">
        Market
        <select
          className={inputClassName}
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        >
          <option value="">{catalogue?.complete ? `All (${total})` : 'Any'}</option>
          {marketOptions.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-gray-700">
        Symbol
        <input
          className={inputClassName}
          value={symbol}
          list={listId}
          autoComplete="off"
          onChange={(e) => choose(e.target.value)}
          placeholder={catalogue?.complete ? 'Type or pick' : 'EURUSD'}
        />
      </label>
      <datalist id={listId} data-testid="symbol-options">
        {symbols.map((s) => (
          <option key={`${s.symbol}|${s.sec_type}`} value={s.symbol}>
            {s.name !== s.symbol ? `${s.name} · ` : ''}
            {MARKET_LABELS[s.market] ?? s.market}
          </option>
        ))}
      </datalist>
      <p
        className="col-span-2 text-xs text-gray-600"
        aria-live="polite"
        data-testid="symbol-list-note"
      >
        {loading && !catalogue ? 'Reading the symbol list…' : note}
        {catalogue ? (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="underline text-blue-700 disabled:text-gray-400"
          >
            {refreshing ? 'Refreshing…' : 'Refresh list'}
          </button>
        ) : null}
      </p>
    </div>
  );
}
