'use client';

import React from 'react';

import { CURRENCIES, EXCHANGES, SECURITY_TYPES, TIMEFRAMES } from './constants';

interface SearchFiltersProps {
  // Basic filters
  symbol: string;
  onSymbolChange: (value: string) => void;
  securityType: string;
  onSecurityTypeChange: (value: string) => void;
  exchange: string;
  onExchangeChange: (value: string) => void;
  currency: string;
  onCurrencyChange: (value: string) => void;
  timeframe: string;
  onTimeframeChange: (value: string) => void;
  searchByName: boolean;
  onSearchByNameChange: (value: boolean) => void;

  // Advanced filters
  showAdvancedSearch: boolean;
  onToggleAdvanced: () => void;
  expiry: string;
  onExpiryChange: (value: string) => void;
  strike: string;
  onStrikeChange: (value: string) => void;
  right: string;
  onRightChange: (value: string) => void;
  multiplier: string;
  onMultiplierChange: (value: string) => void;
  includeExpired: boolean;
  onIncludeExpiredChange: (value: boolean) => void;

  // Recent searches
  searchHistory: string[];
  onHistorySelect: (symbol: string) => void;

  // Actions
  loading: boolean;
  onSearch: () => void;
  onClear: () => void;
}

export default function SearchFilters({
  symbol,
  onSymbolChange,
  securityType,
  onSecurityTypeChange,
  exchange,
  onExchangeChange,
  currency,
  onCurrencyChange,
  timeframe,
  onTimeframeChange,
  searchByName,
  onSearchByNameChange,
  showAdvancedSearch,
  onToggleAdvanced,
  expiry,
  onExpiryChange,
  strike,
  onStrikeChange,
  right,
  onRightChange,
  multiplier,
  onMultiplierChange,
  includeExpired,
  onIncludeExpiredChange,
  searchHistory,
  onHistorySelect,
  loading,
  onSearch,
  onClear,
}: SearchFiltersProps) {
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearch();
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-4 sm:p-6">
      <div className="flex items-center space-x-2 mb-4">
        <span className="text-base sm:text-lg">🔍</span>
        <h3 className="text-base sm:text-lg font-medium text-gray-900">Search Filters</h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
        {/* Symbol Search */}
        <div>
          <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
            Symbol / Company Name
          </label>
          <div className="relative">
            <input
              type="text"
              value={symbol}
              onChange={(e) => onSymbolChange(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="e.g., AAPL, Microsoft"
              className="w-full pl-8 sm:pl-10 pr-3 sm:pr-4 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <span className="absolute left-2 sm:left-3 top-2.5 text-gray-400 text-xs sm:text-sm">
              🔍
            </span>
          </div>
          <div className="mt-1">
            <label className="flex items-center text-xs sm:text-sm text-gray-600">
              <input
                type="checkbox"
                checked={searchByName}
                onChange={(e) => onSearchByNameChange(e.target.checked)}
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
                    onClick={() => onHistorySelect(item)}
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
          <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
            Security Type
          </label>
          <select
            value={securityType}
            onChange={(e) => onSecurityTypeChange(e.target.value)}
            className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
          <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
            Exchange
          </label>
          <select
            value={exchange}
            onChange={(e) => onExchangeChange(e.target.value)}
            className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
          <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
            Currency
          </label>
          <select
            value={currency}
            onChange={(e) => onCurrencyChange(e.target.value)}
            className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
          <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
            Timeframe
          </label>
          <select
            value={timeframe}
            onChange={(e) => onTimeframeChange(e.target.value)}
            className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
          onClick={onToggleAdvanced}
          className="text-xs sm:text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
        >
          <span>{showAdvancedSearch ? '▼' : '▶'}</span>
          <span>Advanced Search Options</span>
        </button>
      </div>

      {/* Advanced Search Fields */}
      {showAdvancedSearch && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6 p-3 sm:p-4 bg-gray-50 rounded-md">
          {/* Expiry Date */}
          <div>
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
              Expiry Date
            </label>
            <input
              type="text"
              value={expiry}
              onChange={(e) => onExpiryChange(e.target.value)}
              placeholder="YYYYMMDD or YYYYMM"
              className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Strike Price */}
          <div>
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
              Strike Price
            </label>
            <input
              type="number"
              step="0.01"
              value={strike}
              onChange={(e) => onStrikeChange(e.target.value)}
              placeholder="e.g., 150.00"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Option Right */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Option Right</label>
            <select
              value={right}
              onChange={(e) => onRightChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Any</option>
              <option value="C">Call</option>
              <option value="P">Put</option>
            </select>
          </div>

          {/* Multiplier */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Multiplier</label>
            <input
              type="text"
              value={multiplier}
              onChange={(e) => onMultiplierChange(e.target.value)}
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
                onChange={(e) => onIncludeExpiredChange(e.target.checked)}
                className="mr-2"
              />
              Include Expired Contracts
            </label>
          </div>
        </div>
      )}

      {/* Search Buttons */}
      <div className="flex justify-between items-center">
        <button onClick={onClear} className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm">
          Clear Search
        </button>

        <div className="flex space-x-2">
          <button
            onClick={onSearch}
            disabled={loading || (!showAdvancedSearch && !symbol.trim())}
            className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
          >
            {loading ? <span className="animate-spin">↻</span> : <span>🔍</span>}
            <span>{loading ? 'Searching...' : 'Search'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
