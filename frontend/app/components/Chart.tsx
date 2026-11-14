'use client';

import React, { useEffect, useRef } from 'react';
import {
  CandlestickData,
  CandlestickSeries,
  ColorType,
  HistogramData,
  HistogramSeries,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineData,
  LineSeries,
  LineStyle,
  SeriesMarker,
  Time,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts';

import { formatChartTime, formatTick } from '../lib/chartTime';
import { chartThemeOptions, useTheme } from '../lib/theme';
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
   * Optional separate scale id (e.g. `'rsi'`, `'macd'`). Overlays that share
   * the price axis with the candles (moving averages, Bollinger bands, VWAP)
   * omit this. An oscillator passes an id and is drawn in its own pane below
   * the candles; series with the same id (MACD and its signal) share a pane.
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

/** A horizontal line at one price, labelled on the price axis: a position's
 *  entry, a stop, a target or a working order (E-24). */
export interface ChartPriceLine {
  /** Stable key: a line whose key and content are unchanged is left alone. */
  key: string;
  price: number;
  color: string;
  style?: 'solid' | 'dashed' | 'dotted';
  /** Shown beside the line. */
  title?: string;
}

const LINE_STYLE = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
} as const;

export interface ChartProps {
  data: ChartBar[];
  /** Optional overlay indicator series. */
  indicators?: ChartIndicatorSeries[];
  /** Optional signal markers pinned to the candle series. */
  markers?: ChartMarker[];
  /** Optional price lines on the candle series. */
  priceLines?: ChartPriceLine[];
  /** Whether to render the volume histogram band. Defaults to true. */
  showVolume?: boolean;
  /** Canvas height in pixels. Defaults to 400. */
  height?: number;
  /** Disable user interactions (pan / zoom). Useful for snapshots. */
  readOnly?: boolean;
  /**
   * The candle being formed from live ticks (lib/liveCandles.ts). It updates
   * the last candle, or adds one after it, without redrawing `data`. Ignored
   * when it is older than the last bar of `data`.
   */
  liveBar?: ChartBar | null;
  /**
   * Called when the chart is scrolled or zoomed back to its first bars, so
   * the caller can load older ones (E-23). When older bars are then put in
   * front of `data`, the bars on screen stay where they are.
   */
  onReachStart?: () => void;
  /**
   * The zone the time axis and crosshair are shown in: an IANA name, or
   * `local` for the browser's (lib/chartTime.ts). Defaults to UTC.
   */
  timeZone?: string;
}

/** Bars left of the screen's edge at which older ones are asked for. */
const START_MARGIN_BARS = 10;

const DEFAULT_HEIGHT = 400;
/** Relative height of the price pane against each oscillator pane. */
const PRICE_PANE_STRETCH = 3;
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
 * How many of `times` (ascending) come before `previousFirst`, when
 * `previousFirst` is still among them: the bars newly put in front. Zero when
 * the data was replaced, not extended.
 */
function addedInFront(times: number[], previousFirst: number): number {
  const index = times.indexOf(previousFirst);
  return index > 0 ? index : 0;
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
/** The pane per oscillator scale id, in first-seen order: pane 0 is the
 *  candles, so the first oscillator id gets pane 1. */
function paneLayout(indicators: ChartIndicatorSeries[]): Map<string, number> {
  const panes = new Map<string, number>();
  for (const ind of indicators) {
    const id = ind.priceScaleId;
    if (id && id !== 'right' && !panes.has(id)) panes.set(id, panes.size + 1);
  }
  return panes;
}

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
  priceLines,
  showVolume = true,
  height = DEFAULT_HEIGHT,
  readOnly = false,
  liveBar = null,
  onReachStart,
  timeZone = 'UTC',
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const layoutRef = useRef('');
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // The price lines drawn, and the candle series they were drawn on.
  const priceLinesRef = useRef<{
    series: ISeriesApi<'Candlestick'> | null;
    lines: Map<string, { line: IPriceLine; shown: string }>;
  }>({ series: null, lines: new Map() });
  /** Time of the last bar drawn, so a stale live bar is never sent. */
  const lastTimeRef = useRef<number | null>(null);
  /** Time of the first bar drawn, to tell when older bars were added. */
  const firstTimeRef = useRef<number | null>(null);
  const onReachStartRef = useRef(onReachStart);
  useEffect(() => {
    onReachStartRef.current = onReachStart;
  }, [onReachStart]);

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

    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, {
        color: 'rgba(38, 166, 154, 0.5)',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      vol.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volumeSeriesRef.current = vol;
    }

    markersRef.current = createSeriesMarkers(candleSeriesRef.current, []);
    chartRef.current = chart;

    // Ask for older bars when the left edge of the screen nears the first.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && firstTimeRef.current !== null && range.from < START_MARGIN_BARS) {
        onReachStartRef.current?.();
      }
    });

    return () => {
      indicatorSeriesRef.current.clear();
      layoutRef.current = '';
      markersRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chartRef.current = null;
      firstTimeRef.current = null;
      chart.remove();
    };
  }, [height, showVolume, readOnly]);

  // Resize observer keeps width in sync with sibling reflows.
  useChartResize(containerRef, chartRef);

  // The page's theme, also given to a chart that was made afresh.
  const theme = useTheme();
  useEffect(() => {
    chartRef.current?.applyOptions(chartThemeOptions(theme));
  }, [theme, height, showVolume, readOnly]);

  // Push data on every change.
  useEffect(() => {
    if (!candleSeriesRef.current || !data) return;

    const candles = sortAndDedupe(data.map(toCandle));
    // Older bars put in front shift every bar's position; move the view by
    // as many, so the bars on screen stay where they are.
    const timeScale = chartRef.current?.timeScale();
    const added =
      firstTimeRef.current === null
        ? 0
        : addedInFront(
            candles.map((c) => Number(c.time)),
            firstTimeRef.current
          );
    const view = added > 0 ? timeScale?.getVisibleLogicalRange() : null;
    candleSeriesRef.current.setData(candles);
    lastTimeRef.current = candles.length ? Number(candles[candles.length - 1].time) : null;
    firstTimeRef.current = candles.length ? Number(candles[0].time) : null;
    if (view) timeScale?.setVisibleLogicalRange({ from: view.from + added, to: view.to + added });

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
    const panes = paneLayout(indicators);
    const layout = JSON.stringify(Array.from(panes.entries()));

    // When the oscillator panes change, start the indicators afresh: the
    // library drops a pane once its last series goes, which would shift the
    // index of every pane below it.
    const relayout = layout !== layoutRef.current;
    layoutRef.current = layout;

    // Drop any indicator series the caller no longer wants.
    // (Array.from keeps this es5-safe without --downlevelIteration.)
    for (const [key, series] of Array.from(live.entries())) {
      if (relayout || !wantedKeys.has(key)) {
        chart.removeSeries(series);
        live.delete(key);
      }
    }

    // Add or update the rest.
    for (const ind of indicators) {
      let series = live.get(ind.key);
      if (!series) {
        const pane = ind.priceScaleId ? (panes.get(ind.priceScaleId) ?? 0) : 0;
        series = chart.addSeries(
          LineSeries,
          {
            color: ind.color ?? DEFAULT_INDICATOR_COLOR,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
          pane
        );
        // Give oscillators a little breathing room so they don't sit flush
        // against the top/bottom of their pane.
        if (pane > 0) {
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

    if (relayout && panes.size > 0) {
      chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? PRICE_PANE_STRETCH : 1));
    }
  }, [indicators, data]);

  // Move the forming candle. `update` replaces the last bar when the time
  // matches and appends otherwise; an older time would throw, so skip it.
  useEffect(() => {
    const candles = candleSeriesRef.current;
    if (!candles || !liveBar || !Number.isFinite(liveBar.time)) return;
    if (lastTimeRef.current !== null && liveBar.time < lastTimeRef.current) return;
    candles.update(toCandle(liveBar));
    volumeSeriesRef.current?.update(toVolume(liveBar));
    lastTimeRef.current = liveBar.time;
  }, [liveBar]);

  // Show times in the chosen zone. A chart left in UTC keeps the library's
  // own labels; once it has shown another zone it keeps these formatters,
  // because the library cannot be given its own back.
  const zonedRef = useRef(false);
  useEffect(() => {
    if (timeZone === 'UTC' && !zonedRef.current) return;
    zonedRef.current = true;
    chartRef.current?.applyOptions({
      localization: {
        timeFormatter: (time: Time) =>
          typeof time === 'number' ? formatChartTime(time, timeZone) : '',
      },
      timeScale: {
        tickMarkFormatter: (time: Time, type: number) =>
          typeof time === 'number' ? formatTick(time, type, timeZone) : null,
      },
    });
    // The chart is made afresh when these change, and needs them again.
  }, [timeZone, height, showVolume, readOnly]);

  // Reconcile candle-series markers (strategy signals).
  useEffect(() => {
    markersRef.current?.setMarkers(prepareMarkers(markers));
  }, [markers]);

  // Reconcile the price lines: add the new, redraw the changed, remove the
  // gone. The chart is made afresh when its size or panes change, and the
  // lines are then drawn again on the new candle series.
  useEffect(() => {
    const candles = candleSeriesRef.current;
    if (!candles) return;
    const state = priceLinesRef.current;
    if (state.series !== candles) {
      // A new chart: the lines of the old one went with it.
      state.series = candles;
      state.lines = new Map();
    }
    const drawn = state.lines;
    const wanted = new Map<string, ChartPriceLine>();
    (priceLines ?? []).forEach((l) => {
      if (Number.isFinite(l.price)) wanted.set(l.key, l);
    });
    Array.from(drawn.entries()).forEach(([key, entry]) => {
      if (!wanted.has(key)) {
        candles.removePriceLine(entry.line);
        drawn.delete(key);
      }
    });
    wanted.forEach((l, key) => {
      const options = {
        price: l.price,
        color: l.color,
        lineWidth: 1 as const,
        lineStyle: LINE_STYLE[l.style ?? 'solid'],
        axisLabelVisible: true,
        title: l.title ?? '',
      };
      const shown = JSON.stringify(options);
      const entry = drawn.get(key);
      if (!entry) drawn.set(key, { line: candles.createPriceLine(options), shown });
      else if (entry.shown !== shown) {
        entry.line.applyOptions(options);
        entry.shown = shown;
      }
    });
  }, [priceLines, height, showVolume, readOnly]);

  return <div ref={containerRef} className="w-full" style={{ height }} aria-label="Chart" />;
}

export const __test = { sortAndDedupe, prepareMarkers, paneLayout, addedInFront };
