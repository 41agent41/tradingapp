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
 * A broker whose stream says only that something traded (IG) publishes on
 * `executions:changed:<broker>:<account>` instead, and that connection is
 * polled straight away, so its fills are read the one way they always are.
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
/** A broker that streams only "something traded" (IG) publishes here. */
export const CHANGED_PATTERN = 'executions:changed:*';
const CHANNEL_PREFIX = 'executions:fill:';
const CHANGED_PREFIX = 'executions:changed:';
/** IG lists a deal in its history a moment after confirming it. */
const REFRESH_DELAY_MS = 1500;

/** The connection a fill channel names; null for a channel that names none. */
export function connectionOfChannel(
  channel: string,
  prefix: string = CHANNEL_PREFIX
): Connection | null {
  if (!channel.startsWith(prefix)) return null;
  const rest = channel.slice(prefix.length);
  const cut = rest.indexOf(':');
  if (cut <= 0 || cut === rest.length - 1) return null;
  // An account may itself contain a colon; the broker never does.
  return { broker: rest.slice(0, cut), brokerAccount: rest.slice(cut + 1) };
}

export interface FillStreamDeps {
  /** Store the fills; returns how many were new. Must not throw. */
  ingest(connection: Connection, rows: RemoteExecution[]): Promise<number>;
  /** Poll one connection's fills now. Must not throw. */
  refresh?(connection: Connection): Promise<void>;
  /** How long after a trade event the poll runs; events in between share it. */
  refreshDelayMs?: number;
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

  /** One pending poll per connection that reported a trade. */
  private readonly pending = new Map<string, NodeJS.Timeout>();

  public received = 0;
  public stored = 0;
  public ignored = 0;
  public refreshes = 0;

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
        await client.pSubscribe(CHANGED_PATTERN, (_message, channel) =>
          this.handleChanged(channel)
        );
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
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
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

  /**
   * A broker said something traded on a connection: poll its fills shortly.
   * Several events close together (a confirmation and the position update
   * that follows it) become one poll.
   */
  handleChanged(channel: string): void {
    this.received++;
    const connection = connectionOfChannel(channel, CHANGED_PREFIX);
    const refresh = this.deps.refresh;
    if (!connection || !refresh) {
      this.ignored++;
      return;
    }
    const key = `${connection.broker}:${connection.brokerAccount}`;
    if (this.pending.has(key)) return;
    this.lastFillAt = (this.deps.now ?? Date.now)();
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.refreshes++;
      this.queue = this.queue.then(async () => {
        try {
          await refresh(connection);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      });
    }, this.deps.refreshDelayMs ?? REFRESH_DELAY_MS);
    timer.unref?.();
    this.pending.set(key, timer);
  }

  status() {
    return {
      listening: this.subscriber !== null,
      received: this.received,
      stored: this.stored,
      ignored: this.ignored,
      refreshes: this.refreshes,
      last_fill: this.lastFillAt ? new Date(this.lastFillAt).toISOString() : null,
      last_error: this.lastError,
    };
  }
}
