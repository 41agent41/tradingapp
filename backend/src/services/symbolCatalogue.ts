/**
 * The symbols each broker connection can trade, kept in the database
 * (`broker_symbols`, migration 011) and grouped by market.
 *
 * A data request for a symbol the broker does not list, or with the wrong
 * security type for it, fails at the venue. The symbol pickers read this
 * catalogue instead, so they offer only what the chosen connection has, and
 * fill in the security type and currency each symbol needs.
 *
 * Two kinds of broker, as the broker service reports them:
 *
 *   - listable (OANDA, cTrader, MT5, Alpaca): the whole list comes in one
 *     fetch, is stored, and is fetched again once it is a day old or when
 *     someone presses Refresh;
 *   - search-only (IB Gateway, IBKR Web API, IG): there is no list of
 *     everything, so what a search finds is stored, and the catalogue grows
 *     with use. A search goes to the broker only when the catalogue has
 *     nothing yet that starts with what was typed.
 *
 * When the broker cannot be reached, what is stored is still served, marked
 * stale, so a broker outage does not empty the pickers.
 */
import axios from 'axios';

import { BROKER_SERVICE_URL } from '../routes/marketData/shared.js';

export const MARKETS = [
  'FX',
  'INDEX',
  'COMMODITY',
  'METAL',
  'BOND',
  'STOCK',
  'ETF',
  'CRYPTO',
  'FUTURE',
  'OPTION',
  'OTHER',
] as const;
export type Market = (typeof MARKETS)[number];

/** A listable broker's list is fetched again once it is this old. */
export const CATALOGUE_MAX_AGE_MS = 24 * 3_600_000;
const MIN_SEARCH_LENGTH = 2;
const INSERT_BATCH = 500;

export interface CatalogueSymbol {
  symbol: string;
  name: string;
  market: string;
  sec_type: string;
  currency: string;
  exchange: string;
  venue_id: string;
}

export interface CatalogueQuery {
  platform: string;
  /** '' for the platform's default account. */
  account: string;
  market?: string;
  q?: string;
  limit?: number;
  refresh?: boolean;
  accountMode?: string;
}

export interface CatalogueAnswer {
  platform: string;
  account: string;
  /** True when this is the broker's whole list; false for a search-only broker. */
  complete: boolean;
  refreshed_at: string | null;
  /** True when the broker could not be reached and stored symbols are served. */
  stale: boolean;
  /** How many symbols each market has, for the market picker. */
  markets: Array<{ market: string; count: number }>;
  symbols: CatalogueSymbol[];
  /** Why the broker could not be reached, when it could not. */
  error?: string;
}

/** What the broker service's `/symbols/catalogue` answers. */
export interface FetchedCatalogue {
  complete: boolean;
  instruments: Array<{
    symbol?: string;
    name?: string;
    market?: string;
    secType?: string;
    currency?: string;
    exchange?: string;
    venue_id?: string;
  }>;
}

export interface FetchParams {
  source: string;
  account?: string;
  q?: string;
  market?: string;
  account_mode?: string;
}

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface CatalogueDb extends Querier {
  transaction<T>(callback: (client: Querier) => Promise<T>): Promise<T>;
}

export async function fetchFromBrokerService(params: FetchParams): Promise<FetchedCatalogue> {
  const response = await axios.get(`${BROKER_SERVICE_URL}/symbols/catalogue`, {
    params,
    // A full list is one call for most brokers, a few for cTrader.
    timeout: 60_000,
  });
  return response.data as FetchedCatalogue;
}

/** The broker service's reason for a failure, in a sentence. */
export function brokerError(error: any): string {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (error?.code === 'ECONNREFUSED') return 'The broker service is not reachable';
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message))) {
    return 'The broker took too long to send its symbol list';
  }
  return String(error?.message || 'The broker could not be reached');
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

/** Clean, deduplicated rows ready to store. */
export function toRows(fetched: FetchedCatalogue['instruments']): CatalogueSymbol[] {
  const seen = new Map<string, CatalogueSymbol>();
  for (const i of Array.isArray(fetched) ? fetched : []) {
    const symbol = clip(i?.symbol, 64).trim();
    if (!symbol) continue;
    const market = (MARKETS as readonly string[]).includes(String(i.market))
      ? String(i.market)
      : 'OTHER';
    const row: CatalogueSymbol = {
      symbol,
      name: clip(i.name || symbol, 256),
      market,
      sec_type: clip(i.secType || 'CFD', 10).toUpperCase(),
      currency: clip(i.currency, 16),
      exchange: clip(i.exchange, 32),
      venue_id: clip(i.venue_id || symbol, 64),
    };
    seen.set(`${row.symbol}|${row.sec_type}`, row);
  }
  return [...seen.values()];
}

/** Symbols compared without dots, slashes or underscores: `EURUSD` finds `EUR.USD`. */
const BARE = (column: string) => `regexp_replace(${column}, '[^A-Za-z0-9]', '', 'g')`;

export class SymbolCatalogue {
  constructor(
    private db: CatalogueDb,
    private fetch: (params: FetchParams) => Promise<FetchedCatalogue> = fetchFromBrokerService,
    private now: () => number = Date.now
  ) {}

  async list(query: CatalogueQuery): Promise<CatalogueAnswer> {
    const { platform, account } = query;
    const q = (query.q ?? '').trim();
    const market = (query.market ?? '').trim().toUpperCase();
    let state = await this.state(platform, account);
    let error: string | undefined;

    const old =
      state !== null &&
      state.complete &&
      this.now() - new Date(state.refreshed_at).getTime() > CATALOGUE_MAX_AGE_MS;
    const searchOnly = state !== null && !state.complete;
    const wantsSearch =
      searchOnly &&
      q.length >= MIN_SEARCH_LENGTH &&
      !(await this.hasPrefix(platform, account, q, market));

    if (state === null || query.refresh || old || wantsSearch) {
      let fetched: FetchedCatalogue | null = null;
      try {
        fetched = await this.fetch({
          source: platform,
          account: account || undefined,
          q: q || undefined,
          market: market || undefined,
          account_mode: query.accountMode,
        });
      } catch (e) {
        error = brokerError(e);
      }
      // A database failure is not the broker's: it is thrown, not served stale.
      if (fetched) {
        await this.store(platform, account, fetched);
        state = await this.state(platform, account);
      }
    }

    const [symbols, markets] = await Promise.all([
      this.symbols(platform, account, q, market, query.limit),
      this.marketCounts(platform, account),
    ]);
    return {
      platform,
      account,
      complete: state?.complete ?? false,
      refreshed_at: state ? new Date(state.refreshed_at).toISOString() : null,
      stale: error !== undefined && state !== null,
      markets,
      symbols,
      ...(error !== undefined ? { error } : {}),
    };
  }

  private async state(
    platform: string,
    account: string
  ): Promise<{ complete: boolean; refreshed_at: string | Date } | null> {
    const { rows } = await this.db.query(
      `SELECT complete, refreshed_at FROM broker_symbol_lists WHERE platform = $1 AND account = $2`,
      [platform, account]
    );
    return rows[0] ?? null;
  }

  private async hasPrefix(
    platform: string,
    account: string,
    q: string,
    market: string
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM broker_symbols
        WHERE platform = $1 AND account = $2 AND ($3::text = '' OR market = $3::text)
          AND ${BARE('symbol')} ILIKE ${BARE('$4::text')} || '%'
        LIMIT 1`,
      [platform, account, market, q]
    );
    return rows.length > 0;
  }

  /**
   * Store what the broker sent: a whole list replaces the old one; search
   * results are added to it.
   */
  private async store(platform: string, account: string, fetched: FetchedCatalogue) {
    const rows = toRows(fetched?.instruments ?? []);
    const complete = Boolean(fetched?.complete);
    await this.db.transaction(async (client) => {
      if (complete) {
        await client.query(`DELETE FROM broker_symbols WHERE platform = $1 AND account = $2`, [
          platform,
          account,
        ]);
      }
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH);
        const column = (key: keyof CatalogueSymbol) => batch.map((r) => r[key]);
        await client.query(
          `INSERT INTO broker_symbols
             (platform, account, symbol, name, market, sec_type, currency, exchange, venue_id, updated_at)
           SELECT $1, $2, s, n, m, t, c, e, v, NOW()
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
               AS u(s, n, m, t, c, e, v)
           ON CONFLICT (platform, account, symbol, sec_type) DO UPDATE SET
             name = EXCLUDED.name, market = EXCLUDED.market, currency = EXCLUDED.currency,
             exchange = EXCLUDED.exchange, venue_id = EXCLUDED.venue_id, updated_at = NOW()`,
          [
            platform,
            account,
            column('symbol'),
            column('name'),
            column('market'),
            column('sec_type'),
            column('currency'),
            column('exchange'),
            column('venue_id'),
          ]
        );
      }
      await client.query(
        `INSERT INTO broker_symbol_lists (platform, account, complete, symbol_count, refreshed_at)
         VALUES ($1::text, $2::text, $3,
                 (SELECT COUNT(*) FROM broker_symbols WHERE platform = $1::text AND account = $2::text),
                 NOW())
         ON CONFLICT (platform, account) DO UPDATE SET
           complete = EXCLUDED.complete, symbol_count = EXCLUDED.symbol_count,
           refreshed_at = EXCLUDED.refreshed_at`,
        [platform, account, complete]
      );
    });
  }

  private async symbols(
    platform: string,
    account: string,
    q: string,
    market: string,
    limit = 200
  ): Promise<CatalogueSymbol[]> {
    const { rows } = await this.db.query(
      `SELECT symbol, name, market, sec_type, currency, exchange, venue_id
         FROM broker_symbols
        WHERE platform = $1 AND account = $2 AND ($3::text = '' OR market = $3::text)
          AND ($4::text = '' OR ${BARE('symbol')} ILIKE ${BARE('$4::text')} || '%' OR name ILIKE '%' || $4 || '%')
        ORDER BY (upper(${BARE('symbol')}) = upper(${BARE('$4::text')})) DESC,
                 (${BARE('symbol')} ILIKE ${BARE('$4::text')} || '%') DESC,
                 symbol
        LIMIT $5`,
      [platform, account, market, q, Math.max(1, Math.min(Math.trunc(limit) || 200, 1000))]
    );
    return rows as CatalogueSymbol[];
  }

  private async marketCounts(
    platform: string,
    account: string
  ): Promise<Array<{ market: string; count: number }>> {
    const { rows } = await this.db.query(
      `SELECT market, COUNT(*)::int AS count FROM broker_symbols
        WHERE platform = $1 AND account = $2 GROUP BY market`,
      [platform, account]
    );
    const order = (m: string) => {
      const i = (MARKETS as readonly string[]).indexOf(m);
      return i < 0 ? MARKETS.length : i;
    };
    return (rows as Array<{ market: string; count: number }>)
      .map((r) => ({ market: r.market, count: Number(r.count) }))
      .sort((a, b) => order(a.market) - order(b.market));
  }
}
