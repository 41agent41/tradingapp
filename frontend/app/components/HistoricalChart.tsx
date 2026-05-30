'use client';

import React from 'react';
import Chart, { ChartBar } from './Chart';
import DataframeViewer from './DataframeViewer';

interface ProcessedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface HistoricalChartProps {
  data: ProcessedBar[];
  symbol: string;
  timeframe: string;
}

/**
 * Thin wrapper around the shared `<Chart>` primitive. Previously held its
 * own lightweight-charts instance + resize wiring; now delegates the
 * candlestick/volume rendering to Chart.tsx so the four overlapping chart
 * components share one canonical implementation (GAP_ANALYSIS §3.5).
 */
export default function HistoricalChart({ data, symbol, timeframe }: HistoricalChartProps) {
  const bars: ChartBar[] = data.map((bar) => ({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));

  return (
    <div className="w-full">
      <Chart data={bars} height={400} />

      {data.length > 0 && (
        <div className="mt-2 text-xs text-gray-500 space-y-1">
          <div>
            Data points: {data.length} | Timeframe: {timeframe}
          </div>
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

      {data.length > 0 && (
        <div className="mt-6">
          <DataframeViewer
            data={data.map((bar) => ({
              time: new Date(bar.time * 1000).toLocaleString(),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            }))}
            title={`${symbol} Historical Data`}
            description={`${data.length} data points for ${timeframe} timeframe`}
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
