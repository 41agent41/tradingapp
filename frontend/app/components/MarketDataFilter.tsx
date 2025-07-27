'use client';

import React, { useState, useEffect } from 'react';
import EnhancedTradingChart from './EnhancedTradingChart';
import { useTradingAccount } from '../contexts/TradingAccountContext';

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
  primaryExchange?: string;
  localSymbol?: string;
  tradingClass?: string;
  multiplier?: string;
  strike?: string;
  right?: string;
  expiry?: string;
  includeExpired?: boolean;
  comboLegsDescrip?: string;
  contractMonth?: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  timeZoneId?: string;
  tradingHours?: string;
  liquidHours?: string;
  evRule?: string;
  evMultiplier?: string;
  secIdList?: any[];
  aggGroup?: string;
  underSymbol?: string;
  underSecType?: string;
  marketRuleIds?: string;
  realExpirationDate?: string;
  lastTradingDay?: string;
  stockType?: string;
  minSize?: string;
  sizeIncrement?: string;
  suggestedSizeIncrement?: string;
  sections?: any[];
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
  { value: 'WAR', label: 'Warrants', description: 'Stock Warrants' },
  { value: 'FUND', label: 'Funds', description: 'Mutual Funds' },
  { value: 'IND', label: 'Indices', description: 'Market Indices' },
  { value: 'BAG', label: 'Baskets', description: 'Basket Products' }
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

const POPULAR_SYMBOLS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'META', name: 'Meta Platforms Inc.' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF' }
];

export default function MarketDataFilter() {
  const { accountMode, dataType } = useTradingAccount();
  
  // Basic filter state
  const [symbol, setSymbol] = useState('');
  const [securityType, setSecurityType] = useState('STK');
  const [exchange, setExchange] = useState('SMART');
  const [currency, setCurrency] = useState('USD');
  const [timeframe, setTimeframe] = useState('1hour');
  const [searchByName, setSearchByName] = useState(false);

  // Advanced filter state
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [strike, setStrike] = useState('');
  const [right, setRight] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);

  // Results state
  const [searchResults, setSearchResults] = useState<ContractResult[]>([]);
  const [selectedContract, setSelectedContract] = useState<ContractResult | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState('Checking...');
  
  // Search history
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  
  // Track if search should be auto-triggered
  const [autoSearchTrigger, setAutoSearchTrigger] = useState<string | null>(null);

  useEffect(() => {
    checkConnection();
  }, []);

  // Auto-trigger search when autoSearchTrigger changes
  useEffect(() => {
    if (autoSearchTrigger && symbol === autoSearchTrigger) {
      handleSearch();
      setAutoSearchTrigger(null); // Reset after triggering
    }
  }, [autoSearchTrigger, symbol]);

  const checkConnection = async () => {
    try {
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || process.env.NEXT_PUBLIC_API_URL;
      if (!backendUrl) {
        setConnectionStatus('Error');
        return;
      }
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
    // For advanced search, symbol is optional
    if (!showAdvancedSearch && !symbol.trim()) {
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
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || process.env.NEXT_PUBLIC_API_URL;
      if (!backendUrl) {
        throw new Error('NEXT_PUBLIC_API_URL is not configured');
      }

      const endpoint = showAdvancedSearch ? '/api/market-data/advanced-search' : '/api/market-data/search';
      
      const searchPayload = showAdvancedSearch ? {
        symbol: symbol.trim().toUpperCase() || '',
        secType: securityType,
        exchange: exchange,
        currency: currency,
        expiry: expiry,
        strike: strike ? parseFloat(strike) : undefined,
        right: right,
        multiplier: multiplier,
        includeExpired: includeExpired,
        searchByName: searchByName,
        account_mode: accountMode
      } : {
        symbol: symbol.trim().toUpperCase(),
        secType: securityType,
        exchange: exchange,
        currency: currency,
        searchByName: searchByName,
        account_mode: accountMode
      };

      const response = await fetch(`${backendUrl}${endpoint}`, {
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
        if (symbol.trim()) {
          const newHistory = [symbol.trim().toUpperCase(), ...searchHistory.filter(h => h !== symbol.trim().toUpperCase())].slice(0, 10);
          setSearchHistory(newHistory);
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
  };

  const handleContractSelect = async (contract: ContractResult) => {
    setSelectedContract(contract);
    setMarketData(null);
    setLoading(true);

    try {
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || process.env.NEXT_PUBLIC_API_URL;
      if (!backendUrl) {
        throw new Error('NEXT_PUBLIC_API_URL is not configured');
      }
      const response = await fetch(
        `${backendUrl}/api/market-data/realtime?symbol=${contract.symbol}&conid=${contract.conid}&account_mode=${accountMode}`
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

  const handleQuickSearch = async (quickSymbol: string) => {
    // Clear any previous errors
    setError(null);
    
    // Clear previous results
    setSearchResults([]);
    setSelectedContract(null);
    setMarketData(null);
    setShowChart(false);
    
    // Update state
    setSymbol(quickSymbol);
    setSecurityType('STK');
    setExchange('SMART');
    setCurrency('USD');
    
    // Set the auto-search trigger
    setAutoSearchTrigger(quickSymbol);
  };

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${
                connectionStatus === 'Connected' ? 'bg-green-500' : 
                connectionStatus === 'Checking...' ? 'bg-yellow-500' : 'bg-red-500'
              }`}></div>
              <span className="text-sm font-medium">{connectionStatus}</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${
                accountMode === 'live' ? 'bg-red-500' : 'bg-green-500'
              }`}></div>
              <span className="text-sm font-medium">
                {accountMode.toUpperCase()} Mode • {dataType === 'real-time' ? 'Live Data' : 'Delayed Data'}
              </span>
            </div>
          </div>
          <button
            onClick={checkConnection}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Quick Search */}
      <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-lg">⚡</span>
          <h3 className="text-lg font-medium text-gray-900">Quick Search</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {POPULAR_SYMBOLS.map((item) => (
            <button
              key={item.symbol}
              onClick={() => handleQuickSearch(item.symbol)}
              className="p-2 text-sm bg-gray-100 hover:bg-blue-100 text-gray-700 hover:text-blue-700 rounded-md transition-colors"
            >
              <div className="font-medium">{item.symbol}</div>
              <div className="text-xs text-gray-500 truncate">{item.name}</div>
            </button>
          ))}
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
            
            {/* Search History */}
            {searchHistory.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-gray-500 mb-1">Recent searches:</div>
                <div className="flex flex-wrap gap-1">
                  {searchHistory.slice(0, 5).map((item) => (
                    <button
                      key={item}
                      onClick={() => handleQuickSearch(item)}
                      className="text-xs bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-600 px-2 py-1 rounded transition-colors"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}
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

        {/* Advanced Search Toggle */}
        <div className="flex justify-between items-center mb-4">
          <button
            onClick={() => setShowAdvancedSearch(!showAdvancedSearch)}
            className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
          >
            <span>{showAdvancedSearch ? '▼' : '▶'}</span>
            <span>Advanced Search Options</span>
          </button>
        </div>

        {/* Advanced Search Fields */}
        {showAdvancedSearch && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 p-4 bg-gray-50 rounded-md">
            {/* Expiry Date */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Expiry Date
              </label>
              <input
                type="text"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                placeholder="YYYYMMDD or YYYYMM"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Strike Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Strike Price
              </label>
              <input
                type="number"
                step="0.01"
                value={strike}
                onChange={(e) => setStrike(e.target.value)}
                placeholder="e.g., 150.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Option Right */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Option Right
              </label>
              <select
                value={right}
                onChange={(e) => setRight(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Any</option>
                <option value="C">Call</option>
                <option value="P">Put</option>
              </select>
            </div>

            {/* Multiplier */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Multiplier
              </label>
              <input
                type="text"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
                placeholder="e.g., 100"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Include Expired */}
            <div className="flex items-center">
              <label className="flex items-center text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={includeExpired}
                  onChange={(e) => setIncludeExpired(e.target.checked)}
                  className="mr-2"
                />
                Include Expired Contracts
              </label>
            </div>
          </div>
        )}

        {/* Search Buttons */}
        <div className="flex justify-between items-center">
          <button
            onClick={() => {
              setSymbol('');
              setSearchResults([]);
              setSelectedContract(null);
              setMarketData(null);
              setShowChart(false);
              setError(null);
            }}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm"
          >
            Clear Search
          </button>
          
          <div className="flex space-x-2">
            <button
              onClick={handleSearch}
              disabled={loading || (!showAdvancedSearch && !symbol.trim())}
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
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="text-red-800">❌ {error}</div>
        </div>
      )}

      {/* Search Tips */}
      {!searchResults.length && !loading && !error && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
          <div className="flex items-start space-x-2">
            <span className="text-blue-600 text-lg">💡</span>
            <div>
              <div className="text-blue-800 font-medium mb-1">Search Tips:</div>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• Use Quick Search buttons for popular stocks</li>
                <li>• Try searching by company name (check "Search by company name")</li>
                <li>• Use Advanced Search for options, futures, and specific criteria</li>
                <li>• For options: specify expiry (YYYYMMDD), strike price, and right (C/P)</li>
                <li>• For futures: specify expiry and multiplier</li>
                <li>• Recent searches are saved for quick access</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            📊 Search Results ({searchResults.length})
          </h3>
          <div className="space-y-3">
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
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-1">
                      <div className="font-medium text-gray-900">
                        {contract.symbol}
                      </div>
                      <div className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        {contract.secType}
                      </div>
                      {contract.exchange && contract.exchange !== 'SMART' && (
                        <div className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                          {contract.exchange}
                        </div>
                      )}
                    </div>
                    
                    <div className="text-sm text-gray-700 mb-2">
                      {contract.companyName}
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                      {contract.currency && (
                        <div>Currency: {contract.currency}</div>
                      )}
                      {contract.primaryExchange && (
                        <div>Primary: {contract.primaryExchange}</div>
                      )}
                      {contract.expiry && (
                        <div>Expiry: {contract.expiry}</div>
                      )}
                      {contract.strike && (
                        <div>Strike: {contract.strike}</div>
                      )}
                      {contract.right && (
                        <div>Right: {contract.right === 'C' ? 'Call' : 'Put'}</div>
                      )}
                      {contract.multiplier && (
                        <div>Multiplier: {contract.multiplier}</div>
                      )}
                      {contract.tradingClass && (
                        <div>Class: {contract.tradingClass}</div>
                      )}
                      {contract.industry && (
                        <div>Industry: {contract.industry}</div>
                      )}
                    </div>
                    
                    {contract.tradingHours && (
                      <div className="text-xs text-gray-500 mt-1">
                        Trading Hours: {contract.tradingHours}
                      </div>
                    )}
                  </div>
                  
                  <div className="text-xs text-gray-500 ml-4">
                    <div>ID: {contract.conid}</div>
                    {contract.localSymbol && (
                      <div>Local: {contract.localSymbol}</div>
                    )}
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