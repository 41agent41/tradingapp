/**
 * Shared constants, types and helpers for the market-data route modules.
 *
 * The market-data endpoints were split out of a single ~870-line
 * `routes/marketData.ts` (GAP_ANALYSIS §3.4) into one module per resource:
 *
 *   search.ts     — POST /search, POST /search/advanced
 *   history.ts    — GET  /history
 *   realtime.ts   — GET  /realtime
 *   indicators.ts — GET  /indicators, GET /indicators/available
 *   database.ts   — GET  /database/stats, POST /upload, POST /database/clean
 *
 * `routes/marketData.ts` re-assembles them into the single router mounted at
 * `/api/market-data`, so the public surface is unchanged.
 */
import type { Request, Response } from 'express';

export const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Cache TTLs (seconds). Tunable via env so operators don't have to redeploy.
export const REALTIME_CACHE_TTL = parseInt(process.env.CACHE_TTL_REALTIME || '2', 10);

export const VALID_TIMEFRAMES = [
  'tick',
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '1day',
];

export const VALID_SEC_TYPES = [
  'STK',
  'OPT',
  'FUT',
  'CASH',
  'BOND',
  'CFD',
  'CMDTY',
  'CRYPTO',
  'WAR',
  'FUND',
  'IND',
  'BAG',
];

// Interface for market data request parameters
export interface MarketDataQuery {
  symbol: string;
  timeframe: string;
  period: string;
}

// Interface for search request parameters
export interface SearchQuery {
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
  searchByName?: boolean;
  account_mode?: string;
}

// Interface for advanced search request parameters
export interface AdvancedSearchQuery {
  symbol?: string;
  secType: string;
  exchange?: string;
  currency?: string;
  expiry?: string;
  strike?: number;
  right?: string;
  multiplier?: string;
  includeExpired?: boolean;
  searchByName?: boolean;
  account_mode?: string;
}

export function cacheKey(parts: Array<string | number | boolean | undefined | null>): string {
  return parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|');
}

// Helper function to check if data query is enabled via headers
export function isDataQueryEnabled(req: Request): boolean {
  const enabled = req.headers['x-data-query-enabled'];
  if (typeof enabled === 'string') {
    return enabled.toLowerCase() === 'true';
  }
  if (Array.isArray(enabled)) {
    return enabled[0]?.toLowerCase() === 'true';
  }
  return false;
}

// Helper function to handle disabled data query response
export function handleDisabledDataQuery(res: Response, message: string) {
  return res.status(200).json({
    disabled: true,
    message: message,
    timestamp: new Date().toISOString(),
  });
}
