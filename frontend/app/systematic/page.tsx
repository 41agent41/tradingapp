'use client';

import React, { useState } from 'react';
import BackToHome from '../components/BackToHome';
import StrategyBuilder from '../components/systematic/StrategyBuilder';
import DefinitionsPanel from '../components/systematic/DefinitionsPanel';
import RunsPanel from '../components/systematic/RunsPanel';
import FleetPanel from '../components/systematic/FleetPanel';
import RunDetail from '../components/systematic/RunDetail';

/**
 * Systematic trading monitor (A5 / Phase 4).
 *
 * One surface over the systematic engine: a rule builder that creates
 * definitions, the definitions list (start a run), the run dashboard (status +
 * per-run Stop), and a per-run detail view with a signal-marked chart and a
 * live signal feed. Execution stays gated server-side — this page is the
 * operator's window onto what the runner and A3 engine are doing.
 */
export default function SystematicPage() {
  // A nonce bumps to force the definitions/runs panels to reload after a
  // create/start, without threading refresh callbacks through every layer.
  const [defNonce, setDefNonce] = useState(0);
  const [runNonce, setRunNonce] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4 py-4 sm:py-6">
            <BackToHome />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Systematic</h1>
              <p className="text-xs sm:text-sm text-gray-600 mt-1">
                Build rule-driven strategies, run them live, and watch signals + paper orders
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded p-3">
          Runs evaluate only when the backend is started with{' '}
          <code className="px-1 bg-white rounded">SYSTEMATIC_ENABLED=true</code>, and auto-execution
          places orders only when{' '}
          <code className="px-1 bg-white rounded">SYSTEMATIC_EXECUTION_ENABLED=true</code> as well
          (paper unless <code className="px-1 bg-white rounded">LIVE_TRADING_ENABLED=true</code>).
          Both default off.
        </div>

        {/* Fleet first: the operational question — "is anything wrong?" —
            should be answerable before scrolling past the authoring tools. */}
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Fleet</h2>
          <FleetPanel />
        </section>

        <StrategyBuilder onCreated={() => setDefNonce((n) => n + 1)} />

        <DefinitionsPanel
          refreshNonce={defNonce}
          onRunStarted={(runId) => {
            setRunNonce((n) => n + 1);
            setSelectedRunId(runId);
          }}
        />

        <RunsPanel
          refreshNonce={runNonce}
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
        />

        {selectedRunId != null && <RunDetail runId={selectedRunId} />}
      </main>
    </div>
  );
}
