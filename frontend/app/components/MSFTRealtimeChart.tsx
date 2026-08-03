'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Time } from 'lightweight-charts';
import Chart, { ChartBar, ChartIndicatorSeries } from './Chart';
import DataSwitch from './DataSwitch';
import IndicatorSelector from './IndicatorSelector';
import DataframeViewer from './DataframeViewer';
import { useTradingAccount } from '../contexts/TradingAccountContext';
import { apiFetch } from '../lib/api';
import { useRealtimeStream, TickPayload } from '../lib/useRealtimeStream';
import ChartSkeleton from './ChartSkeleton';

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
 * Which indicator fields render as chart overlays, and how. Overlays that
 * share the candle price axis (moving averages, Bollinger bands, VWAP) leave
 * `priceScaleId` unset; oscillators (MACD, RSI) get their own scale so they
 * don't flatten the candles. Keyed by the bar field name the IB service
 * returns, so the value can be pulled straight off each bar.
 */
const INDICATOR_CONFIGS: Record<string, { color: string; label: string; priceScaleId?: string }> = {
  sma_20: { color: '#2563eb', label: 'SMA 20' },
  sma_50: { color: '#dc2626', label: 'SMA 50' },
  ema_12: { color: '#059669', label: 'EMA 12' },
  ema_26: { color: '#ea580c', label: 'EMA 26' },
  bb_upper: { color: '#7c3aed', label: 'BB Upper' },
  bb_middle: { color: '#7c3aed', label: 'BB Middle' },
  bb_lower: { color: '#7c3aed', label: 'BB Lower' },
  vwap: { color: '#0891b2', label: 'VWAP' },
  macd: { color: '#be123c', label: 'MACD', priceScaleId: 'macd' },
  macd_signal: { color: '#0369a1', label: 'MACD Signal', priceScaleId: 'macd' },
  rsi: { color: '#9333ea', label: 'RSI', priceScaleId: 'rsi' },
};

const INDICATOR_FIELDS = [
  'sma_20',
  'sma_50',
  'ema_12',
  'ema_26',
  'rsi',
  'macd',
  'macd_signal',
  'macd_histogram',
  'bb_upper',
  'bb_middle',
  'bb_lower',
  'stoch_k',
  'stoch_d',
  'atr',
  'obv',
  'vwap',
  'volume_sma',
] as const;

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
    { label: 'Custom Range', value: 'CUSTOM' },
  ];

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

  // Keep the latest fetch inputs available to the imperative refresh button
  // without threading them through as arguments.
  const fetchRef = useRef<() => void>(() => {});

  // Simple date initialization
  useEffect(() => {
    const now = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(now.getMonth() - 3);

    setEndDate(now.toISOString().split('T')[0]);
    setStartDate(threeMonthsAgo.toISOString().split('T')[0]);
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

  // Handle indicator selection change. The shared <Chart> reconciles overlay
  // series from the `indicators` prop, so we just update state + persist and
  // let the historical refetch pull the new indicator columns.
  const handleIndicatorChange = (indicators: string[]) => {
    setSelectedIndicators(indicators);
    if (typeof window !== 'undefined') {
      localStorage.setItem('msft-chart-indicators', JSON.stringify(indicators));
    }
  };

  // Simplified historical data fetch
  const fetchHistoricalData = async () => {
    if (!dataQueryEnabled) {
      setIsLoadingHistorical(false);
      return;
    }

    setIsLoadingHistorical(true);
    setError(null);

    try {
      // Simple query building (apiFetch will prefix with NEXT_PUBLIC_API_URL)
      let url = `/api/market-data/history?symbol=MSFT&timeframe=${currentTimeframe}&account_mode=${accountMode}`;

      if (useCustomDateRange && startDate && endDate) {
        url += `&start_date=${startDate}&end_date=${endDate}`;
      } else {
        url += `&period=${currentPeriod}`;
      }

      // Add indicators if selected
      if (selectedIndicators.length > 0) {
        url += `&indicators=${selectedIndicators.join(',')}&include_indicators=true`;
      }

      const response = await apiFetch(url, {
        headers: { 'X-Data-Query-Enabled': 'true' },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error:', errorText);
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.bars || !Array.isArray(data.bars)) {
        throw new Error('No bars data received');
      }

      // Data conversion with indicators and proper timestamp handling
      const formattedData: CandlestickData[] = data.bars
        .map((bar: any) => {
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
          if (timestamp > now + 86400 || timestamp < now - 31536000 * 10) {
            // Within 1 day future or 10 years past
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
          INDICATOR_FIELDS.forEach((field) => {
            if (bar[field] !== undefined && bar[field] !== null && !isNaN(bar[field])) {
              (candlestick as any)[field] = Number(bar[field]);
            }
          });

          return candlestick;
        })
        .filter(
          (bar: CandlestickData | null) =>
            bar !== null &&
            !isNaN(bar.open) &&
            !isNaN(bar.high) &&
            !isNaN(bar.low) &&
            !isNaN(bar.close)
        );

      // Sort by timestamp in ascending order (oldest first) - required by TradingView
      formattedData.sort((a, b) => (a.time as number) - (b.time as number));

      setChartData(formattedData);
      setLastHistoricalUpdate(new Date());
    } catch (err) {
      console.error('Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoadingHistorical(false);
    }
  };

  fetchRef.current = fetchHistoricalData;

  // One-shot REST fetch used to seed the price display before the
  // first streaming tick arrives, and as a manual-refresh fallback.
  // Live updates come from `useRealtimeStream` below — there is no
  // polling timer any more (see GAP_ANALYSIS.md Phase 4).
  const refreshRealtimeOnce = async () => {
    if (!dataQueryEnabled) {
      setIsLoading(false);
      return;
    }
    try {
      const response = await apiFetch(
        `/api/market-data/realtime?symbol=MSFT&account_mode=${accountMode}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Data-Query-Enabled': dataQueryEnabled.toString(),
          },
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data: RealtimeData = await response.json();
      if (data.last && data.last > 0) {
        setCurrentData(data);
        setLastUpdate(new Date());
        setError(null);
      }
    } catch (err) {
      console.error('Error seeding real-time data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch historical data when timeframe, period, or indicators change - only when data query is enabled
  useEffect(() => {
    if (dataQueryEnabled) {
      fetchHistoricalData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeframe, currentPeriod, dataQueryEnabled, selectedIndicators]);

  // Seed the price display once on mount / when the dependencies
  // change. Live updates come from the streaming hook below; we do
  // NOT poll on a timer any more.
  useEffect(() => {
    if (!dataQueryEnabled) {
      return;
    }
    if (useCustomDateRange) {
      return;
    }
    refreshRealtimeOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataQueryEnabled, useCustomDateRange, accountMode]);

  // Real-time tick stream from the backend Socket.IO bridge. The hook
  // owns the Socket.IO connection and per-symbol subscribe/unsubscribe;
  // we just consume the latest tick payload as it arrives.
  const streamEnabled = dataQueryEnabled && !useCustomDateRange;
  const stream = useRealtimeStream({
    symbol: streamEnabled ? 'MSFT' : null,
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    enabled: streamEnabled,
  });

  // Merge each incoming tick into the synthetic RealtimeData shape so
  // the rest of the chart (which expects bid/ask/last/volume) doesn't
  // have to change. We persist non-zero numeric values so a LAST tick
  // doesn't wipe the most-recent BID and vice-versa.
  useEffect(() => {
    const tick: TickPayload | null = stream.latestTick;
    if (!tick) return;
    setCurrentData((prev) => {
      const merged: RealtimeData = {
        symbol: tick.symbol,
        bid: prev?.bid ?? 0,
        ask: prev?.ask ?? 0,
        last: prev?.last ?? 0,
        volume: prev?.volume ?? 0,
        timestamp: new Date(tick.timestamp * 1000).toISOString(),
      };
      const value = typeof tick.value === 'number' ? tick.value : null;
      if (value !== null && Number.isFinite(value) && value > 0) {
        switch (tick.tick_type) {
          case 'BID':
            merged.bid = value;
            break;
          case 'ASK':
            merged.ask = value;
            break;
          case 'LAST':
            merged.last = value;
            break;
          case 'VOLUME':
            merged.volume = Math.round(value);
            break;
          default:
            break;
        }
      }
      return merged;
    });
    setLastUpdate(new Date());
    setError(null);
  }, [stream.latestTick]);

  // Surface stream-level errors (Socket.IO connect_error, subscribe
  // failures) on the existing error banner.
  useEffect(() => {
    if (stream.error) setError(stream.error);
  }, [stream.error]);

  // Project the fetched bars into the shared <Chart> shapes. The candle/
  // volume data drops the indicator columns; the overlay series are built
  // from the configured indicator fields, aligned by index to the bars.
  const bars = useMemo<ChartBar[]>(
    () =>
      chartData.map((bar) => ({
        time: bar.time as number,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })),
    [chartData]
  );

  const indicators = useMemo<ChartIndicatorSeries[]>(() => {
    const out: ChartIndicatorSeries[] = [];
    for (const key of selectedIndicators) {
      const cfg = INDICATOR_CONFIGS[key];
      if (!cfg) continue;
      out.push({
        key,
        label: cfg.label,
        color: cfg.color,
        priceScaleId: cfg.priceScaleId,
        values: chartData.map((bar) => (bar as any)[key] as number | undefined),
      });
    }
    return out;
  }, [chartData, selectedIndicators]);

  // Helper functions
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
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

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-2 sm:space-y-0">
          <h2 className="text-lg sm:text-xl font-bold">MSFT - Microsoft Corporation</h2>
          <div className="text-xs sm:text-sm opacity-90">
            NASDAQ • {dataType === 'real-time' ? 'Live Data' : 'Delayed Data (15-20 min)'} •{' '}
            {accountMode.toUpperCase()} Mode
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
              <label className="text-xs sm:text-sm font-medium text-gray-700 mr-2">
                Timeframe:
              </label>
              <select
                value={currentTimeframe}
                onChange={(e) => {
                  setCurrentTimeframe(e.target.value);
                }}
                className="border border-gray-300 rounded px-2 sm:px-3 py-1 text-xs sm:text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {timeframes.map((tf) => (
                  <option key={tf.value} value={tf.value}>
                    {tf.label}
                  </option>
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
                }}
                className="border border-gray-300 rounded px-2 sm:px-3 py-1 text-xs sm:text-sm"
                disabled={isLoadingHistorical || !dataQueryEnabled}
              >
                {periods.map((period) => (
                  <option key={period.value} value={period.value}>
                    {period.label}
                  </option>
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
              onClick={() => fetchRef.current()}
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
            {isLoading && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
            )}
            <span className="text-sm text-gray-600">Last Price Update</span>
          </div>
          {lastUpdate && <div className="text-sm text-gray-500">{formatTime(lastUpdate)}</div>}
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
                  {getPriceChange()!.change.toFixed(2)}(
                  {getPriceChange()!.changePercent > 0 ? '+' : ''}
                  {getPriceChange()!.changePercent.toFixed(2)}%)
                </p>
              )}
            </div>

            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Bid</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">
                ${currentData.bid.toFixed(2)}
              </p>
            </div>

            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Ask</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">
                ${currentData.ask.toFixed(2)}
              </p>
            </div>

            <div className="bg-gray-50 p-2 sm:p-3 rounded">
              <p className="text-xs sm:text-sm text-gray-600">Volume</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900">
                {currentData.volume.toLocaleString()}
              </p>
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
              onClick={refreshRealtimeOnce}
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

        {isLoadingHistorical && chartData.length === 0 ? (
          <ChartSkeleton height={500} label="Loading MSFT history…" />
        ) : (
          <div className="border border-gray-200 rounded">
            <Chart data={bars} indicators={indicators} height={500} />
          </div>
        )}

        {chartData.length > 0 && (
          <div className="mt-2 text-xs text-gray-500 space-y-1">
            <div>
              Data points: {chartData.length} | Timeframe: {currentTimeframe}
            </div>
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
            data={chartData.map((bar) => ({
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
              ...(bar.volume_sma && { volume_sma: bar.volume_sma }),
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
