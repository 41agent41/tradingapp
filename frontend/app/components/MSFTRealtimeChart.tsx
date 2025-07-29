'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import DataSwitch from './DataSwitch';
import { useTradingAccount } from '../contexts/TradingAccountContext';

interface RealtimeData {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}

interface CandlestickData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface PricePoint {
  time: Time;
  value: number;
}

const timeframes = [
  { label: '5m', value: '5min', minutes: 5 },
  { label: '15m', value: '15min', minutes: 15 },
  { label: '30m', value: '30min', minutes: 30 },
  { label: '1h', value: '1hour', minutes: 60 },
  { label: '4h', value: '4hour', minutes: 240 },
  { label: '8h', value: '8hour', minutes: 480 },
  { label: '1d', value: '1day', minutes: 1440 }
];

const periods = [
  { label: '1 Day', value: '1D' },
  { label: '5 Days', value: '5D' },
  { label: '1 Month', value: '1M' },
  { label: '3 Months', value: '3M' },
  { label: '6 Months', value: '6M' },
  { label: '1 Year', value: '1Y' },
  { label: 'Custom Range', value: 'CUSTOM' }
];

export default function MSFTRealtimeChart() {
  const { accountMode, dataType } = useTradingAccount();
  
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candlestickSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  
  const [currentData, setCurrentData] = useState<RealtimeData | null>(null);
  const [chartData, setChartData] = useState<CandlestickData[]>([]);
  const [currentTimeframe, setCurrentTimeframe] = useState('1hour');
  const [currentPeriod, setCurrentPeriod] = useState('3M');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingHistorical, setIsLoadingHistorical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [lastHistoricalUpdate, setLastHistoricalUpdate] = useState<Date | null>(null);
  
  // Date range states
  const [useCustomDateRange, setUseCustomDateRange] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  // Data switch states
  const [dataQueryEnabled, setDataQueryEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('msft-chart-data-enabled');
      return saved !== null ? JSON.parse(saved) : false;
    }
    return false;
  });

  // Initialize default date range (last 3 months)
  useEffect(() => {
    const now = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(now.getMonth() - 3);
    
    setEndDate(now.toISOString().split('T')[0]);
    setStartDate(threeMonthsAgo.toISOString().split('T')[0]);
    
    // Debug log to verify new code is running
    console.log('MSFT Chart: Date range functionality initialized', {
      startDate: threeMonthsAgo.toISOString().split('T')[0],
      endDate: now.toISOString().split('T')[0],
      useCustomDateRange,
      periodsLength: periods.length,
      periodsArray: periods,
      hasCustomOption: periods.find(p => p.value === 'CUSTOM')
    });
  }, []);

  // Debug effect to track period changes
  useEffect(() => {
    console.log('MSFT Chart: Period changed', {
      currentPeriod,
      useCustomDateRange,
      hasCustomOption: periods.some(p => p.value === 'CUSTOM'),
      allPeriods: periods.map(p => `${p.label}:${p.value}`)
    });
  }, [currentPeriod, useCustomDateRange]);

  // Handle data switch toggle with persistence
  const handleDataSwitchToggle = (enabled: boolean) => {
    setDataQueryEnabled(enabled);
    if (typeof window !== 'undefined') {
      localStorage.setItem('msft-chart-data-enabled', JSON.stringify(enabled));
    }
    
    // Clear any errors when disabling
    if (!enabled) {
      setError(null);
    }
  };

  // Initialize chart with candlestick display
  useEffect(() => {
    if (!chartContainerRef.current) return;

    chart.current = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: chartContainerRef.current.clientWidth,
      height: 500,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      crosshair: {
        mode: 1,
      },
      rightPriceScale: {
        borderColor: '#cccccc',
      },
      timeScale: {
        borderColor: '#cccccc',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // Add candlestick series with green/red color coding
    candlestickSeries.current = chart.current.addCandlestickSeries({
      upColor: '#22c55e', // Green for bull bars
      downColor: '#ef4444', // Red for bear bars
      borderDownColor: '#ef4444',
      borderUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      wickUpColor: '#22c55e',
    });

    // Add volume series
    volumeSeries.current = chart.current.addHistogramSeries({
      color: '#64748b',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
      visible: true,
    });

    // Position volume series at the bottom
    volumeSeries.current.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    // Handle resize
    const handleResize = () => {
      if (chart.current && chartContainerRef.current) {
        chart.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chart.current) {
        chart.current.remove();
      }
    };
  }, []);

  // Fetch historical OHLC data
  const fetchHistoricalData = async () => {
    if (!dataQueryEnabled) {
      console.log('Historical data fetching is disabled');
      setIsLoadingHistorical(false);
      return;
    }
    
    setIsLoadingHistorical(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('NEXT_PUBLIC_API_URL not configured');
      }

      // Build query parameters
      let queryParams = `symbol=MSFT&timeframe=${currentTimeframe}&account_mode=${accountMode}`;
      
      if (useCustomDateRange && startDate && endDate) {
        // Use custom date range
        queryParams += `&start_date=${startDate}&end_date=${endDate}`;
        console.log(`Fetching historical data with custom date range: ${startDate} to ${endDate}`);
      } else {
        // Use period-based query
        queryParams += `&period=${currentPeriod}`;
        console.log(`Fetching historical data with period: ${currentPeriod}`);
      }

      const response = await fetch(
        `${apiUrl}/api/market-data/history?${queryParams}`,
        {
          headers: {
            'X-Data-Query-Enabled': dataQueryEnabled.toString()
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch historical data: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      // Convert data to TradingView format
      const formattedData: CandlestickData[] = data.bars?.map((bar: any) => ({
        time: bar.timestamp as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })) || [];

      setChartData(formattedData);
      setLastHistoricalUpdate(new Date());

      // Update chart series
      if (candlestickSeries.current && volumeSeries.current && formattedData.length > 0) {
        candlestickSeries.current.setData(formattedData);
        
        // Volume data with color coding based on price movement
        const volumeData = formattedData.map(bar => ({
          time: bar.time,
          value: bar.volume || 0,
          color: bar.close >= bar.open ? '#22c55e' : '#ef4444' // Green for up, red for down
        }));
        
        volumeSeries.current.setData(volumeData);
        
        // Fit content to show all data
        chart.current?.timeScale().fitContent();
      }

    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch historical data');
    } finally {
      setIsLoadingHistorical(false);
    }
  };

  // Fetch real-time data for current price display
  const fetchRealtimeData = async () => {
    if (!dataQueryEnabled) {
      console.log('Real-time data fetching is disabled');
      setIsLoading(false);
      return;
    }
    
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('NEXT_PUBLIC_API_URL not configured');
      }

      const response = await fetch(`${apiUrl}/api/market-data/realtime?symbol=MSFT&account_mode=${accountMode}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Data-Query-Enabled': dataQueryEnabled.toString()
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        if (response.status === 504) {
          throw new Error('Gateway timeout - IB service busy, will retry');
        } else if (response.status === 503) {
          throw new Error('Service temporarily unavailable, will retry');
        } else if (response.status === 500) {
          try {
            const errorData = await response.json();
            if (errorData.detail && errorData.detail.includes('subscription')) {
              throw new Error('Using delayed market data - real-time subscription not available');
            } else if (errorData.detail && errorData.detail.includes('timeout')) {
              throw new Error('IB Gateway timeout - will retry');
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

      const data: RealtimeData = await response.json();
      
      if (data.last && data.last > 0) {
        setCurrentData(data);
        setLastUpdate(new Date());
        setError(null);
      } else {
        throw new Error('Invalid data received from API');
      }
    } catch (err) {
      console.error('Error fetching real-time data:', err);
      
      if (err instanceof Error && (err.message.includes('timeout') || err.message.includes('busy'))) {
        console.log('Temporary timeout, will retry automatically...');
        if (!currentData || (new Date().getTime() - (lastUpdate?.getTime() || 0)) > 30000) {
          setError('Connection temporarily slow, retrying...');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch data');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch historical data when timeframe or period changes - only when data query is enabled
  useEffect(() => {
    if (dataQueryEnabled) {
      fetchHistoricalData();
    }
  }, [currentTimeframe, currentPeriod, dataQueryEnabled]);

  // Set up polling for real-time data - only when data query is enabled
  useEffect(() => {
    if (!dataQueryEnabled) {
      console.log('Real-time polling disabled - data querying is off');
      return;
    }

    fetchRealtimeData();
    const interval = setInterval(fetchRealtimeData, 5000); // Every 5 seconds for current price
    return () => clearInterval(interval);
  }, [dataQueryEnabled]);

  // Helper functions
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: true, 
      hour: 'numeric', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  const getPriceChange = () => {
    if (!currentData || chartData.length === 0) return null;
    const previousClose = chartData[chartData.length - 1]?.close;
    if (!previousClose) return null;
    
    const change = currentData.last - previousClose;
    const changePercent = (change / previousClose) * 100;
    return { change, changePercent };
  };

  const getPriceChangeColor = () => {
    const priceChange = getPriceChange();
    if (!priceChange) return 'text-gray-900';
    return priceChange.change >= 0 ? 'text-green-600' : 'text-red-600';
  };

  const handleTimeframeChange = (timeframe: string) => {
    setCurrentTimeframe(timeframe);
  };

  const handlePeriodChange = (period: string) => {
    setCurrentPeriod(period);
    
    // Toggle custom date range mode
    if (period === 'CUSTOM') {
      setUseCustomDateRange(true);
    } else {
      setUseCustomDateRange(false);
    }
  };

  const handleDateRangeChange = (start: string, end: string) => {
    setStartDate(start);
    setEndDate(end);
    
    // Validate date range
    if (start && end) {
      const startDateTime = new Date(start);
      const endDateTime = new Date(end);
      
      if (startDateTime >= endDateTime) {
        setError('Start date must be before end date');
        return;
      }
      
      // Clear any previous errors
      setError(null);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold">MSFT - Microsoft Corporation</h2>
          <div className="text-sm opacity-90">
            NASDAQ • {dataType === 'real-time' ? 'Live Data' : 'Delayed Data (15-20 min)'} • {accountMode.toUpperCase()} Mode
            {/* Debug indicator for date range functionality */}
            <span className="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded">
              Date Range v2.0 {periods.length} periods
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="p-4 border-b border-gray-200">
        {/* Data Switch */}
        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <DataSwitch
            enabled={dataQueryEnabled}
            onToggle={handleDataSwitchToggle}
            label="IB Gateway Data Query"
            description="Enable or disable real-time and historical data fetching from IB Gateway"
            size="medium"
          />
        </div>
        
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mr-2">Timeframe:</label>
              <select
                value={currentTimeframe}
                onChange={(e) => handleTimeframeChange(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1 text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {timeframes.map((tf) => (
                  <option key={tf.value} value={tf.value}>{tf.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="text-sm font-medium text-gray-700 mr-2">Period:</label>
              <select
                value={currentPeriod}
                onChange={(e) => handlePeriodChange(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1 text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {periods.map((period) => {
                  // Debug log each period being rendered
                  console.log(`Rendering period option: ${period.label} (${period.value})`);
                  return (
                    <option key={period.value} value={period.value}>{period.label}</option>
                  );
                })}
              </select>
            </div>
            
            {/* Custom Date Range Controls */}
            {useCustomDateRange && (
              <>
                <div>
                  <label className="text-sm font-medium text-gray-700 mr-2">Start Date:</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => handleDateRangeChange(e.target.value, endDate)}
                    className="border border-gray-300 rounded px-3 py-1 text-sm"
                    disabled={isLoadingHistorical || !dataQueryEnabled}
                    max={endDate || undefined}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 mr-2">End Date:</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => handleDateRangeChange(startDate, e.target.value)}
                    className="border border-gray-300 rounded px-3 py-1 text-sm"
                    disabled={isLoadingHistorical || !dataQueryEnabled}
                    min={startDate || undefined}
                    max={new Date().toISOString().split('T')[0]}
                  />
                </div>
              </>
            )}
            
            <button
              onClick={fetchHistoricalData}
              disabled={isLoadingHistorical || !dataQueryEnabled || (useCustomDateRange && (!startDate || !endDate))}
              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:bg-gray-400"
            >
              {isLoadingHistorical ? 'Loading...' : 'Refresh Chart'}
            </button>
            
            {!dataQueryEnabled && (
              <div className="px-3 py-1 bg-amber-100 text-amber-800 text-sm rounded border border-amber-200">
                Data querying disabled
              </div>
            )}
          </div>

          {lastHistoricalUpdate && (
            <div className="text-sm text-gray-500">
              Chart updated: {formatTime(lastHistoricalUpdate)}
            </div>
          )}
        </div>
      </div>

      {/* Current Price Info */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            {isLoading && <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>}
            <span className="text-sm text-gray-600">Last Price Update</span>
          </div>
          {lastUpdate && (
            <div className="text-sm text-gray-500">
              {formatTime(lastUpdate)}
            </div>
          )}
        </div>

        {currentData && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-sm text-gray-600">Last Price</p>
              <p className={`text-xl font-bold ${getPriceChangeColor()}`}>
                ${currentData.last.toFixed(2)}
              </p>
              {getPriceChange() && (
                <p className={`text-sm ${getPriceChangeColor()}`}>
                  {getPriceChange()!.change > 0 ? '+' : ''}
                  {getPriceChange()!.change.toFixed(2)} 
                  ({getPriceChange()!.changePercent > 0 ? '+' : ''}
                  {getPriceChange()!.changePercent.toFixed(2)}%)
                </p>
              )}
            </div>
            
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-sm text-gray-600">Bid</p>
              <p className="text-lg font-semibold text-gray-900">${currentData.bid.toFixed(2)}</p>
            </div>
            
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-sm text-gray-600">Ask</p>
              <p className="text-lg font-semibold text-gray-900">${currentData.ask.toFixed(2)}</p>
            </div>
            
            <div className="bg-gray-50 p-3 rounded">
              <p className="text-sm text-gray-600">Volume</p>
              <p className="text-lg font-semibold text-gray-900">{currentData.volume.toLocaleString()}</p>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
            <div className="flex items-center">
              <span className="text-red-600 mr-2">⚠️</span>
              <p className="text-sm text-red-800">{error}</p>
            </div>
            <button
              onClick={fetchRealtimeData}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* OHLC Candlestick Chart */}
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-700">
            OHLC Candlestick Chart - {currentTimeframe} / {currentPeriod}
          </h4>
          {isLoadingHistorical && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              Loading chart data...
            </div>
          )}
        </div>
        
        <div 
          ref={chartContainerRef} 
          className="w-full border border-gray-200 rounded"
        />
        
        {chartData.length > 0 && (
          <div className="mt-2 text-xs text-gray-500 space-y-1">
            <div>Data points: {chartData.length} | Timeframe: {currentTimeframe}</div>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <div className="w-3 h-3 bg-green-500 rounded"></div>
                Bull Bars (Green)
              </span>
              <span className="flex items-center gap-1">
                <div className="w-3 h-3 bg-red-500 rounded"></div>
                Bear Bars (Red)
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
} 