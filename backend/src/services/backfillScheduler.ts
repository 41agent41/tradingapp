/**
 * Backfill scheduler (Phase 5 — data lifecycle).
 *
 * Periodically tops up the local Postgres/TimescaleDB store with recent bars
 * for every (contract, timeframe) row in `data_collection_config` that is
 * both `enabled` and `auto_collect`. Without it, the only way to get data
 * into the database is to click the Download page by hand.
 *
 *   data_collection_config ─▶ scheduler ─▶ ib_service /market-data/history
 *                                              │
 *                                              ▼
 *                          marketDataService.storeCandlestickData (upsert)
 *                                              │
 *                                              ▼
 *                          marketDataService.recordDataQuality
 *
 * Design notes:
 *
 *  - Lives in the **backend**, not `ib_service`, because the IB service has
 *    no database access — it cannot read `data_collection_config` nor write
 *    `candlestick_data`. The backend owns Postgres and already proxies the
 *    IB service, so orchestration belongs here.
 *  - **Opt-in.** Disabled unless `BACKFILL_ENABLED=true`, because it makes
 *    live IB requests on a timer.
 *  - **Period-based, upsert-driven.** Each run fetches the most recent
 *    `BACKFILL_PERIOD` window and upserts it. Existing bars update, new bars
 *    insert, and holes inside the window self-heal — without the date-range
 *    edge cases of the IB history endpoint. Deep historical gaps are still a
 *    Download-page job.
 *  - **Per-row cadence.** A config row is skipped when its newest stored bar
 *    is younger than its `collection_interval_minutes`, so a fast global
 *    tick does not hammer IB for slow-moving daily data.
 *  - **No overlap.** A long run cannot overlap the next tick.
 *  - Dependencies are injected so the orchestration is unit-testable with no
 *    network, DB or IB Gateway (mirrors `streamingBridge.ts`).
 */

import axios from 'axios';
import {
  marketDataService,
  type CandlestickBar,
  type CollectionConfig,
} from './marketDataService.js';

const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

const BACKFILL_ENABLED = (process.env.BACKFILL_ENABLED ?? 'false').toLowerCase() === 'true';
const BACKFILL_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.BACKFILL_INTERVAL_MINUTES || '15', 10) || 15
);
const BACKFILL_PERIOD = process.env.BACKFILL_PERIOD || '5D';
// Small delay before the first run so it doesn't fire mid-startup.
const BACKFILL_INITIAL_DELAY_MS = Math.max(
  0,
  parseInt(process.env.BACKFILL_INITIAL_DELAY_MS || '30000', 10) || 30000
);

/** A raw bar as returned by the IB service (`timestamp` is unix seconds). */
export interface RawBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wap?: number;
  count?: number;
}

export interface HistoryRequest {
  symbol: string;
  timeframe: string;
  period: string;
  secType: string;
  exchange: string;
  currency: string;
}

export interface StoreResult {
  inserted: number;
  updated: number;
  errors: number;
}

/**
 * Everything the scheduler needs from the outside world. Defaults wire to
 * `marketDataService` and the IB service over HTTP; tests inject fakes.
 */
export interface BackfillDeps {
  listConfigs(): Promise<CollectionConfig[]>;
  getLatestStoredTimestamp(contractId: number, timeframe: string): Promise<Date | null>;
  fetchHistory(req: HistoryRequest): Promise<RawBar[]>;
  storeCandlestickData(
    contractId: number,
    timeframe: string,
    bars: CandlestickBar[]
  ): Promise<StoreResult>;
  recordDataQuality(contractId: number, timeframe: string, bars: CandlestickBar[]): Promise<void>;
  startSession(contractId: number, timeframe: string): Promise<number | null>;
  endSession(
    sessionId: number,
    status: string,
    recordsCollected: number,
    errorMessage?: string
  ): Promise<void>;
  now(): number;
}

export interface BackfillSchedulerOptions {
  deps?: Partial<BackfillDeps>;
  enabled?: boolean;
  intervalMinutes?: number;
  period?: string;
  initialDelayMs?: number;
}

function defaultDeps(): BackfillDeps {
  return {
    listConfigs: () => marketDataService.getActiveCollectionConfigs({ autoCollectOnly: true }),
    getLatestStoredTimestamp: (contractId, timeframe) =>
      marketDataService.getLatestStoredTimestamp(contractId, timeframe),
    fetchHistory: async (req) => {
      const response = await axios.get(`${IB_SERVICE_URL}/market-data/history`, {
        params: {
          symbol: req.symbol,
          timeframe: req.timeframe,
          period: req.period,
          secType: req.secType,
          exchange: req.exchange,
          currency: req.currency,
        },
        timeout: 60000,
        headers: { Connection: 'close' },
      });
      const bars = Array.isArray(response.data?.bars) ? response.data.bars : [];
      return bars.map((b: any) => ({
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        wap: b.wap,
        count: b.count,
      }));
    },
    storeCandlestickData: (contractId, timeframe, bars) =>
      marketDataService.storeCandlestickData(contractId, timeframe, bars),
    recordDataQuality: (contractId, timeframe, bars) =>
      marketDataService.recordDataQuality(contractId, timeframe, bars),
    startSession: (contractId, timeframe) =>
      marketDataService.startDataCollectionSession(contractId, timeframe),
    endSession: (sessionId, status, recordsCollected, errorMessage) =>
      marketDataService.endDataCollectionSession(sessionId, status, recordsCollected, errorMessage),
    now: () => Date.now(),
  };
}

export class BackfillScheduler {
  private readonly deps: BackfillDeps;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly period: string;
  private readonly initialDelayMs: number;

  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  // Diagnostics.
  public runs = 0;
  public configsProcessed = 0;
  public configsSkipped = 0;
  public barsStored = 0;
  public errors = 0;

  constructor(opts: BackfillSchedulerOptions = {}) {
    this.deps = { ...defaultDeps(), ...opts.deps } as BackfillDeps;
    this.enabled = opts.enabled ?? BACKFILL_ENABLED;
    this.intervalMs = (opts.intervalMinutes ?? BACKFILL_INTERVAL_MINUTES) * 60_000;
    this.period = opts.period ?? BACKFILL_PERIOD;
    this.initialDelayMs = opts.initialDelayMs ?? BACKFILL_INITIAL_DELAY_MS;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  start(): void {
    if (!this.enabled) {
      console.log('[backfill] disabled via BACKFILL_ENABLED (set BACKFILL_ENABLED=true to enable)');
      return;
    }
    if (this.started) return;
    this.started = true;
    console.log(
      `[backfill] enabled — every ${this.intervalMs / 60_000}m, period=${this.period}, ` +
        `first run in ${Math.round(this.initialDelayMs / 1000)}s`
    );

    this.initialTimer = setTimeout(() => {
      void this.runOnce();
      this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
      // Don't keep the event loop alive solely for the backfill timer.
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

  // -------------------------------------------------------------------
  // Work
  // -------------------------------------------------------------------
  /**
   * Run a single backfill pass over every auto-collect config row. Safe to
   * call directly (e.g. from tests or an admin endpoint). Never throws —
   * per-row failures are isolated and counted.
   */
  async runOnce(): Promise<void> {
    if (this.running) {
      console.warn('[backfill] previous run still in progress — skipping this tick');
      return;
    }
    this.running = true;
    this.runs++;
    try {
      const configs = await this.deps.listConfigs();
      if (configs.length === 0) {
        console.log('[backfill] no enabled auto_collect rows in data_collection_config');
        return;
      }
      for (const cfg of configs) {
        await this.backfillOne(cfg);
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[backfill] run failed:', this.lastError);
    } finally {
      this.lastRunAt = this.deps.now();
      this.running = false;
    }
  }

  private async backfillOne(cfg: CollectionConfig): Promise<void> {
    // Respect per-row cadence: skip if data is fresher than the configured
    // collection interval.
    try {
      const latest = await this.deps.getLatestStoredTimestamp(cfg.contractId, cfg.timeframe);
      if (latest) {
        const ageMs = this.deps.now() - latest.getTime();
        if (ageMs < cfg.collectionIntervalMinutes * 60_000) {
          this.configsSkipped++;
          return;
        }
      }
    } catch (err) {
      // A freshness-check failure shouldn't block the fetch; log and proceed.
      console.warn(
        `[backfill] freshness check failed for ${cfg.symbol} ${cfg.timeframe}:`,
        err instanceof Error ? err.message : err
      );
    }

    let sessionId: number | null = null;
    try {
      sessionId = await this.deps.startSession(cfg.contractId, cfg.timeframe).catch(() => null);

      const rawBars = await this.deps.fetchHistory({
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
        period: this.period,
        secType: cfg.secType,
        exchange: cfg.exchange || 'SMART',
        currency: cfg.currency || 'USD',
      });

      const bars: CandlestickBar[] = rawBars.map((b) => ({
        timestamp: new Date(b.timestamp * 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        wap: b.wap,
        count: b.count,
      }));

      const result = await this.deps.storeCandlestickData(cfg.contractId, cfg.timeframe, bars);
      const stored = result.inserted + result.updated;
      this.barsStored += stored;
      this.configsProcessed++;

      try {
        await this.deps.recordDataQuality(cfg.contractId, cfg.timeframe, bars);
      } catch (qualityError) {
        console.warn(
          `[backfill] quality metrics failed for ${cfg.symbol} ${cfg.timeframe}:`,
          qualityError instanceof Error ? qualityError.message : qualityError
        );
      }

      if (sessionId != null) {
        await this.deps.endSession(sessionId, 'completed', stored);
      }
      console.log(
        `[backfill] ${cfg.symbol} ${cfg.timeframe}: ${result.inserted} inserted, ` +
          `${result.updated} updated, ${result.errors} errors`
      );
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] ${cfg.symbol} ${cfg.timeframe} failed:`, this.lastError);
      if (sessionId != null) {
        await this.deps.endSession(sessionId, 'failed', 0, this.lastError).catch(() => undefined);
      }
    }
  }

  // -------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------
  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      interval_minutes: this.intervalMs / 60_000,
      period: this.period,
      last_run: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      last_error: this.lastError,
      totals: {
        runs: this.runs,
        configs_processed: this.configsProcessed,
        configs_skipped: this.configsSkipped,
        bars_stored: this.barsStored,
        errors: this.errors,
      },
    };
  }
}

export function createBackfillScheduler(opts: BackfillSchedulerOptions = {}): BackfillScheduler {
  return new BackfillScheduler(opts);
}
