/**
 * Real-time streaming bridge (Phase 4).
 *
 * Sits between the IB service (which publishes ticks to Redis) and the
 * Socket.IO clients (which subscribe to per-symbol updates):
 *
 *      ib_service ──redis.publish──▶ marketdata:tick:<SYMBOL>
 *                                            │
 *                                            ▼
 *                       StreamingBridge.handleMessage
 *                                            │
 *                                            ▼
 *               io.to('market-data:<SYMBOL>').emit('market-data-update', ...)
 *
 * The bridge owns:
 *
 *   - A dedicated Redis pSubscribe client. node-redis requires a
 *     connection in subscribe-mode to be separate from a connection
 *     used for ordinary commands, so we never share with cacheService.
 *   - Per-symbol refcounts on the IB-service side. Many Socket.IO
 *     clients may share a symbol — the bridge only POSTs
 *     /market-data/stream/subscribe once and unsubscribes when the
 *     last client leaves.
 *   - Per-socket bookkeeping so disconnects free everything cleanly.
 *
 * A Redis outage degrades gracefully: subscribe still POSTs to the IB
 * service so historical data still flows, the bridge logs the error,
 * and reconnection is automatic via node-redis's built-in retry.
 */

import axios from 'axios';
import type { Server as SocketIOServer } from 'socket.io';
import { createClient } from 'redis';
import { logger } from './logger.js';

const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const STREAMING_ENABLED = (process.env.STREAMING_ENABLED ?? 'true').toLowerCase() !== 'false';

const TICK_PATTERN = 'marketdata:tick:*';
const STATUS_CHANNEL = 'marketdata:status';

const ROOM_PREFIX = 'market-data:';
const EVENT = 'market-data-update';
const STATUS_EVENT = 'market-data-status';

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

interface SymbolState {
  refCount: number;
  /** Sockets that currently hold a reference to this symbol. */
  sockets: Set<string>;
}

interface IBClientLike {
  subscribe(payload: {
    symbol: string;
    secType?: string;
    exchange?: string;
    currency?: string;
  }): Promise<void>;
  unsubscribe(payload: { symbol: string }): Promise<void>;
}

/** HTTP implementation that calls into the IB service. */
class HttpIBClient implements IBClientLike {
  async subscribe(payload: {
    symbol: string;
    secType?: string;
    exchange?: string;
    currency?: string;
  }): Promise<void> {
    await axios.post(`${IB_SERVICE_URL}/market-data/stream/subscribe`, payload, {
      timeout: 5000,
    });
  }

  async unsubscribe(payload: { symbol: string }): Promise<void> {
    await axios.post(`${IB_SERVICE_URL}/market-data/stream/unsubscribe`, payload, {
      timeout: 5000,
    });
  }
}

interface RedisLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  pSubscribe(
    pattern: string,
    listener: (message: string, channel: string) => void
  ): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void
  ): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  isOpen?: boolean;
}

export interface StreamingBridgeOptions {
  ibClient?: IBClientLike;
  redisFactory?: () => RedisLike;
}

export class StreamingBridge {
  private readonly io: SocketIOServer;
  private readonly ibClient: IBClientLike;
  private readonly redisFactory: () => RedisLike;

  private subscriber: RedisLike | null = null;
  private started = false;
  private connecting: Promise<void> | null = null;
  private lastError: string | null = null;

  /** Per-symbol state, keyed by uppercase symbol. */
  private readonly bySymbol: Map<string, SymbolState> = new Map();
  /** Per-socket symbol set, so disconnects can clean up cleanly. */
  private readonly bySocket: Map<string, Set<string>> = new Map();

  /** Diagnostics. */
  public ticksReceived = 0;
  public ticksForwarded = 0;
  public ticksDropped = 0;

  constructor(io: SocketIOServer, opts: StreamingBridgeOptions = {}) {
    this.io = io;
    this.ibClient = opts.ibClient ?? new HttpIBClient();
    this.redisFactory = opts.redisFactory ?? defaultRedisFactory;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  async start(): Promise<void> {
    if (!STREAMING_ENABLED) {
      logger.info('streaming disabled via STREAMING_ENABLED=false');
      return;
    }
    if (this.started) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = (async () => {
      try {
        const client = this.redisFactory();
        client.on('error', (...args: unknown[]) => {
          this.lastError = String(args[0]);
        });
        await client.connect();
        await client.pSubscribe(TICK_PATTERN, (message, channel) =>
          this.handleTickMessage(message, channel)
        );
        await client.subscribe(STATUS_CHANNEL, (message) => this.handleStatusMessage(message));
        this.subscriber = client;
        this.started = true;
        this.lastError = null;
        logger.info(
          { pattern: TICK_PATTERN, redis_host: REDIS_HOST, redis_port: REDIS_PORT },
          'streaming bridge subscribed to redis',
        );
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { redis_host: REDIS_HOST, redis_port: REDIS_PORT, err: this.lastError },
          'streaming bridge could not connect to redis — streaming will be degraded',
        );
      } finally {
        this.connecting = null;
      }
    })();
    await this.connecting;
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        // best effort on shutdown
      }
    }
    this.subscriber = null;
    this.started = false;
    this.bySymbol.clear();
    this.bySocket.clear();
  }

  // -------------------------------------------------------------------
  // Subscription API — driven by Socket.IO handlers in index.ts
  // -------------------------------------------------------------------
  async subscribe(
    socketId: string,
    payload: { symbol: string; secType?: string; exchange?: string; currency?: string }
  ): Promise<{ symbol: string; room: string; refCount: number }> {
    const symbol = payload.symbol?.toUpperCase().trim();
    if (!symbol) throw new Error('symbol is required');

    const sockets = this.bySocket.get(socketId) ?? new Set<string>();
    this.bySocket.set(socketId, sockets);

    let state = this.bySymbol.get(symbol);
    const first = !state;
    if (!state) {
      state = { refCount: 0, sockets: new Set<string>() };
      this.bySymbol.set(symbol, state);
    }

    // Skip duplicate subscribes from the same socket — idempotent.
    if (!state.sockets.has(socketId)) {
      state.sockets.add(socketId);
      state.refCount++;
      sockets.add(symbol);
    }

    if (first) {
      try {
        await this.ibClient.subscribe({
          symbol,
          secType: payload.secType,
          exchange: payload.exchange,
          currency: payload.currency,
        });
      } catch (err) {
        // Roll back the bookkeeping if the IB call fails.
        state.sockets.delete(socketId);
        state.refCount = Math.max(0, state.refCount - 1);
        sockets.delete(symbol);
        if (state.refCount === 0) this.bySymbol.delete(symbol);
        throw err;
      }
    }

    return {
      symbol,
      room: ROOM_PREFIX + symbol,
      refCount: state.refCount,
    };
  }

  async unsubscribe(
    socketId: string,
    payload: { symbol: string }
  ): Promise<{ symbol: string; refCount: number }> {
    const symbol = payload.symbol?.toUpperCase().trim();
    if (!symbol) throw new Error('symbol is required');

    const state = this.bySymbol.get(symbol);
    if (!state || !state.sockets.has(socketId)) {
      return { symbol, refCount: state?.refCount ?? 0 };
    }

    state.sockets.delete(socketId);
    state.refCount = Math.max(0, state.refCount - 1);
    this.bySocket.get(socketId)?.delete(symbol);

    if (state.refCount === 0) {
      this.bySymbol.delete(symbol);
      try {
        await this.ibClient.unsubscribe({ symbol });
      } catch (err) {
        // Keep the room torn down even if the IB call fails — the IB
        // service has its own refcount and will catch up on the next
        // healthcheck.
        logger.warn({ symbol, err: String(err) }, 'ib_service unsubscribe failed');
      }
    }

    return { symbol, refCount: state.refCount };
  }

  /** Called from Socket.IO's `disconnect` event. Drops every sub the
   * socket held. Safe to call for unknown sockets. */
  async releaseSocket(socketId: string): Promise<void> {
    const symbols = this.bySocket.get(socketId);
    if (!symbols || symbols.size === 0) {
      this.bySocket.delete(socketId);
      return;
    }
    this.bySocket.delete(socketId);
    for (const symbol of Array.from(symbols)) {
      try {
        await this.unsubscribe(socketId, { symbol });
      } catch (err) {
        logger.warn(
          { socket_id: socketId, symbol, err: String(err) },
          'releaseSocket unsubscribe failed',
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // Redis message handling
  // -------------------------------------------------------------------
  /**
   * Internal — exposed for tests. Parses a tick payload and forwards
   * it to the matching Socket.IO room.
   */
  handleTickMessage(message: string, channel: string): void {
    this.ticksReceived++;
    let payload: TickPayload;
    try {
      payload = JSON.parse(message) as TickPayload;
    } catch (err) {
      this.ticksDropped++;
      logger.warn({ err: String(err) }, 'invalid JSON tick payload');
      return;
    }

    const expectedChannel = channel.startsWith('marketdata:tick:') ? channel : null;
    const symbol =
      (payload && typeof payload.symbol === 'string' && payload.symbol.toUpperCase()) ||
      (expectedChannel ? expectedChannel.slice('marketdata:tick:'.length).toUpperCase() : null);

    if (!symbol) {
      this.ticksDropped++;
      return;
    }

    const room = ROOM_PREFIX + symbol;
    if (this.io.sockets.adapter.rooms.get(room) === undefined) {
      // Nobody listening — no point in emitting.
      this.ticksDropped++;
      return;
    }

    this.io.to(room).emit(EVENT, { ...payload, symbol });
    this.ticksForwarded++;
  }

  handleStatusMessage(message: string): void {
    try {
      const payload = JSON.parse(message) as { event?: string; symbol?: string };
      if (typeof payload?.symbol === 'string') {
        this.io.to(ROOM_PREFIX + payload.symbol.toUpperCase()).emit(STATUS_EVENT, payload);
      } else {
        this.io.emit(STATUS_EVENT, payload);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'invalid JSON status payload');
    }
  }

  // -------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------
  status() {
    const subs: Array<{ symbol: string; refCount: number; sockets: number }> = [];
    for (const [symbol, state] of this.bySymbol.entries()) {
      subs.push({ symbol, refCount: state.refCount, sockets: state.sockets.size });
    }
    return {
      enabled: STREAMING_ENABLED,
      connected: !!this.subscriber?.isOpen,
      last_error: this.lastError,
      subscriptions: subs.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      totals: {
        ticks_received: this.ticksReceived,
        ticks_forwarded: this.ticksForwarded,
        ticks_dropped: this.ticksDropped,
      },
    };
  }
}

function defaultRedisFactory(): RedisLike {
  const url = REDIS_PASSWORD
    ? `redis://default:${encodeURIComponent(REDIS_PASSWORD)}@${REDIS_HOST}:${REDIS_PORT}`
    : `redis://${REDIS_HOST}:${REDIS_PORT}`;
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
      connectTimeout: 2000,
    },
  });
  return client as unknown as RedisLike;
}

// Re-export the bridge factory used by index.ts.
export function createStreamingBridge(
  io: SocketIOServer,
  opts: StreamingBridgeOptions = {}
): StreamingBridge {
  return new StreamingBridge(io, opts);
}
