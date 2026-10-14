'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

const POLL_INTERVAL_MS = 10_000;

type ServiceState = 'ok' | 'warn' | 'down' | 'disabled' | 'unknown';

interface ServiceRow {
  key: string;
  label: string;
  state: ServiceState;
  detail?: string;
}

interface BrokerConnection {
  label: string;
  platform: string;
  account: string;
  is_default?: boolean;
  status?: 'connected' | 'unreachable' | 'unchecked';
  error?: string | null;
}

interface BrokersBlock {
  default?: string | null;
  connections?: BrokerConnection[];
}

interface HealthPayload {
  status?: string;
  services?: {
    database?: { connected?: boolean };
    broker_service?: { connected?: boolean; status?: string; error?: string };
    brokers?: BrokersBlock;
    cache?: { connected?: boolean; enabled?: boolean; last_error?: string | null };
    streaming?: { connected?: boolean; enabled?: boolean; last_error?: string | null };
    backfill?: { running?: boolean; enabled?: boolean; last_error?: string | null };
  };
}

function rowsFromPayload(p: HealthPayload | null, fetchError: string | null): ServiceRow[] {
  if (fetchError) {
    return [{ key: 'backend', label: 'Backend', state: 'down', detail: fetchError }];
  }
  if (!p) {
    return [{ key: 'backend', label: 'Backend', state: 'unknown' }];
  }

  const svc = p.services ?? {};

  const brokerServiceState: ServiceState = svc.broker_service?.connected
    ? 'ok'
    : svc.broker_service?.status === 'error'
      ? 'down'
      : 'warn';

  const dbState: ServiceState = svc.database?.connected ? 'ok' : 'down';

  const cacheState: ServiceState =
    svc.cache?.enabled === false ? 'disabled' : svc.cache?.connected ? 'ok' : 'warn';

  const streamState: ServiceState =
    svc.streaming?.enabled === false ? 'disabled' : svc.streaming?.connected ? 'ok' : 'warn';

  const backfillState: ServiceState =
    svc.backfill?.enabled === false ? 'disabled' : svc.backfill?.last_error ? 'warn' : 'ok';

  return [
    {
      key: 'broker_service',
      label: 'Broker service',
      state: brokerServiceState,
      detail: svc.broker_service?.error ?? svc.broker_service?.status,
    },
    ...brokerRows(svc.broker_service?.connected ? svc.brokers : undefined),
    { key: 'db', label: 'Database', state: dbState },
    { key: 'cache', label: 'Cache', state: cacheState, detail: svc.cache?.last_error ?? undefined },
    {
      key: 'stream',
      label: 'Streaming',
      state: streamState,
      detail: svc.streaming?.last_error ?? undefined,
    },
    {
      key: 'backfill',
      label: 'Backfill',
      state: backfillState,
      detail: svc.backfill?.last_error ?? undefined,
    },
  ];
}

const PLATFORM_NAME: Record<string, string> = {
  oanda: 'OANDA',
  mt5: 'MT5',
  ib: 'IB',
  alpaca: 'Alpaca',
};

/**
 * One row per broker connection, in the priority order the backend sends.
 * The default broker being unreachable is down (orders can't be placed);
 * any other connection being unreachable is a warning. Nothing is shown when
 * the broker service itself is not answering: its own row already says so.
 */
function brokerRows(brokers: BrokersBlock | undefined): ServiceRow[] {
  if (!brokers) return [];
  const connections = brokers.connections ?? [];
  if (connections.length === 0) {
    return [{ key: 'broker:none', label: 'No broker connected', state: 'warn' }];
  }
  const multi = new Set<string>();
  const seen = new Set<string>();
  for (const c of connections) {
    if (seen.has(c.platform)) multi.add(c.platform);
    seen.add(c.platform);
  }
  return connections.map((c) => {
    const name = PLATFORM_NAME[c.platform] ?? c.platform;
    const label = `${name}${multi.has(c.platform) ? ` (${c.account})` : ''}${
      c.is_default ? ' · default' : ''
    }`;
    const state: ServiceState =
      c.status === 'connected'
        ? 'ok'
        : c.status === 'unreachable'
          ? c.is_default
            ? 'down'
            : 'warn'
          : 'unknown';
    return { key: `broker:${c.label}`, label, state, detail: c.error ?? undefined };
  });
}

const STATE_DOT: Record<ServiceState, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  down: 'bg-red-500',
  disabled: 'bg-gray-300',
  unknown: 'bg-gray-300 animate-pulse',
};

const STATE_LABEL: Record<ServiceState, string> = {
  ok: 'OK',
  warn: 'Degraded',
  down: 'Down',
  disabled: 'Disabled',
  unknown: 'Checking…',
};

function summarise(rows: ServiceRow[]): { state: ServiceState; label: string } {
  if (rows.some((r) => r.state === 'down')) return { state: 'down', label: 'Services degraded' };
  if (rows.some((r) => r.state === 'warn')) return { state: 'warn', label: 'Partial outage' };
  if (rows.every((r) => r.state === 'disabled')) return { state: 'disabled', label: 'Idle' };
  if (rows.some((r) => r.state === 'unknown')) return { state: 'unknown', label: 'Checking…' };
  return { state: 'ok', label: 'All systems healthy' };
}

export interface HealthBadgeProps {
  /** Override the poll interval (ms). Defaults to 10 000. */
  intervalMs?: number;
}

export default function HealthBadge({ intervalMs = POLL_INTERVAL_MS }: HealthBadgeProps) {
  const [payload, setPayload] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/health');
        const body = (await res.json()) as HealthPayload;
        if (cancelled) return;
        setPayload(body);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'unreachable';
        setError(message);
      }
    };

    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const rows = rowsFromPayload(payload, error);
  const summary = summarise(rows);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`System health: ${summary.label}`}
        aria-expanded={open}
        className="flex items-center space-x-2 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs sm:text-sm text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_DOT[summary.state]}`}
          aria-hidden="true"
        />
        <span className="hidden sm:inline">{summary.label}</span>
        <span className="sm:hidden">{STATE_LABEL[summary.state]}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Service health detail"
          className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-gray-200 bg-white p-3 shadow-lg"
        >
          <h4 className="mb-2 text-sm font-medium text-gray-900">Services</h4>
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li key={row.key} className="flex items-start justify-between text-xs">
                <div className="flex items-center space-x-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${STATE_DOT[row.state]}`}
                    aria-hidden="true"
                  />
                  <span className="text-gray-700">{row.label}</span>
                </div>
                <span
                  className="ml-2 max-w-[10rem] truncate text-right text-gray-500"
                  title={row.detail ?? STATE_LABEL[row.state]}
                >
                  {STATE_LABEL[row.state]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const __test = { rowsFromPayload, summarise, brokerRows };
