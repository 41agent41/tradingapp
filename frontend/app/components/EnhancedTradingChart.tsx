'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface CandlestickData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface ContractData {
  conid: string;
  symbol: string;
  companyName: string;
  description: string;
  secType: string;
  currency?: string;
  exchange?: string;
}

interface EnhancedTradingChartProps {
  contract: ContractData | null;
  timeframe: string;
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

const periods = [
  { label: '1 Day', value: '1D' },
  { label: '5 Days', value: '5D' },
  { label: '1 Month', value: '1M' },
  { label: '3 Months', value: '3M' },
  { label: '6 Months', value: '6M' },
  { label: '1 Year', value: '1Y' }
];

export default function EnhancedTradingChart({ 
  contract, 
  timeframe, 
  onTimeframeChange 
}: EnhancedTradingChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candlestickSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  
  const [currentTimeframe, setCurrentTimeframe] = useState(timeframe);
  const [currentPeriod, setCurrentPeriod] = useState('3M');
  const [chartData, setChartData] = useState<CandlestickData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart
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

  // Fetch historical data when contract or timeframe changes
  useEffect(() => {
    if (contract) {
      fetchHistoricalData();
    }
  }, [contract, currentTimeframe, currentPeriod]);

  const fetchHistoricalData = async () => {
    if (!contract) return;

    setIsLoading(true);
    setError(null);
    
    try {
      const backendUrl = (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_API_URL) || process.env.NEXT_PUBLIC_API_URL;
    if (!backendUrl) {
      console.error('NEXT_PUBLIC_API_URL is not configured');
      return;
    }
      const response = await fetch(
        `${backendUrl}/api/market-data/history?symbol=${contract.symbol}&timeframe=${currentTimeframe}&period=${currentPeriod}`
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
      if (candlestickSeries.current && volumeSeries.current && formattedData.length > 0) {
        candlestickSeries.current.setData(formattedData);
        
        // Volume data
        const volumeData = formattedData.map(bar => ({
          time: bar.time,
          value: bar.volume || 0,
          color: bar.close >= bar.open ? '#4CAF50' : '#F44336'
        }));
        
        volumeSeries.current.setData(volumeData);
        
        // Set last price
        const lastBar = formattedData[formattedData.length - 1];
        setLastPrice(lastBar.close);
        
        // Fit content
        chart.current?.timeScale().fitContent();
      }
      
    } catch (err) {
      console.error('Error fetching historical data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTimeframeChange = (newTimeframe: string) => {
    setCurrentTimeframe(newTimeframe);
    onTimeframeChange?.(newTimeframe);
  };

  const handlePeriodChange = (newPeriod: string) => {
    setCurrentPeriod(newPeriod);
  };

  if (!contract) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="text-center py-8">
          <div className="text-gray-400 text-lg mb-2">📈</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Contract Selected</h3>
          <p className="text-gray-600">
            Select a contract from the search results above to view the chart.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Chart Header */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-medium text-gray-900">
              {contract.symbol} - {contract.companyName}
            </h3>
            <div className="text-sm text-gray-600">
              {contract.description} • {contract.secType}
              {contract.currency && ` • ${contract.currency}`}
            </div>
            {lastPrice && (
              <div className="text-xl font-bold text-gray-900 mt-1">
                ${lastPrice.toFixed(2)}
              </div>
            )}
          </div>
          
          {isLoading && (
            <div className="flex items-center text-blue-600">
              <span className="animate-spin mr-2">↻</span>
              <span className="text-sm">Loading...</span>
            </div>
          )}
        </div>

        {/* Timeframe and Period Controls */}
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-gray-700">Timeframe:</span>
            <div className="flex space-x-1">
              {timeframes.map((tf) => (
                <button
                  key={tf.value}
                  onClick={() => handleTimeframeChange(tf.value)}
                  className={`px-3 py-1 text-sm rounded-md transition-colors ${
                    currentTimeframe === tf.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-gray-700">Period:</span>
            <select
              value={currentPeriod}
              onChange={(e) => handlePeriodChange(e.target.value)}
              className="px-3 py-1 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {periods.map((period) => (
                <option key={period.value} value={period.value}>
                  {period.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Chart Container */}
      <div className="p-4">
        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-md p-4">
            <div className="text-red-800">❌ {error}</div>
            <button
              onClick={fetchHistoricalData}
              className="mt-2 px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        ) : (
          <div ref={chartContainerRef} className="w-full" />
        )}
      </div>

      {/* Chart Info */}
      {chartData.length > 0 && !isLoading && (
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div>
              Data points: {chartData.length}
            </div>
            <div>
              Period: {currentPeriod} • Timeframe: {currentTimeframe}
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 