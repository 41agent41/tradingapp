'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Chart, { type ChartMarker } from '../Chart';
import ChartSkeleton from '../ChartSkeleton';
import { apiFetch } from '../../lib/api';
import { useHistoricalData } from '../../lib/useHistoricalData';
import { useStrategySignals, type StrategySignalEvent } from '../../lib/useStrategySignals';

/**
 * Per-run detail (A5 / Phase 4): the run's signals over a candle chart with
 * buy/sell markers, a live-updating signal table (REST history merged with the
 * `strategy:<runId>` socket feed), and a summary strip (net position, signals,
 * orders placed). Delivers the roadmap's "chart with signal markers" and the
 * order-history overlay for free.
 */

interface SignalRow {
  id: number;
  run_id: number;
  bar_time: string;
  signal: string;
  reason: string | null;
  entry: boolean;
  exit: boolean;
  in_session: boolean;
  position_size: string | number;
  acted: boolean;
  order_audit_id: number | null;
}

interface DefinitionInfo {
  symbol: string;
  timeframe: string;
}

const PERIOD_FOR: Record<string, string> = {
  '1day': '1Y',
  '8hour': '6M',
  '4hour': '6M',
  '1hour': '1M',
};
const periodFor = (tf: string) => PERIOD_FOR[tf] ?? '10D';

function barTimeToUnix(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

/** Merge REST rows with live socket events, dedupe by bar_time, newest first. */
export function mergeSignals(rest: SignalRow[], live: StrategySignalEvent[]): SignalRow[] {
  const byTime = new Map<string, SignalRow>();
  for (const r of rest) byTime.set(r.bar_time, r);
  for (const e of live) {
    const key = e.bar_time;
    if (!byTime.has(key)) {
      byTime.set(key, {
        id: -1,
        run_id: e.run_id,
        bar_time: e.bar_time,
        signal: e.signal,
        reason: e.reason,
        entry: e.entry,
        exit: e.exit,
        in_session: e.in_session,
        position_size: e.position_size,
        acted: e.acted ?? false,
        order_audit_id: e.order_audit_id ?? null,
      });
    }
  }
  return Array.from(byTime.values()).sort(
    (a, b) => Date.parse(b.bar_time) - Date.parse(a.bar_time)
  );
}

/** Buy/sell markers for the candle chart. Acted orders render filled/solid via
 *  a bolder colour; unacted signals use a muted tone. */
export function signalsToMarkers(rows: SignalRow[]): ChartMarker[] {
  const markers: ChartMarker[] = [];
  for (const r of rows) {
    const time = barTimeToUnix(r.bar_time);
    if (!Number.isFinite(time)) continue;
    if (r.signal === 'buy') {
      markers.push({
        time,
        position: 'belowBar',
        shape: 'arrowUp',
        color: r.acted ? '#16a34a' : '#86efac',
        text: r.acted ? 'BUY' : 'buy',
      });
    } else if (r.signal === 'sell') {
      markers.push({
        time,
        position: 'aboveBar',
        shape: 'arrowDown',
        color: r.acted ? '#dc2626' : '#fca5a5',
        text: r.acted ? 'SELL' : 'sell',
      });
    }
  }
  return markers;
}

export interface RunDetailProps {
  runId: number;
}

export default function RunDetail({ runId }: RunDetailProps) {
  const [definition, setDefinition] = useState<DefinitionInfo | null>(null);
  const [restSignals, setRestSignals] = useState<SignalRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSignals = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/strategies/runs/${runId}/signals?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { signals: SignalRow[] };
      setRestSignals(body.signals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load signals');
    }
  }, [runId]);

  // Resolve the run's symbol/timeframe via its definition.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runRes = await apiFetch(`/api/strategies/runs/${runId}`);
        if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
        const run = await runRes.json();
        const defRes = await apiFetch(`/api/strategies/definitions/${run.definition_id}`);
        if (!defRes.ok) throw new Error(`HTTP ${defRes.status}`);
        const def = await defRes.json();
        if (!cancelled) setDefinition({ symbol: def.symbol, timeframe: def.timeframe });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load run');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    loadSignals();
  }, [loadSignals]);

  const live = useStrategySignals({ runId });
  // Refresh the REST list whenever a live signal lands so acted/order links
  // (which the socket also carries) stay authoritative.
  useEffect(() => {
    if (live.latest) loadSignals();
  }, [live.latest, loadSignals]);

  const merged = useMemo(
    () => mergeSignals(restSignals, live.signals),
    [restSignals, live.signals]
  );
  const markers = useMemo(() => signalsToMarkers(merged), [merged]);

  const history = useHistoricalData({
    symbol: definition?.symbol ?? '',
    timeframe: definition?.timeframe ?? '5min',
    period: periodFor(definition?.timeframe ?? '5min'),
    enabled: !!definition?.symbol,
  });

  const netPosition = merged.length > 0 ? Number(merged[0].position_size) : 0;
  const ordersPlaced = merged.filter((s) => s.acted).length;
  const latest = merged[0] ?? null;

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">
          Run #{runId}
          {definition && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              {definition.symbol} · {definition.timeframe}
            </span>
          )}
        </h2>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            live.connected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {live.connected ? 'live' : 'offline'}
        </span>
      </div>

      {error && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 p-3 rounded border border-amber-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <Summary label="Net position" value={String(netPosition)} />
        <Summary label="Signals" value={String(merged.length)} />
        <Summary label="Orders placed" value={String(ordersPlaced)} />
        <Summary
          label="Latest"
          value={latest ? latest.signal : '—'}
          hint={latest?.reason ?? undefined}
        />
      </div>

      <div className="mb-6">
        {definition && history.bars.length > 0 ? (
          <Chart data={history.bars} markers={markers} height={360} />
        ) : (
          <ChartSkeleton height={360} label="Loading chart…" />
        )}
      </div>

      <h3 className="text-base font-semibold mb-2">Signals ({merged.length})</h3>
      {merged.length === 0 ? (
        <p className="text-sm text-gray-500">
          No signals recorded yet. They appear here (and on the chart) as the runner evaluates each
          closed bar.
        </p>
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-gray-600 border-b sticky top-0 bg-white">
              <tr>
                <th className="py-2 pr-3 font-medium">Bar time</th>
                <th className="py-2 pr-3 font-medium">Signal</th>
                <th className="py-2 pr-3 font-medium">Session</th>
                <th className="py-2 pr-3 font-medium text-right">Pos</th>
                <th className="py-2 pr-3 font-medium">Acted</th>
                <th className="py-2 pr-3 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {merged.map((s) => (
                <tr key={`${s.bar_time}-${s.id}`} className="hover:bg-gray-50">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-700">
                    {new Date(s.bar_time).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={
                        s.signal === 'buy'
                          ? 'text-green-700 font-medium'
                          : s.signal === 'sell'
                            ? 'text-red-700 font-medium'
                            : 'text-gray-500'
                      }
                    >
                      {s.signal}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-gray-600">{s.in_session ? 'in' : 'out'}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-700">
                    {String(s.position_size)}
                  </td>
                  <td className="py-1.5 pr-3">
                    {s.acted ? (
                      <span className="text-blue-700" title={`order_audit #${s.order_audit_id}`}>
                        ✓ #{s.order_audit_id}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-gray-600">{s.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-gray-50 p-3 rounded" title={hint}>
      <span className="text-xs text-gray-500">{label}</span>
      <div className="text-base font-semibold text-gray-900 truncate">{value}</div>
    </div>
  );
}
