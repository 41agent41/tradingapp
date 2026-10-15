/**
 * Keeps the broker service's app-added connections in step with the database.
 *
 * The broker service holds them in memory only (it has no database access),
 * so the backend sends the full set, secrets decrypted, to
 * `PUT /connections/managed`: straight after every change on the Connections
 * tab, and whenever the `managed.revision` the broker service reports on
 * `/health` is not the one last sent (it restarted, or a send was lost).
 *
 * The same push carries the settings the broker service enforces itself (the
 * live-trading gate, the default broker, the base currency, the IB status
 * wait and the broker-check and price-poll intervals), so a change on the
 * Settings page reaches it too. Until the first push it knows only `.env`, so
 * live orders fail closed.
 *
 * The revision is an HMAC of the set under a key made fresh per process, so
 * it changes whenever the set does without exposing anything about the
 * secrets in it. A backend restart therefore sends the set once more, which
 * is harmless.
 */
import axios from 'axios';
import { createHmac, randomBytes } from 'crypto';

import { configService } from '../config/configService.js';
import type { BrokerConnectionStore } from './brokerConnections.js';
import { logger } from './logger.js';
import { isLiveTradingEnabled } from './orderTypes.js';

const CHECK_SECONDS = 15;
const REVISION_KEY = randomBytes(32);

export interface ManagedPayload {
  revision: string;
  priority: string[] | null;
  connections: Record<string, unknown>[];
  settings: Record<string, string>;
}

/** Settings the broker service enforces; sent with the connections. */
export const BROKER_SETTING_KEYS = [
  'LIVE_TRADING_ENABLED',
  'DEFAULT_BROKER',
  'PORTFOLIO_BASE_CURRENCY',
  'ORDER_PLACE_WAIT_SECONDS',
  'BROKER_PROBE_INTERVAL_SECONDS',
  'STREAM_POLL_SECONDS',
  // Live trading is only in effect with the trader role and MFA set up.
  'TRADING_TOKENS',
  'ORDER_MFA_SECRET',
] as const;

export function brokerSettings(): Record<string, string> {
  const out: Record<string, string> = {
    // The backend's own decision, safeguards included, so the two never differ.
    LIVE_TRADING_ENABLED: isLiveTradingEnabled() ? 'true' : 'false',
  };
  for (const key of [
    'DEFAULT_BROKER',
    'PORTFOLIO_BASE_CURRENCY',
    'ORDER_PLACE_WAIT_SECONDS',
    'BROKER_PROBE_INTERVAL_SECONDS',
    'STREAM_POLL_SECONDS',
  ]) {
    const value = configService.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function brokerPriorityFromConfig(): string[] | null {
  const raw = configService.get('BROKER_PRIORITY');
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

export async function buildPayload(store: BrokerConnectionStore): Promise<ManagedPayload> {
  const connections = await store.managedEntries();
  const priority = brokerPriorityFromConfig();
  const settings = brokerSettings();
  const revision = createHmac('sha256', REVISION_KEY)
    .update(JSON.stringify({ priority, connections, settings }))
    .digest('hex')
    .slice(0, 32);
  return { revision, priority, connections, settings };
}

type Http = {
  get(url: string, config?: any): Promise<{ data: any }>;
  put(url: string, body: unknown, config?: any): Promise<{ data: any }>;
};

export class BrokerSync {
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: BrokerConnectionStore,
    private readonly brokerServiceUrl: string,
    private readonly http: Http = axios
  ) {}

  /**
   * Send the set when the broker service's revision differs, or always with
   * `force`. Returns what the broker service answered, or null when nothing
   * was sent. Throws on a send the broker service refused (its 422 message
   * names the bad entry), so a save can report it.
   */
  async sync(force = false): Promise<any | null> {
    const payload = await buildPayload(this.store);
    if (!force) {
      const health = await this.http.get(`${this.brokerServiceUrl}/health`, { timeout: 5000 });
      if (health.data?.providers?.managed?.revision === payload.revision) return null;
    }
    const res = await this.http.put(`${this.brokerServiceUrl}/connections/managed`, payload, {
      timeout: 10000,
    });
    logger.info(
      { revision: payload.revision, connections: res.data?.connections },
      'broker connections sent to the broker service'
    );
    return res.data;
  }

  /** The background check. Never throws. */
  async check(): Promise<void> {
    try {
      await this.sync(false);
      this.lastError = null;
    } catch (err: any) {
      const message = String(err?.response?.data?.detail ?? err?.message ?? err);
      if (message !== this.lastError) {
        logger.warn({ err: message }, 'broker connection sync failed; will retry');
      }
      this.lastError = message;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_SECONDS * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
