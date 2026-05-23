/**
 * React hook for the Phase 4 real-time streaming pipeline.
 *
 * Provides a small, opinionated wrapper around `socket.io-client` that
 * matches the backend's contract:
 *
 *   - Connect to `apiBaseUrl` with `socketAuth()` for the bearer token.
 *   - Emit `subscribe-market-data` with the symbol/contract details
 *     when the symbol changes.
 *   - Listen for `market-data-update` events (a stream of
 *     {@link TickPayload}) and surface the latest one via `latestTick`.
 *   - Also expose a small `connected` flag and the last subscription
 *     status payload for UI badges.
 *   - Clean up on unmount: emit `unsubscribe-market-data`, leave the
 *     room, and disconnect the socket.
 *
 * This hook deliberately does NOT keep a history of ticks — it only
 * exposes the most recent one. Charts can append it to their existing
 * candle bar or drive a "current price" badge. Storing every tick in
 * React state would re-render the chart on every tick (10+ Hz during
 * active markets) and tank performance.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { apiBaseUrl, socketAuth } from './api';

export interface TickPayload {
  symbol: string;
  type: 'tick';
  tick_type: string;
  tick_type_code: number;
  price: number | null;
  size: number | null;
  value: number;
  timestamp: number;
}

export interface StreamStatusPayload {
  event?: string;
  symbol?: string;
  req_id?: number;
  timestamp?: number;
}

export interface UseRealtimeStreamOptions {
  /** Trading symbol, uppercase. Pass `null` / empty to disable. */
  symbol: string | null;
  /** Contract qualifiers passed through to the IB service. */
  secType?: string;
  exchange?: string;
  currency?: string;
  /** If false, the hook does nothing — useful for tests / SSR. */
  enabled?: boolean;
}

export interface UseRealtimeStreamResult {
  /** True once the Socket.IO handshake completes. */
  connected: boolean;
  /** Last tick observed for `symbol`. Null until the first tick. */
  latestTick: TickPayload | null;
  /** Last status event seen (subscribe/unsubscribe confirmations). */
  lastStatus: StreamStatusPayload | null;
  /** Last error message (connect or subscribe failure). */
  error: string | null;
  /** Imperative escape hatch: drop the current subscription. */
  unsubscribe: () => void;
}

const MARKET_DATA_EVENT = 'market-data-update';
const STATUS_EVENT = 'market-data-status';

/**
 * Subscribe to the live tick stream for `symbol`.
 *
 * The Socket.IO connection is keyed off the (apiBaseUrl, token) tuple
 * so all calls within the same page share a single connection. The
 * subscription set is keyed off `symbol`; changing it triggers an
 * unsubscribe + re-subscribe under the hood.
 */
export function useRealtimeStream(opts: UseRealtimeStreamOptions): UseRealtimeStreamResult {
  const { symbol, secType, exchange, currency, enabled = true } = opts;

  const socketRef = useRef<Socket | null>(null);
  const subscribedSymbolRef = useRef<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [latestTick, setLatestTick] = useState<TickPayload | null>(null);
  const [lastStatus, setLastStatus] = useState<StreamStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalisedSymbol = useMemo(
    () => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : null),
    [symbol]
  );

  // Create / dispose the underlying Socket.IO connection. Symbol changes
  // do NOT recycle the socket — only `enabled` does — so swapping
  // symbols on the same page keeps the same WebSocket.
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

    socket.on(MARKET_DATA_EVENT, (payload: TickPayload) => {
      // Filter on our subscribed symbol — the bridge already targets
      // the right room, but defensive filtering protects against a
      // rogue server emit.
      if (subscribedSymbolRef.current && payload.symbol !== subscribedSymbolRef.current) {
        return;
      }
      setLatestTick(payload);
    });

    socket.on(STATUS_EVENT, (payload: StreamStatusPayload) => {
      setLastStatus(payload);
    });

    socket.on('subscription-error', (payload: { symbol?: string; error?: string }) => {
      if (payload?.error) setError(payload.error);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  // Manage the per-symbol subscription. Re-runs whenever the symbol
  // (or contract qualifiers) change.
  useEffect(() => {
    const socket = socketRef.current;
    if (!enabled || !socket || !normalisedSymbol) {
      // If we just lost a symbol, also drop the active subscription.
      const old = subscribedSymbolRef.current;
      if (socket && old) {
        socket.emit('unsubscribe-market-data', { symbol: old });
        subscribedSymbolRef.current = null;
        setLatestTick(null);
      }
      return;
    }

    // Wait for the socket to actually connect before emitting. If
    // `connected` is false we'll re-run when it flips true.
    if (!connected) return;

    // Already subscribed? Just refresh the latest tick state.
    if (subscribedSymbolRef.current === normalisedSymbol) return;

    const previous = subscribedSymbolRef.current;
    if (previous) {
      socket.emit('unsubscribe-market-data', { symbol: previous });
    }

    socket.emit('subscribe-market-data', {
      symbol: normalisedSymbol,
      secType,
      exchange,
      currency,
    });
    subscribedSymbolRef.current = normalisedSymbol;
    setLatestTick(null);

    return () => {
      // No-op here — cleanup happens on enabled-flag flip or on the
      // next subscription change, so we don't unsubscribe just because
      // React re-ran the effect.
    };
  }, [enabled, normalisedSymbol, secType, exchange, currency, connected]);

  // Imperative tear-down for callers that want to stop streaming
  // without unmounting the whole tree.
  const unsubscribe = () => {
    const socket = socketRef.current;
    const old = subscribedSymbolRef.current;
    if (socket && old) socket.emit('unsubscribe-market-data', { symbol: old });
    subscribedSymbolRef.current = null;
    setLatestTick(null);
  };

  return { connected, latestTick, lastStatus, error, unsubscribe };
}
