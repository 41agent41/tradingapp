'use client';

import React from 'react';

interface ChartSkeletonProps {
  /** Chart area height in px. Defaults to 400 to match the historical chart. */
  height?: number;
  /**
   * Show a header row of pill placeholders (mimicking the timeframe / period
   * controls). Off for embedded charts (e.g. backtest equity curve) where the
   * surrounding card already has a title.
   */
  withHeader?: boolean;
  /** Optional label centred over the skeleton; "Loading…" by default. */
  label?: string;
}

/**
 * Lightweight pulsing placeholder displayed while a chart's data is in flight.
 *
 * Mimics the basic geometry of the lightweight-charts canvas — a tall main
 * area plus a thin volume band below — so the layout doesn't jump when the
 * real chart mounts. No animation library; uses Tailwind's `animate-pulse`.
 */
export default function ChartSkeleton({
  height = 400,
  withHeader = false,
  label = 'Loading…',
}: ChartSkeletonProps) {
  return (
    <div className="w-full" aria-busy="true" aria-live="polite">
      {withHeader && (
        <div className="flex items-center space-x-2 mb-3">
          <div className="h-6 w-24 rounded bg-gray-200 animate-pulse" />
          <div className="h-6 w-16 rounded bg-gray-200 animate-pulse" />
          <div className="h-6 w-16 rounded bg-gray-200 animate-pulse" />
        </div>
      )}
      <div
        className="relative w-full rounded-md bg-gray-100 overflow-hidden border border-gray-200"
        style={{ height }}
      >
        {/* Main chart band */}
        <div
          className="absolute inset-x-0 top-0 bg-gray-200 animate-pulse"
          style={{ height: `${Math.floor(height * 0.78)}px` }}
        />
        {/* Volume band */}
        <div
          className="absolute inset-x-0 bottom-0 bg-gray-300/70 animate-pulse"
          style={{ height: `${Math.floor(height * 0.18)}px` }}
        />
        {/* Centred status label */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-gray-500 bg-white/80 px-2 py-1 rounded">{label}</span>
        </div>
      </div>
    </div>
  );
}
