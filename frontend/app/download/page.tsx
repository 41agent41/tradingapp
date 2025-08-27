'use client';

import React, { useState, useEffect } from 'react';
import { useTradingAccount } from '../contexts/TradingAccountContext';
import DataSwitch from '../components/DataSwitch';
import DataframeViewer from '../components/DataframeViewer';
import BackToHome from '../components/BackToHome';
import ExchangeDrivenFilters from '../components/ExchangeDrivenFilters';
import PeriodDateFilters from '../components/PeriodDateFilters';

interface HistoricalData {
  symbol: string;
  timeframe: string;
  account_mode: string;
  bars: any[];
  count: number;
  last_updated: string;
  source: string;
  exchange?: string;
  secType?: string;
}

interface DownloadStatus {
  isDownloading: boolean;
  isUploading: boolean;
  downloadProgress?: string;
  uploadProgress?: string;
  error?: string;
}

export default function DownloadPage() {
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
  
  const [timeframe, setTimeframe] = useState('1hour');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<HistoricalData | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>({
    isDownloading: false,
    isUploading: false
  });
  
  // Data query switch state
  const [dataQueryEnabled, setDataQueryEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('download-page-data-enabled');
      return saved !== null ? JSON.parse(saved) : true;
    }
    return true;
  });

  // Updated timeframes to match backend API expectations
  const timeframes = [
    { label: 'Tick Data', value: 'tick' },
    { label: '1 Minute', value: '1min' },
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
      localStorage.setItem('download-page-data-enabled', JSON.stringify(enabled));
    }
    if (!enabled) {
      setError(null);
      setChartData(null);
    }
  };

  // Fetch historical data from IB API
  const fetchHistoricalData = async () => {
    if (!dataQueryEnabled) {
      console.log('Data querying disabled');
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setDownloadStatus({ isDownloading: true, isUploading: false, downloadProgress: 'Connecting to IB Gateway...' });
    
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
        account_mode: accountMode,
        secType: exchangeFilters.secType,
        exchange: exchangeFilters.exchange,
        currency: exchangeFilters.currency
      });

      // Add date range if using custom dates
      if (periodFilters.useDateRange && periodFilters.startDate && periodFilters.endDate) {
        params.append('start_date', periodFilters.startDate);
        params.append('end_date', periodFilters.endDate);
      }

      const url = `${apiUrl}/api/market-data/history?${params.toString()}`;
      
      console.log('Fetching historical data:', url);
      
      setDownloadStatus(prev => ({ ...prev, downloadProgress: 'Fetching data from IB Gateway...' }));
      
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

      console.log('Received', data.bars.length, 'bars');

      setChartData(data);
      setDownloadStatus({ isDownloading: false, isUploading: false, downloadProgress: `Successfully downloaded ${data.bars.length} records` });
      console.log('Historical data downloaded successfully');

    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch historical data');
      setDownloadStatus({ isDownloading: false, isUploading: false, error: err instanceof Error ? err.message : 'Failed to fetch historical data' });
    } finally {
      setIsLoading(false);
    }
  };

  // Load data into PostgreSQL database
  const loadDataToDatabase = async () => {
    if (!chartData || !chartData.bars || chartData.bars.length === 0) {
      setError('No data available to upload. Please download data first.');
      return;
    }

    setDownloadStatus({ isDownloading: false, isUploading: true, uploadProgress: 'Preparing data for database...' });
    setError(null);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('API URL not configured');
      }

      setDownloadStatus(prev => ({ ...prev, uploadProgress: 'Uploading data to PostgreSQL...' }));

      const response = await fetch(`${apiUrl}/api/market-data/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Data-Query-Enabled': 'true'
        },
        body: JSON.stringify({
          symbol: chartData.symbol,
          timeframe: chartData.timeframe,
          bars: chartData.bars,
          account_mode: chartData.account_mode,
          secType: exchangeFilters.secType,
          exchange: exchangeFilters.exchange,
          currency: exchangeFilters.currency
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Upload Error:', errorText);
        
        try {
          const errorData = JSON.parse(errorText);
          throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
        } catch (jsonError) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const result = await response.json();
      console.log('Upload result:', result);
      
      setDownloadStatus({ 
        isDownloading: false, 
        isUploading: false, 
        uploadProgress: `Successfully uploaded ${result.uploaded_count || chartData.bars.length} records to database` 
      });

    } catch (err) {
      console.error('Error uploading data:', err);
      setError(err instanceof Error ? err.message : 'Failed to upload data to database');
      setDownloadStatus({ 
        isDownloading: false, 
        isUploading: false, 
        error: err instanceof Error ? err.message : 'Failed to upload data to database' 
      });
    }
  };

  // Handle download button click
  const handleDownloadData = () => {
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

  // Handle upload button click
  const handleUploadData = () => {
    if (!chartData || !chartData.bars || chartData.bars.length === 0) {
      setError('No data available to upload. Please download data first.');
      return;
    }
    
    loadDataToDatabase();
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
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">Download Historical Data</h1>
                <p className="text-xs sm:text-sm text-gray-600 mt-1">Download data from IB API and load into PostgreSQL database</p>
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

            {/* Timeframe & Actions */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-900 mb-4">Download Settings</h3>
                
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

                {/* Action Buttons */}
                <div className="space-y-3">
                  <button
                    onClick={handleDownloadData}
                    disabled={isLoading || !dataQueryEnabled || downloadStatus.isDownloading}
                    className="w-full px-4 py-3 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    {downloadStatus.isDownloading ? 'Downloading...' : 'Download from IB API'}
                  </button>
                  
                  <button
                    onClick={handleUploadData}
                    disabled={!chartData || !chartData.bars || chartData.bars.length === 0 || downloadStatus.isUploading}
                    className="w-full px-4 py-3 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    {downloadStatus.isUploading ? 'Uploading...' : 'Load to PostgreSQL'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Display */}
        {(downloadStatus.isDownloading || downloadStatus.isUploading || downloadStatus.downloadProgress || downloadStatus.uploadProgress || downloadStatus.error) && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {downloadStatus.isDownloading && <span className="text-blue-600">⏳</span>}
                {downloadStatus.isUploading && <span className="text-green-600">⏳</span>}
                {downloadStatus.error && <span className="text-red-600">⚠️</span>}
                {!downloadStatus.isDownloading && !downloadStatus.isUploading && !downloadStatus.error && <span className="text-green-600">✅</span>}
                <div>
                  {downloadStatus.isDownloading && <p className="text-sm text-blue-800">Downloading...</p>}
                  {downloadStatus.isUploading && <p className="text-sm text-green-800">Uploading...</p>}
                  {downloadStatus.error && <p className="text-sm text-red-800">{downloadStatus.error}</p>}
                  {downloadStatus.downloadProgress && !downloadStatus.isDownloading && !downloadStatus.error && (
                    <p className="text-sm text-blue-800">{downloadStatus.downloadProgress}</p>
                  )}
                  {downloadStatus.uploadProgress && !downloadStatus.isUploading && !downloadStatus.error && (
                    <p className="text-sm text-green-800">{downloadStatus.uploadProgress}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

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

        {/* Data Display */}
        {chartData && chartData.bars && chartData.bars.length > 0 ? (
          <div className="space-y-6">
            {/* Data Summary */}
            <div className="bg-white rounded-lg shadow-sm border p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-medium text-gray-900">
                  Downloaded Data: {chartData.symbol}
                </h2>
                <div className="text-sm text-gray-500">
                  {exchangeFilters.exchange} - {exchangeFilters.secType} | Timeframe: {timeframes.find(tf => tf.value === timeframe)?.label}
                  {chartData.last_updated && (
                    <span className="ml-4">
                      Last update: {formatTime(new Date(chartData.last_updated))}
                    </span>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="p-3 bg-green-50 border border-green-200 rounded-md">
                  <p className="text-green-800 font-medium">Records Downloaded</p>
                  <p className="text-green-700">{chartData.bars.length}</p>
                </div>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <p className="text-blue-800 font-medium">Data Source</p>
                  <p className="text-blue-700">{chartData.source}</p>
                </div>
                <div className="p-3 bg-purple-50 border border-purple-200 rounded-md">
                  <p className="text-purple-800 font-medium">Account Mode</p>
                  <p className="text-purple-700">{chartData.account_mode}</p>
                </div>
              </div>
            </div>
            
            {/* Dataframe Viewer */}
            <DataframeViewer
              data={chartData.bars}
              title={`Historical Data - ${chartData.symbol}`}
              description={`${chartData.bars.length} records from ${chartData.source} | Timeframe: ${timeframes.find(tf => tf.value === timeframe)?.label}`}
              maxHeight="600px"
              showExport={true}
              showPagination={true}
              itemsPerPage={25}
            />
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="text-center py-8">
              <div className="text-4xl mb-4">📊</div>
              <p className="text-gray-600">No data downloaded yet</p>
              <p className="text-sm text-gray-500 mt-2">
                {dataQueryEnabled 
                  ? `Select market, symbol, and timeframe, then click "Download from IB API" to fetch data`
                  : 'Enable data querying to download historical data from IB Gateway'
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
      </main>
    </div>
  );
}
