'use client';

import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { useChartResize } from '../lib/useChartResize';

export interface EquityPoint {
  time: number; // unix seconds
  value: number;
}

interface EquityCurveChartProps {
  data: EquityPoint[];
  height?: number;
}

export default function EquityCurveChart({ data, height = 320 }: EquityCurveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#333',
      },
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#cccccc' },
      timeScale: {
        borderColor: '#cccccc',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const series = chart.addAreaSeries({
      lineColor: '#2563eb',
      lineWidth: 2,
      topColor: 'rgba(37, 99, 235, 0.35)',
      bottomColor: 'rgba(37, 99, 235, 0.03)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useChartResize(containerRef, chartRef);

  useEffect(() => {
    if (!seriesRef.current || !data?.length) return;

    // lightweight-charts requires strictly ascending, unique timestamps.
    const seen = new Set<number>();
    const formatted = data
      .filter((p) => p && Number.isFinite(p.time) && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time)
      .filter((p) => {
        if (seen.has(p.time)) return false;
        seen.add(p.time);
        return true;
      })
      .map((p) => ({ time: p.time as Time, value: p.value }));

    seriesRef.current.setData(formatted);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="w-full" />;
}
