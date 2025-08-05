'use client';

import React, { useState, useEffect } from 'react';
import { useTradingAccount } from '../contexts/TradingAccountContext';
import DataSwitch from '../components/DataSwitch';
import HistoricalChart from '../components/HistoricalChart';
import BackToHome from '../components/BackToHome';
import ExchangeDrivenFilters from '../components/ExchangeDrivenFilters';
import PeriodDateFilters from '../components/PeriodDateFilters';
import TechnicalIndicatorsFilter from '../components/TechnicalIndicatorsFilter';

interface HistoricalData {
  symbol: string;
  timeframe: string;
  account_mode: string;
  bars: any[];
  count: number;
  last_updated: string;
  source: string;
}

interface ProcessedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export default function HistoricalChartPage() {
  const { isLiveTrading, accountMode, dataType } = useTradingAccount();
  
  // Enhanced filter state
  const [exchangeFilters, setExchangeFilters] = useState({
    region: 'US' as 'US' | 'AU',
    exchange: 'SMART',
    secType: 'STK',
    symbol: 'MSFT',
    currency: 'USD',
    searchTerm: ''
  });
  
  const [periodFilters, setPeriodFilters] = useState<{
    period: string;
    startDate?: string;
    endDate?: string;
    useDateRange: boolean;
  }>({
    period: '3M',
    startDate: undefined,
    endDate: undefined,
    useDateRange: false
  });
  
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState('1hour');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<HistoricalData | null>(null);
  const [processedBars, setProcessedBars] = useState<ProcessedBar[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  // Data query switch state
  const [dataQueryEnabled, setDataQueryEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('historical-chart-data-enabled');
      return saved !== null ? JSON.parse(saved) : true; // Default to true (enabled)
    }
    return true; // Default to true (enabled)
  });

  // Updated timeframes to match backend API expectations
  const timeframes = [
    { label: '5 Minutes', value: '5min' },
    { label: '15 Minutes', value: '15min' },
    { label: '30 Minutes', value: '30min' },
    { label: '1 Hour', value: '1hour' },
    { label: '4 Hours', value: '4hour' },
    { label: '8 Hours', value: '8hour' },
    { label: '1 Day', value: '1day' }
  ];

  // Handle data switch toggle
  const handleDataSwitchToggle = (enabled: boolean) => {
    setDataQueryEnabled(enabled);
    if (typeof window !== 'undefined') {
      localStorage.setItem('historical-chart-data-enabled', JSON.stringify(enabled));
    }
    if (!enabled) {
      setError(null);
      setChartData(null);
      setProcessedBars([]);
    }
  };

  // Process bars data from API response
  const processBarsData = (bars: any[]): ProcessedBar[] => {
    if (!bars || !Array.isArray(bars)) {
      return [];
    }

    const processedBars: ProcessedBar[] = [];
    
    for (const bar of bars) {
      // Simple validation and conversion
      let timestamp = bar.timestamp;
      
      if (typeof timestamp !== 'number' || isNaN(timestamp)) {
        console.warn('Invalid timestamp:', timestamp, 'for bar:', bar);
        continue;
      }
      
      // Debug logging for first few bars to understand the data format
      if (processedBars.length < 5) {
        console.log('=== Raw Bar Data ===');
        console.log('Full bar:', bar);
        console.log('Raw timestamp:', timestamp);
        console.log('As Date (assuming seconds):', new Date(timestamp * 1000));
        console.log('As Date (assuming milliseconds):', new Date(timestamp));
        console.log('Current year check - seconds format:', new Date(timestamp * 1000).getFullYear());
        console.log('Current year check - milliseconds format:', new Date(timestamp).getFullYear());
      }
      
      // Backend sends Unix timestamps in seconds, validate they're reasonable
      const timestampAsDate = new Date(timestamp * 1000);
      
      // Validate timestamp represents a date between 2020-2030
      if (timestampAsDate.getFullYear() < 2020 || timestampAsDate.getFullYear() > 2030) {
        console.warn('Timestamp out of reasonable range:', {
          timestamp: timestamp,
          interpretedDate: timestampAsDate,
          year: timestampAsDate.getFullYear()
        });
        continue;
      }
      
      // Keep timestamp in seconds format (consistent with chart components)
      const finalTimestamp = timestamp;

      // Validate numeric fields
      const open = Number(bar.open);
      const high = Number(bar.high);
      const low = Number(bar.low);
      const close = Number(bar.close);
      const volume = Number(bar.volume);

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
        console.warn('Invalid numeric values in bar:', bar);
        continue;
      }

      processedBars.push({
        time: finalTimestamp,
        open,
        high,
        low,
        close,
        volume
      });
    }
    
    // Sort by timestamp in ascending order (oldest first) - required by TradingView
    processedBars.sort((a, b) => a.time - b.time);
    
    console.log('Processed and sorted bars:', processedBars.length);
    if (processedBars.length > 0) {
      console.log('First bar (oldest):', new Date(processedBars[0].time * 1000));
      console.log('Last bar (newest):', new Date(processedBars[processedBars.length - 1].time * 1000));
    }
    
    return processedBars;
  };

  // Fetch historical data
  const fetchHistoricalData = async () => {
    if (!dataQueryEnabled) {
      console.log('Data querying disabled');
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('API URL not configured');
      }

      // Build query parameters
      const params = new URLSearchParams({
        symbol: exchangeFilters.symbol,
        timeframe: timeframe,
        period: periodFilters.useDateRange ? 'CUSTOM' : periodFilters.period,
        account_mode: accountMode
      });

      // Add date range if using custom dates
      if (periodFilters.useDateRange && periodFilters.startDate && periodFilters.endDate) {
        params.append('start_date', periodFilters.startDate);
        params.append('end_date', periodFilters.endDate);
      }

      // Add indicators if selected
      if (selectedIndicators.length > 0) {
        params.append('indicators', selectedIndicators.join(','));
      }

      const url = `${apiUrl}/api/market-data/history?${params.toString()}`;
      
      console.log('Fetching historical data:', url);
      
      const response = await fetch(url, {
        headers: { 
          'X-Data-Query-Enabled': 'true',
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      console.log('Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error:', errorText);
        
        if (response.status === 504) {
          throw new Error('Gateway timeout - IB service busy, please try again');
        } else if (response.status === 503) {
          throw new Error('Service temporarily unavailable, please try again');
        } else if (response.status === 500) {
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.detail && errorData.detail.includes('subscription')) {
              throw new Error('Using delayed market data - real-time subscription not available');
            } else if (errorData.detail && errorData.detail.includes('timeout')) {
              throw new Error('IB Gateway timeout - please try again');
            } else {
              throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
            }
          } catch (jsonError) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data: HistoricalData = await response.json();
      console.log('Historical data received:', data);
      
      if (!data.bars || !Array.isArray(data.bars)) {
        throw new Error('No bars data received from API');
      }

      console.log('Processing', data.bars.length, 'bars');

      // Process the bars data
      const processed = processBarsData(data.bars);
      console.log('Processed', processed.length, 'valid bars');

      setChartData(data);
      setProcessedBars(processed);
      setLastUpdate(new Date());
      console.log('Historical data loaded successfully');

    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch historical data');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle load button click
  const handleLoadData = () => {
    if (!dataQueryEnabled) {
      setError('Data querying is disabled. Please enable the switch above.');
      return;
    }
    
    if (!exchangeFilters.symbol.trim()) {
      setError('Please select a valid symbol');
      return;
    }
    
    fetchHistoricalData();
  };

  // Helper function to format time
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: true, 
      hour: 'numeric', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center py-4 sm:py-6 space-y-4 sm:space-y-0">
            <div className="flex items-center space-x-2 sm:space-x-4">
              <BackToHome />
              <div className="min-w-0 flex-1">
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">Historical Chart</h1>
                <p className="text-xs sm:text-sm text-gray-600 mt-1">Interactive historical data visualization</p>
              </div>
            </div>
            <div className="flex items-center space-x-2 sm:space-x-4">
              <div className="text-xs sm:text-sm text-gray-500">
                {isLiveTrading ? 'Live Trading Mode' : 'Paper Trading Mode'}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        {/* Data Query Switch */}
        <div className="mb-4 sm:mb-6 bg-white rounded-lg shadow-sm border p-3 sm:p-4">
          <DataSwitch
            enabled={dataQueryEnabled}
            onToggle={handleDataSwitchToggle}
            label="IB Gateway Data Query"
            description="Enable or disable historical data fetching from IB Gateway"
            size="medium"
          />
        </div>

        {/* Enhanced Filters */}
        <div className="mb-6 sm:mb-8 bg-white rounded-lg shadow-sm border p-4 sm:p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Exchange-Driven Filters */}
            <div>
              <h3 className="text-sm font-medium text-gray-900 mb-4">Market & Symbol</h3>
              <ExchangeDrivenFilters
                onFiltersChange={setExchangeFilters}
                disabled={!dataQueryEnabled}
              />
            </div>

            {/* Period & Date Filters */}
            <div>
              <h3 className="text-sm font-medium text-gray-900 mb-4">Time Period</h3>
              <PeriodDateFilters
                onFiltersChange={setPeriodFilters}
                disabled={!dataQueryEnabled}
              />
            </div>

            {/* Timeframe & Action */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-900 mb-4">Chart Settings</h3>
                
                {/* Timeframe Selection */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Timeframe
                  </label>
                  <select
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    disabled={!dataQueryEnabled}
                  >
                    {timeframes.map((tf) => (
                      <option key={tf.value} value={tf.value}>
                        {tf.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Technical Indicators */}
                <div>
                  <TechnicalIndicatorsFilter
                    onIndicatorsChange={setSelectedIndicators}
                    disabled={!dataQueryEnabled}
                  />
                </div>

                {/* Action Button */}
                <div className="mt-6">
                  <button
                    onClick={handleLoadData}
                    disabled={isLoading || !dataQueryEnabled}
                    className="w-full px-4 py-3 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    {isLoading ? 'Loading...' : 'Load Historical Data'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md">
            <div className="flex items-center">
              <span className="text-red-600 mr-2">⚠️</span>
              <p className="text-sm text-red-800">{error}</p>
            </div>
            <button
              onClick={fetchHistoricalData}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        )}

        {/* Chart Area */}
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900">
              Historical Chart: {exchangeFilters.symbol}
            </h2>
            <div className="text-sm text-gray-500">
              {exchangeFilters.exchange} - {exchangeFilters.secType} | Timeframe: {timeframes.find(tf => tf.value === timeframe)?.label}
              {lastUpdate && (
                <span className="ml-4">
                  Last update: {formatTime(lastUpdate)}
                </span>
              )}
            </div>
          </div>
          
          {/* Chart Display */}
          {chartData && processedBars.length > 0 ? (
            <div>
              {/* Data Summary */}
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-800">
                  Data source: {chartData.source} | Account mode: {chartData.account_mode}
                </p>
                <p className="text-sm text-green-700 mt-1">
                  Last updated: {new Date(chartData.last_updated).toLocaleString()}
                </p>
                <p className="text-sm text-green-700 mt-1">
                  Date range: {new Date(processedBars[0].time * 1000).toLocaleDateString()} to {new Date(processedBars[processedBars.length - 1].time * 1000).toLocaleDateString()}
                </p>
              </div>
              
              {/* TradingView Chart */}
              <div className="h-96 border border-gray-200 rounded">
                <HistoricalChart 
                  data={processedBars}
                  symbol={chartData.symbol}
                  timeframe={chartData.timeframe}
                />
              </div>
            </div>
          ) : chartData && processedBars.length === 0 ? (
            <div className="h-96 bg-gray-100 rounded-lg flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">⚠️</div>
                <p className="text-gray-600">Data received but no valid bars found</p>
                <p className="text-sm text-gray-500 mt-2">
                  Raw data count: {chartData.bars.length} | Processed: {processedBars.length}
                </p>
                <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                  <p className="text-sm text-yellow-800">
                    The API returned data but it couldn't be processed into valid chart bars.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-96 bg-gray-100 rounded-lg flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">📊</div>
                <p className="text-gray-600">Historical chart will be displayed here</p>
                <p className="text-sm text-gray-500 mt-2">
                  {dataQueryEnabled 
                    ? `Select market, symbol, and timeframe, then click "Load Historical Data" to fetch data from IB Gateway`
                    : 'Enable data querying to load historical data from IB Gateway'
                  }
                </p>
                {!dataQueryEnabled && (
                  <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md">
                    <p className="text-sm text-amber-800">
                      Data querying is currently disabled. Enable the switch above to connect to IB Gateway.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}