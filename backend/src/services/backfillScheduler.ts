/**
 * Backfill scheduler (Phase 5 — data lifecycle).
 *
 * Periodically tops up the local Postgres/TimescaleDB store with recent bars
 * for every (contract, timeframe) row in `data_collection_config` that is
 * both `enabled` and `auto_collect`. Without it, the only way to get data
 * into the database is to click the Download page by hand.
 *
 *   data_collection_config ─▶ scheduler ─▶ broker_service /market-data/history
 *                                              │
 *                                              ▼
 *                          marketDataService.storeCandlestickData (upsert)
 *                                              │
 *                                              ▼
 *                          marketDataService.recordDataQuality
 *
 * Design notes:
 *
 *  - Lives in the **backend**, not `broker_service`, because the IB service has
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
import { logger } from './logger.js';
import { configService } from '../config/configService.js';
import { type EnvLike, definedOnly, readBool, readInt } from '../config/read.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

/** The scheduler's settings, from `.env` or the Settings page. */
export function backfillSettings(
  env: EnvLike = configService.asEnv()
): Required<Omit<BackfillSchedulerOptions, 'deps'>> {
  return {
    enabled: readBool(env, 'BACKFILL_ENABLED', false),
    intervalMinutes: readInt(env, 'BACKFILL_INTERVAL_MINUTES', 15, 1),
    period: env.BACKFILL_PERIOD || '5D',
    // Small delay before the first run so it doesn't fire mid-startup.
    initialDelayMs: readInt(env, 'BACKFILL_INITIAL_DELAY_MS', 30000, 0),
  };
}

/** Changing any of these restarts the scheduler with the new values. */
export const BACKFILL_SETTING_KEYS = [
  'BACKFILL_ENABLED',
  'BACKFILL_INTERVAL_MINUTES',
  'BACKFILL_PERIOD',
  'BACKFILL_INITIAL_DELAY_MS',
] as const;

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
  /** The broker the contract belongs to, so its bars come from that broker. */
  broker: string;
  /** The account on that broker; 'default' lets the broker service choose. */
  brokerAccount: string;
  symbol: string;
  timeframe: string;
  period: string;
  secType: string;
  exchange?: string;
  currency?: string;
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
      const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/history`, {
        params: {
          // Named explicitly: with no source the broker service answers from
          // whichever broker responds first, and those bars would be stored
          // under this contract's broker.
          source: req.broker,
          account: req.brokerAccount === 'default' ? undefined : req.brokerAccount,
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
  private enabled: boolean;
  private intervalMs: number;
  private period: string;
  private initialDelayMs: number;

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
    const settings = { ...backfillSettings(), ...definedOnly(opts) };
    this.enabled = settings.enabled;
    this.intervalMs = settings.intervalMinutes * 60_000;
    this.period = settings.period;
    this.initialDelayMs = settings.initialDelayMs;
  }

  /** Stops the scheduler and takes new settings. Call `start()` to resume. */
  reconfigure(opts: Omit<BackfillSchedulerOptions, 'deps'>): void {
    this.stop();
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
    if (opts.intervalMinutes !== undefined) this.intervalMs = opts.intervalMinutes * 60_000;
    if (opts.period !== undefined) this.period = opts.period;
    if (opts.initialDelayMs !== undefined) this.initialDelayMs = opts.initialDelayMs;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  start(): void {
    if (!this.enabled) {
      logger.info('backfill disabled (turn it on in Settings or with BACKFILL_ENABLED=true)');
      return;
    }
    if (this.started) return;
    this.started = true;
    logger.info(
      {
        interval_minutes: this.intervalMs / 60_000,
        period: this.period,
        first_run_seconds: Math.round(this.initialDelayMs / 1000),
      },
      'backfill scheduler enabled'
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
      logger.warn('previous backfill run still in progress — skipping this tick');
      return;
    }
    this.running = true;
    this.runs++;
    try {
      const configs = await this.deps.listConfigs();
      if (configs.length === 0) {
        logger.info('no enabled auto_collect rows in data_collection_config');
        return;
      }
      for (const cfg of configs) {
        await this.backfillOne(cfg);
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, 'backfill run failed');
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
      logger.warn(
        {
          symbol: cfg.symbol,
          timeframe: cfg.timeframe,
          err: err instanceof Error ? err.message : String(err),
        },
        'backfill freshness check failed'
      );
    }

    let sessionId: number | null = null;
    try {
      sessionId = await this.deps.startSession(cfg.contractId, cfg.timeframe).catch(() => null);

      // Exchange and currency as stored: the broker service applies its
      // own defaults, which differ by broker.
      const rawBars = await this.deps.fetchHistory({
        broker: cfg.broker,
        brokerAccount: cfg.brokerAccount,
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
        period: this.period,
        secType: cfg.secType,
        exchange: cfg.exchange || undefined,
        currency: cfg.currency || undefined,
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
        logger.warn(
          {
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            err: qualityError instanceof Error ? qualityError.message : String(qualityError),
          },
          'backfill quality metrics failed'
        );
      }

      if (sessionId != null) {
        await this.deps.endSession(sessionId, 'completed', stored);
      }
      logger.info(
        {
          symbol: cfg.symbol,
          timeframe: cfg.timeframe,
          inserted: result.inserted,
          updated: result.updated,
          errors: result.errors,
        },
        'backfill row completed'
      );
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error(
        { symbol: cfg.symbol, timeframe: cfg.timeframe, err: this.lastError },
        'backfill row failed'
      );
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
