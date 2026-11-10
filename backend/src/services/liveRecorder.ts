/**
 * The live recorder (docs/plans/E-05-live-recorder.md).
 *
 * Stores 1-minute bars, and quotes where chosen, for every Data collection
 * row with "Record live" ticked, whether or not a chart is open:
 *
 *   broker_service ── XADD marketdata:quotes ──▶ Redis Stream
 *                                                    │ XREAD from the cursor
 *                                                    ▼
 *                       recorder: bars in memory, quotes waiting
 *                                                    │ every 5 s and at each minute end
 *                                                    ▼
 *           one transaction: bars + quotes + the cursor (recorder_cursor)
 *
 * The cursor is the ID of the last stream entry stored. It moves in the same
 * transaction as what that entry produced, so after any restart the recorder
 * resumes at the next entry: nothing is stored twice and nothing is skipped
 * (unless Redis trimmed it while the backend was down; TICK_STREAM_MAXLEN).
 *
 * What to record is a desired set. The recorder sends the whole set to the
 * broker service (`PUT /market-data/stream/recorded`) at start, on every
 * change to the collection list and every minute, so a restart on either side
 * heals itself. The answer says which account each instrument's quotes carry,
 * which is how a quote is matched to its contract.
 *
 * Bars are built on the price each broker builds its own history from (the
 * entry's `basis`: mid, bid or last), and written with source 'stream'. A
 * stream bar never replaces a broker bar; the backfill replaces stream bars.
 */
import axios from 'axios';
import { createClient } from 'redis';
import type { PoolClient } from 'pg';

import { configService } from '../config/configService.js';
import { type EnvLike, readBool } from '../config/read.js';
import { collectionEvents } from './collectionConfig.js';
import { dbService } from './database.js';
import { logger } from './logger.js';
import { recorderEntries, recorderFlushSeconds, recorderLagSeconds } from './metrics.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

export const QUOTE_STREAM = 'marketdata:quotes';
const MINUTE_MS = 60_000;
/** Bars this recent stay in memory and still take late quotes. */
export const WINDOW_MINUTES = 10;
export const FLUSH_MS = 5_000;
/** Waiting quotes that force a flush before the 5 seconds are up. */
export const FLUSH_TICKS = 5_000;
/** Unstored entries at which reading stops (the database is down or slow). */
export const MAX_WAITING = 50_000;
const READ_COUNT = 1_000;
const READ_BLOCK_MS = 1_000;
const RESEND_MS = 60_000;
/** Health is degraded when the recorder is this far behind the stream. */
export const LAG_DEGRADED_SECONDS = 60;

export const RECORDER_SETTING_KEYS = ['RECORDER_ENABLED'] as const;

/** From `.env` or the Settings page. (REDIS_ENABLED is the cache's switch;
 *  like the streaming bridge, the recorder uses Redis regardless.) */
export function recorderEnabled(env: EnvLike = configService.asEnv()): boolean {
  return readBool(env, 'RECORDER_ENABLED', true);
}

/** An instrument to record: a contract, and whether its quotes are stored. */
export interface RecordTarget {
  contractId: number;
  platform: string;
  /** The account as stored on the contract, often 'default'. */
  account: string;
  symbol: string;
  secType: string;
  exchange?: string | null;
  currency?: string | null;
  ticks: boolean;
}

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface BarRow {
  contractId: number;
  /** Start of the minute, epoch milliseconds. */
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  count: number;
}

export interface TickRow {
  contractId: number;
  ts: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  lastSize: number | null;
  recvTs: number;
}

export interface Flush {
  bars: BarRow[];
  ticks: TickRow[];
  cursor: string;
}

/** What the broker service answered for the recorded set. */
export interface RecordedAnswer {
  resolved: Array<{
    platform: string;
    account: string | null;
    symbol: string;
    stream_account: string;
    mode: string;
  }>;
  errors: Array<{ platform: string; account: string | null; symbol: string; error: string }>;
  poll_seconds?: number;
}

export interface RecorderRedis {
  connect(): Promise<void>;
  /** Entries after `id`, oldest first; empty after the block time. */
  read(id: string, count: number, blockMs: number): Promise<StreamEntry[]>;
  /** The newest entry's ID, or null for an empty or missing stream. */
  lastId(): Promise<string | null>;
  length(): Promise<number>;
  close(): Promise<void>;
}

export interface RecorderDeps {
  redis: () => RecorderRedis;
  targets(): Promise<RecordTarget[]>;
  loadCursor(): Promise<string | null>;
  /** Stream-built 1-minute bars from `sinceMs` on, to continue after a restart. */
  loadBars(sinceMs: number): Promise<BarRow[]>;
  /** Stores bars, quotes and the cursor in one transaction. */
  flush(batch: Flush): Promise<void>;
  sendRecorded(targets: RecordTarget[]): Promise<RecordedAnswer>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface Bar extends BarRow {
  /** Time of the newest quote in the bar, which owns the close. */
  lastTs: number;
  dirty: boolean;
}

interface ContractState {
  target: RecordTarget;
  bars: Map<number, Bar>;
  lastQuote: number | null;
  lastBar: number | null;
  /** Quotes per wall-clock minute, this one and the one before. */
  bucketMinute: number;
  bucket: number;
  previousBucket: number;
  prevLast: number | null;
  prevLastSize: number | null;
  mode: string | null;
  error: string | null;
}

/** Stream IDs are `<milliseconds>-<sequence>`. */
export function compareIds(a: string, b: string): number {
  const [am, as = '0'] = a.split('-');
  const [bm, bs = '0'] = b.split('-');
  const ms = BigInt(am) - BigInt(bm);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(as) - BigInt(bs);
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}

function idMs(id: string): number {
  return Number(id.split('-')[0]);
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function key(platform: string, account: string, symbol: string): string {
  return `${platform.toLowerCase()}|${account.toLowerCase()}|${symbol.toUpperCase()}`;
}

/** The price a bar is built from, or null when the quote lacks it. */
export function basisPrice(
  basis: string,
  bid: number | null,
  ask: number | null,
  last: number | null
): number | null {
  if (basis === 'mid') return bid !== null && ask !== null ? (bid + ask) / 2 : null;
  if (basis === 'bid') return bid;
  if (basis === 'last') return last;
  return null;
}

export class LiveRecorder {
  private readonly deps: RecorderDeps;
  private enabled: boolean;
  private running = false;
  private loop: Promise<void> | null = null;
  private resendTimer: NodeJS.Timeout | null = null;
  private redis: RecorderRedis | null = null;

  private contracts = new Map<number, ContractState>();
  private wanted = new Set<number>();
  /** The account each contract's quotes carry, as the broker service
   *  resolved it ('default' on a contract may be 'practice' in the stream). */
  private streamAccounts = new Map<number, string>();
  private setError: string | null = null;
  /** Stream connection and symbol to the contracts recording it. */
  private byKey = new Map<string, ContractState[]>();
  private ticks: TickRow[] = [];

  /** The last entry read, and the last one stored. */
  private readId: string | null = null;
  private storedId: string | null = null;
  private waiting = 0;
  private lastFlushAt = 0;
  private lastFlushMinute = 0;
  private retryAt = 0;

  private totals = { written: 0, late: 0, invalid: 0, unrecorded: 0 };
  private lagSeconds = 0;
  private streamLength = 0;
  private pollSeconds: number | null = null;
  private lastError: string | null = null;
  private lastFlushIso: string | null = null;

  constructor(deps: Partial<RecorderDeps> = {}, enabled?: boolean) {
    this.deps = { ...defaultDeps(), ...deps };
    this.enabled = enabled ?? recorderEnabled();
    collectionEvents.on('changed', () => {
      if (this.resendTimer) void this.syncTargets();
    });
  }

  // -- lifecycle --------------------------------------------------------- //

  /** Takes the setting again. Call `start()` afterwards. */
  reconfigure(enabled = recorderEnabled()): void {
    this.enabled = enabled;
  }

  /**
   * Starts the resend timer, and the reader when recording is on. With it
   * off the timer still runs, sending an empty set, so a broker service that
   * kept an old set lets go of it.
   */
  start(): void {
    if (!this.resendTimer) {
      this.resendTimer = setInterval(() => void this.syncTargets(), RESEND_MS);
      this.resendTimer.unref?.();
    }
    if (this.enabled && !this.running) {
      this.running = true;
      // After a reader that is still stopping, never beside it.
      this.loop = (this.loop ?? Promise.resolve())
        .then(() => this.run())
        .catch((err) => {
          this.lastError = String(err);
          logger.error({ err: String(err) }, 'live recorder stopped on an error');
          this.running = false;
        });
      logger.info('live recorder started');
    } else if (!this.enabled) {
      if (this.running) void this.stopReading();
      // The reader sends the set itself; with recording off, send the empty one.
      void this.syncTargets();
    }
  }

  private async stopReading(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  async stop(): Promise<void> {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
    await this.stopReading();
  }

  // -- the recorded set -------------------------------------------------- //

  /** Re-reads what to record and tells the broker service. Safe to repeat. */
  async syncTargets(): Promise<boolean> {
    try {
      const targets = this.enabled ? await this.deps.targets() : [];
      this.setTargets(targets);
      const answer = await this.deps.sendRecorded(targets);
      this.applyAnswer(answer);
      this.setError = null;
      return true;
    } catch (err) {
      this.setError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: this.setError }, 'live recorder could not update the recorded set');
      return false;
    }
  }

  private setTargets(targets: RecordTarget[]): void {
    const wanted = new Set(targets.map((t) => t.contractId));
    this.wanted = wanted;
    for (const id of [...this.contracts.keys()]) {
      // Bars and quotes already read stay until the next flush stores them.
      if (!wanted.has(id) && !this.hasUnstored(id)) this.contracts.delete(id);
    }
    for (const target of targets) {
      const state = this.contracts.get(target.contractId);
      if (state) state.target = target;
      else this.contracts.set(target.contractId, newState(target));
    }
    this.rebuildKeys();
  }

  private hasUnstored(contractId: number): boolean {
    const state = this.contracts.get(contractId);
    return Boolean(state && [...state.bars.values()].some((b) => b.dirty));
  }

  private rebuildKeys(): void {
    this.byKey.clear();
    for (const state of this.contracts.values()) {
      const t = state.target;
      if (!this.wanted.has(t.contractId)) continue;
      const account = this.streamAccounts.get(t.contractId) ?? t.account;
      const k = key(t.platform, account, t.symbol);
      this.byKey.set(k, [...(this.byKey.get(k) ?? []), state]);
    }
  }

  private applyAnswer(answer: RecordedAnswer): void {
    this.pollSeconds = answer.poll_seconds ?? this.pollSeconds;
    for (const state of this.contracts.values()) {
      const t = state.target;
      const same = (r: { platform: string; account: string | null; symbol: string }) =>
        r.platform.toLowerCase() === t.platform.toLowerCase() &&
        (r.account ?? 'default').toLowerCase() === t.account.toLowerCase() &&
        r.symbol.toUpperCase() === t.symbol.toUpperCase();
      const resolved = (answer.resolved ?? []).find(same);
      const failed = (answer.errors ?? []).find(
        (e) =>
          e.platform.toLowerCase() === t.platform.toLowerCase() &&
          e.symbol.toUpperCase() === t.symbol.toUpperCase() &&
          (e.account ?? 'default').toLowerCase() ===
            (resolved?.stream_account ?? t.account).toLowerCase()
      );
      if (resolved) {
        this.streamAccounts.set(t.contractId, resolved.stream_account);
        state.mode = resolved.mode;
      }
      state.error = failed ? failed.error : null;
    }
    this.rebuildKeys();
  }

  // -- reading ----------------------------------------------------------- //

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.open();
        break;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ err: this.lastError }, 'live recorder could not start; retrying');
        await this.closeRedis();
        await this.deps.sleep(FLUSH_MS);
      }
    }
    while (this.running) {
      try {
        await this.step();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ err: this.lastError }, 'live recorder read failed; retrying');
        await this.deps.sleep(READ_BLOCK_MS);
      }
    }
    // Store what was read before stopping; on failure the cursor has not
    // moved, so the next start reads those entries again.
    await this.flush().catch(() => undefined);
    await this.closeRedis();
  }

  private async closeRedis(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    await redis?.close().catch(() => undefined);
  }

  /** Connects, finds where to resume, and reloads the bars still open. */
  private async open(): Promise<void> {
    // Quotes are matched to contracts by the broker service's answer, so
    // nothing is read (and the cursor does not move) until it has answered.
    if (!(await this.syncTargets())) {
      throw new Error(`the broker service did not take the recorded set: ${this.setError}`);
    }
    const redis = this.deps.redis();
    this.redis = redis;
    await redis.connect();
    const now = this.deps.now();
    const [cursor, newest] = [await this.deps.loadCursor(), await redis.lastId()];
    let start = cursor ?? newest ?? '0-0';
    if (cursor && newest && compareIds(newest, cursor) < 0) {
      // Redis lost its data and its clock went back: the cursor points past
      // everything in the stream. Take new entries only.
      logger.warn({ cursor, newest }, 'live recorder cursor is ahead of the stream; restarting');
      start = newest;
    }
    this.readId = start;
    this.storedId = cursor;
    this.ticks = [];
    this.waiting = 0;
    for (const state of this.contracts.values()) state.bars.clear();
    for (const bar of await this.deps.loadBars(windowStart(now))) {
      const state = this.contracts.get(bar.contractId);
      if (state) state.bars.set(bar.minute, { ...bar, lastTs: bar.minute, dirty: false });
    }
    this.lastFlushAt = now;
    this.lastFlushMinute = Math.floor(now / MINUTE_MS);
    this.lastError = null;
  }

  /** One read and, when due, one flush. Public so tests can drive it. */
  async step(): Promise<void> {
    const redis = this.redis;
    if (!redis || this.readId === null) throw new Error('recorder is not open');
    if (this.waiting < MAX_WAITING) {
      const entries = await redis.read(this.readId, READ_COUNT, READ_BLOCK_MS);
      for (const entry of entries) {
        this.apply(entry);
        this.readId = entry.id;
        this.waiting++;
      }
    } else {
      await this.deps.sleep(READ_BLOCK_MS);
    }
    const now = this.deps.now();
    if (now < this.retryAt) return;
    const due =
      now - this.lastFlushAt >= FLUSH_MS ||
      Math.floor(now / MINUTE_MS) !== this.lastFlushMinute ||
      this.ticks.length >= FLUSH_TICKS;
    if (!due) return;
    try {
      await this.flush();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.retryAt = now + FLUSH_MS;
      logger.warn({ err: this.lastError, waiting: this.waiting }, 'live recorder flush failed');
    }
    await this.measure(redis);
  }

  private async measure(redis: RecorderRedis): Promise<void> {
    try {
      const newest = await redis.lastId();
      this.streamLength = await redis.length();
      const at = this.storedId ?? this.readId;
      this.lagSeconds =
        newest && at && compareIds(newest, at) > 0
          ? Math.max(0, (idMs(newest) - idMs(at)) / 1000)
          : 0;
      recorderLagSeconds.set(this.lagSeconds);
    } catch {
      // The next read reports a Redis that is down.
    }
  }

  /** Applies one stream entry to its contracts' bars and waiting quotes. */
  apply(entry: StreamEntry): void {
    const f = entry.fields;
    const ts = num(f.ts);
    const bid = num(f.bid);
    const ask = num(f.ask);
    const last = num(f.last);
    if (f.v !== '1' || ts === null || !f.platform || !f.symbol) {
      this.count('invalid');
      return;
    }
    const states = this.byKey.get(key(f.platform, f.account ?? 'default', f.symbol));
    if (!states?.length) {
      // Not recorded any more (the set changed after the quote was added).
      this.totals.unrecorded++;
      return;
    }
    const lastSize = num(f.last_size);
    const recvTs = num(f.recv_ts) ?? ts;
    const price = basisPrice(f.basis ?? '', bid, ask, last);
    const now = this.deps.now();
    const minute = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const wallMinute = Math.floor(now / MINUTE_MS);

    for (const state of states) {
      let used = false;
      if (state.target.ticks) {
        this.ticks.push({
          contractId: state.target.contractId,
          ts,
          bid,
          ask,
          last,
          lastSize,
          recvTs,
        });
        used = true;
      }
      if (state.bucketMinute !== wallMinute) {
        state.previousBucket = state.bucketMinute === wallMinute - 1 ? state.bucket : 0;
        state.bucket = 0;
        state.bucketMinute = wallMinute;
      }
      state.bucket++;
      state.lastQuote = Math.max(state.lastQuote ?? 0, ts);

      // Volume only for trade-built bars, and only when the trade is new: a
      // snapshot repeats the last trade when just the bid or ask moved.
      const traded =
        f.basis === 'last' &&
        lastSize !== null &&
        (last !== state.prevLast || lastSize !== state.prevLastSize);
      state.prevLast = last;
      state.prevLastSize = lastSize;

      if (price === null) {
        if (!used) this.count('invalid');
        else this.count('written');
        continue;
      }
      if (minute < windowStart(now)) {
        this.count('late');
        continue;
      }
      const bar = state.bars.get(minute);
      if (!bar) {
        state.bars.set(minute, {
          contractId: state.target.contractId,
          minute,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: traded ? lastSize! : 0,
          count: 1,
          lastTs: ts,
          dirty: true,
        });
      } else {
        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
        if (ts >= bar.lastTs) {
          bar.close = price;
          bar.lastTs = ts;
        }
        if (traded) bar.volume += lastSize!;
        bar.count++;
        bar.dirty = true;
      }
      this.count('written');
    }
  }

  private count(result: 'written' | 'late' | 'invalid'): void {
    this.totals[result]++;
    recorderEntries.inc({ result });
  }

  // -- storing ----------------------------------------------------------- //

  /** Stores every changed bar, the waiting quotes and the cursor together. */
  async flush(): Promise<void> {
    const now = this.deps.now();
    const dirty: Bar[] = [];
    for (const state of this.contracts.values()) {
      for (const bar of state.bars.values()) if (bar.dirty) dirty.push(bar);
    }
    const moved = this.readId !== null && this.readId !== this.storedId;
    if (moved || dirty.length || this.ticks.length) {
      const started = Date.now();
      await this.deps.flush({
        bars: dirty.map(({ lastTs: _l, dirty: _d, ...row }) => row),
        ticks: this.ticks,
        cursor: this.readId!,
      });
      recorderFlushSeconds.observe((Date.now() - started) / 1000);
      for (const bar of dirty) {
        bar.dirty = false;
        const state = this.contracts.get(bar.contractId);
        if (state) state.lastBar = Math.max(state.lastBar ?? 0, bar.minute);
      }
      this.ticks = [];
      this.storedId = this.readId;
      this.waiting = 0;
      this.lastError = null;
      this.lastFlushIso = new Date(now).toISOString();
    }
    this.lastFlushAt = now;
    this.lastFlushMinute = Math.floor(now / MINUTE_MS);
    const keepFrom = windowStart(now);
    for (const state of this.contracts.values()) {
      for (const minute of [...state.bars.keys()]) {
        if (minute < keepFrom) state.bars.delete(minute);
      }
    }
  }

  // -- status ------------------------------------------------------------ //

  status() {
    const now = this.deps.now();
    const wallMinute = Math.floor(now / MINUTE_MS);
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    return {
      enabled: this.enabled,
      running: this.running,
      degraded: this.lagSeconds > LAG_DEGRADED_SECONDS || this.retryAt > now,
      stream_length: this.streamLength,
      lag_seconds: this.lagSeconds,
      waiting: this.waiting,
      cursor: this.storedId,
      last_flush: this.lastFlushIso,
      last_error: this.lastError ?? this.setError,
      poll_seconds: this.pollSeconds,
      totals: { ...this.totals },
      contracts: [...this.contracts.values()].map((s) => ({
        contract_id: s.target.contractId,
        platform: s.target.platform,
        account: s.target.account,
        symbol: s.target.symbol,
        ticks: s.target.ticks,
        mode: s.mode,
        last_quote: iso(s.lastQuote),
        last_bar: iso(s.lastBar),
        quotes_last_minute:
          s.bucketMinute === wallMinute
            ? s.previousBucket
            : s.bucketMinute === wallMinute - 1
              ? s.bucket
              : 0,
        error: s.error,
      })),
    };
  }
}

function windowStart(now: number): number {
  return (Math.floor(now / MINUTE_MS) - WINDOW_MINUTES) * MINUTE_MS;
}

function newState(target: RecordTarget): ContractState {
  return {
    target,
    bars: new Map(),
    lastQuote: null,
    lastBar: null,
    bucketMinute: 0,
    bucket: 0,
    previousBucket: 0,
    prevLast: null,
    prevLastSize: null,
    mode: null,
    error: null,
  };
}

// --------------------------------------------------------------------------- //
// Defaults: the real Redis, database and broker service
// --------------------------------------------------------------------------- //

/** The recorder's own Redis connection: a blocking read would hold up any
 *  other use of a shared one. */
function redisClient(): RecorderRedis {
  const client = createClient({
    socket: { host: REDIS_HOST, port: REDIS_PORT },
    password: REDIS_PASSWORD,
  });
  client.on('error', () => undefined);
  return {
    connect: async () => {
      await client.connect();
    },
    read: async (id, count, blockMs) => {
      const res = await client.xRead({ key: QUOTE_STREAM, id }, { COUNT: count, BLOCK: blockMs });
      return (res?.[0]?.messages ?? []).map((m) => ({ id: m.id, fields: m.message }));
    },
    lastId: async () => {
      const res = await client.xRevRange(QUOTE_STREAM, '+', '-', { COUNT: 1 });
      return res[0]?.id ?? null;
    },
    length: () => client.xLen(QUOTE_STREAM),
    close: async () => {
      await client.disconnect();
    },
  };
}

export const TARGETS_SQL = `
  SELECT c.id AS contract_id, c.broker, c.broker_account, c.symbol, c.sec_type, c.exchange,
         c.currency, bool_or(dcc.record_ticks) AS ticks
    FROM data_collection_config dcc
    JOIN contracts c ON c.id = dcc.contract_id
   WHERE dcc.enabled AND dcc.record_live
   GROUP BY c.id
   ORDER BY c.id`;

export const BARS_SQL = `
  INSERT INTO candlestick_data
         (contract_id, timestamp, timeframe, open, high, low, close, volume, count, source)
  SELECT c, to_timestamp(t / 1000.0), '1min', o, h, l, cl, v, n, 'stream'
    FROM unnest($1::int[], $2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[],
                $6::numeric[], $7::bigint[], $8::int[]) AS b(c, t, o, h, l, cl, v, n)
  ON CONFLICT (contract_id, timestamp, timeframe) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume, count = EXCLUDED.count
   WHERE candlestick_data.source = 'stream'`;

export const TICKS_SQL = `
  INSERT INTO quote_ticks (contract_id, ts, bid, ask, last, last_size, recv_ts)
  SELECT c, to_timestamp(t / 1000.0), b, a, l, s, to_timestamp(r / 1000.0)
    FROM unnest($1::int[], $2::bigint[], $3::float8[], $4::float8[], $5::float8[],
                $6::float8[], $7::bigint[]) AS q(c, t, b, a, l, s, r)`;

export const CURSOR_SQL = `
  INSERT INTO recorder_cursor (id, last_entry_id, updated_at) VALUES (TRUE, $1, NOW())
  ON CONFLICT (id) DO UPDATE SET last_entry_id = EXCLUDED.last_entry_id, updated_at = NOW()`;

/** One transaction for the bars, the quotes and the cursor. */
export async function storeFlush(
  batch: Flush,
  transaction: <T>(cb: (client: PoolClient) => Promise<T>) => Promise<T> = (cb) =>
    dbService.transaction(cb)
): Promise<void> {
  await transaction(async (client) => {
    if (batch.bars.length) {
      const b = batch.bars;
      await client.query(BARS_SQL, [
        b.map((x) => x.contractId),
        b.map((x) => Math.round(x.minute)),
        b.map((x) => x.open),
        b.map((x) => x.high),
        b.map((x) => x.low),
        b.map((x) => x.close),
        b.map((x) => Math.round(x.volume)),
        b.map((x) => x.count),
      ]);
    }
    if (batch.ticks.length) {
      const t = batch.ticks;
      await client.query(TICKS_SQL, [
        t.map((x) => x.contractId),
        t.map((x) => Math.round(x.ts)),
        t.map((x) => x.bid),
        t.map((x) => x.ask),
        t.map((x) => x.last),
        t.map((x) => x.lastSize),
        t.map((x) => Math.round(x.recvTs)),
      ]);
    }
    await client.query(CURSOR_SQL, [batch.cursor]);
  });
}

function defaultDeps(): RecorderDeps {
  return {
    redis: redisClient,
    targets: async () => {
      const { rows } = await dbService.query(TARGETS_SQL);
      return rows.map((r) => ({
        contractId: Number(r.contract_id),
        platform: r.broker,
        account: r.broker_account || 'default',
        symbol: r.symbol,
        secType: r.sec_type,
        exchange: r.exchange ?? null,
        currency: r.currency ?? null,
        ticks: Boolean(r.ticks),
      }));
    },
    loadCursor: async () => {
      const { rows } = await dbService.query(`SELECT last_entry_id FROM recorder_cursor`);
      return rows[0]?.last_entry_id ?? null;
    },
    loadBars: async (sinceMs) => {
      const { rows } = await dbService.query(
        `SELECT contract_id, timestamp, open, high, low, close, volume, count
           FROM candlestick_data
          WHERE timeframe = '1min' AND source = 'stream' AND timestamp >= to_timestamp($1 / 1000.0)`,
        [sinceMs]
      );
      return rows.map((r) => ({
        contractId: Number(r.contract_id),
        minute: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume ?? 0),
        count: Number(r.count ?? 0),
      }));
    },
    flush: (batch) => storeFlush(batch),
    sendRecorded: async (targets) => {
      const res = await axios.put(
        `${BROKER_SERVICE_URL}/market-data/stream/recorded`,
        {
          instruments: targets.map((t) => ({
            platform: t.platform,
            // 'default' on a contract means the broker's default account.
            account: t.account === 'default' ? undefined : t.account,
            symbol: t.symbol,
            secType: t.secType,
            exchange: t.exchange ?? undefined,
            currency: t.currency ?? undefined,
          })),
        },
        { timeout: 30_000 }
      );
      return res.data as RecordedAnswer;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The app's recorder; `index.ts` starts it and the routes read its status. */
export const liveRecorder = new LiveRecorder();
