'use client';

import React, { useState } from 'react';

import EnhancedTradingChart from './EnhancedTradingChart';
import ConnectionStatusBar from './marketData/ConnectionStatusBar';
import MarketDataPanel from './marketData/MarketDataPanel';
import QuickSearch from './marketData/QuickSearch';
import SearchFilters from './marketData/SearchFilters';
import SearchResultsList from './marketData/SearchResultsList';
import SearchTips from './marketData/SearchTips';
import { TIMEFRAMES } from './marketData/constants';
import { useTradingAccount } from '../contexts/TradingAccountContext';
import { STORAGE_KEYS, usePersistentState } from '../lib/usePersistentState';
import { useContractSearch, type ContractSearchParams } from '../lib/useContractSearch';

/**
 * Home-page market-data filter. This is the container: it owns the form inputs
 * and composes the presentational pieces under `marketData/`, while the data
 * flow (health probe, contract search, quote fetch) lives in the
 * `useContractSearch` hook.
 */
export default function MarketDataFilter() {
  const { accountMode, dataType } = useTradingAccount();

  // Basic filter state
  const [symbol, setSymbol] = usePersistentState(STORAGE_KEYS.lastSymbol, '');
  const [securityType, setSecurityType] = useState('STK');
  const [exchange, setExchange] = useState('SMART');
  const [currency, setCurrency] = useState('USD');
  const [timeframe, setTimeframe] = usePersistentState(STORAGE_KEYS.lastTimeframe, '1hour', (v) =>
    TIMEFRAMES.some((tf) => tf.value === v)
  );
  const [searchByName, setSearchByName] = useState(false);

  // Advanced filter state
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [strike, setStrike] = useState('');
  const [right, setRight] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);

  const {
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
  } = useContractSearch(accountMode);

  // Assemble search params from the current form state, allowing quick-search
  // to override the basic fields.
  const buildParams = (
    overrides: Partial<
      Pick<ContractSearchParams, 'symbol' | 'secType' | 'exchange' | 'currency'>
    > = {}
  ): ContractSearchParams => ({
    symbol: overrides.symbol ?? symbol,
    secType: overrides.secType ?? securityType,
    exchange: overrides.exchange ?? exchange,
    currency: overrides.currency ?? currency,
    searchByName,
    advanced: showAdvancedSearch
      ? { expiry, strike, right, multiplier, includeExpired }
      : undefined,
  });

  const handleSearch = () => {
    void search(buildParams());
  };

  const handleClear = () => {
    setSymbol('');
    reset();
  };

  const handleQuickSearch = (quickSymbol: string) => {
    reset();
    setSymbol(quickSymbol);
    setSecurityType('STK');
    setExchange('SMART');
    setCurrency('USD');
    void search(
      buildParams({ symbol: quickSymbol, secType: 'STK', exchange: 'SMART', currency: 'USD' })
    );
  };

  return (
    <div className="space-y-6">
      <ConnectionStatusBar
        connectionStatus={connectionStatus}
        accountMode={accountMode}
        dataType={dataType}
        onRefresh={checkConnection}
      />

      <QuickSearch onSelect={handleQuickSearch} />

      <SearchFilters
        symbol={symbol}
        onSymbolChange={setSymbol}
        securityType={securityType}
        onSecurityTypeChange={setSecurityType}
        exchange={exchange}
        onExchangeChange={setExchange}
        currency={currency}
        onCurrencyChange={setCurrency}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        searchByName={searchByName}
        onSearchByNameChange={setSearchByName}
        showAdvancedSearch={showAdvancedSearch}
        onToggleAdvanced={() => setShowAdvancedSearch(!showAdvancedSearch)}
        expiry={expiry}
        onExpiryChange={setExpiry}
        strike={strike}
        onStrikeChange={setStrike}
        right={right}
        onRightChange={setRight}
        multiplier={multiplier}
        onMultiplierChange={setMultiplier}
        includeExpired={includeExpired}
        onIncludeExpiredChange={setIncludeExpired}
        searchHistory={searchHistory}
        onHistorySelect={handleQuickSearch}
        loading={loading}
        onSearch={handleSearch}
        onClear={handleClear}
      />

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="text-red-800">❌ {error}</div>
        </div>
      )}

      {/* Search Tips */}
      {!searchResults.length && !loading && !error && <SearchTips />}

      {/* Search Results */}
      {searchResults.length > 0 && (
        <SearchResultsList
          results={searchResults}
          selectedConid={selectedContract?.conid}
          onSelect={selectContract}
        />
      )}

      {/* Market Data Display */}
      {selectedContract && (
        <MarketDataPanel
          contract={selectedContract}
          marketData={marketData}
          loading={loading}
          onShowChart={showChartNow}
        />
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
