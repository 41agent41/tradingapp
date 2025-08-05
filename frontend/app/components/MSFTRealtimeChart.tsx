'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import DataSwitch from './DataSwitch';
import IndicatorSelector from './IndicatorSelector';
import DataframeViewer from './DataframeViewer';
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
  
  // Technical Indicators
  sma_20?: number;
  sma_50?: number;
  ema_12?: number;
  ema_26?: number;
  rsi?: number;
  macd?: number;
  macd_signal?: number;
  macd_histogram?: number;
  bb_upper?: number;
  bb_middle?: number;
  bb_lower?: number;
  stoch_k?: number;
  stoch_d?: number;
  atr?: number;
  obv?: number;
  vwap?: number;
  volume_sma?: number;
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

export default function MSFTRealtimeChart() {
  const { accountMode, dataType } = useTradingAccount();
  
  // Simple periods array - always fresh
  const periods = [
    { label: '1 Day', value: '1D' },
    { label: '5 Days', value: '5D' },
    { label: '1 Month', value: '1M' },
    { label: '3 Months', value: '3M' },
    { label: '6 Months', value: '6M' },
    { label: '1 Year', value: '1Y' },
    { label: 'Custom Range', value: 'CUSTOM' }
  ];
  
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
      return saved !== null ? JSON.parse(saved) : true; // Default to true (enabled)
    }
    return true; // Default to true (enabled)
  });

  // Indicator states
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('msft-chart-indicators');
      return saved ? JSON.parse(saved) : [];
    }
    return [];
  });
  
  // Chart series for indicators
  const indicatorSeries = useRef<Map<string, ISeriesApi<any>>>(new Map());

  // Interface for indicator configuration
  interface IndicatorConfig {
    color: string;
    title: string;
    type: string;
    priceScale?: string;
  }

  // Simple date initialization
  useEffect(() => {
    const now = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(now.getMonth() - 3);
    
    setEndDate(now.toISOString().split('T')[0]);
    setStartDate(threeMonthsAgo.toISOString().split('T')[0]);
    
    console.log('MSFT Chart v3.0: Initialized with', periods.length, 'periods');
  }, []);

  // Handle data switch toggle
  const handleDataSwitchToggle = (enabled: boolean) => {
    setDataQueryEnabled(enabled);
    if (typeof window !== 'undefined') {
      localStorage.setItem('msft-chart-data-enabled', JSON.stringify(enabled));
    }
    if (!enabled) {
      setError(null);
    }
  };

  // Handle indicator selection change
  const handleIndicatorChange = (indicators: string[]) => {
    setSelectedIndicators(indicators);
    if (typeof window !== 'undefined') {
      localStorage.setItem('msft-chart-indicators', JSON.stringify(indicators));
    }
    
    // Clear existing indicator series
    indicatorSeries.current.forEach((series, key) => {
      if (chart.current) {
        chart.current.removeSeries(series);
      }
    });
    indicatorSeries.current.clear();
    
    // Refetch data with new indicators
    if (dataQueryEnabled) {
      fetchHistoricalData();
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

  // Update indicator series on chart
  const updateIndicatorSeries = (data: CandlestickData[]) => {
    if (!chart.current) return;

    const chartInstance = chart.current; // Store reference for TypeScript

    // Clear existing indicator series first
    indicatorSeries.current.forEach((series) => {
      chartInstance.removeSeries(series);
    });
    indicatorSeries.current.clear();

    // Define indicator configurations
    const indicatorConfigs: Record<string, IndicatorConfig> = {
      sma_20: { color: '#2563eb', title: 'SMA 20', type: 'line' },
      sma_50: { color: '#dc2626', title: 'SMA 50', type: 'line' },
      ema_12: { color: '#059669', title: 'EMA 12', type: 'line' },
      ema_26: { color: '#ea580c', title: 'EMA 26', type: 'line' },
      bb_upper: { color: '#7c3aed', title: 'BB Upper', type: 'line' },
      bb_middle: { color: '#7c3aed', title: 'BB Middle', type: 'line' },
      bb_lower: { color: '#7c3aed', title: 'BB Lower', type: 'line' },
      vwap: { color: '#0891b2', title: 'VWAP', type: 'line' },
      macd: { color: '#be123c', title: 'MACD', type: 'line', priceScale: 'macd' },
      macd_signal: { color: '#0369a1', title: 'MACD Signal', type: 'line', priceScale: 'macd' },
      rsi: { color: '#9333ea', title: 'RSI', type: 'line', priceScale: 'rsi' }
    };

    selectedIndicators.forEach(indicatorKey => {
      const config = indicatorConfigs[indicatorKey as keyof typeof indicatorConfigs];
      if (!config) return;

      // Extract data for this indicator
      const indicatorData = data
        .map(bar => ({
          time: bar.time,
          value: (bar as any)[indicatorKey]
        }))
        .filter(point => point.value !== undefined && !isNaN(point.value));

      if (indicatorData.length === 0) return;

      try {
        let series: ISeriesApi<any>;

        if (config.type === 'line') {
          series = chartInstance.addLineSeries({
            color: config.color,
            lineWidth: 2,
            title: config.title,
            priceScaleId: config.priceScale ?? 'right',
            visible: true
          });

          // Set price scale options for oscillators
          if (config.priceScale === 'rsi') {
            series.priceScale().applyOptions({
              scaleMargins: { top: 0.1, bottom: 0.1 },
              autoScale: false,
              mode: 1,
              invertScale: false,
              borderVisible: false,
              ticksVisible: false,
              entireTextOnly: false,
              visible: true
            });
          } else if (config.priceScale === 'macd') {
            series.priceScale().applyOptions({
              scaleMargins: { top: 0.1, bottom: 0.1 },
              autoScale: true,
              mode: 1,
              invertScale: false,
              borderVisible: false,
              ticksVisible: false,
              entireTextOnly: false,
              visible: true
            });
          }
        } else {
          // Default to line series
          series = chartInstance.addLineSeries({
            color: config.color,
            lineWidth: 2,
            title: config.title
          });
        }

        series.setData(indicatorData);
        indicatorSeries.current.set(indicatorKey, series);
        
        console.log(`Added ${config.title} indicator series with ${indicatorData.length} points`);
      } catch (error) {
        console.error(`Error adding ${config.title} series:`, error);
      }
    });
  };

  // Simplified historical data fetch
  const fetchHistoricalData = async () => {
    if (!dataQueryEnabled) {
      console.log('Data querying disabled');
      setIsLoadingHistorical(false);
      return;
    }
    
    setIsLoadingHistorical(true);
    setError(null);
    
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('API URL not configured');
      }

      // Simple query building
      let url = `${apiUrl}/api/market-data/history?symbol=MSFT&timeframe=${currentTimeframe}&account_mode=${accountMode}`;
      
      if (useCustomDateRange && startDate && endDate) {
        url += `&start_date=${startDate}&end_date=${endDate}`;
        console.log('Fetching custom date range:', startDate, 'to', endDate);
      } else {
        url += `&period=${currentPeriod}`;
        console.log('Fetching period:', currentPeriod);
      }
      
      // Add indicators if selected
      if (selectedIndicators.length > 0) {
        url += `&indicators=${selectedIndicators.join(',')}`;
        console.log('Fetching with indicators:', selectedIndicators);
      }

      console.log('API Request:', url);
      
      const response = await fetch(url, {
        headers: { 'X-Data-Query-Enabled': 'true' }
      });

      console.log('Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error:', errorText);
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      console.log('Response data:', data);
      
      if (!data.bars || !Array.isArray(data.bars)) {
        throw new Error('No bars data received');
      }

      console.log('Processing', data.bars.length, 'bars');

      // Data conversion with indicators and proper timestamp handling
      const formattedData: CandlestickData[] = data.bars.map((bar: any) => {
        // Validate and convert timestamp to TradingView format (Unix timestamp in seconds)
        let timestamp = bar.timestamp;
        
        // Validate timestamp is a valid number
        if (typeof timestamp !== 'number' || isNaN(timestamp)) {
          console.warn('Invalid timestamp:', timestamp, 'for bar:', bar);
          return null;
        }
        
        // Convert to seconds if in milliseconds
        if (timestamp > 1000000000000) {
          timestamp = Math.floor(timestamp / 1000);
        }
        
        // Validate timestamp is reasonable (not in the future or too far in the past)
        const now = Math.floor(Date.now() / 1000);
        if (timestamp > now + 86400 || timestamp < now - 31536000 * 10) { // Within 1 day future or 10 years past
          console.warn('Timestamp out of reasonable range:', timestamp, 'for bar:', bar);
          return null;
        }
        
        const candlestick: CandlestickData = {
          time: timestamp as Time,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume),
        };
        
        // Add indicator values if present
        const indicatorFields = [
          'sma_20', 'sma_50', 'ema_12', 'ema_26', 'rsi',
          'macd', 'macd_signal', 'macd_histogram',
          'bb_upper', 'bb_middle', 'bb_lower',
          'stoch_k', 'stoch_d', 'atr', 'obv', 'vwap', 'volume_sma'
        ];
        
        indicatorFields.forEach(field => {
          if (bar[field] !== undefined && bar[field] !== null && !isNaN(bar[field])) {
            (candlestick as any)[field] = Number(bar[field]);
          }
        });
        
        return candlestick;
      }).filter((bar: CandlestickData | null) => 
        bar !== null && !isNaN(bar.open) && !isNaN(bar.high) && !isNaN(bar.low) && !isNaN(bar.close)
      );

      console.log('Formatted', formattedData.length, 'valid bars');

      // Sort by timestamp in ascending order (oldest first) - required by TradingView
      formattedData.sort((a, b) => (a.time as number) - (b.time as number));
      console.log('Sorted data for TradingView chart');

      setChartData(formattedData);
      setLastHistoricalUpdate(new Date());

      // Update chart
      if (candlestickSeries.current && formattedData.length > 0) {
        candlestickSeries.current.setData(formattedData);
        
        if (volumeSeries.current) {
          const volumeData = formattedData.map(bar => ({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? '#22c55e' : '#ef4444'
          }));
          volumeSeries.current.setData(volumeData);
        }
        
        // Add indicator series
        updateIndicatorSeries(formattedData);
        
        chart.current?.timeScale().fitContent();
        console.log('Chart updated successfully');
      }

    } catch (err) {
      console.error('Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
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

  // Fetch historical data when timeframe, period, or indicators change - only when data query is enabled
  useEffect(() => {
    if (dataQueryEnabled) {
      fetchHistoricalData();
    }
  }, [currentTimeframe, currentPeriod, dataQueryEnabled, selectedIndicators]);

  // Set up polling for real-time data - only when data query is enabled
  useEffect(() => {
    if (!dataQueryEnabled) {
      console.log('Real-time polling disabled - data querying is off');
      return;
    }

    if (useCustomDateRange) {
      console.log('Custom date range active, stopping real-time polling.');
      return;
    }

    fetchRealtimeData();
    const interval = setInterval(fetchRealtimeData, 5000); // Every 5 seconds for current price
    return () => clearInterval(interval);
  }, [dataQueryEnabled, useCustomDateRange]);

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
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-2 sm:space-y-0">
          <h2 className="text-lg sm:text-xl font-bold">MSFT - Microsoft Corporation</h2>
          <div className="text-xs sm:text-sm opacity-90">
            NASDAQ • {dataType === 'real-time' ? 'Live Data' : 'Delayed Data (15-20 min)'} • {accountMode.toUpperCase()} Mode
            <span className="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded">
              v3.0 {periods.length} periods
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="p-3 sm:p-4 border-b border-gray-200">
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

        {/* Indicator Selector */}
        {dataQueryEnabled && (
          <div className="mb-4">
            <IndicatorSelector
              selectedIndicators={selectedIndicators}
              onIndicatorChange={handleIndicatorChange}
              isLoading={isLoadingHistorical}
            />
          </div>
        )}
        
        <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 items-start sm:items-center justify-between">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
            <div>
              <label className="text-xs sm:text-sm font-medium text-gray-700 mr-2">Timeframe:</label>
              <select
                value={currentTimeframe}
                onChange={(e) => {
                  setCurrentTimeframe(e.target.value);
                  console.log('Timeframe changed to:', e.target.value);
                }}
                className="border border-gray-300 rounded px-2 sm:px-3 py-1 text-xs sm:text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {timeframes.map((tf) => (
                  <option key={tf.value} value={tf.value}>{tf.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="text-xs sm:text-sm font-medium text-gray-700 mr-2">Period:</label>
              <select
                value={currentPeriod}
                onChange={(e) => {
                  const newPeriod = e.target.value;
                  setCurrentPeriod(newPeriod);
                  setUseCustomDateRange(newPeriod === 'CUSTOM');
                  console.log('Period changed to:', newPeriod, 'Custom range:', newPeriod === 'CUSTOM');
                }}
                className="border border-gray-300 rounded px-2 sm:px-3 py-1 text-xs sm:text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {periods.map((period) => (
                  <option key={period.value} value={period.value}>{period.label}</option>
                ))}
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
                    onChange={(e) => setStartDate(e.target.value)}
                    className="border border-gray-300 rounded px-3 py-1 text-sm"
                    disabled={isLoadingHistorical || !dataQueryEnabled}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 mr-2">End Date:</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="border border-gray-300 rounded px-3 py-1 text-sm"
                    disabled={isLoadingHistorical || !dataQueryEnabled}
                  />
                </div>
              </>
            )}
            
            <button
              onClick={() => {
                console.log('Refresh button clicked');
                fetchHistoricalData();
              }}
              disabled={isLoadingHistorical || !dataQueryEnabled}
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
              Chart updated: {lastHistoricalUpdate.toLocaleTimeString()}
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4 mb-4">
            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Last Price</p>
              <p className={`text-lg sm:text-xl font-bold ${getPriceChangeColor()}`}>
                ${currentData.last.toFixed(2)}
              </p>
              {getPriceChange() && (
                <p className={`text-xs sm:text-sm ${getPriceChangeColor()}`}>
                  {getPriceChange()!.change > 0 ? '+' : ''}
                  {getPriceChange()!.change.toFixed(2)} 
                  ({getPriceChange()!.changePercent > 0 ? '+' : ''}
                  {getPriceChange()!.changePercent.toFixed(2)}%)
                </p>
              )}
            </div>
            
            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Bid</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">${currentData.bid.toFixed(2)}</p>
            </div>
            
            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Ask</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">${currentData.ask.toFixed(2)}</p>
            </div>
            
            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Volume</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">{currentData.volume.toLocaleString()}</p>
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
      <div className="p-3 sm:p-4">
        <div className="mb-2 flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
          <h4 className="text-xs sm:text-sm font-medium text-gray-700">
            OHLC Candlestick Chart - {currentTimeframe} / {currentPeriod}
          </h4>
          {isLoadingHistorical && (
            <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-600">
              <div className="animate-spin rounded-full h-3 w-3 sm:h-4 sm:w-4 border-b-2 border-blue-600"></div>
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
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 sm:w-3 sm:h-3 bg-green-500 rounded"></div>
                Bull Bars (Green)
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 sm:w-3 sm:h-3 bg-red-500 rounded"></div>
                Bear Bars (Red)
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Dataframe Display */}
      {chartData.length > 0 && (
        <div className="mt-6">
          <DataframeViewer
            data={chartData.map(bar => ({
              time: (() => {
                if (typeof bar.time === 'number') {
                  return new Date(bar.time * 1000).toLocaleString();
                } else if (typeof bar.time === 'string') {
                  return new Date(bar.time).toLocaleString();
                } else if (bar.time && typeof bar.time === 'object' && 'year' in bar.time) {
                  return new Date(bar.time.year, bar.time.month - 1, bar.time.day).toLocaleString();
                } else {
                  return String(bar.time);
                }
              })(),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              ...(bar.sma_20 && { sma_20: bar.sma_20 }),
              ...(bar.sma_50 && { sma_50: bar.sma_50 }),
              ...(bar.ema_12 && { ema_12: bar.ema_12 }),
              ...(bar.ema_26 && { ema_26: bar.ema_26 }),
              ...(bar.rsi && { rsi: bar.rsi }),
              ...(bar.macd && { macd: bar.macd }),
              ...(bar.macd_signal && { macd_signal: bar.macd_signal }),
              ...(bar.macd_histogram && { macd_histogram: bar.macd_histogram }),
              ...(bar.bb_upper && { bb_upper: bar.bb_upper }),
              ...(bar.bb_middle && { bb_middle: bar.bb_middle }),
              ...(bar.bb_lower && { bb_lower: bar.bb_lower }),
              ...(bar.stoch_k && { stoch_k: bar.stoch_k }),
              ...(bar.stoch_d && { stoch_d: bar.stoch_d }),
              ...(bar.atr && { atr: bar.atr }),
              ...(bar.obv && { obv: bar.obv }),
              ...(bar.vwap && { vwap: bar.vwap }),
              ...(bar.volume_sma && { volume_sma: bar.volume_sma })
            }))}
            title="MSFT Historical Data"
            description={`${chartData.length} data points for ${currentTimeframe} timeframe`}
            maxHeight="400px"
            showExport={true}
            showPagination={true}
            itemsPerPage={25}
          />
        </div>
      )}
    </div>
  );
} 