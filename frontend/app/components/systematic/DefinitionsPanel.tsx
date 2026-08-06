'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

/** Definitions list with a per-row "Start run" action (A5 / Phase 4). */

interface DefinitionRow {
  id: number;
  name: string;
  broker: string;
  symbol: string;
  timeframe: string;
  version: number;
  created_at: string;
}

export interface DefinitionsPanelProps {
  /** Bump to force a reload (e.g. after the builder creates one). */
  refreshNonce?: number;
  /** Called after a run is started so the runs panel can refresh + select it. */
  onRunStarted?: (runId: number) => void;
}

export default function DefinitionsPanel({ refreshNonce, onRunStarted }: DefinitionsPanelProps) {
  const [rows, setRows] = useState<DefinitionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/strategies/definitions?limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { definitions: DefinitionRow[] };
      setRows(body.definitions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load definitions');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshNonce]);

  const startRun = useCallback(
    async (definitionId: number) => {
      setBusyId(definitionId);
      try {
        const res = await apiFetch('/api/strategies/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition_id: definitionId, account_mode: 'paper' }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        onRunStarted?.(body.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start run');
      } finally {
        setBusyId(null);
      }
    },
    [onRunStarted]
  );

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Definitions</h2>
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
          No definitions yet. Create one with the rule builder above.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-gray-600 border-b">
              <tr>
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Symbol</th>
                <th className="py-2 pr-3 font-medium">TF</th>
                <th className="py-2 pr-3 font-medium">Broker</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50">
                  <td className="py-2 pr-3 text-gray-500">{d.id}</td>
                  <td className="py-2 pr-3 font-medium">{d.name}</td>
                  <td className="py-2 pr-3">{d.symbol}</td>
                  <td className="py-2 pr-3 text-gray-700">{d.timeframe}</td>
                  <td className="py-2 pr-3 text-gray-700">{d.broker}</td>
                  <td className="py-2 pr-3 text-gray-700 whitespace-nowrap">
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <a
                      href={`/backtest?definition=${d.id}`}
                      className="text-xs px-2 py-1 mr-2 border border-blue-600 text-blue-600 rounded hover:bg-blue-50"
                    >
                      Backtest
                    </a>
                    <button
                      type="button"
                      onClick={() => startRun(d.id)}
                      disabled={busyId === d.id}
                      className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
                    >
                      {busyId === d.id ? 'Starting…' : 'Start run'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
