'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

/**
 * Fleet status (Component C — C-5).
 *
 * One poll for the whole picture: every connection with its health and
 * declared mode, and every active run grouped by the definition it came from.
 * Deliberately a single request rather than a fan-out — the operational
 * question is "is anything wrong?", and a screen that answers it from four
 * requests shows a half-true answer while three are still in flight.
 */

export interface FleetConnection {
  connection: string;
  platform: string;
  account: string;
  account_mode: 'live' | 'paper';
  currency?: string;
  is_default?: boolean;
  market_data?: boolean;
  broker?: boolean;
  server_timezone?: string | null;
  same_funds_as?: string | null;
  active_runs: number;
}

export interface FleetLeg {
  run_id: number;
  connection: string;
  native_symbol: string | null;
  account_mode: string;
  status: string;
  is_canary: boolean;
  current_stop: number | null;
  last_evaluated_at: string | null;
  last_error: string | null;
}

export interface FleetStrategy {
  definition_id: number;
  name: string;
  symbol: string | null;
  timeframe: string | null;
  group_ids: number[];
  legs: FleetLeg[];
}

export interface FleetStatus {
  connections: FleetConnection[];
  currency: { consistent?: boolean; currencies?: string[]; expected?: string | null } | null;
  strategies: FleetStrategy[];
  totals: {
    connections: number;
    active_runs: number;
    pending_runs: number;
    errored_runs: number;
  };
  broker_service_error: string | null;
  last_updated: string;
}

export interface UseFleetResult {
  fleet: FleetStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFleet(pollMs = 15_000): UseFleetResult {
  const [fleet, setFleet] = useState<FleetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow response landing after the component unmounted, and
  // against an earlier poll overwriting a later one.
  const latest = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const request = ++latest.current;
      try {
        const response = await apiFetch('/api/strategies/fleet');
        if (!response.ok) throw new Error(`fleet request failed (${response.status})`);
        const data = (await response.json()) as FleetStatus;
        if (cancelled || request !== latest.current) return;
        setFleet(data);
        setError(null);
      } catch (err) {
        if (cancelled || request !== latest.current) return;
        // Keep the last good snapshot on screen. A blank panel during a
        // transient blip reads as "nothing is running", which is the opposite
        // of the truth and exactly the wrong thing to show an operator.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && request === latest.current) setLoading(false);
      }
    };

    void load();
    if (pollMs <= 0)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs, nonce]);

  return { fleet, loading, error, refresh };
}

/** Connections a live order may be routed to, for a picker. */
export function tradableConnections(fleet: FleetStatus | null): FleetConnection[] {
  return (fleet?.connections ?? []).filter((c) => c.broker !== false);
}

/**
 * Whether a connection accepts orders in this mode.
 *
 * The registry enforces this server-side (a mismatch is a 409), but the picker
 * should not offer a choice that will be refused — and, more importantly, the
 * live/demo distinction has to be visible *at the point the mistake would be
 * made*, not discovered from an error afterwards.
 */
export function acceptsMode(connection: FleetConnection, mode: 'live' | 'paper'): boolean {
  return connection.account_mode === mode;
}
