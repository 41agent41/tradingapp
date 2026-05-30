import { dbService } from './database.js';
import { logger } from './logger.js';
import { PoolClient } from 'pg';

// Interfaces for market data
export interface CandlestickBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wap?: number;
  count?: number;
}

export interface Contract {
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
  multiplier?: string;
  expiry?: string;
  strike?: number;
  right?: string;
  localSymbol?: string;
  contractId?: number;
}

/**
 * A row from `data_collection_config` joined to its contract. Drives both
 * the backfill scheduler (which symbols/timeframes to auto-collect) and the
 * retention-aware `cleanOldData()` deletion.
 */
export interface CollectionConfig {
  contractId: number;
  timeframe: string;
  enabled: boolean;
  autoCollect: boolean;
  collectionIntervalMinutes: number;
  retentionDays: number;
  symbol: string;
  secType: string;
  exchange: string | null;
  currency: string | null;
}

/** Per-UTC-day data-quality counts derived from a batch of stored bars. */
export interface DailyQualityMetric {
  /** UTC midnight of the day the metrics describe. */
  date: Date;
  totalBars: number;
  missingBars: number;
  duplicateBars: number;
  invalidBars: number;
}

// Market Data Service Class
export class MarketDataService {
  // Get or create contract in database
  async getOrCreateContract(contract: Contract): Promise<number> {
    const query = `
      INSERT INTO contracts (symbol, sec_type, exchange, currency, multiplier, expiry, strike, right, local_symbol, contract_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (symbol, sec_type, exchange, currency, expiry, strike, right)
      DO UPDATE SET 
        local_symbol = EXCLUDED.local_symbol,
        contract_id = EXCLUDED.contract_id,
        updated_at = NOW()
      RETURNING id
    `;

    const params = [
      contract.symbol,
      contract.secType,
      contract.exchange || null,
      contract.currency || 'USD',
      contract.multiplier || null,
      contract.expiry ? new Date(contract.expiry) : null,
      contract.strike || null,
      contract.right || null,
      contract.localSymbol || null,
      contract.contractId || null,
    ];

    const result = await dbService.query(query, params);
    return result.rows[0].id;
  }

  // Store candlestick data
  async storeCandlestickData(
    contractId: number,
    timeframe: string,
    bars: CandlestickBar[]
  ): Promise<{ inserted: number; updated: number; errors: number }> {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    await dbService.transaction(async (client: PoolClient) => {
      for (const bar of bars) {
        try {
          const query = `
            INSERT INTO candlestick_data (contract_id, timestamp, timeframe, open, high, low, close, volume, wap, count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (contract_id, timestamp, timeframe)
            DO UPDATE SET 
              open = EXCLUDED.open,
              high = EXCLUDED.high,
              low = EXCLUDED.low,
              close = EXCLUDED.close,
              volume = EXCLUDED.volume,
              wap = EXCLUDED.wap,
              count = EXCLUDED.count
            RETURNING id
          `;

          const params = [
            contractId,
            bar.timestamp,
            timeframe,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.wap || null,
            bar.count || null,
          ];

          const result = await client.query(query, params);

          if (result.rowCount === 1) {
            inserted++;
          } else {
            updated++;
          }
        } catch (error) {
          logger.error({ err: String(error) }, 'error storing candlestick bar');
          errors++;
        }
      }
    });

    return { inserted, updated, errors };
  }

  // Retrieve historical (raw OHLCV) data from the database.
  //
  // Technical indicators are intentionally NOT persisted (the canonical
  // TimescaleDB schema omits the `technical_indicators` table) — they are
  // computed on demand in `ib_service/indicators.py` and rendered client-side.
  // Callers that need indicators should fetch from the IB service rather than
  // this cache (see GAP_ANALYSIS.md §3.2).
  async getHistoricalData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<CandlestickBar[]> {
    const query = `
      SELECT
        cd.timestamp,
        cd.open,
        cd.high,
        cd.low,
        cd.close,
        cd.volume,
        cd.wap,
        cd.count
      FROM candlestick_data cd
      JOIN contracts c ON cd.contract_id = c.id
      WHERE c.symbol = $1
        AND cd.timeframe = $2
        AND cd.timestamp >= $3
        AND cd.timestamp <= $4
      ORDER BY cd.timestamp ASC
    `;

    const params = [symbol, timeframe, startDate, endDate];
    const result = await dbService.query(query, params);

    return result.rows.map((row) => ({
      timestamp: new Date(row.timestamp),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume),
      wap: row.wap ? parseFloat(row.wap) : undefined,
      count: row.count ? parseInt(row.count) : undefined,
    }));
  }

  // Get latest data for a symbol
  async getLatestData(
    symbol: string,
    timeframe: string,
    limit: number = 100
  ): Promise<CandlestickBar[]> {
    const query = `
      SELECT 
        cd.timestamp,
        cd.open,
        cd.high,
        cd.low,
        cd.close,
        cd.volume,
        cd.wap,
        cd.count
      FROM candlestick_data cd
      JOIN contracts c ON cd.contract_id = c.id
      WHERE c.symbol = $1 AND cd.timeframe = $2
      ORDER BY cd.timestamp DESC
      LIMIT $3
    `;

    const params = [symbol, timeframe, limit];
    const result = await dbService.query(query, params);

    return result.rows.reverse().map((row) => ({
      timestamp: new Date(row.timestamp),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume),
      wap: row.wap ? parseFloat(row.wap) : undefined,
      count: row.count ? parseInt(row.count) : undefined,
    }));
  }

  // Start a data collection session
  async startDataCollectionSession(contractId: number, timeframe: string): Promise<number> {
    const query = `
      INSERT INTO data_collection_sessions (contract_id, timeframe, start_time, status)
      VALUES ($1, $2, NOW(), 'active')
      RETURNING id
    `;

    const result = await dbService.query(query, [contractId, timeframe]);
    return result.rows[0].id;
  }

  // End a data collection session
  async endDataCollectionSession(
    sessionId: number,
    status: string,
    recordsCollected: number,
    errorMessage?: string
  ): Promise<void> {
    const query = `
      UPDATE data_collection_sessions 
      SET end_time = NOW(), status = $2, records_collected = $3, error_message = $4
      WHERE id = $1
    `;

    await dbService.query(query, [sessionId, status, recordsCollected, errorMessage]);
  }

  // Update data quality metrics
  async updateDataQualityMetrics(
    contractId: number,
    timeframe: string,
    date: Date,
    totalBars: number,
    missingBars: number,
    duplicateBars: number,
    invalidBars: number
  ): Promise<void> {
    const rawScore =
      totalBars > 0 ? (totalBars - missingBars - duplicateBars - invalidBars) / totalBars : 0;
    // The score column is DECIMAL(5,4) in [0,1]; clamp so a day with more
    // missing/duplicate/invalid than total bars can never overflow or go
    // negative.
    const qualityScore = Math.max(0, Math.min(1, rawScore));

    const query = `
      INSERT INTO data_quality_metrics (contract_id, timeframe, date, total_bars, missing_bars, duplicate_bars, invalid_bars, data_quality_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (contract_id, timeframe, date)
      DO UPDATE SET 
        total_bars = EXCLUDED.total_bars,
        missing_bars = EXCLUDED.missing_bars,
        duplicate_bars = EXCLUDED.duplicate_bars,
        invalid_bars = EXCLUDED.invalid_bars,
        data_quality_score = EXCLUDED.data_quality_score,
        last_updated = NOW()
    `;

    await dbService.query(query, [
      contractId,
      timeframe,
      date,
      totalBars,
      missingBars,
      duplicateBars,
      invalidBars,
      qualityScore,
    ]);
  }

  // Get data collection statistics
  async getDataCollectionStats(symbol?: string): Promise<any> {
    let query = `
      SELECT 
        c.symbol,
        cd.timeframe,
        COUNT(cd.id) as total_bars,
        MIN(cd.timestamp) as earliest_data,
        MAX(cd.timestamp) as latest_data,
        AVG(dqm.data_quality_score) as avg_quality_score
      FROM contracts c
      LEFT JOIN candlestick_data cd ON c.id = cd.contract_id
      LEFT JOIN data_quality_metrics dqm ON c.id = dqm.contract_id AND cd.timeframe = dqm.timeframe
    `;

    const params: any[] = [];

    if (symbol) {
      query += ' WHERE c.symbol = $1';
      params.push(symbol);
    }

    query += ' GROUP BY c.symbol, cd.timeframe ORDER BY c.symbol, cd.timeframe';

    const result = await dbService.query(query, params);
    return result.rows;
  }

  // -------------------------------------------------------------------
  // Data-collection configuration
  // -------------------------------------------------------------------

  /**
   * Return the `data_collection_config` rows (joined to their contract)
   * that should drive automated work.
   *
   * @param opts.autoCollectOnly when true, only rows with `auto_collect = true`
   *   are returned (used by the backfill scheduler). When false (the
   *   default) every enabled row is returned (used by retention cleanup).
   */
  async getActiveCollectionConfigs(
    opts: { autoCollectOnly?: boolean } = {}
  ): Promise<CollectionConfig[]> {
    const where = opts.autoCollectOnly
      ? 'WHERE dcc.enabled = true AND dcc.auto_collect = true'
      : 'WHERE dcc.enabled = true';

    const query = `
      SELECT
        dcc.contract_id,
        dcc.timeframe,
        dcc.enabled,
        dcc.auto_collect,
        dcc.collection_interval_minutes,
        dcc.retention_days,
        c.symbol,
        c.sec_type,
        c.exchange,
        c.currency
      FROM data_collection_config dcc
      JOIN contracts c ON c.id = dcc.contract_id
      ${where}
      ORDER BY c.symbol, dcc.timeframe
    `;

    const result = await dbService.query(query);
    return result.rows.map((row) => ({
      contractId: Number(row.contract_id),
      timeframe: row.timeframe,
      enabled: row.enabled,
      autoCollect: row.auto_collect,
      collectionIntervalMinutes: Number(row.collection_interval_minutes ?? 5),
      retentionDays: Number(row.retention_days ?? 365),
      symbol: row.symbol,
      secType: row.sec_type,
      exchange: row.exchange,
      currency: row.currency,
    }));
  }

  /** Most recent stored bar timestamp for a (contract, timeframe), or null. */
  async getLatestStoredTimestamp(contractId: number, timeframe: string): Promise<Date | null> {
    const result = await dbService.query(
      'SELECT MAX(timestamp) AS latest FROM candlestick_data WHERE contract_id = $1 AND timeframe = $2',
      [contractId, timeframe]
    );
    const latest = result.rows[0]?.latest;
    return latest ? new Date(latest) : null;
  }

  // -------------------------------------------------------------------
  // Data-quality metrics
  // -------------------------------------------------------------------

  /** Seconds between consecutive bars for a timeframe (0 = unknown / tick). */
  static timeframeSeconds(timeframe: string): number {
    switch (timeframe) {
      case '1min':
        return 60;
      case '5min':
        return 300;
      case '15min':
        return 900;
      case '30min':
        return 1800;
      case '1hour':
        return 3600;
      case '4hour':
        return 14400;
      case '8hour':
        return 28800;
      case '1day':
        return 86400;
      default:
        return 0; // tick / unknown — no gap analysis possible
    }
  }

  /** Epoch seconds for a bar whose timestamp may be a Date or a number. */
  private static barEpochSeconds(bar: CandlestickBar): number {
    const ts = bar.timestamp;
    const ms = ts instanceof Date ? ts.getTime() : new Date(ts as any).getTime();
    return Math.round(ms / 1000);
  }

  /** A bar is invalid if its OHLCV fails basic sanity checks. */
  static isInvalidBar(bar: CandlestickBar): boolean {
    const prices = [bar.open, bar.high, bar.low, bar.close];
    if (prices.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      return true;
    }
    if (typeof bar.volume !== 'number' || !Number.isFinite(bar.volume) || bar.volume < 0) {
      return true;
    }
    const eps = 1e-9;
    if (bar.high + eps < bar.low) return true;
    if (bar.high + eps < Math.max(bar.open, bar.close)) return true;
    if (bar.low - eps > Math.min(bar.open, bar.close)) return true;
    return false;
  }

  /**
   * Compute per-UTC-day data-quality metrics for a batch of bars. Pure and
   * side-effect free so it is unit-testable without a database.
   *
   * - `duplicateBars` — rows sharing a timestamp with another row that day.
   * - `invalidBars`   — rows failing {@link isInvalidBar}.
   * - `missingBars`   — interior gaps between consecutive distinct bars,
   *                     estimated from the timeframe interval. This counts
   *                     only holes *between* observed bars (it makes no
   *                     assumption about market hours), so an empty day reads
   *                     as zero missing rather than a full session.
   * - `totalBars`     — distinct timestamps observed that day.
   */
  static computeDailyQualityMetrics(
    bars: CandlestickBar[],
    timeframe: string
  ): DailyQualityMetric[] {
    if (!bars || bars.length === 0) return [];

    const interval = this.timeframeSeconds(timeframe);
    const byDay = new Map<string, CandlestickBar[]>();

    for (const bar of bars) {
      const seconds = this.barEpochSeconds(bar);
      if (!Number.isFinite(seconds)) continue;
      // UTC calendar day, e.g. "2026-01-02" (toISOString is always UTC).
      const key = new Date(seconds * 1000).toISOString().slice(0, 10);
      const list = byDay.get(key);
      if (list) list.push(bar);
      else byDay.set(key, [bar]);
    }

    const out: DailyQualityMetric[] = [];
    for (const [key, dayBars] of byDay) {
      const seconds = dayBars.map((b) => this.barEpochSeconds(b));
      const distinct = Array.from(new Set(seconds)).sort((a, b) => a - b);
      const duplicateBars = seconds.length - distinct.length;
      let invalidBars = 0;
      for (const b of dayBars) if (this.isInvalidBar(b)) invalidBars++;

      let missingBars = 0;
      if (interval > 0) {
        for (let i = 1; i < distinct.length; i++) {
          const gap = Math.round((distinct[i] - distinct[i - 1]) / interval) - 1;
          if (gap > 0) missingBars += gap;
        }
      }

      out.push({
        date: new Date(`${key}T00:00:00.000Z`),
        totalBars: distinct.length,
        missingBars,
        duplicateBars,
        invalidBars,
      });
    }

    return out.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /**
   * Compute and persist data-quality metrics for a batch of stored bars.
   * Best-effort: callers wrap this in their own try/catch so a metrics
   * failure never aborts the underlying store.
   */
  async recordDataQuality(
    contractId: number,
    timeframe: string,
    bars: CandlestickBar[]
  ): Promise<void> {
    const metrics = MarketDataService.computeDailyQualityMetrics(bars, timeframe);
    for (const m of metrics) {
      await this.updateDataQualityMetrics(
        contractId,
        timeframe,
        m.date,
        m.totalBars,
        m.missingBars,
        m.duplicateBars,
        m.invalidBars
      );
    }
  }

  // -------------------------------------------------------------------
  // Retention cleanup
  // -------------------------------------------------------------------

  /**
   * Delete bars older than each (contract, timeframe)'s configured
   * `retention_days`, driven by `data_collection_config`. Returns the real
   * number of rows deleted (the previous implementation called a
   * `clean_old_data()` SQL function that does not exist in the canonical
   * TimescaleDB schema and always reported `0`).
   *
   * Note: this complements — it does not replace — TimescaleDB's own
   * `add_retention_policy` chunk-dropping. It exists so an operator can
   * enforce a tighter, per-symbol retention than the coarse global policy.
   */
  async cleanOldData(): Promise<{
    deleted: number;
    byConfig: Array<{ symbol: string; timeframe: string; retentionDays: number; deleted: number }>;
  }> {
    const configs = await this.getActiveCollectionConfigs();
    let deleted = 0;
    const byConfig: Array<{
      symbol: string;
      timeframe: string;
      retentionDays: number;
      deleted: number;
    }> = [];

    for (const cfg of configs) {
      const result = await dbService.query(
        `DELETE FROM candlestick_data
         WHERE contract_id = $1
           AND timeframe = $2
           AND timestamp < NOW() - make_interval(days => $3::int)`,
        [cfg.contractId, cfg.timeframe, cfg.retentionDays]
      );
      const n = result.rowCount ?? 0;
      deleted += n;
      byConfig.push({
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
        retentionDays: cfg.retentionDays,
        deleted: n,
      });
    }

    return { deleted, byConfig };
  }

  // Upload historical data to database
  async uploadHistoricalData(data: {
    symbol: string;
    timeframe: string;
    bars: any[];
    account_mode: string;
    secType: string;
    exchange: string;
    currency: string;
  }): Promise<{ uploaded_count: number; skipped_count: number }> {
    const { symbol, timeframe, bars, secType, exchange, currency } = data;

    logger.info({ symbol, timeframe, bars: bars.length }, 'uploading bars to database');

    // Get or create contract
    const contractId = await this.getOrCreateContract({
      symbol,
      secType,
      exchange,
      currency,
    });

    // Convert bars to CandlestickBar format
    const candlestickBars: CandlestickBar[] = bars.map((bar) => ({
      timestamp: new Date(bar.timestamp * 1000), // Convert Unix timestamp to Date
      open: parseFloat(bar.open),
      high: parseFloat(bar.high),
      low: parseFloat(bar.low),
      close: parseFloat(bar.close),
      volume: parseInt(bar.volume),
      wap: bar.wap ? parseFloat(bar.wap) : undefined,
      count: bar.count ? parseInt(bar.count) : undefined,
    }));

    // Store candlestick data
    const result = await this.storeCandlestickData(contractId, timeframe, candlestickBars);

    // Record data-quality metrics for the batch (best-effort).
    try {
      await this.recordDataQuality(contractId, timeframe, candlestickBars);
    } catch (qualityError) {
      logger.warn(
        { symbol, timeframe, err: String(qualityError) },
        'failed to record data-quality metrics',
      );
    }

    logger.info(
      {
        symbol,
        timeframe,
        inserted: result.inserted,
        updated: result.updated,
        errors: result.errors,
      },
      'upload completed',
    );

    return {
      uploaded_count: result.inserted + result.updated,
      skipped_count: result.errors,
    };
  }
}

// Export singleton instance
export const marketDataService = new MarketDataService();
export default marketDataService;
