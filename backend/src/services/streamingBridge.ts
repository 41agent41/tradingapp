/**
 * Real-time streaming bridge (Phase 4).
 *
 * Sits between the IB service (which publishes ticks to Redis) and the
 * Socket.IO clients (which subscribe to per-symbol updates):
 *
 *      broker_service ──redis.publish──▶ marketdata:tick:<platform>:<account>:<SYMBOL>
 *                                            │
 *                                            ▼
 *                       StreamingBridge.handleMessage
 *                                            │
 *                                            ▼
 *      io.to('market-data:<platform>:<account>:<SYMBOL>').emit('market-data-update', ...)
 *
 * A stream belongs to one broker connection, so the same symbol can be
 * charted from two firms at once (docs/plans/E-05-live-recorder.md, D3). A
 * chart that names no connection gets the one the broker service chose.
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
import { configService } from '../config/configService.js';
import { readBool } from '../config/read.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
/** From `.env` or the Settings page; `index.ts` starts or stops the bridge
 *  when it changes. */
export function streamingEnabled(): boolean {
  return readBool(configService.asEnv(), 'STREAMING_ENABLED', true);
}

const TICK_PATTERN = 'marketdata:tick:*';
const STATUS_CHANNEL = 'marketdata:status';

const ROOM_PREFIX = 'market-data:';
const EVENT = 'market-data-update';
const STATUS_EVENT = 'market-data-status';

export interface TickPayload {
  symbol: string;
  /** The connection the tick came from. */
  platform?: string;
  account?: string;
  source?: string;
  type: 'tick';
  tick_type: string;
  tick_type_code: number;
  price: number | null;
  size: number | null;
  value: number;
  timestamp: number;
}

/**
 * One stream as charts asked for it: a symbol on a named connection, or on
 * "whichever the broker priority gives" (no source). Keyed by `requestKey`.
 */
interface SymbolState {
  symbol: string;
  refCount: number;
  /** Sockets that currently hold a reference to this stream. */
  sockets: Set<string>;
  /** The connection the broker service answered with. */
  platform: string;
  account: string;
  /** Settles when the broker service has answered the first subscribe. */
  ready: Promise<void>;
}

export interface StreamSubscription {
  symbol: string;
  platform: string;
  account: string;
  room: string;
  refCount: number;
}

function requestKey(symbol: string, source?: string, account?: string): string {
  return `${source ?? ''}|${account ?? ''}|${symbol}`;
}

export function streamRoom(platform: string, account: string, symbol: string): string {
  return `${ROOM_PREFIX}${platform}:${account}:${symbol}`;
}

/** What a chart asks to stream: the symbol and, optionally, its connection. */
export type StreamRequest = {
  symbol: string;
  secType?: string;
  exchange?: string;
  currency?: string;
  /** Broker platform; omitted, the broker service follows the priority. */
  source?: string;
  /** Account on that platform; omitted, its default. */
  account?: string;
};

/** A platform or account name as the broker service accepts it, else undefined. */
function connectionPart(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

/** Which connection the broker service started (or shared) the stream on. */
type StreamAnswer = { source?: string; account?: string } | void;

interface IBClientLike {
  subscribe(payload: StreamRequest): Promise<StreamAnswer>;
  unsubscribe(payload: { symbol: string; source?: string; account?: string }): Promise<void>;
}

/** HTTP implementation that calls into the IB service. */
class HttpIBClient implements IBClientLike {
  async subscribe(payload: StreamRequest): Promise<StreamAnswer> {
    const res = await axios.post(`${BROKER_SERVICE_URL}/market-data/stream/subscribe`, payload, {
      timeout: 5000,
    });
    return res?.data ?? undefined;
  }

  async unsubscribe(payload: { symbol: string; source?: string; account?: string }): Promise<void> {
    await axios.post(`${BROKER_SERVICE_URL}/market-data/stream/unsubscribe`, payload, {
      timeout: 5000,
    });
  }
}

export interface RedisLike {
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

  /** Per-stream state, keyed by `requestKey`. */
  private readonly bySymbol: Map<string, SymbolState> = new Map();
  /** Per-socket set of request keys, so disconnects can clean up cleanly. */
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
    if (!streamingEnabled()) {
      logger.info('streaming disabled (Settings or STREAMING_ENABLED=false)');
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
          'streaming bridge subscribed to redis'
        );
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { redis_host: REDIS_HOST, redis_port: REDIS_PORT, err: this.lastError },
          'streaming bridge could not connect to redis — streaming will be degraded'
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
  async subscribe(socketId: string, payload: StreamRequest): Promise<StreamSubscription> {
    const symbol = payload.symbol?.toUpperCase().trim();
    if (!symbol) throw new Error('symbol is required');
    const source = connectionPart(payload.source);
    const account = connectionPart(payload.account);
    const key = requestKey(symbol, source, account);

    const sockets = this.bySocket.get(socketId) ?? new Set<string>();
    this.bySocket.set(socketId, sockets);

    let state = this.bySymbol.get(key);
    if (!state) {
      const created: SymbolState = {
        symbol,
        refCount: 0,
        sockets: new Set<string>(),
        platform: source ?? '',
        account: account ?? '',
        ready: Promise.resolve(),
      };
      created.ready = this.ibClient
        .subscribe({
          symbol,
          secType: payload.secType,
          exchange: payload.exchange,
          currency: payload.currency,
          source,
          account,
        })
        .then((answer) => {
          created.platform = connectionPart(answer?.source) ?? source ?? 'ib';
          created.account = connectionPart(answer?.account) ?? account ?? 'default';
        });
      state = created;
      this.bySymbol.set(key, state);
    }

    // Skip duplicate subscribes from the same socket — idempotent.
    const added = !state.sockets.has(socketId);
    if (added) {
      state.sockets.add(socketId);
      state.refCount++;
      sockets.add(key);
    }

    try {
      await state.ready;
    } catch (err) {
      // The broker service refused: nobody holds this stream.
      if (added) {
        state.sockets.delete(socketId);
        state.refCount = Math.max(0, state.refCount - 1);
        sockets.delete(key);
      }
      if (this.bySymbol.get(key) === state) this.bySymbol.delete(key);
      throw err;
    }

    return {
      symbol,
      platform: state.platform,
      account: state.account,
      room: streamRoom(state.platform, state.account, symbol),
      refCount: state.refCount,
    };
  }

  /**
   * Drops the socket's reference. `room` is the room to leave, or null when
   * the socket holds another stream that resolved to the same connection
   * (one asked for by name, one by priority) and so still needs it.
   */
  async unsubscribe(
    socketId: string,
    payload: { symbol: string; source?: string; account?: string }
  ): Promise<{ symbol: string; refCount: number; room: string | null }> {
    const symbol = payload.symbol?.toUpperCase().trim();
    if (!symbol) throw new Error('symbol is required');
    return this.release(
      socketId,
      requestKey(symbol, connectionPart(payload.source), connectionPart(payload.account)),
      symbol
    );
  }

  private async release(
    socketId: string,
    key: string,
    symbol: string
  ): Promise<{ symbol: string; refCount: number; room: string | null }> {
    const state = this.bySymbol.get(key);
    if (!state || !state.sockets.has(socketId)) {
      return { symbol, refCount: state?.refCount ?? 0, room: null };
    }

    state.sockets.delete(socketId);
    state.refCount = Math.max(0, state.refCount - 1);
    const held = this.bySocket.get(socketId);
    held?.delete(key);

    const room = streamRoom(state.platform, state.account, symbol);
    const stillNeeded = Array.from(held ?? []).some((other) => {
      const o = this.bySymbol.get(other);
      return !!o && streamRoom(o.platform, o.account, o.symbol) === room;
    });

    if (state.refCount === 0) {
      this.bySymbol.delete(key);
      try {
        await this.ibClient.unsubscribe({
          symbol,
          source: state.platform,
          account: state.account,
        });
      } catch (err) {
        // Keep the room torn down even if the call fails — the broker
        // service has its own refcount.
        logger.warn({ symbol, err: String(err) }, 'broker_service unsubscribe failed');
      }
    }

    return { symbol, refCount: state.refCount, room: stillNeeded ? null : room };
  }

  /** Called from Socket.IO's `disconnect` event. Drops every sub the
   * socket held. Safe to call for unknown sockets. */
  async releaseSocket(socketId: string): Promise<void> {
    const keys = this.bySocket.get(socketId);
    if (!keys || keys.size === 0) {
      this.bySocket.delete(socketId);
      return;
    }
    for (const key of Array.from(keys)) {
      const symbol = this.bySymbol.get(key)?.symbol ?? '';
      try {
        await this.release(socketId, key, symbol);
      } catch (err) {
        logger.warn(
          { socket_id: socketId, symbol, err: String(err) },
          'releaseSocket unsubscribe failed'
        );
      }
    }
    this.bySocket.delete(socketId);
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

    // The payload names its own connection and symbol. The channel is not
    // parsed: a symbol may contain a colon (BHP:ASX).
    void channel;
    const symbol =
      payload && typeof payload.symbol === 'string' ? payload.symbol.toUpperCase() : null;
    if (!symbol) {
      this.ticksDropped++;
      return;
    }

    const room = streamRoom(
      payload.platform ?? payload.source ?? 'ib',
      payload.account ?? 'default',
      symbol
    );
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
        // A status names only the symbol: tell every stream of it.
        const symbol = payload.symbol.toUpperCase();
        const rooms = new Set<string>();
        for (const state of this.bySymbol.values()) {
          if (state.symbol === symbol && state.platform) {
            rooms.add(streamRoom(state.platform, state.account, symbol));
          }
        }
        for (const room of rooms) this.io.to(room).emit(STATUS_EVENT, payload);
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
    const subs: Array<{
      symbol: string;
      connection: string;
      refCount: number;
      sockets: number;
    }> = [];
    for (const state of this.bySymbol.values()) {
      subs.push({
        symbol: state.symbol,
        connection: `${state.platform}:${state.account}`,
        refCount: state.refCount,
        sockets: state.sockets.size,
      });
    }
    return {
      enabled: streamingEnabled(),
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

export function defaultRedisFactory(): RedisLike {
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
