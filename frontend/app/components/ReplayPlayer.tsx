'use client';

import React, { useEffect, useMemo, useState } from 'react';

import Chart, { type ChartMarker } from './Chart';
import {
  REPLAY_SPEEDS,
  columnsToBars,
  formatClock,
  frameAt,
  nextBarCursor,
  prepareReplay,
  previousBarCursor,
  replaySeconds,
  tradeMarkers,
  type ReplayResponse,
  type ReplayTrade,
} from '../lib/replay';

const BUTTON =
  'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40';
/** How often the clock is moved while playing, in milliseconds. */
const TICK_MS = 50;

export interface ReplayPlayerProps {
  replay: ReplayResponse;
  /** Trades of a strategy over the same bars, shown as they happen. */
  trades?: ReplayTrade[];
}

/**
 * Plays a replay's 1-minute bars onto a chart: play, pause, step a minute or
 * a bar either way, set the speed, or drag to any point. The last candle
 * grows minute by minute as it did at the time.
 */
export default function ReplayPlayer({ replay, trades }: ReplayPlayerProps) {
  const seconds = replaySeconds(replay.timeframe);
  const history = useMemo(() => columnsToBars(replay.history), [replay]);
  const prepared = useMemo(
    () => prepareReplay(columnsToBars(replay.minutes), seconds),
    [replay, seconds]
  );
  const total = prepared.minutes.length;

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  // Counts moves backwards. The chart only ever adds to its last candle, so
  // going back has to give it its bars afresh.
  const [rewinds, setRewinds] = useState(0);

  const go = (to: number) => {
    const next = Math.max(0, Math.min(total, Math.floor(to)));
    if (next < cursor) setRewinds((n) => n + 1);
    setCursor(next);
  };

  // While playing, the clock moves `speed` minutes of market each second.
  // Minutes due are counted from when play began, so no fraction is lost
  // between ticks.
  useEffect(() => {
    if (!playing) return;
    const began = Date.now();
    let given = 0;
    const id = setInterval(() => {
      const due = Math.floor(((Date.now() - began) * speed) / 1000);
      if (due > given) {
        const step = due - given;
        given = due;
        setCursor((c) => Math.min(total, c + step));
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, total]);

  useEffect(() => {
    if (cursor >= total) setPlaying(false);
  }, [cursor, total]);

  const frame = useMemo(() => frameAt(prepared, cursor), [prepared, cursor]);
  const bars = useMemo(
    () => history.concat(prepared.bars.slice(0, frame.done)),
    // `rewinds` is here to hand the chart a fresh array after a move back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, prepared, frame.done, rewinds]
  );
  const markers = useMemo<ChartMarker[]>(
    () => (trades?.length ? tradeMarkers(trades, seconds, frame.clock) : []),
    [trades, seconds, frame.clock]
  );

  const atEnd = cursor >= total;
  const f = frame.forming;
  const price = (v: number) => String(Number(v.toPrecision(8)));

  return (
    <div className="bg-white rounded-lg shadow-sm border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Replay controls">
        <button type="button" className={BUTTON} onClick={() => go(0)} disabled={cursor === 0}>
          Restart
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => go(previousBarCursor(prepared, cursor))}
          disabled={cursor === 0}
        >
          Back one bar
        </button>
        <button
          type="button"
          className="px-4 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          onClick={() => setPlaying((p) => !p)}
          disabled={atEnd}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => go(cursor + 1)}
          disabled={atEnd || playing}
        >
          Step one minute
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => go(nextBarCursor(prepared, cursor))}
          disabled={atEnd || playing}
        >
          Step one bar
        </button>
        <label className="text-sm text-gray-700 flex items-center gap-1 ml-2">
          Speed
          <select
            className="px-2 py-1 text-sm border border-gray-300 rounded-md"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-gray-500">1x plays one minute each second.</span>
      </div>

      <input
        type="range"
        aria-label="Replay position"
        className="w-full"
        min={0}
        max={total}
        value={cursor}
        onChange={(e) => go(Number(e.target.value))}
      />

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span className="font-medium text-gray-900" data-testid="replay-clock">
          {frame.clock === null
            ? `Starts ${formatClock(prepared.minutes[0]?.time ?? null)} UTC`
            : `${formatClock(frame.clock)} UTC`}
        </span>
        {f && (
          <span className="text-gray-600" data-testid="replay-candle">
            O {price(f.open)} H {price(f.high)} L {price(f.low)} C {price(f.close)}
          </span>
        )}
        <span className="text-gray-500" data-testid="replay-progress">
          {cursor} of {total} minutes{atEnd ? ' (end)' : ''}
        </span>
      </div>

      <Chart data={bars} liveBar={frame.forming} markers={markers} height={480} />
    </div>
  );
}
