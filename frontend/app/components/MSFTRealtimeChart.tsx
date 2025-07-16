'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface RealtimeData {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}

interface PricePoint {
  time: Time;
  value: number;
}

export default function MSFTRealtimeChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lineSeries = useRef<ISeriesApi<'Line'> | null>(null);
  
  const [currentData, setCurrentData] = useState<RealtimeData | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    chart.current = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: chartContainerRef.current.clientWidth,
      height: 400,
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
        secondsVisible: true,
      },
    });

    // Add line series for real-time price
    lineSeries.current = chart.current.addLineSeries({
      color: '#2196F3',
      lineWidth: 2,
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

  // Fetch real-time data
  const fetchRealtimeData = async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiUrl) {
        throw new Error('NEXT_PUBLIC_API_URL not configured');
      }

      const response = await fetch(`${apiUrl}/api/market-data/realtime?symbol=MSFT`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: RealtimeData = await response.json();
      
      if (data.last && data.last > 0) {
        setCurrentData(data);
        setLastUpdate(new Date());
        
        // Add new price point to history
        const now = Math.floor(Date.now() / 1000) as Time;
        const newPoint: PricePoint = {
          time: now,
          value: data.last
        };
        
        setPriceHistory(prev => {
          const updated = [...prev, newPoint];
          // Keep only last 100 points for performance
          const trimmed = updated.slice(-100);
          
          // Update chart
          if (lineSeries.current) {
            lineSeries.current.setData(trimmed);
          }
          
          return trimmed;
        });
        
        setError(null);
      } else {
        throw new Error('Invalid data received from API');
      }
    } catch (err) {
      console.error('Error fetching real-time data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  // Set up polling for real-time data
  useEffect(() => {
    // Initial fetch
    fetchRealtimeData();
    
    // Set up polling every 2 seconds
    const interval = setInterval(fetchRealtimeData, 2000);
    
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  const getPriceChangeColor = () => {
    if (priceHistory.length < 2) return 'text-gray-900';
    const current = priceHistory[priceHistory.length - 1]?.value;
    const previous = priceHistory[priceHistory.length - 2]?.value;
    if (current > previous) return 'text-green-600';
    if (current < previous) return 'text-red-600';
    return 'text-gray-900';
  };

  const getPriceChange = () => {
    if (priceHistory.length < 2) return null;
    const current = priceHistory[priceHistory.length - 1]?.value;
    const previous = priceHistory[priceHistory.length - 2]?.value;
    const change = current - previous;
    const changePercent = (change / previous) * 100;
    return { change, changePercent };
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Header */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">MSFT - Microsoft Corporation</h3>
            <p className="text-sm text-gray-600">Real-time Market Data</p>
          </div>
          
          <div className="flex items-center space-x-4">
            {isLoading && (
              <div className="flex items-center text-blue-600">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
                <span className="text-sm">Loading...</span>
              </div>
            )}
            
            {!isLoading && (
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                <span className="text-sm text-gray-600">Live</span>
              </div>
            )}
          </div>
        </div>

        {/* Price Display */}
        {currentData && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
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

        {/* Last Update */}
        {lastUpdate && (
          <div className="mt-2 text-sm text-gray-500">
            Last updated: {formatTime(lastUpdate)}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
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

      {/* Chart */}
      <div className="p-4">
        <div className="mb-2">
          <h4 className="text-sm font-medium text-gray-700">Price Movement (Last 100 Updates)</h4>
        </div>
        
        <div 
          ref={chartContainerRef} 
          className="w-full border border-gray-200 rounded"
        />
        
        {priceHistory.length > 0 && (
          <div className="mt-2 text-xs text-gray-500">
            Data points: {priceHistory.length} | Update frequency: Every 2 seconds
          </div>
        )}
      </div>
    </div>
  );
} 