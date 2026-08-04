/**
 * React hook for the systematic strategy signal stream (A5 / Phase 4).
 *
 * Mirrors `useRealtimeStream` but for the strategy rooms the backend fans out
 * on: it connects to `apiBaseUrl`, emits `subscribe-strategy` with a `runId`,
 * and collects `strategy-signal` events (each an evaluation the runner made,
 * carrying signal/reason, entry/exit, position size and — from A3 — whether it
 * acted and the resulting order_audit id).
 *
 * Unlike the tick stream, signals are low-frequency (one per closed bar) and
 * individually meaningful, so the hook keeps a bounded rolling list rather than
 * only the latest one.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { apiBaseUrl, socketAuth } from './api';

export interface StrategySignalEvent {
  run_id: number;
  symbol: string;
  timeframe: string;
  bar_time: string;
  signal: string; // 'buy' | 'sell' | 'none'
  reason: string | null;
  entry: boolean;
  exit: boolean;
  in_session: boolean;
  position_size: number;
  acted?: boolean;
  order_audit_id?: number | null;
  execution_reason?: string | null;
}

export interface UseStrategySignalsOptions {
  /** Run id to watch. Pass `null` to disable. */
  runId: number | null;
  /** If false, the hook does nothing (tests / SSR). */
  enabled?: boolean;
  /** Cap the rolling in-memory list. Defaults to 200. */
  max?: number;
}

export interface UseStrategySignalsResult {
  connected: boolean;
  /** Most recent signal first. */
  signals: StrategySignalEvent[];
  latest: StrategySignalEvent | null;
  error: string | null;
}

const SIGNAL_EVENT = 'strategy-signal';

export function useStrategySignals(opts: UseStrategySignalsOptions): UseStrategySignalsResult {
  const { runId, enabled = true, max = 200 } = opts;

  const socketRef = useRef<Socket | null>(null);
  const subscribedRunRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [signals, setSignals] = useState<StrategySignalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create / dispose the socket. Only `enabled` recycles it.
  useEffect(() => {
    if (!enabled) return;

    const socket: Socket = io(apiBaseUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      ...socketAuth(),
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err: Error) => setError(err.message));

    socket.on(SIGNAL_EVENT, (payload: StrategySignalEvent) => {
      // Defensive room filtering — the server already targets the right room.
      if (subscribedRunRef.current != null && payload.run_id !== subscribedRunRef.current) {
        return;
      }
      setSignals((prev) => [payload, ...prev].slice(0, max));
    });

    socket.on('strategy-subscription-error', (payload: { error?: string }) => {
      if (payload?.error) setError(payload.error);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, max]);

  // Manage the per-run subscription.
  useEffect(() => {
    const socket = socketRef.current;
    if (!enabled || !socket || runId == null) {
      const old = subscribedRunRef.current;
      if (socket && old != null) {
        socket.emit('unsubscribe-strategy', { runId: old });
        subscribedRunRef.current = null;
      }
      return;
    }
    if (!connected) return;
    if (subscribedRunRef.current === runId) return;

    const previous = subscribedRunRef.current;
    if (previous != null) socket.emit('unsubscribe-strategy', { runId: previous });

    socket.emit('subscribe-strategy', { runId });
    subscribedRunRef.current = runId;
    setSignals([]);
  }, [enabled, runId, connected]);

  return { connected, signals, latest: signals[0] ?? null, error };
}
