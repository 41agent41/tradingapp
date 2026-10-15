/**
 * What market data the app collects on its own: the rows of
 * `data_collection_config`, edited on Settings > Schedulers and data.
 *
 * Each row is one instrument at one broker (its contract) and one timeframe.
 * With `auto_collect` on, the backfill scheduler fetches its recent bars
 * whenever the newest stored bar is older than `collection_interval_minutes`;
 * `retention_days` is how long its raw bars are kept. With `history_start`
 * set, the scheduler also walks back to that date a chunk at a time, and bars
 * from it on are kept whatever the retention. A disabled row is kept but
 * ignored by both.
 */
import type { Querier } from './backtestRunRepository.js';
import type { Contract } from './marketDataService.js';
import { BROKERS } from './brokers.js';
import { VALID_SEC_TYPES, VALID_TIMEFRAMES } from '../routes/marketData/shared.js';

export interface CollectionRow {
  id: number;
  contract_id: number;
  broker: string;
  account: string;
  symbol: string;
  sec_type: string;
  exchange: string | null;
  currency: string | null;
  timeframe: string;
  enabled: boolean;
  auto_collect: boolean;
  collection_interval_minutes: number;
  retention_days: number;
  latest_bar: string | null;
  /** Deep history: the date to collect back to, YYYY-MM-DD, or null. */
  history_start: string | null;
  /** The oldest stored bar. */
  oldest_bar: string | null;
  /** How far back the scheduler has asked the broker so far. */
  backfilled_to: string | null;
  updated_at: string | null;
}

export class CollectionConfigError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** How far back history may go: TimescaleDB drops bars older than two years
 *  (the retention policy in timescaledb-schema.sql). */
export const MAX_HISTORY_DAYS = 730;

/** Timeframes the scheduler can fetch as bars (ticks are streamed, not backfilled). */
export const COLLECTION_TIMEFRAMES = VALID_TIMEFRAMES.filter((t) => t !== 'tick');

const SELECT = `
  SELECT dcc.id, dcc.contract_id, c.broker, c.broker_account AS account, c.symbol, c.sec_type,
         c.exchange, c.currency, dcc.timeframe, dcc.enabled, dcc.auto_collect,
         dcc.collection_interval_minutes, dcc.retention_days, dcc.updated_at,
         to_char(dcc.history_start, 'YYYY-MM-DD') AS history_start, dcc.backfilled_to,
         (SELECT MAX(cd.timestamp) FROM candlestick_data cd
           WHERE cd.contract_id = dcc.contract_id AND cd.timeframe = dcc.timeframe) AS latest_bar,
         (SELECT MIN(cd.timestamp) FROM candlestick_data cd
           WHERE cd.contract_id = dcc.contract_id AND cd.timeframe = dcc.timeframe) AS oldest_bar
    FROM data_collection_config dcc
    JOIN contracts c ON c.id = dcc.contract_id`;

function toRow(r: any): CollectionRow {
  return {
    id: Number(r.id),
    contract_id: Number(r.contract_id),
    broker: r.broker,
    account: r.account,
    symbol: r.symbol,
    sec_type: r.sec_type,
    exchange: r.exchange ?? null,
    currency: r.currency ?? null,
    timeframe: r.timeframe,
    enabled: Boolean(r.enabled),
    auto_collect: Boolean(r.auto_collect),
    collection_interval_minutes: Number(r.collection_interval_minutes ?? 5),
    retention_days: Number(r.retention_days ?? 365),
    latest_bar: r.latest_bar ? new Date(r.latest_bar).toISOString() : null,
    history_start: r.history_start ?? null,
    oldest_bar: r.oldest_bar ? new Date(r.oldest_bar).toISOString() : null,
    backfilled_to: r.backfilled_to ? new Date(r.backfilled_to).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function wholeNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || text(value) === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CollectionConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new CollectionConfigError(`${name} must be true or false.`);
}

/**
 * A history start date: '' or null clears it (undefined leaves it as is).
 * Must be in the past and within MAX_HISTORY_DAYS.
 */
function historyStart(value: unknown, now: Date): string | null | undefined {
  if (value === undefined) return undefined;
  const raw = text(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new CollectionConfigError('history_start must be a date, YYYY-MM-DD.');
  }
  const day = new Date(`${raw}T00:00:00Z`).getTime();
  if (day >= now.getTime()) {
    throw new CollectionConfigError('history_start must be in the past.');
  }
  if (now.getTime() - day > MAX_HISTORY_DAYS * 86_400_000) {
    throw new CollectionConfigError(
      `history_start can go back at most ${MAX_HISTORY_DAYS} days: the database keeps two years of bars.`
    );
  }
  return raw;
}

function options(input: Record<string, unknown>, now = new Date()) {
  return {
    historyStart: historyStart(input.history_start, now),
    enabled: flag(input.enabled, 'enabled'),
    autoCollect: flag(input.auto_collect, 'auto_collect'),
    interval: wholeNumber(
      input.collection_interval_minutes,
      'collection_interval_minutes',
      1,
      10080
    ),
    retention: wholeNumber(input.retention_days, 'retention_days', 1, 36500),
  };
}

export class CollectionConfigRepository {
  constructor(
    private readonly db: Querier,
    private readonly contracts: { getOrCreateContract(c: Contract): Promise<number> }
  ) {}

  async list(): Promise<CollectionRow[]> {
    const { rows } = await this.db.query(`${SELECT} ORDER BY c.symbol, c.broker, dcc.timeframe`);
    return rows.map(toRow);
  }

  private async get(id: number): Promise<CollectionRow> {
    const { rows } = await this.db.query(`${SELECT} WHERE dcc.id = $1`, [id]);
    if (!rows[0]) throw new CollectionConfigError('No such collection entry.', 404);
    return toRow(rows[0]);
  }

  /**
   * Adds an instrument and timeframe to collect, creating its contract if this
   * is the first time it is seen. Adding one that exists updates its options.
   */
  async add(input: Record<string, unknown>): Promise<CollectionRow> {
    const broker = text(input.broker).toLowerCase();
    if (!(BROKERS as readonly string[]).includes(broker)) {
      throw new CollectionConfigError(`broker must be one of: ${BROKERS.join(', ')}.`);
    }
    const account = text(input.account).toLowerCase() || 'default';
    const symbol = text(input.symbol).toUpperCase();
    if (!symbol || symbol.length > 32) {
      throw new CollectionConfigError('symbol is required (up to 32 characters).');
    }
    const secType = text(input.sec_type).toUpperCase() || (broker === 'ib' ? 'STK' : 'CASH');
    if (!VALID_SEC_TYPES.includes(secType)) {
      throw new CollectionConfigError(`sec_type must be one of: ${VALID_SEC_TYPES.join(', ')}.`);
    }
    const timeframe = text(input.timeframe);
    if (!COLLECTION_TIMEFRAMES.includes(timeframe)) {
      throw new CollectionConfigError(
        `timeframe must be one of: ${COLLECTION_TIMEFRAMES.join(', ')}.`
      );
    }
    const exchange = text(input.exchange).toUpperCase() || undefined;
    const currency = text(input.currency).toUpperCase() || undefined;
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new CollectionConfigError('currency must be a three-letter code.');
    }
    const opts = options(input);

    const contractId = await this.contracts.getOrCreateContract({
      broker,
      brokerAccount: account,
      symbol,
      secType,
      exchange,
      currency,
    });
    const { rows } = await this.db.query(
      `INSERT INTO data_collection_config
         (contract_id, timeframe, enabled, auto_collect, collection_interval_minutes, retention_days,
          history_start)
       VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true), COALESCE($5, 5), COALESCE($6, 365),
               $8::date)
       ON CONFLICT (contract_id, timeframe) DO UPDATE
          SET enabled = COALESCE($3, data_collection_config.enabled),
              auto_collect = COALESCE($4, data_collection_config.auto_collect),
              collection_interval_minutes =
                COALESCE($5, data_collection_config.collection_interval_minutes),
              retention_days = COALESCE($6, data_collection_config.retention_days),
              history_start = CASE WHEN $7 THEN $8::date ELSE data_collection_config.history_start END
       RETURNING id`,
      [
        contractId,
        timeframe,
        opts.enabled ?? null,
        opts.autoCollect ?? null,
        opts.interval ?? null,
        opts.retention ?? null,
        opts.historyStart !== undefined,
        opts.historyStart ?? null,
      ]
    );
    return this.get(Number(rows[0].id));
  }

  /** Changes a row's options. The instrument and timeframe are fixed. */
  async update(id: number, input: Record<string, unknown>): Promise<CollectionRow> {
    await this.get(id);
    const opts = options(input);
    await this.db.query(
      `UPDATE data_collection_config
          SET enabled = COALESCE($2, enabled),
              auto_collect = COALESCE($3, auto_collect),
              collection_interval_minutes = COALESCE($4, collection_interval_minutes),
              retention_days = COALESCE($5, retention_days),
              history_start = CASE WHEN $6 THEN $7::date ELSE history_start END
        WHERE id = $1`,
      [
        id,
        opts.enabled ?? null,
        opts.autoCollect ?? null,
        opts.interval ?? null,
        opts.retention ?? null,
        opts.historyStart !== undefined,
        opts.historyStart ?? null,
      ]
    );
    return this.get(id);
  }

  /** Stops collecting. Bars already stored are kept. */
  async remove(id: number): Promise<void> {
    await this.get(id);
    await this.db.query(`DELETE FROM data_collection_config WHERE id = $1`, [id]);
  }
}
