'use client';

import React, { useState, useEffect } from 'react';
import EnhancedTradingChart from './EnhancedTradingChart';

interface SecurityType {
  value: string;
  label: string;
  description: string;
}

interface Exchange {
  value: string;
  label: string;
}

interface Currency {
  value: string;
  label: string;
}

interface Timeframe {
  value: string;
  label: string;
  minutes: number;
}

interface ContractResult {
  conid: string;
  symbol: string;
  companyName: string;
  description: string;
  secType: string;
  currency?: string;
  exchange?: string;
}

interface MarketData {
  symbol: string;
  last?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  change?: number;
  changePercent?: number;
}

const SECURITY_TYPES: SecurityType[] = [
  { value: 'STK', label: 'Stocks', description: 'Stocks and ETFs' },
  { value: 'OPT', label: 'Options', description: 'Stock and Index Options' },
  { value: 'FUT', label: 'Futures', description: 'Futures Contracts' },
  { value: 'CASH', label: 'Forex', description: 'Currency Pairs' },
  { value: 'BOND', label: 'Bonds', description: 'Fixed Income' },
  { value: 'CFD', label: 'CFDs', description: 'Contracts for Difference' },
  { value: 'CMDTY', label: 'Commodities', description: 'Commodity Contracts' },
  { value: 'CRYPTO', label: 'Crypto', description: 'Cryptocurrencies' },
  { value: 'FUND', label: 'Funds', description: 'Mutual Funds' },
  { value: 'IND', label: 'Indices', description: 'Market Indices' }
];

const EXCHANGES: Exchange[] = [
  { value: 'SMART', label: 'SMART (Best Execution)' },
  { value: 'NYSE', label: 'New York Stock Exchange' },
  { value: 'NASDAQ', label: 'NASDAQ' },
  { value: 'AMEX', label: 'American Stock Exchange' },
  { value: 'EUREX', label: 'Eurex' },
  { value: 'LSE', label: 'London Stock Exchange' },
  { value: 'TSE', label: 'Tokyo Stock Exchange' },
  { value: 'IDEALPRO', label: 'Forex (IDEALPRO)' },
  { value: 'CME', label: 'Chicago Mercantile Exchange' },
  { value: 'CBOE', label: 'Chicago Board Options Exchange' }
];

const CURRENCIES: Currency[] = [
  { value: 'USD', label: 'US Dollar' },
  { value: 'EUR', label: 'Euro' },
  { value: 'GBP', label: 'British Pound' },
  { value: 'JPY', label: 'Japanese Yen' },
  { value: 'CAD', label: 'Canadian Dollar' },
  { value: 'AUD', label: 'Australian Dollar' },
  { value: 'CHF', label: 'Swiss Franc' },
  { value: 'HKD', label: 'Hong Kong Dollar' }
];

const TIMEFRAMES: Timeframe[] = [
  { value: '5min', label: '5m', minutes: 5 },
  { value: '15min', label: '15m', minutes: 15 },
  { value: '30min', label: '30m', minutes: 30 },
  { value: '1hour', label: '1h', minutes: 60 },
  { value: '4hour', label: '4h', minutes: 240 },
  { value: '8hour', label: '8h', minutes: 480 },
  { value: '1day', label: '1d', minutes: 1440 }
];

export default function MarketDataFilter() {
  // Filter state
  const [symbol, setSymbol] = useState('');
  const [securityType, setSecurityType] = useState('STK');
  const [exchange, setExchange] = useState('SMART');
  const [currency, setCurrency] = useState('USD');
  const [timeframe, setTimeframe] = useState('1hour');
  const [searchByName, setSearchByName] = useState(false);

  // Results state
  const [searchResults, setSearchResults] = useState<ContractResult[]>([]);
  const [selectedContract, setSelectedContract] = useState<ContractResult | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState('Checking...');

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || 'http://localhost:4000';
      const response = await fetch(`${backendUrl}/api/health`);
      if (response.ok) {
        setConnectionStatus('Connected');
      } else {
        setConnectionStatus('Error');
      }
    } catch (error) {
      setConnectionStatus('Disconnected');
    }
  };

  const handleSearch = async () => {
    if (!symbol.trim()) {
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
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || 'http://localhost:4000';
      const response = await fetch(`${backendUrl}/api/market-data/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          secType: securityType,
          exchange: exchange,
          currency: currency,
          searchByName: searchByName
        }),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.results && data.results.length > 0) {
        setSearchResults(data.results);
      } else {
        setError('No contracts found for the specified criteria');
      }
    } catch (err) {
      console.error('Search error:', err);
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleContractSelect = async (contract: ContractResult) => {
    setSelectedContract(contract);
    setMarketData(null);
    setLoading(true);

    try {
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || 'http://localhost:4000';
      const response = await fetch(
        `${backendUrl}/api/market-data/realtime?symbol=${contract.symbol}&conid=${contract.conid}`
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
  };

  const handleShowChart = () => {
    setShowChart(true);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className={`w-3 h-3 rounded-full ${
              connectionStatus === 'Connected' ? 'bg-green-500' : 
              connectionStatus === 'Checking...' ? 'bg-yellow-500' : 'bg-red-500'
            }`}></div>
            <span className="text-sm font-medium">{connectionStatus}</span>
          </div>
          <button
            onClick={checkConnection}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Search Filters */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-lg">🔍</span>
          <h3 className="text-lg font-medium text-gray-900">Search Filters</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {/* Symbol Search */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Symbol / Company Name
            </label>
            <div className="relative">
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="e.g., AAPL, Microsoft"
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <span className="absolute left-3 top-2.5 text-gray-400">🔍</span>
            </div>
            <div className="mt-1">
              <label className="flex items-center text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={searchByName}
                  onChange={(e) => setSearchByName(e.target.checked)}
                  className="mr-2"
                />
                Search by company name
              </label>
            </div>
          </div>

          {/* Security Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Security Type
            </label>
            <select
              value={securityType}
              onChange={(e) => setSecurityType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {SECURITY_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label} - {type.description}
                </option>
              ))}
            </select>
          </div>

          {/* Exchange */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Exchange
            </label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {EXCHANGES.map((ex) => (
                <option key={ex.value} value={ex.value}>
                  {ex.label}
                </option>
              ))}
            </select>
          </div>

          {/* Currency */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Currency
            </label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {CURRENCIES.map((curr) => (
                <option key={curr.value} value={curr.value}>
                  {curr.label} ({curr.value})
                </option>
              ))}
            </select>
          </div>

          {/* Timeframe */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Timeframe
            </label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf.value} value={tf.value}>
                  {tf.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Search Button */}
        <div className="flex justify-end">
          <button
            onClick={handleSearch}
            disabled={loading || !symbol.trim()}
            className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
          >
            {loading ? (
              <span className="animate-spin">↻</span>
            ) : (
              <span>🔍</span>
            )}
            <span>{loading ? 'Searching...' : 'Search'}</span>
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="text-red-800">❌ {error}</div>
        </div>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            📊 Search Results ({searchResults.length})
          </h3>
          <div className="space-y-2">
            {searchResults.map((contract) => (
              <div
                key={contract.conid}
                onClick={() => handleContractSelect(contract)}
                className={`p-4 border rounded-md cursor-pointer transition-colors ${
                  selectedContract?.conid === contract.conid
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">
                      {contract.symbol} - {contract.companyName}
                    </div>
                    <div className="text-sm text-gray-600">
                      {contract.description} • {contract.secType}
                      {contract.currency && ` • ${contract.currency}`}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500">
                    ID: {contract.conid}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Market Data Display */}
      {selectedContract && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <span className="text-lg text-green-500">📈</span>
              <h3 className="text-lg font-medium text-gray-900">
                Market Data - {selectedContract.symbol}
              </h3>
            </div>
            
            <div className="flex space-x-2">
              <button
                onClick={handleShowChart}
                className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 flex items-center space-x-2"
              >
                <span>📊</span>
                <span>View Chart</span>
              </button>
            </div>
          </div>
          
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="animate-spin mr-2">↻</span>
              <span className="text-gray-600">Loading market data...</span>
            </div>
          ) : marketData ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-gray-50 rounded-md">
                <div className="text-sm text-gray-600">Last Price</div>
                <div className="text-xl font-bold text-gray-900">
                  ${marketData.last?.toFixed(2) || 'N/A'}
                </div>
              </div>
              <div className="text-center p-4 bg-gray-50 rounded-md">
                <div className="text-sm text-gray-600">Bid</div>
                <div className="text-xl font-bold text-blue-600">
                  ${marketData.bid?.toFixed(2) || 'N/A'}
                </div>
              </div>
              <div className="text-center p-4 bg-gray-50 rounded-md">
                <div className="text-sm text-gray-600">Ask</div>
                <div className="text-xl font-bold text-red-600">
                  ${marketData.ask?.toFixed(2) || 'N/A'}
                </div>
              </div>
              <div className="text-center p-4 bg-gray-50 rounded-md">
                <div className="text-sm text-gray-600">Volume</div>
                <div className="text-xl font-bold text-gray-900">
                  {marketData.volume?.toLocaleString() || 'N/A'}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              No market data available
            </div>
          )}
        </div>
      )}

      {/* Enhanced Trading Chart */}
      {selectedContract && showChart && (
        <EnhancedTradingChart
          contract={selectedContract}
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
        />
      )}
    </div>
  );
} 