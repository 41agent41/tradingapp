'use client';

import React from 'react';
import { useFleet, type FleetConnection, type FleetLeg } from '../../lib/useFleet';

/**
 * Fleet view (Component C — C-5).
 *
 * Two questions, one screen: which connections are healthy, and what is each
 * strategy doing on each of them. One strategy across several accounts renders
 * as **one row with N legs** rather than N unrelated runs, because that is how
 * it is deployed and how it is reasoned about — a fleet listed as a flat run
 * table makes "is leg 3 of this group broken?" a manual join.
 */

function modeBadge(mode: string): string {
  // Live is deliberately the loud one. The live/demo distinction has to be
  // visible where a mistake would be made, not buried in configuration.
  return mode === 'live'
    ? 'bg-red-100 text-red-800 ring-1 ring-red-300'
    : 'bg-slate-100 text-slate-700';
}

function legBadge(leg: FleetLeg): string {
  if (leg.last_error) return 'bg-red-100 text-red-800';
  if (leg.status === 'pending') return 'bg-amber-100 text-amber-800';
  if (leg.status === 'running') return 'bg-green-100 text-green-800';
  return 'bg-gray-100 text-gray-700';
}

function legStatusLabel(leg: FleetLeg): string {
  // A pending leg is a canary-staged deploy waiting its turn, not a fault —
  // saying so stops it reading as a stuck run.
  if (leg.status === 'pending') return 'staged';
  return leg.status;
}

export interface FleetPanelProps {
  pollMs?: number;
}

export default function FleetPanel({ pollMs = 15_000 }: FleetPanelProps) {
  const { fleet, loading, error, refresh } = useFleet(pollMs);

  if (loading && !fleet) {
    return <div className="p-4 text-sm text-gray-500">Loading fleet…</div>;
  }

  return (
    <div className="space-y-6">
      {/* A stale snapshot with a warning beats a blank panel: "nothing is
          running" is the opposite of the truth during a transient blip. */}
      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Could not refresh fleet status ({error}). Showing the last known state.
        </div>
      )}

      {fleet?.broker_service_error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          Broker service unreachable: {fleet.broker_service_error}. Connection health is unknown;
          the strategies below come from the database.
        </div>
      )}

      {fleet?.currency && fleet.currency.consistent === false && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          Connections report different currencies ({(fleet.currency.currencies ?? []).join(', ')}).
          Portfolio-level caps refuse to aggregate across mixed denominations, so they are currently
          inactive.
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">
            Connections ({fleet?.totals.connections ?? 0})
          </h3>
          <button
            type="button"
            onClick={refresh}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(fleet?.connections ?? []).map((connection) => (
            <ConnectionCard key={connection.connection} connection={connection} />
          ))}
          {(fleet?.connections ?? []).length === 0 && (
            <div className="text-sm text-gray-500">No connections configured.</div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">
          Strategies ({fleet?.strategies.length ?? 0})
          {(fleet?.totals.pending_runs ?? 0) > 0 && (
            <span className="ml-2 text-xs font-normal text-amber-700">
              {fleet?.totals.pending_runs} leg(s) staged behind a canary
            </span>
          )}
        </h3>
        <div className="space-y-3">
          {(fleet?.strategies ?? []).map((strategy) => (
            <div key={strategy.definition_id} className="rounded border border-gray-200 p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-gray-900">{strategy.name}</span>
                <span className="text-xs text-gray-500">
                  {strategy.symbol} · {strategy.timeframe}
                </span>
                <span className="text-xs text-gray-400">
                  {strategy.legs.length} leg{strategy.legs.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="py-1 pr-3">Connection</th>
                      <th className="py-1 pr-3">Trades as</th>
                      <th className="py-1 pr-3">Mode</th>
                      <th className="py-1 pr-3">Status</th>
                      <th className="py-1 pr-3">Stop</th>
                      <th className="py-1">Last evaluated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategy.legs.map((leg) => (
                      <tr key={leg.run_id} className="border-t border-gray-100">
                        <td className="py-1 pr-3 font-mono text-xs">
                          {leg.connection}
                          {leg.is_canary && (
                            <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-800">
                              canary
                            </span>
                          )}
                        </td>
                        {/* The connection's own name for the instrument: the
                            same strategy trades EURUSD.a here and EURUSD_i
                            next door, and showing the canonical symbol would
                            hide that. */}
                        <td className="py-1 pr-3 font-mono text-xs">{leg.native_symbol ?? '—'}</td>
                        <td className="py-1 pr-3">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${modeBadge(leg.account_mode)}`}
                          >
                            {leg.account_mode}
                          </span>
                        </td>
                        <td className="py-1 pr-3">
                          <span className={`rounded px-2 py-0.5 text-xs ${legBadge(leg)}`}>
                            {legStatusLabel(leg)}
                          </span>
                          {leg.last_error && (
                            <div className="mt-0.5 text-xs text-red-700">{leg.last_error}</div>
                          )}
                        </td>
                        <td className="py-1 pr-3 font-mono text-xs">
                          {leg.current_stop == null ? '—' : leg.current_stop}
                        </td>
                        <td className="py-1 text-xs text-gray-500">
                          {leg.last_evaluated_at
                            ? new Date(leg.last_evaluated_at).toLocaleTimeString()
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {(fleet?.strategies ?? []).length === 0 && (
            <div className="text-sm text-gray-500">No strategies running.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ConnectionCard({ connection }: { connection: FleetConnection }) {
  const reachable = connection.broker !== false;
  return (
    <div
      className={`rounded border p-3 ${reachable ? 'border-gray-200' : 'border-red-300 bg-red-50'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium">{connection.connection}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${modeBadge(connection.account_mode)}`}>
          {connection.account_mode}
        </span>
      </div>
      <div className="mt-1 text-xs text-gray-600">
        {connection.active_runs} active run{connection.active_runs === 1 ? '' : 's'}
        {connection.currency ? ` · ${connection.currency}` : ''}
      </div>
      {!reachable && (
        <div className="mt-1 text-xs text-red-700">No broker adapter — orders will be refused.</div>
      )}
      {/* Two connections reaching the same money must be visible, or aggregate
          exposure looks half as large as it is. */}
      {connection.same_funds_as && (
        <div className="mt-1 text-xs text-amber-700">
          Shares funds with {connection.same_funds_as}
        </div>
      )}
    </div>
  );
}
