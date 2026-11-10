/**
 * Nightly reconcile of recorded bars with the broker's own history (E-07).
 *
 * The live recorder's 1-minute bars are built from quotes as they arrive, so
 * a polled broker misses highs and lows between polls, and any outage leaves a
 * gap. Each night, for every recorded instrument, the last two days of
 * 1-minute bars are fetched from the broker and stored. A broker bar replaces
 * a recorded one (source 'stream' becomes 'broker') and fills any minute the
 * recorder missed. The minute still forming is left alone.
 *
 * For each instrument the run notes how many recorded bars were replaced, how
 * many missing minutes were filled, how many recorded bars the broker had no
 * bar for, and how far the replaced closes moved. A large, steady move means
 * the recorder builds that broker's bars on the wrong price (its bar_basis).
 */
import type { Querier } from './backtestRunRepository.js';
import type { HistoryRequest, RawBar } from './backfillScheduler.js';
import type { CandlestickBar } from './marketDataService.js';
import { fetchBrokerHistory } from './backfillScheduler.js';
import { dbService } from './database.js';
import { marketDataService } from './marketDataService.js';
import { recordTargets, type RecordTarget } from './liveRecorder.js';
import { logger } from './logger.js';

const DAY_MS = 86_400_000;
/** Days back from today (UTC) that a run covers. */
export const RECONCILE_DAYS = 2;

export interface ReconcileResult {
  contract_id: number;
  platform: string;
  account: string;
  symbol: string;
  /** Bars the broker returned for the range. */
  fetched: number;
  /** Recorded bars a broker bar replaced. */
  replaced: number;
  /** Minutes the recorder had no bar for, now filled. */
  filled: number;
  /** Recorded bars the broker had no bar for; they stay as recorded. */
  left: number;
  /** Mean move of the replaced closes, in basis points; null with none replaced. */
  mean_move_bps: number | null;
  error: string | null;
}

export interface ReconcileStatus {
  running: boolean;
  last_run: string | null;
  last_error: string | null;
  results: ReconcileResult[];
}

export interface ReconcileDeps {
  db: Querier;
  targets(): Promise<RecordTarget[]>;
  fetchHistory(req: HistoryRequest): Promise<RawBar[]>;
  storeCandlestickData(
    contractId: number,
    timeframe: string,
    bars: CandlestickBar[]
  ): Promise<{ inserted: number; updated: number; errors: number }>;
  recordDataQuality(contractId: number, timeframe: string, bars: CandlestickBar[]): Promise<void>;
  now(): number;
}

export class Reconciler {
  private running = false;
  private lastRun: string | null = null;
  private lastError: string | null = null;
  private results: ReconcileResult[] = [];

  constructor(private readonly deps: ReconcileDeps) {}

  status(): ReconcileStatus {
    return {
      running: this.running,
      last_run: this.lastRun,
      last_error: this.lastError,
      results: this.results,
    };
  }

  /** One pass over every recorded instrument. A second call while one runs
   *  returns what the first has so far. */
  async run(): Promise<ReconcileResult[]> {
    if (this.running) return this.results;
    this.running = true;
    try {
      const now = this.deps.now();
      const today = Math.floor(now / DAY_MS) * DAY_MS;
      const from = today - RECONCILE_DAYS * DAY_MS;
      // Whole UTC days, end exclusive: through the end of today.
      const to = today + DAY_MS;
      const results: ReconcileResult[] = [];
      for (const target of await this.deps.targets()) {
        results.push(await this.one(target, from, to));
      }
      this.results = results;
      this.lastRun = new Date(now).toISOString();
      this.lastError = null;
      logger.info(
        {
          instruments: results.length,
          replaced: results.reduce((n, r) => n + r.replaced, 0),
          filled: results.reduce((n, r) => n + r.filled, 0),
          failed: results.filter((r) => r.error).length,
        },
        'recorded bars reconciled with broker history'
      );
      return results;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: this.lastError }, 'reconcile failed');
      throw err;
    } finally {
      this.running = false;
    }
  }

  private async one(target: RecordTarget, from: number, to: number): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      contract_id: target.contractId,
      platform: target.platform,
      account: target.account,
      symbol: target.symbol,
      fetched: 0,
      replaced: 0,
      filled: 0,
      left: 0,
      mean_move_bps: null,
      error: null,
    };
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    try {
      const raw = await this.deps.fetchHistory({
        broker: target.platform,
        brokerAccount: target.account,
        symbol: target.symbol,
        timeframe: '1min',
        period: 'CUSTOM',
        secType: target.secType,
        exchange: target.exchange || undefined,
        currency: target.currency || undefined,
        startDate: day(from),
        endDate: day(to),
      });
      result.fetched = raw.length;

      // The recorded bars as they stand, to see what the broker's replace.
      const recorded = await this.streamBars(target.contractId, from, to);
      const brokerClose = new Map(raw.map((b) => [b.timestamp * 1000, b.close]));
      let moved = 0;
      let compared = 0;
      for (const [minute, close] of recorded) {
        const other = brokerClose.get(minute);
        if (other === undefined || !close) continue;
        moved += Math.abs(other - close) / close;
        compared++;
      }

      const bars: CandlestickBar[] = raw.map((b) => ({
        timestamp: new Date(b.timestamp * 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        wap: b.wap,
        count: b.count,
      }));
      if (bars.length) {
        const stored = await this.deps.storeCandlestickData(target.contractId, '1min', bars);
        result.filled = stored.inserted;
        await this.deps.recordDataQuality(target.contractId, '1min', bars).catch(() => undefined);
      }
      result.left = (await this.streamBars(target.contractId, from, to)).size;
      result.replaced = recorded.size - result.left;
      result.mean_move_bps = compared ? Math.round((moved / compared) * 1e6) / 100 : null;
      logger.info({ ...result }, 'reconciled recorded bars');
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.warn(
        { symbol: target.symbol, platform: target.platform, err: result.error },
        'reconcile failed for an instrument'
      );
    }
    return result;
  }

  /** Minute (epoch ms) to close of the recorder-built bars in a range. */
  private async streamBars(contractId: number, from: number, to: number) {
    const { rows } = await this.deps.db.query(
      `SELECT (extract(epoch FROM timestamp) * 1000)::bigint AS minute, close::float8 AS close
         FROM candlestick_data
        WHERE contract_id = $1 AND timeframe = '1min' AND source = 'stream'
          AND timestamp >= to_timestamp($2 / 1000.0) AND timestamp < to_timestamp($3 / 1000.0)`,
      [contractId, from, to]
    );
    return new Map<number, number>(rows.map((r) => [Number(r.minute), Number(r.close)]));
  }
}

/** The app's reconciler; `index.ts` runs it nightly and the routes on request. */
export const reconciler = new Reconciler({
  db: dbService,
  targets: recordTargets,
  fetchHistory: fetchBrokerHistory,
  storeCandlestickData: (id, timeframe, bars) =>
    marketDataService.storeCandlestickData(id, timeframe, bars),
  recordDataQuality: (id, timeframe, bars) =>
    marketDataService.recordDataQuality(id, timeframe, bars),
  now: () => Date.now(),
});
