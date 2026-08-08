/**
 * Executions poller — keeps `order_executions` in step with the venues.
 *
 * This is the ingest half of the fills feed. On a timer it asks the broker
 * service for each active venue's recent executions and upserts them, so the
 * app's view of what it holds and what it has made comes from **fills** rather
 * than from the submitted-order estimate in `order_audit` — which silently
 * disagrees with the account on a partial fill, on a rejection that lands after
 * the acknowledgement, and on any trade placed outside the app.
 *
 *   order_audit / strategy_runs ─▶ poller ─▶ broker_service /account/executions
 *   (which venues are in use)                        │
 *                                                    ▼
 *                                    order_executions (upsert on exec_id)
 *                                                    │
 *                                                    ▼
 *                          fill-authoritative positions + realised P&L
 *                                    (→ risk.max_daily_loss)
 *
 * Design mirrors `backfillScheduler.ts` — it is the same kind of component:
 *
 *  - **In the backend, not the broker service.** Only the backend has the
 *    database; the broker service can neither read which venues are in use nor
 *    write `order_executions`.
 *  - **Opt-in** (`EXECUTIONS_SYNC_ENABLED`), because it makes live venue
 *    requests on a timer.
 *  - **Overlapping window, idempotent write.** Every tick re-fetches the last
 *    `EXECUTIONS_SYNC_LOOKBACK_DAYS` rather than tracking a high-water mark.
 *    A fill can be reported late and IB delivers a fill's commission on a
 *    separate callback from the fill itself, so re-reading is how those
 *    converge; `(broker, exec_id)` makes re-delivery a no-op.
 *  - **Per-venue isolation.** One unreachable venue must not stop the others
 *    from syncing — an error is counted and the loop continues.
 *  - **No overlap** between ticks, and fully-injected dependencies so the
 *    orchestration is unit-testable with no DB, venue or network.
 */

import axios from 'axios';
import { logger } from './logger.js';
import { dbService } from './database.js';
import { ExecutionRepository, type ExecutionInput } from './executionRepository.js';
import { DEFAULT_BROKER_ACCOUNT, connectionLabel, type Connection } from './orderTypes.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

const EXECUTIONS_SYNC_ENABLED =
  (process.env.EXECUTIONS_SYNC_ENABLED ?? 'false').toLowerCase() === 'true';
const EXECUTIONS_SYNC_INTERVAL_SECONDS = Math.max(
  15,
  parseInt(process.env.EXECUTIONS_SYNC_INTERVAL_SECONDS || '120', 10) || 120
);
const EXECUTIONS_SYNC_LOOKBACK_DAYS = Math.min(
  30,
  Math.max(1, parseInt(process.env.EXECUTIONS_SYNC_LOOKBACK_DAYS || '2', 10) || 2)
);
const EXECUTIONS_SYNC_INITIAL_DELAY_MS = Math.max(
  0,
  parseInt(process.env.EXECUTIONS_SYNC_INITIAL_DELAY_MS || '20000', 10) || 20000
);
/** Account mode stamped on a fill with no order of ours behind it. Paper by
 *  default, matching `LIVE_TRADING_ENABLED` defaulting to false. */
const EXECUTIONS_DEFAULT_ACCOUNT_MODE = (
  process.env.EXECUTIONS_DEFAULT_ACCOUNT_MODE || 'paper'
).toLowerCase();

/** One fill as the broker service reports it (`models.Execution`). */
export interface RemoteExecution {
  exec_id: string;
  order_id?: string | null;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  commission?: number | null;
  realized_pnl?: number | null;
  executed_at: string;
  account?: string | null;
  currency?: string;
  broker?: string;
}

export interface ExecutionsPollerDeps {
  /** Which connections to poll. */
  listConnections(): Promise<Connection[]>;
  /** Fetch a connection's recent fills from the broker service. */
  fetchExecutions(connection: Connection, days: number): Promise<RemoteExecution[]>;
  upsert(input: ExecutionInput): Promise<{ inserted: boolean }>;
  /** Attach late-arriving audit/run links to fills that had none. */
  relinkOrphans(): Promise<number>;
  now(): number;
}

export interface ExecutionsPollerOptions {
  deps?: Partial<ExecutionsPollerDeps>;
  enabled?: boolean;
  intervalSeconds?: number;
  lookbackDays?: number;
  initialDelayMs?: number;
}

function defaultDeps(): ExecutionsPollerDeps {
  const repo = new ExecutionRepository(dbService);
  return {
    listConnections: async () => {
      const connections = await repo.activeConnections();
      // A fresh install has traded nowhere yet; IB's default account is the
      // default venue, so poll it rather than doing nothing until the first
      // order exists.
      return connections.length > 0
        ? connections
        : [{ broker: 'ib', brokerAccount: DEFAULT_BROKER_ACCOUNT }];
    },
    fetchExecutions: async (connection, days) => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/account/executions`, {
        params: { broker: connection.broker, account: connection.brokerAccount, days },
        timeout: 45_000,
        headers: { Connection: 'close' },
      });
      return Array.isArray(response.data) ? (response.data as RemoteExecution[]) : [];
    },
    upsert: (input) => repo.upsert(input),
    relinkOrphans: () => repo.relinkOrphans(),
    now: () => Date.now(),
  };
}

export class ExecutionsPoller {
  private readonly deps: ExecutionsPollerDeps;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly lookbackDays: number;
  private readonly initialDelayMs: number;

  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  // Diagnostics.
  public runs = 0;
  public fetched = 0;
  public inserted = 0;
  public relinked = 0;
  public errors = 0;

  constructor(opts: ExecutionsPollerOptions = {}) {
    this.deps = { ...defaultDeps(), ...opts.deps } as ExecutionsPollerDeps;
    this.enabled = opts.enabled ?? EXECUTIONS_SYNC_ENABLED;
    this.intervalMs = (opts.intervalSeconds ?? EXECUTIONS_SYNC_INTERVAL_SECONDS) * 1000;
    this.lookbackDays = opts.lookbackDays ?? EXECUTIONS_SYNC_LOOKBACK_DAYS;
    this.initialDelayMs = opts.initialDelayMs ?? EXECUTIONS_SYNC_INITIAL_DELAY_MS;
  }

  start(): void {
    if (!this.enabled) {
      logger.info(
        'executions sync disabled via EXECUTIONS_SYNC_ENABLED ' +
          '(set EXECUTIONS_SYNC_ENABLED=true to derive positions and realised P&L from fills)'
      );
      return;
    }
    if (this.started) return;
    this.started = true;
    logger.info(
      {
        interval_seconds: this.intervalMs / 1000,
        lookback_days: this.lookbackDays,
        first_run_seconds: Math.round(this.initialDelayMs / 1000),
      },
      'executions poller enabled'
    );

    this.initialTimer = setTimeout(() => {
      void this.runOnce();
      this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
      this.timer?.unref?.();
    }, this.initialDelayMs);
    this.initialTimer?.unref?.();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
    this.started = false;
  }

  /** One sync pass over every active venue. Never throws — a venue-level
   *  failure is counted and isolated so the others still sync. */
  async runOnce(): Promise<void> {
    if (this.running) {
      logger.warn('previous executions sync still in progress — skipping this tick');
      return;
    }
    this.running = true;
    this.runs++;
    try {
      const connections = await this.deps.listConnections();
      for (const connection of connections) {
        await this.syncConnection(connection);
      }
      // Runs after ingest so a fill polled in the same tick as its order was
      // acknowledged still gets attributed.
      try {
        this.relinked += await this.deps.relinkOrphans();
      } catch (relinkErr) {
        this.errors++;
        this.lastError = relinkErr instanceof Error ? relinkErr.message : String(relinkErr);
        logger.error({ err: this.lastError }, 'execution re-link pass failed');
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, 'executions sync failed');
    } finally {
      this.lastRunAt = this.deps.now();
      this.running = false;
    }
  }

  private async syncConnection(connection: Connection): Promise<void> {
    const { broker, brokerAccount } = connection;
    const label = connectionLabel(broker, brokerAccount);
    try {
      const rows = await this.deps.fetchExecutions(connection, this.lookbackDays);
      this.fetched += rows.length;
      let newRows = 0;
      for (const row of rows) {
        if (!row?.exec_id || !row?.symbol) continue;
        try {
          const { inserted } = await this.deps.upsert({
            broker: row.broker || broker,
            // Always the connection we polled, never a value from the payload:
            // the venue reports its own fill ids without knowing which of our
            // accounts it is, and mis-attributing one would recreate the
            // collision the connection-scoped key exists to prevent.
            broker_account: brokerAccount,
            account_mode: EXECUTIONS_DEFAULT_ACCOUNT_MODE,
            exec_id: String(row.exec_id),
            broker_order_id: row.order_id != null ? String(row.order_id) : null,
            symbol: row.symbol,
            side: row.side,
            quantity: Number(row.quantity),
            price: Number(row.price),
            commission: row.commission ?? null,
            realized_pnl: row.realized_pnl ?? null,
            currency: row.currency ?? 'USD',
            executed_at: row.executed_at,
            raw: row as unknown as Record<string, unknown>,
          });
          if (inserted) newRows++;
        } catch (rowErr) {
          // One malformed fill must not abandon the rest of the batch.
          this.errors++;
          this.lastError = rowErr instanceof Error ? rowErr.message : String(rowErr);
          logger.error(
            { connection: label, exec_id: row.exec_id, err: this.lastError },
            'execution upsert failed'
          );
        }
      }
      this.inserted += newRows;
      if (newRows > 0) {
        logger.info(
          { connection: label, new_fills: newRows, seen: rows.length },
          'executions synced'
        );
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ connection: label, err: this.lastError }, 'executions sync failed');
    }
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      interval_seconds: this.intervalMs / 1000,
      lookback_days: this.lookbackDays,
      last_run: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      last_error: this.lastError,
      totals: {
        runs: this.runs,
        fetched: this.fetched,
        inserted: this.inserted,
        relinked: this.relinked,
        errors: this.errors,
      },
    };
  }
}

export function createExecutionsPoller(opts: ExecutionsPollerOptions = {}): ExecutionsPoller {
  return new ExecutionsPoller(opts);
}
