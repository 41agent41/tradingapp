'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

/**
 * Every configured broker connection, in broker priority order, with its last
 * connectivity check and a Test button. The broker service checks each
 * connection on a timer; Test checks one now (a read-only call at the venue).
 */

export type ConnectionCheck = {
  status: 'connected' | 'unreachable';
  error: string | null;
  latency_ms: number | null;
  checked_at: string | null;
};

export type BrokerConnection = {
  label: string;
  platform: string;
  account: string;
  account_mode: string | null;
  is_default: boolean;
  check: ConnectionCheck | null;
};

type StatusPayload = {
  default: string | null;
  priority: string[];
  connections: BrokerConnection[];
};

const PLATFORM_NAME: Record<string, string> = {
  oanda: 'OANDA',
  mt5: 'MT5',
  ib: 'Interactive Brokers',
  alpaca: 'Alpaca',
};

export function platformName(platform: string): string {
  return PLATFORM_NAME[platform] ?? platform;
}

export function checkSummary(check: ConnectionCheck | null): {
  tone: 'ok' | 'bad' | 'none';
  text: string;
} {
  if (!check) return { tone: 'none', text: 'Not checked yet' };
  if (check.status === 'connected') {
    return {
      tone: 'ok',
      text: `Connected${check.latency_ms != null ? ` (${check.latency_ms} ms)` : ''}`,
    };
  }
  return { tone: 'bad', text: `Unreachable${check.error ? `: ${check.error}` : ''}` };
}

const TONE_STYLES = {
  ok: 'bg-emerald-100 text-emerald-800',
  bad: 'bg-red-100 text-red-800',
  none: 'bg-gray-100 text-gray-600',
};

export default function BrokerConnections() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/brokers/status');
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async (label: string) => {
    setTesting(label);
    try {
      const r = await apiFetch(`/api/brokers/${encodeURIComponent(label)}/test`, {
        method: 'POST',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setData((d) =>
        d
          ? {
              ...d,
              connections: d.connections.map((c) =>
                c.label === label ? { ...c, check: body.check } : c
              ),
            }
          : d
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
    }
  };

  if (!data && error) {
    return <p className="text-sm text-red-700">Broker status could not be loaded: {error}</p>;
  }
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Brokers in priority order. Orders go to the default broker unless a strategy names another;
        each connection is checked in the background.
      </p>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {data.connections.length === 0 ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">
          No broker connected. Add broker credentials to .env and redeploy.
        </p>
      ) : (
        <ul className="divide-y">
          {data.connections.map((c) => {
            const s = checkSummary(c.check);
            return (
              <li
                key={c.label}
                className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{platformName(c.platform)}</span>
                    {c.account !== 'default' && (
                      <span className="text-sm text-gray-600">{c.account}</span>
                    )}
                    {c.is_default && (
                      <span className="px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-800">
                        default
                      </span>
                    )}
                    {c.account_mode && (
                      <span className="px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-700">
                        {c.account_mode}
                      </span>
                    )}
                  </div>
                  <span
                    className={`inline-block mt-1 px-1.5 py-0.5 text-xs rounded break-all ${TONE_STYLES[s.tone]}`}
                    title={c.check?.checked_at ?? undefined}
                  >
                    {s.text}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void test(c.label)}
                  disabled={testing !== null}
                  aria-label={`Test ${platformName(c.platform)} ${c.account}`}
                  className="self-start sm:self-auto px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {testing === c.label ? 'Testing…' : 'Test'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
