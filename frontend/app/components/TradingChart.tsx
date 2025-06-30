'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { io, Socket } from 'socket.io-client';

interface CandlestickData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface TradingChartProps {
  symbol: string;
  onTimeframeChange?: (timeframe: string) => void;
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

export default function TradingChart({ symbol, onTimeframeChange }: TradingChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candlestickSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const socket = useRef<Socket | null>(null);
  
  const [currentTimeframe, setCurrentTimeframe] = useState('1hour');
  const [chartData, setChartData] = useState<CandlestickData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realTimePrice, setRealTimePrice] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');

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

  // Set up Socket.io connection for real-time data
  useEffect(() => {
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    socket.current = io(backendUrl);

    socket.current.on('connect', () => {
      setConnectionStatus('Connected');
      console.log('Chart connected to backend for real-time data');
      
      // Subscribe to market data for this symbol
      socket.current?.emit('subscribe-market-data', {
        symbol: symbol,
        timeframe: currentTimeframe
      });
    });

    socket.current.on('disconnect', () => {
      setConnectionStatus('Disconnected');
      console.log('Chart disconnected from backend');
    });

    socket.current.on('market-data-update', (data: any) => {
      if (data.symbol === symbol && data.data?.last) {
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
        socket.current.emit('unsubscribe-market-data', { symbol });
        socket.current.close();
      }
    };
  }, [symbol, currentTimeframe]);

  // Fetch historical data when timeframe changes
  useEffect(() => {
    fetchHistoricalData();
  }, [currentTimeframe, symbol]);

  const fetchHistoricalData = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const response = await fetch(
        `${backendUrl}/api/market-data/history?symbol=${symbol}&timeframe=${currentTimeframe}&period=12M`
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
        volumeSeries.current.setData(
          formattedData.map(bar => ({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? '#4CAF50' : '#F44336',
          }))
        );
        
        // Fit content to chart
        chart.current?.timeScale().fitContent();
      }
      
    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTimeframeChange = (timeframe: string) => {
    setCurrentTimeframe(timeframe);
    onTimeframeChange?.(timeframe);
  };

  // Update chart with real-time data
  const updateRealTimeData = (newBar: CandlestickData) => {
    if (candlestickSeries.current && volumeSeries.current) {
      candlestickSeries.current.update(newBar);
      volumeSeries.current.update({
        time: newBar.time,
        value: newBar.volume || 0,
        color: newBar.close >= newBar.open ? '#4CAF50' : '#F44336',
      });
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <div className="flex items-center space-x-4">
            <h2 className="text-2xl font-bold text-gray-900">{symbol}</h2>
            {realTimePrice && (
              <div className="text-2xl font-bold text-blue-600">
                ${realTimePrice.toFixed(2)}
              </div>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <p className="text-gray-600">Real-time Chart</p>
            <div className={`px-2 py-1 rounded text-xs font-medium ${
              connectionStatus === 'Connected' ? 'bg-green-100 text-green-800' : 
              'bg-red-100 text-red-800'
            }`}>
              {connectionStatus}
            </div>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-600">Timeframe:</span>
          <div className="flex bg-gray-100 rounded-lg p-1">
            {timeframes.map((tf) => (
              <button
                key={tf.value}
                onClick={() => handleTimeframeChange(tf.value)}
                className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                  currentTimeframe === tf.value
                    ? 'bg-blue-500 text-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          Error loading chart data: {error}
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center items-center h-96">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          <span className="ml-2 text-gray-600">Loading {symbol} data...</span>
        </div>
      )}

      <div
        ref={chartContainerRef}
        className={`w-full ${isLoading ? 'hidden' : 'block'}`}
        style={{ height: '600px' }}
      />
      
      <div className="mt-4 flex justify-between text-sm text-gray-600">
        <div>
          Data: 12 months • Timeframe: {timeframes.find(tf => tf.value === currentTimeframe)?.label}
        </div>
        <div>
          Bars: {chartData.length} • Source: Interactive Brokers
        </div>
      </div>
    </div>
  );
} 