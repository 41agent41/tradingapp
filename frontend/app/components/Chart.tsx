'use client';

import React, { useEffect, useRef } from 'react';
import {
  CandlestickData,
  ColorType,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  SeriesMarker,
  Time,
  createChart,
} from 'lightweight-charts';

import { useChartResize } from '../lib/useChartResize';

export interface ChartBar {
  /** Unix seconds (lightweight-charts' canonical time unit). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface ChartIndicatorSeries {
  /** Stable key (also used as the series id). */
  key: string;
  /** Display label for the legend (optional). */
  label?: string;
  /** Time-aligned values; index `i` corresponds to `bars[i]`. */
  values: Array<number | null | undefined>;
  /** Line colour (defaults to a TradingView blue). */
  color?: string;
  /**
   * Optional separate price scale id (e.g. `'rsi'`, `'macd'`). Overlays that
   * share the price axis with the candles (moving averages, Bollinger bands,
   * VWAP) should omit this; oscillators whose range would distort the candle
   * scale should pass a dedicated id so they render on their own axis.
   */
  priceScaleId?: string;
}

/** A buy/sell (or arbitrary) marker drawn on the candle series. Used by the
 *  systematic monitor to overlay strategy signals. */
export interface ChartMarker {
  /** Unix seconds — should line up with a bar's `time`. */
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text?: string;
}

export interface ChartProps {
  data: ChartBar[];
  /** Optional overlay indicator series. */
  indicators?: ChartIndicatorSeries[];
  /** Optional signal markers pinned to the candle series. */
  markers?: ChartMarker[];
  /** Whether to render the volume histogram band. Defaults to true. */
  showVolume?: boolean;
  /** Canvas height in pixels. Defaults to 400. */
  height?: number;
  /** Disable user interactions (pan / zoom). Useful for snapshots. */
  readOnly?: boolean;
}

const DEFAULT_HEIGHT = 400;
const DEFAULT_INDICATOR_COLOR = '#2563eb';

function toCandle(bar: ChartBar): CandlestickData {
  return {
    time: bar.time as Time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function toVolume(bar: ChartBar): HistogramData {
  const up = bar.close >= bar.open;
  return {
    time: bar.time as Time,
    value: bar.volume ?? 0,
    color: up ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
  };
}

/**
 * Sort + dedupe by `time` ascending — lightweight-charts requires strictly
 * increasing time stamps, otherwise it throws on `setData`.
 */
function sortAndDedupe<T extends { time: Time }>(rows: T[]): T[] {
  const seen = new Set<Time>();
  return rows
    .filter((r) => r.time != null && (r.time as number) === (r.time as number))
    .sort((a, b) => Number(a.time) - Number(b.time))
    .filter((r) => {
      if (seen.has(r.time)) return false;
      seen.add(r.time);
      return true;
    });
}

/**
 * Shared OHLCV chart primitive. Consumers feed `ChartBar[]` data; the
 * component owns lightweight-charts creation, candlestick + volume + any
 * indicator overlays, and the ResizeObserver wiring via `useChartResize`.
 *
 * GAP_ANALYSIS §3.5 — collapses the four overlapping chart wrappers
 * (HistoricalChart / TradingChart / EnhancedTradingChart /
 * MSFTRealtimeChart). The existing wrappers can adopt this primitive
 * incrementally.
 */
/** Sort + dedupe markers by time ascending — lightweight-charts requires
 *  `setMarkers` input in non-decreasing time order. */
function prepareMarkers(markers: ChartMarker[]): SeriesMarker<Time>[] {
  return markers
    .filter((m) => m.time != null && Number.isFinite(m.time))
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((m) => ({
      time: m.time as Time,
      position: m.position,
      shape: m.shape,
      color: m.color,
      text: m.text,
    }));
}

export default function Chart({
  data,
  indicators = [],
  markers = [],
  showVolume = true,
  height = DEFAULT_HEIGHT,
  readOnly = false,
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // Create the chart once on mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#cccccc' },
      timeScale: { borderColor: '#cccccc', timeVisible: true, secondsVisible: false },
      handleScroll: !readOnly,
      handleScale: !readOnly,
    });

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    if (showVolume) {
      const vol = chart.addHistogramSeries({
        color: 'rgba(38, 166, 154, 0.5)',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      vol.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volumeSeriesRef.current = vol;
    }

    chartRef.current = chart;

    return () => {
      indicatorSeriesRef.current.clear();
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [height, showVolume, readOnly]);

  // Resize observer keeps width in sync with sibling reflows.
  useChartResize(containerRef, chartRef);

  // Push data on every change.
  useEffect(() => {
    if (!candleSeriesRef.current || !data) return;

    const candles = sortAndDedupe(data.map(toCandle));
    candleSeriesRef.current.setData(candles);

    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(sortAndDedupe(data.map(toVolume)));
    }
  }, [data]);

  // Reconcile indicator overlay series.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const live = indicatorSeriesRef.current;
    const wantedKeys = new Set(indicators.map((i) => i.key));

    // Drop any indicator series the caller no longer wants.
    // (Array.from keeps this es5-safe without --downlevelIteration.)
    for (const [key, series] of Array.from(live.entries())) {
      if (!wantedKeys.has(key)) {
        chart.removeSeries(series);
        live.delete(key);
      }
    }

    // Add or update the rest.
    for (const ind of indicators) {
      let series = live.get(ind.key);
      if (!series) {
        const onSeparateScale =
          ind.priceScaleId != null && ind.priceScaleId !== '' && ind.priceScaleId !== 'right';
        series = chart.addLineSeries({
          color: ind.color ?? DEFAULT_INDICATOR_COLOR,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: ind.priceScaleId ?? 'right',
        });
        // Give oscillator scales a little breathing room so they don't sit
        // flush against the top/bottom of the pane.
        if (onSeparateScale) {
          series.priceScale().applyOptions({
            scaleMargins: { top: 0.1, bottom: 0.1 },
          });
        }
        live.set(ind.key, series);
      } else if (ind.color) {
        series.applyOptions({ color: ind.color });
      }

      const points: LineData[] = [];
      for (let i = 0; i < data.length; i++) {
        const v = ind.values[i];
        if (v != null && Number.isFinite(v)) {
          points.push({ time: data[i].time as Time, value: v as number });
        }
      }
      series.setData(sortAndDedupe(points));
    }
  }, [indicators, data]);

  // Reconcile candle-series markers (strategy signals).
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    series.setMarkers(prepareMarkers(markers));
  }, [markers]);

  return <div ref={containerRef} className="w-full" style={{ height }} aria-label="Chart" />;
}

export const __test = { sortAndDedupe, prepareMarkers };
