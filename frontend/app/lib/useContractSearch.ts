'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from './api';
import type { ContractResult, MarketData } from '../components/marketData/types';

export interface AdvancedSearchFields {
  expiry: string;
  strike: string;
  right: string;
  multiplier: string;
  includeExpired: boolean;
}

export interface ContractSearchParams {
  symbol: string;
  secType: string;
  exchange: string;
  currency: string;
  searchByName: boolean;
  /** Present when the advanced form is open; drives the advanced endpoint. */
  advanced?: AdvancedSearchFields;
}

export interface ContractSearchState {
  connectionStatus: string;
  searchResults: ContractResult[];
  selectedContract: ContractResult | null;
  marketData: MarketData | null;
  loading: boolean;
  error: string | null;
  showChart: boolean;
  searchHistory: string[];
  checkConnection: () => Promise<void>;
  search: (params: ContractSearchParams) => Promise<void>;
  selectContract: (contract: ContractResult) => Promise<void>;
  showChartNow: () => void;
  reset: () => void;
}

/**
 * Owns the contract-search data flow for the home-page market-data filter:
 * the IB health probe, the (basic/advanced) contract search, per-contract
 * real-time quote fetch, and the derived results/selection/error state. The
 * component keeps the form inputs; this hook keeps everything fetched.
 */
export function useContractSearch(accountMode: 'paper' | 'live'): ContractSearchState {
  const [connectionStatus, setConnectionStatus] = useState('Checking...');
  const [searchResults, setSearchResults] = useState<ContractResult[]>([]);
  const [selectedContract, setSelectedContract] = useState<ContractResult | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  const checkConnection = useCallback(async () => {
    try {
      // /api/health is on the auth allow-list; skipAuth keeps the request lean.
      const response = await apiFetch(`/api/health`, { skipAuth: true });
      setConnectionStatus(response.ok ? 'Connected' : 'Error');
    } catch {
      setConnectionStatus('Disconnected');
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const reset = useCallback(() => {
    setSearchResults([]);
    setSelectedContract(null);
    setMarketData(null);
    setShowChart(false);
    setError(null);
  }, []);

  const search = useCallback(
    async (params: ContractSearchParams) => {
      const isAdvanced = !!params.advanced;

      // For basic search, a symbol is required; advanced search allows an empty
      // symbol (filter-only queries).
      if (!isAdvanced && !params.symbol.trim()) {
        setError('Please enter a symbol to search');
        return;
      }

      setLoading(true);
      setError(null);
      setSearchResults([]);
      setSelectedContract(null);
      setMarketData(null);
      setShowChart(false);

      try {
        const endpoint = isAdvanced
          ? '/api/market-data/advanced-search'
          : '/api/market-data/search';

        const searchPayload = isAdvanced
          ? {
              symbol: params.symbol.trim().toUpperCase() || '',
              secType: params.secType,
              exchange: params.exchange,
              currency: params.currency,
              expiry: params.advanced!.expiry,
              strike: params.advanced!.strike ? parseFloat(params.advanced!.strike) : undefined,
              right: params.advanced!.right,
              multiplier: params.advanced!.multiplier,
              includeExpired: params.advanced!.includeExpired,
              searchByName: params.searchByName,
              account_mode: accountMode,
            }
          : {
              symbol: params.symbol.trim().toUpperCase(),
              secType: params.secType,
              exchange: params.exchange,
              currency: params.currency,
              searchByName: params.searchByName,
              account_mode: accountMode,
            };

        const response = await apiFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(searchPayload),
        });

        if (!response.ok) {
          throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.results && data.results.length > 0) {
          setSearchResults(data.results);

          // Save to search history
          if (params.symbol.trim()) {
            const upper = params.symbol.trim().toUpperCase();
            setSearchHistory((prev) => [upper, ...prev.filter((h) => h !== upper)].slice(0, 10));
          }
        } else {
          setError('No contracts found for the specified criteria');
        }
      } catch (err) {
        console.error('Search error:', err);
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    },
    [accountMode]
  );

  const selectContract = useCallback(
    async (contract: ContractResult) => {
      setSelectedContract(contract);
      setMarketData(null);
      setLoading(true);

      try {
        const response = await apiFetch(
          `/api/market-data/realtime?symbol=${contract.symbol}&conid=${contract.conid}&account_mode=${accountMode}`
        );

        if (response.ok) {
          const data = await response.json();
          setMarketData(data);
        }
      } catch (err) {
        console.error('Market data error:', err);
      } finally {
        setLoading(false);
      }
    },
    [accountMode]
  );

  const showChartNow = useCallback(() => setShowChart(true), []);

  return {
    connectionStatus,
    searchResults,
    selectedContract,
    marketData,
    loading,
    error,
    showChart,
    searchHistory,
    checkConnection,
    search,
    selectContract,
    showChartNow,
    reset,
  };
}
