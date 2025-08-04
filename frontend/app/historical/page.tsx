'use client';

import React, { useState, useEffect } from 'react';
import { useTradingAccount } from '../contexts/TradingAccountContext';
import DataSwitch from '../components/DataSwitch';
import HistoricalChart from '../components/HistoricalChart';
import BackToHome from '../components/BackToHome';

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
  const [selectedSymbol, setSelectedSymbol] = useState('MSFT');
  const [timeframe, setTimeframe] = useState('1hour'); // Changed default to match backend
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<HistoricalData | null>(null);
  const [processedBars, setProcessedBars] = useState<ProcessedBar[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  // Data query switch state
  const [dataQueryEnabled, setDataQueryEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('historical-chart-data-enabled');
      return saved !== null ? JSON.parse(saved) : false;
    }
    return false;
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

  const popularSymbols = ['MSFT', 'AAPL', 'GOOGL', 'TSLA', 'AMZN', 'NVDA', 'META', 'NFLX'];

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

    return bars.map((bar: any) => {
      // Validate and convert timestamp properly
      let timestamp = bar.timestamp;
      
      // Validate timestamp is a valid number
      if (typeof timestamp !== 'number' || isNaN(timestamp)) {
        console.warn('Invalid timestamp:', timestamp, 'for bar:', bar);
        return null;
      }
      
      // Convert to milliseconds if it's in seconds (for display purposes)
      if (timestamp < 1000000000000) {
        timestamp = timestamp * 1000;
      }
      
      // Validate timestamp is reasonable
      const now = Date.now();
      if (timestamp > now + 86400000 || timestamp < now - 31536000000 * 10) { // Within 1 day future or 10 years past
        console.warn('Timestamp out of reasonable range:', timestamp, 'for bar:', bar);
        return null;
      }

      return {
        time: timestamp,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume)
      };
    }).filter((bar: ProcessedBar | null) => 
      bar !== null && !isNaN(bar.open) && !isNaN(bar.high) && !isNaN(bar.low) && !isNaN(bar.close) && !isNaN(bar.volume)
    );
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
        symbol: selectedSymbol,
        timeframe: timeframe,
        period: '3M', // Default to 3 months for historical data
        account_mode: accountMode
      });

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
    
    if (!selectedSymbol.trim()) {
      setError('Please enter a valid symbol');
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

        {/* Controls */}
        <div className="mb-6 sm:mb-8 bg-white rounded-lg shadow-sm border p-4 sm:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {/* Symbol Selection */}
            <div>
              <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                Symbol
              </label>
              <input
                type="text"
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter symbol..."
                disabled={!dataQueryEnabled}
              />
              <div className="mt-2 flex flex-wrap gap-1">
                {popularSymbols.map((symbol) => (
                  <button
                    key={symbol}
                    onClick={() => setSelectedSymbol(symbol)}
                    disabled={!dataQueryEnabled}
                    className={`px-2 py-1 text-xs rounded ${
                      selectedSymbol === symbol
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    } ${!dataQueryEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            </div>

            {/* Timeframe Selection */}
            <div>
              <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                Timeframe
              </label>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                className="w-full px-3 py-2 text-xs sm:text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={!dataQueryEnabled}
              >
                {timeframes.map((tf) => (
                  <option key={tf.value} value={tf.value}>
                    {tf.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Action Button */}
            <div className="flex items-end">
              <button
                onClick={handleLoadData}
                disabled={isLoading || !dataQueryEnabled}
                className="w-full px-3 sm:px-4 py-2 text-xs sm:text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Loading...' : 'Load Historical Data'}
              </button>
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
              Historical Chart: {selectedSymbol}
            </h2>
            <div className="text-sm text-gray-500">
              Timeframe: {timeframes.find(tf => tf.value === timeframe)?.label}
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
                    ? `Select a symbol and timeframe, then click "Load Historical Data" to fetch data from IB Gateway`
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