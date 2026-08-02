'use client';

import React, { useState } from 'react';
import Chart from './Chart';
import DataframeViewer from './DataframeViewer';
import { useHistoricalData } from '../lib/useHistoricalData';

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

const periods = [
  { label: '1 Day', value: '1D' },
  { label: '5 Days', value: '5D' },
  { label: '1 Month', value: '1M' },
  { label: '3 Months', value: '3M' },
  { label: '6 Months', value: '6M' },
  { label: '1 Year', value: '1Y' },
];

/**
 * Contract-driven historical chart. Now a thin wrapper around the shared
 * `<Chart>` primitive + `useHistoricalData` hook (GAP_ANALYSIS §3.5) — the
 * bespoke lightweight-charts instance, timestamp-validation loop and manual
 * series management it used to own now live in one canonical place.
 */
export default function EnhancedTradingChart({
  contract,
  timeframe,
  onTimeframeChange,
}: EnhancedTradingChartProps) {
  const [currentTimeframe, setCurrentTimeframe] = useState(timeframe);
  const [currentPeriod, setCurrentPeriod] = useState('3M');

  const { bars, loading, error, refresh } = useHistoricalData({
    symbol: contract?.symbol ?? '',
    timeframe: currentTimeframe,
    period: currentPeriod,
    secType: contract?.secType ?? 'STK',
    exchange: contract?.exchange ?? 'SMART',
    currency: contract?.currency ?? 'USD',
    enabled: !!contract,
  });

  const lastPrice = bars.length > 0 ? bars[bars.length - 1].close : null;

  const handleTimeframeChange = (newTimeframe: string) => {
    setCurrentTimeframe(newTimeframe);
    onTimeframeChange?.(newTimeframe);
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
            {lastPrice != null && (
              <div className="text-xl font-bold text-gray-900 mt-1">${lastPrice.toFixed(2)}</div>
            )}
          </div>

          {loading && (
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
              onChange={(e) => setCurrentPeriod(e.target.value)}
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
              onClick={refresh}
              className="mt-2 px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        ) : (
          <Chart data={bars} height={500} />
        )}
      </div>

      {/* Chart Info */}
      {bars.length > 0 && !loading && (
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div>Data points: {bars.length}</div>
            <div>
              Period: {currentPeriod} • Timeframe: {currentTimeframe}
            </div>
          </div>
        </div>
      )}

      {/* Dataframe Display */}
      {bars.length > 0 && !loading && (
        <div className="mt-6 p-4 border-t border-gray-200">
          <DataframeViewer
            data={bars.map((bar) => ({
              time: new Date(bar.time * 1000).toLocaleString(),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume ?? 0,
            }))}
            title={`${contract.symbol} Historical Data`}
            description={`${bars.length} data points for ${currentTimeframe} timeframe`}
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
