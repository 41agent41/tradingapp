/**
 * Fills as they happen (E-10).
 *
 * The executions poller asks each broker for its recent fills on a timer, so
 * a fill can be minutes old before `order_executions` has it. A broker that
 * streams its fills (OANDA's transaction stream) is also listened to by the
 * broker service, which publishes each fill on the Redis channel
 * `executions:fill:<broker>:<account>` in the shape the poll returns. This
 * listens there and hands each fill to the poller's own store step, so a
 * streamed fill is written exactly as a polled one is.
 *
 * The stream adds speed only. A Redis message can be missed and a stream can
 * drop, so the poll stays on and remains the record; `(broker, account,
 * exec_id)` makes a fill that arrives both ways one row.
 *
 * It listens while executions sync is on, and the broker service streams only
 * then (`FILL_STREAM_ENABLED` in brokerSync.ts).
 */
import { logger } from './logger.js';
import type { RemoteExecution } from './executionsPoller.js';
import type { Connection } from './orderTypes.js';
import { defaultRedisFactory, type RedisLike } from './streamingBridge.js';

export const FILL_PATTERN = 'executions:fill:*';
const CHANNEL_PREFIX = 'executions:fill:';

/** The connection a fill channel names; null for a channel that names none. */
export function connectionOfChannel(channel: string): Connection | null {
  if (!channel.startsWith(CHANNEL_PREFIX)) return null;
  const rest = channel.slice(CHANNEL_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut <= 0 || cut === rest.length - 1) return null;
  // An account may itself contain a colon; the broker never does.
  return { broker: rest.slice(0, cut), brokerAccount: rest.slice(cut + 1) };
}

export interface FillStreamDeps {
  /** Store the fills; returns how many were new. Must not throw. */
  ingest(connection: Connection, rows: RemoteExecution[]): Promise<number>;
  redisFactory?: () => RedisLike;
  now?: () => number;
}

export class FillStream {
  private subscriber: RedisLike | null = null;
  private connecting: Promise<void> | null = null;
  private wanted = false;
  private lastError: string | null = null;
  private lastFillAt: number | null = null;
  /** Fills are stored one at a time, in the order they arrived. */
  private queue: Promise<unknown> = Promise.resolve();

  public received = 0;
  public stored = 0;
  public ignored = 0;

  constructor(private readonly deps: FillStreamDeps) {}

  /** Start listening. Safe to call again; a failed connect is retried by the
   *  next call. */
  async start(): Promise<void> {
    this.wanted = true;
    if (this.subscriber) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = (this.deps.redisFactory ?? defaultRedisFactory)();
      try {
        client.on('error', (...args: unknown[]) => {
          this.lastError = String(args[0]);
        });
        await client.connect();
        await client.pSubscribe(FILL_PATTERN, (message, channel) => this.handle(message, channel));
        if (!this.wanted) {
          await client.quit();
          return;
        }
        this.subscriber = client;
        this.lastError = null;
        logger.info({ pattern: FILL_PATTERN }, 'listening for streamed fills');
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: this.lastError },
          'could not listen for streamed fills; fills still arrive by polling'
        );
        try {
          await client.quit();
        } catch {
          // never connected
        }
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async stop(): Promise<void> {
    this.wanted = false;
    const client = this.subscriber;
    this.subscriber = null;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      // best effort
    }
  }

  /** One message from Redis. Returns once the fill is stored (for tests). */
  handle(message: string, channel: string): Promise<unknown> {
    this.received++;
    const connection = connectionOfChannel(channel);
    let row: RemoteExecution | null = null;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed;
    } catch {
      row = null;
    }
    if (!connection || !row?.exec_id || !row?.symbol) {
      this.ignored++;
      return this.queue;
    }
    const fill = row;
    this.lastFillAt = (this.deps.now ?? Date.now)();
    this.queue = this.queue.then(async () => {
      try {
        const added = await this.deps.ingest(connection, [fill]);
        this.stored += added;
        if (added > 0) {
          logger.info(
            {
              connection: `${connection.broker}:${connection.brokerAccount}`,
              exec_id: fill.exec_id,
              symbol: fill.symbol,
            },
            'streamed fill stored'
          );
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    });
    return this.queue;
  }

  status() {
    return {
      listening: this.subscriber !== null,
      received: this.received,
      stored: this.stored,
      ignored: this.ignored,
      last_fill: this.lastFillAt ? new Date(this.lastFillAt).toISOString() : null,
      last_error: this.lastError,
    };
  }
}
