'use client';

import React, { useEffect, useState } from 'react';
import Chart from './Chart';
import { useHistoricalData } from '../lib/useHistoricalData';
import { useRealtimeStream } from '../lib/useRealtimeStream';

interface TradingChartProps {
  onTimeframeChange?: (timeframe: string) => void;
  onSymbolChange?: (symbol: string) => void;
}

const timeframes = [
  { label: 'Tick', value: 'tick', minutes: 0 },
  { label: '1m', value: '1min', minutes: 1 },
  { label: '5m', value: '5min', minutes: 5 },
  { label: '15m', value: '15min', minutes: 15 },
  { label: '30m', value: '30min', minutes: 30 },
  { label: '1h', value: '1hour', minutes: 60 },
  { label: '4h', value: '4hour', minutes: 240 },
  { label: '8h', value: '8hour', minutes: 480 },
  { label: '1d', value: '1day', minutes: 1440 },
];

/**
 * Symbol-input trading chart with a live price badge. Rewritten on top of the
 * shared `<Chart>` primitive + `useHistoricalData` / `useRealtimeStream`
 * hooks (GAP_ANALYSIS §3.5) — the bespoke lightweight-charts instance and its
 * own Socket.IO wiring are gone; the live price now flows through the same
 * streaming hook the rest of the app uses.
 */
export default function TradingChart({ onTimeframeChange, onSymbolChange }: TradingChartProps) {
  const [currentSymbol, setCurrentSymbol] = useState('AAPL');
  const [symbolInput, setSymbolInput] = useState('AAPL');
  const [currentTimeframe, setCurrentTimeframe] = useState('5min');

  const { bars, loading, error } = useHistoricalData({
    symbol: currentSymbol,
    timeframe: currentTimeframe,
    period: '90D',
  });

  const stream = useRealtimeStream({
    symbol: currentSymbol,
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  });

  const [realTimePrice, setRealTimePrice] = useState<number | null>(null);

  useEffect(() => {
    const tick = stream.latestTick;
    if (tick && tick.tick_type === 'LAST' && typeof tick.value === 'number' && tick.value > 0) {
      setRealTimePrice(tick.value);
    }
  }, [stream.latestTick]);

  // Reset the price badge when the symbol changes.
  useEffect(() => {
    setRealTimePrice(null);
  }, [currentSymbol]);

  const handleSymbolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newSymbol = symbolInput.trim().toUpperCase();
    if (newSymbol && newSymbol !== currentSymbol) {
      setCurrentSymbol(newSymbol);
      onSymbolChange?.(newSymbol);
    }
  };

  const handleTimeframeChange = (timeframe: string) => {
    setCurrentTimeframe(timeframe);
    onTimeframeChange?.(timeframe);
  };

  const connectionStatus = stream.connected ? 'Connected' : 'Disconnected';

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
              <div
                className={`w-2 h-2 rounded-full ${connectionStatus === 'Connected' ? 'bg-green-500' : 'bg-red-500'}`}
              ></div>
              <span className="text-sm text-gray-600">{connectionStatus}</span>
            </div>
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
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-75 z-10">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              <span className="text-gray-600">Loading {currentSymbol} data...</span>
            </div>
          </div>
        )}
        <Chart data={bars} height={600} />
      </div>
    </div>
  );
}
