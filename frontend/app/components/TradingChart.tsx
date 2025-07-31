'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { io, Socket } from 'socket.io-client';
import IndicatorSelector from './IndicatorSelector';

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

interface TradingChartProps {
  onTimeframeChange?: (timeframe: string) => void;
  onSymbolChange?: (symbol: string) => void;
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

export default function TradingChart({ onTimeframeChange, onSymbolChange }: TradingChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candlestickSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const socket = useRef<Socket | null>(null);
  
  const [currentSymbol, setCurrentSymbol] = useState('AAPL');
  const [symbolInput, setSymbolInput] = useState('AAPL');
  const [currentTimeframe, setCurrentTimeframe] = useState('5min');
  const [chartData, setChartData] = useState<CandlestickData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realTimePrice, setRealTimePrice] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [isSubscribed, setIsSubscribed] = useState(false);
  
  // Indicator states
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>([]);
  const indicatorSeries = useRef<Map<string, ISeriesApi<any>>>(new Map());

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart
    chart.current = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: chartContainerRef.current.clientWidth,
      height: 600,
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

    // Add candlestick series
    candlestickSeries.current = chart.current.addCandlestickSeries({
      upColor: '#4CAF50',
      downColor: '#F44336',
      borderDownColor: '#F44336',
      borderUpColor: '#4CAF50',
      wickDownColor: '#F44336',
      wickUpColor: '#4CAF50',
    });

    // Add volume series
    volumeSeries.current = chart.current.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
      visible: true,
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

  // Set up Socket.io connection for real-time data
  useEffect(() => {
    const backendUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!backendUrl) {
      console.error('NEXT_PUBLIC_API_URL is not configured');
      return;
    }
    socket.current = io(backendUrl);

    socket.current.on('connect', () => {
      setConnectionStatus('Connected');
      console.log('Chart connected to backend for real-time data');
    });

    socket.current.on('disconnect', () => {
      setConnectionStatus('Disconnected');
      setIsSubscribed(false);
      console.log('Chart disconnected from backend');
    });

    socket.current.on('market-data-update', (data: any) => {
      if (data.symbol === currentSymbol && data.data?.last) {
        setRealTimePrice(data.data.last);
        
        // Update chart with real-time price if we have chart data
        if (chartData.length > 0 && candlestickSeries.current) {
          const lastBar = chartData[chartData.length - 1];
          const now = Math.floor(Date.now() / 1000);
          
          // Create a new bar or update the last bar based on timeframe
          const updatedBar: CandlestickData = {
            time: now as Time,
            open: lastBar.close,
            high: Math.max(lastBar.high, data.data.last),
            low: Math.min(lastBar.low, data.data.last),
            close: data.data.last,
            volume: lastBar.volume || 0
          };
          
          candlestickSeries.current.update(updatedBar);
        }
      }
    });

    return () => {
      if (socket.current) {
        socket.current.close();
      }
    };
  }, [currentSymbol, currentTimeframe]);

  // Subscribe/unsubscribe to market data when symbol or timeframe changes
  useEffect(() => {
    if (socket.current && connectionStatus === 'Connected') {
      // Unsubscribe from previous symbol if subscribed
      if (isSubscribed) {
        socket.current.emit('unsubscribe-market-data', { symbol: currentSymbol });
      }
      
      // Subscribe to new symbol
      socket.current.emit('subscribe-market-data', {
        symbol: currentSymbol,
        timeframe: currentTimeframe
      });
      setIsSubscribed(true);
    }
  }, [currentSymbol, currentTimeframe, connectionStatus]);

  // Fetch historical data when timeframe or symbol changes
  useEffect(() => {
    fetchHistoricalData();
  }, [currentTimeframe, currentSymbol]);

  const fetchHistoricalData = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!backendUrl) {
        throw new Error('NEXT_PUBLIC_API_URL is not configured');
      }
      const response = await fetch(
        `${backendUrl}/api/market-data/history?symbol=${currentSymbol}&timeframe=${currentTimeframe}&period=90D`
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      // Convert data to TradingView format
      const formattedData: CandlestickData[] = data.bars?.map((bar: any) => ({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })) || [];
      
      setChartData(formattedData);
      
      // Update chart series
      if (candlestickSeries.current && volumeSeries.current) {
        candlestickSeries.current.setData(formattedData);
        
        // Volume data
        const volumeData = formattedData.map(bar => ({
          time: bar.time,
          value: bar.volume || 0,
          color: bar.close >= bar.open ? '#4CAF50' : '#F44336'
        }));
        
        volumeSeries.current.setData(volumeData);
      }
      
    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSymbolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newSymbol = symbolInput.trim().toUpperCase();
    if (newSymbol && newSymbol !== currentSymbol) {
      setCurrentSymbol(newSymbol);
      setRealTimePrice(null);
      setError(null);
      onSymbolChange?.(newSymbol);
    }
  };

  const handleTimeframeChange = (timeframe: string) => {
    setCurrentTimeframe(timeframe);
    onTimeframeChange?.(timeframe);
  };

  const updateRealTimeData = (newBar: CandlestickData) => {
    setChartData(prev => {
      const updated = [...prev, newBar];
      if (candlestickSeries.current) {
        candlestickSeries.current.update(newBar);
      }
      return updated;
    });
  };

  return (
    <div className="w-full h-full flex flex-col">
      {/* Header with Symbol Input and Controls */}
      <div className="bg-white border-b border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          {/* Symbol Input */}
          <div className="flex items-center gap-4">
            <form onSubmit={handleSymbolSubmit} className="flex items-center gap-2">
              <label htmlFor="symbol-input" className="text-sm font-medium text-gray-700">
                Symbol:
              </label>
              <input
                id="symbol-input"
                type="text"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                placeholder="Enter symbol (e.g., AAPL)"
                className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={10}
              />
              <button
                type="submit"
                className="px-3 py-1 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Load
              </button>
            </form>
            
            {/* Current Symbol and Price Display */}
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-gray-900">{currentSymbol}</span>
              {realTimePrice && (
                <span className="text-lg font-semibold text-green-600">
                  ${realTimePrice.toFixed(2)}
                </span>
              )}
            </div>
          </div>

          {/* Status Indicators */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${connectionStatus === 'Connected' ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-sm text-gray-600">{connectionStatus}</span>
            </div>
            {isSubscribed && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                <span className="text-sm text-gray-600">Subscribed</span>
              </div>
            )}
          </div>
        </div>

        {/* Timeframe Buttons */}
        <div className="flex flex-wrap gap-2 mt-4">
          {timeframes.map((tf) => (
            <button
              key={tf.value}
              onClick={() => handleTimeframeChange(tf.value)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                currentTimeframe === tf.value
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Error Display */}
        {error && (
          <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>

      {/* Chart Container */}
      <div className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-75 z-10">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              <span className="text-gray-600">Loading {currentSymbol} data...</span>
            </div>
          </div>
        )}
        <div ref={chartContainerRef} className="w-full h-full" />
      </div>
    </div>
  );
} 