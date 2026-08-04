'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

/** Run dashboard (A5 / Phase 4): active + past runs, per-run Stop, and row
 *  selection that drives the detail view. Polls so status/last-eval stay fresh
 *  even without a socket event. */

export interface RunRow {
  id: number;
  definition_id: number;
  broker: string;
  account_mode: string;
  status: string;
  last_evaluated_at: string | null;
  last_error: string | null;
  started_at: string;
  stopped_at: string | null;
}

export interface RunsPanelProps {
  refreshNonce?: number;
  selectedRunId: number | null;
  onSelect: (runId: number) => void;
  pollMs?: number;
}

function statusBadge(status: string): string {
  if (status === 'running') return 'bg-green-100 text-green-800';
  if (status === 'error') return 'bg-red-100 text-red-800';
  return 'bg-gray-100 text-gray-700';
}

export default function RunsPanel({
  refreshNonce,
  selectedRunId,
  onSelect,
  pollMs = 10_000,
}: RunsPanelProps) {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/strategies/runs?limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { runs: RunRow[] };
      setRows(body.runs ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runs');
    }
  }, []);

  useEffect(() => {
    load();
    if (pollMs <= 0) return;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs, refreshNonce]);

  const stop = useCallback(
    async (runId: number) => {
      setBusyId(runId);
      try {
        const res = await apiFetch(`/api/strategies/runs/${runId}/stop`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to stop run');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Runs</h2>
        <button type="button" onClick={load} className="text-xs text-blue-600 hover:text-blue-800">
          Refresh
        </button>
      </div>
      {error && (
        <div className="mb-3 text-sm text-amber-700 bg-amber-50 p-3 rounded border border-amber-200">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          No runs yet. Start one from a definition to begin evaluating live.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-gray-600 border-b">
              <tr>
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Def</th>
                <th className="py-2 pr-3 font-medium">Mode</th>
                <th className="py-2 pr-3 font-medium">Last eval</th>
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const isSelected = selectedRunId === r.id;
                return (
                  <tr
                    key={r.id}
                    className={`cursor-pointer hover:bg-blue-50 ${isSelected ? 'bg-blue-50' : ''}`}
                    onClick={() => onSelect(r.id)}
                  >
                    <td className="py-2 pr-3 text-gray-500">{r.id}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${statusBadge(r.status)}`}
                        title={r.last_error ?? undefined}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-700">{r.definition_id}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          r.account_mode === 'live'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-blue-50 text-blue-700'
                        }`}
                      >
                        {r.account_mode}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-700 whitespace-nowrap">
                      {r.last_evaluated_at
                        ? new Date(r.last_evaluated_at).toLocaleTimeString()
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 text-gray-700 whitespace-nowrap">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      {r.status === 'running' ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            stop(r.id);
                          }}
                          disabled={busyId === r.id}
                          className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400"
                        >
                          {busyId === r.id ? 'Stopping…' : 'Stop'}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
