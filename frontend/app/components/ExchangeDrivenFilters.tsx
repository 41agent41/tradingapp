'use client';

import React, { useState, useEffect } from 'react';

// Exchange and Security Type definitions for US and Australian markets
const EXCHANGES = {
  US: [
    { value: 'SMART', label: 'SMART (Best Execution)', description: 'Automated routing for best execution' },
    { value: 'NASDAQ', label: 'NASDAQ', description: 'National Association of Securities Dealers Automated Quotations' },
    { value: 'NYSE', label: 'NYSE', description: 'New York Stock Exchange' },
    { value: 'ARCA', label: 'ARCA', description: 'NYSE Arca Exchange' },
    { value: 'BATS', label: 'BATS', description: 'BATS Exchange' },
    { value: 'EDGX', label: 'EDGX', description: 'CBOE EDGX Exchange' },
    { value: 'EDGA', label: 'EDGA', description: 'CBOE EDGA Exchange' },
    { value: 'IEX', label: 'IEX', description: 'Investors Exchange' },
    { value: 'LTSE', label: 'LTSE', description: 'Long-Term Stock Exchange' },
    { value: 'PSX', label: 'PSX', description: 'NASDAQ PSX' }
  ],
  AU: [
    { value: 'ASX', label: 'ASX', description: 'Australian Securities Exchange' },
    { value: 'ASXCEN', label: 'ASX Centre Point', description: 'ASX Centre Point Dark Pool' },
    { value: 'CHIXAU', label: 'CBOE Australia', description: 'CBOE Australia (formerly Chi-X)' },
    { value: 'SNFE', label: 'Sydney Futures Exchange', description: 'Futures and options exchange' },
    { value: 'NSX', label: 'NSX', description: 'National Stock Exchange of Australia' },
    { value: 'SSX', label: 'Sydney Stock Exchange', description: 'Sydney Stock Exchange' },
    { value: 'AXHX', label: 'Australian Securities Exchange Historical', description: 'ASX Historical Exchange' },
    { value: 'SMART', label: 'SMART (Best Execution)', description: 'Automated routing for best execution across AU markets' }
  ]
};

const SECURITY_TYPES = {
  US: [
    { value: 'STK', label: 'Stock', description: 'Common and preferred stocks' },
    { value: 'OPT', label: 'Option', description: 'Stock and index options' },
    { value: 'ETF', label: 'ETF', description: 'Exchange Traded Funds' },
    { value: 'FUT', label: 'Future', description: 'Futures contracts' },
    { value: 'CASH', label: 'Forex', description: 'Foreign exchange pairs' },
    { value: 'BOND', label: 'Bond', description: 'Government and corporate bonds' },
    { value: 'CRYPTO', label: 'Cryptocurrency', description: 'Digital currencies' }
  ],
  AU: [
    { value: 'STK', label: 'Stock', description: 'Australian stocks' },
    { value: 'OPT', label: 'Option', description: 'Australian options' },
    { value: 'ETF', label: 'ETF', description: 'Australian ETFs' },
    { value: 'FUT', label: 'Future', description: 'Australian futures' },
    { value: 'CASH', label: 'Forex', description: 'Foreign exchange pairs' },
    { value: 'BOND', label: 'Bond', description: 'Australian government and corporate bonds' },
    { value: 'WAR', label: 'Warrant', description: 'Warrants and structured products' }
  ]
};

const CURRENCIES = {
  US: [
    { value: 'USD', label: 'USD', description: 'US Dollar' },
    { value: 'EUR', label: 'EUR', description: 'Euro' },
    { value: 'GBP', label: 'GBP', description: 'British Pound' },
    { value: 'JPY', label: 'JPY', description: 'Japanese Yen' },
    { value: 'CAD', label: 'CAD', description: 'Canadian Dollar' }
  ],
  AU: [
    { value: 'AUD', label: 'AUD', description: 'Australian Dollar' },
    { value: 'USD', label: 'USD', description: 'US Dollar' },
    { value: 'EUR', label: 'EUR', description: 'Euro' },
    { value: 'GBP', label: 'GBP', description: 'British Pound' },
    { value: 'JPY', label: 'JPY', description: 'Japanese Yen' }
  ]
};

// Popular symbols by exchange and security type
const POPULAR_SYMBOLS: Record<string, Record<string, string[]>> = {
  'NASDAQ': {
    'STK': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'NFLX', 'ADBE', 'CRM'],
    'ETF': ['QQQ', 'TQQQ', 'SQQQ', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLU', 'XLY']
  },
  'NYSE': {
    'STK': ['JPM', 'JNJ', 'PG', 'UNH', 'HD', 'MA', 'V', 'DIS', 'PYPL', 'BAC'],
    'ETF': ['SPY', 'VTI', 'VOO', 'IVV', 'DIA', 'IWM', 'GLD', 'SLV', 'TLT', 'VEA']
  },
  'ASX': {
    'STK': ['CBA', 'CSL', 'NAB', 'ANZ', 'WBC', 'BHP', 'RIO', 'WES', 'WOW', 'MQG'],
    'ETF': ['VAS', 'VGS', 'VAF', 'VGE', 'VGT', 'VISM', 'VESG', 'VDHG', 'VTS', 'VEU'],
    'OPT': ['CBAO', 'CSLO', 'BHPO', 'WBCO', 'NABO', 'ANZO', 'RIOO', 'WESO', 'MQGO', 'TLSO'],
    'WAR': ['CBAW', 'CSLW', 'BHPW', 'WBCW', 'NABW', 'ANZW', 'RIOW', 'WESW', 'MQGW', 'TLSW']
  },
  'SNFE': {
    'FUT': ['SPI', 'YT', 'IR', 'XT', 'TF', 'CF', 'WF', 'SF', 'MF', 'BF'],
    'OPT': ['SPIO', 'YTO', 'IRO', 'XTO', 'TFO', 'CFO', 'WFO', 'SFO', 'MFO', 'BFO']
  },
  'CHIXAU': {
    'STK': ['CBA', 'CSL', 'NAB', 'ANZ', 'WBC', 'BHP', 'RIO', 'WES', 'WOW', 'MQG'],
    'ETF': ['VAS', 'VGS', 'VAF', 'VGE', 'VGT', 'VISM', 'VESG', 'VDHG', 'VTS', 'VEU']
  }
};

interface FilterState {
  region: 'US' | 'AU';
  exchange: string;
  secType: string;
  symbol: string;
  currency: string;
  searchTerm: string;
}

interface ExchangeDrivenFiltersProps {
  onFiltersChange: (filters: FilterState) => void;
  disabled?: boolean;
}

export default function ExchangeDrivenFilters({ onFiltersChange, disabled = false }: ExchangeDrivenFiltersProps) {
  const [filters, setFilters] = useState<FilterState>({
    region: 'US',
    exchange: 'SMART',
    secType: 'STK',
    symbol: '',
    currency: 'USD',
    searchTerm: ''
  });

  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Get available exchanges for selected region
  const getAvailableExchanges = () => EXCHANGES[filters.region];

  // Get available security types for selected region
  const getAvailableSecTypes = () => SECURITY_TYPES[filters.region];

  // Get available currencies for selected region
  const getAvailableCurrencies = () => CURRENCIES[filters.region];

  // Get popular symbols for selected exchange and secType
  const getPopularSymbols = () => {
    const exchangeSymbols = POPULAR_SYMBOLS[filters.exchange];
    if (!exchangeSymbols) return [];
    return exchangeSymbols[filters.secType] || [];
  };

  // Update filters and notify parent
  const updateFilters = (updates: Partial<FilterState>) => {
    const newFilters = { ...filters, ...updates };
    setFilters(newFilters);
    onFiltersChange(newFilters);
  };

  // Handle region change
  const handleRegionChange = (region: 'US' | 'AU') => {
    const newFilters = {
      region,
      exchange: region === 'US' ? 'SMART' : 'ASX',
      secType: 'STK',
      symbol: '',
      currency: region === 'US' ? 'USD' : 'AUD',
      searchTerm: ''
    };
    setFilters(newFilters);
    onFiltersChange(newFilters);
    setSearchResults([]);
  };

  // Handle exchange change
  const handleExchangeChange = (exchange: string) => {
    const newFilters = {
      ...filters,
      exchange,
      symbol: '',
      searchTerm: ''
    };
    setFilters(newFilters);
    onFiltersChange(newFilters);
    setSearchResults([]);
  };

  // Handle secType change
  const handleSecTypeChange = (secType: string) => {
    const newFilters = {
      ...filters,
      secType,
      symbol: '',
      searchTerm: ''
    };
    setFilters(newFilters);
    onFiltersChange(newFilters);
    setSearchResults([]);
  };

  // Handle symbol change
  const handleSymbolChange = (symbol: string) => {
    const newFilters = {
      ...filters,
      symbol: symbol.toUpperCase(),
      searchTerm: symbol
    };
    setFilters(newFilters);
    onFiltersChange(newFilters);
  };

  // Handle currency change
  const handleCurrencyChange = (currency: string) => {
    const newFilters = {
      ...filters,
      currency
    };
    setFilters(newFilters);
    onFiltersChange(newFilters);
  };

  // Enhanced symbol search using the new discovery endpoint
  const searchSymbols = async (searchTerm: string) => {
    if (!searchTerm || searchTerm.length < 1) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('API URL not configured');
      }

      // Use the new enhanced symbol discovery endpoint
      const response = await fetch(`${apiUrl}/api/market-data/symbols/discover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pattern: searchTerm,
          secType: filters.secType,
          exchange: filters.exchange,
          currency: filters.currency,
          max_results: 20,
          use_fallback: true,
          account_mode: 'paper'
        })
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`Symbol discovery: Found ${data.count} results using ${data.method}${data.cached ? ' (cached)' : ''}`);
        setSearchResults(data.results || []);
      } else {
        console.error('Symbol discovery failed:', response.statusText);
        
        // Fallback to the old search method if the new one fails
        try {
          const fallbackResponse = await fetch(`${apiUrl}/api/market-data/search`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              symbol: searchTerm,
              secType: filters.secType,
              exchange: filters.exchange,
              currency: filters.currency,
              account_mode: 'paper'
            })
          });

          if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            console.log('Fallback search successful');
            setSearchResults(fallbackData.results || []);
          } else {
            setSearchResults([]);
          }
        } catch (fallbackError) {
          console.error('Fallback search also failed:', fallbackError);
          setSearchResults([]);
        }
      }
    } catch (error) {
      console.error('Error in symbol discovery:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Debounced search
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (filters.searchTerm && filters.searchTerm.length >= 1) {
        searchSymbols(filters.searchTerm);
      } else {
        setSearchResults([]);
      }
    }, 500); // Increased debounce time for better performance

    return () => clearTimeout(timeoutId);
  }, [filters.searchTerm, filters.exchange, filters.secType, filters.currency]);

  return (
    <div className="space-y-4">
      {/* Region Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Market Region
        </label>
        <div className="flex space-x-2">
          <button
            onClick={() => handleRegionChange('US')}
            disabled={disabled}
            className={`px-4 py-2 text-sm rounded-md font-medium ${
              filters.region === 'US'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            United States
          </button>
          <button
            onClick={() => handleRegionChange('AU')}
            disabled={disabled}
            className={`px-4 py-2 text-sm rounded-md font-medium ${
              filters.region === 'AU'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Australia
          </button>
        </div>
      </div>

      {/* Exchange Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Exchange
        </label>
        <select
          value={filters.exchange}
          onChange={(e) => handleExchangeChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {getAvailableExchanges().map((exchange) => (
            <option key={exchange.value} value={exchange.value}>
              {exchange.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          {getAvailableExchanges().find(e => e.value === filters.exchange)?.description}
        </p>
      </div>

      {/* Security Type Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Security Type
        </label>
        <select
          value={filters.secType}
          onChange={(e) => handleSecTypeChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {getAvailableSecTypes().map((secType) => (
            <option key={secType.value} value={secType.value}>
              {secType.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          {getAvailableSecTypes().find(s => s.value === filters.secType)?.description}
        </p>
      </div>

      {/* Symbol Search */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Symbol
        </label>
        <div className="relative">
          <input
            type="text"
            value={filters.searchTerm}
            onChange={(e) => handleSymbolChange(e.target.value)}
            placeholder="Search for symbols..."
            disabled={disabled}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {isSearching && (
            <div className="absolute right-3 top-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            </div>
          )}
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded-md">
            {searchResults.map((result, index) => (
              <button
                key={index}
                onClick={() => {
                  handleSymbolChange(result.symbol);
                  setSearchResults([]);
                }}
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 border-b border-gray-100 last:border-b-0"
              >
                <div className="font-medium">{result.symbol}</div>
                <div className="text-xs text-gray-500">{result.companyName || result.description}</div>
              </button>
            ))}
          </div>
        )}

        {/* Popular Symbols */}
        {!filters.searchTerm && getPopularSymbols().length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-gray-500 mb-1">Popular symbols:</p>
            <div className="flex flex-wrap gap-1">
              {getPopularSymbols().map((symbol) => (
                <button
                  key={symbol}
                  onClick={() => handleSymbolChange(symbol)}
                  disabled={disabled}
                  className={`px-2 py-1 text-xs rounded ${
                    filters.symbol === symbol
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Currency Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Currency
        </label>
        <select
          value={filters.currency}
          onChange={(e) => handleCurrencyChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {getAvailableCurrencies().map((currency) => (
            <option key={currency.value} value={currency.value}>
              {currency.label} - {currency.description}
            </option>
          ))}
        </select>
      </div>

      {/* Current Selection Summary */}
      {filters.symbol && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
          <p className="text-sm text-blue-800">
            <span className="font-medium">Selected:</span> {filters.symbol} ({filters.exchange} - {filters.secType})
          </p>
          <p className="text-xs text-blue-600 mt-1">
            Currency: {filters.currency} | Region: {filters.region}
          </p>
        </div>
      )}
    </div>
  );
} 