import { createClient, RedisClientType } from 'redis';
import { logger } from './logger.js';

/**
 * Thin Redis cache wrapper.
 *
 * Design goals:
 *   - Lazy connect on first use so the backend boots even if Redis is
 *     unavailable.
 *   - Every public method is fail-safe: a Redis outage degrades into a
 *     cache miss, never a request failure. The caller's data path keeps
 *     working.
 *   - Single-flight `wrap()` helper so we can wrap any async loader
 *     (`fetcher`) with TTL caching in one line.
 *
 * Configured via env:
 *   REDIS_HOST     (default: redis)
 *   REDIS_PORT     (default: 6379)
 *   REDIS_PASSWORD (optional)
 *   REDIS_ENABLED  ("false" disables the cache entirely)
 */

const ENABLED = (process.env.REDIS_ENABLED ?? 'true').toLowerCase() !== 'false';

const HOST = process.env.REDIS_HOST || 'redis';
const PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const PASSWORD = process.env.REDIS_PASSWORD || undefined;

export class CacheService {
  private client: RedisClientType | null = null;
  private connecting: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor() {
    if (!ENABLED) {
      logger.info('redis cache disabled via REDIS_ENABLED=false');
    }
  }

  private async ensureConnected(): Promise<RedisClientType | null> {
    if (!ENABLED) return null;
    if (this.client?.isOpen) return this.client;
    if (this.connecting) {
      await this.connecting;
      return this.client?.isOpen ? this.client : null;
    }

    this.connecting = (async () => {
      try {
        const url = PASSWORD
          ? `redis://default:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}`
          : `redis://${HOST}:${PORT}`;
        const client = createClient({
          url,
          socket: {
            // Cap reconnect delay so we don't spin forever on a dead host.
            reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
            connectTimeout: 2000,
          },
        }) as RedisClientType;

        client.on('error', (err: Error) => {
          this.lastError = err.message;
        });

        await client.connect();
        this.client = client;
        this.lastError = null;
        logger.info({ host: HOST, port: PORT }, 'redis cache connected');
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.client = null;
      } finally {
        this.connecting = null;
      }
    })();

    await this.connecting;
    return this.client?.isOpen ? this.client : null;
  }

  /** Returns true if Redis is reachable. Never throws. */
  async ping(): Promise<boolean> {
    if (!ENABLED) return false;
    try {
      const client = await this.ensureConnected();
      if (!client) return false;
      const pong = await client.ping();
      return pong === 'PONG';
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const client = await this.ensureConnected();
      if (!client) return null;
      const raw = await client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const client = await this.ensureConnected();
      if (!client) return;
      await client.set(key, JSON.stringify(value), { EX: Math.max(1, ttlSeconds) });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      const client = await this.ensureConnected();
      if (!client) return;
      await client.del(key);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Read-through cache:
   *   const data = await cache.wrap('quote:MSFT', 2, () => fetchQuote('MSFT'));
   *
   * If the cache hits, `fetcher` is never called. On miss, `fetcher`
   * runs, and its (truthy) return value is stored under `key` with the
   * given TTL. If Redis is down the function is just a pass-through to
   * `fetcher`.
   */
  async wrap<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    const fresh = await fetcher();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  status() {
    return {
      enabled: ENABLED,
      connected: !!this.client?.isOpen,
      host: HOST,
      port: PORT,
      last_error: this.lastError,
    };
  }

  async close(): Promise<void> {
    if (this.client?.isOpen) {
      try {
        await this.client.quit();
      } catch {
        // ignore — we're shutting down
      }
    }
    this.client = null;
  }
}

export const cacheService = new CacheService();
export default cacheService;
