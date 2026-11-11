/**
 * The bars a backtest runs on, read from the database (E-02).
 *
 * A backtest names an instrument, a timeframe and a range. This finds the
 * contract the bars are stored under, says how well the stored bars cover the
 * range, can fetch what is missing from the broker and store it, and loads
 * the bars with a hash of exactly what was loaded, so a run can be repeated
 * on the same data and shown to have been.
 *
 * The backend sends the bars to the broker service with the run; the broker
 * service never reads the database.
 *
 * Built bars (E-08): migration 008 keeps 5-minute to daily bars built from
 * the stored 1-minute bars. A backtest on 5 minutes to 1 hour can run on
 * those, so an instrument recorded at 1 minute needs no other timeframe
 * collected. Which kind a run prefers is `PREFER`; the run records which it
 * used (`built_from`).
 */
import { createHash } from 'crypto';

import type { Querier } from './backtestRunRepository.js';
import type { CandlestickBar, Contract } from './marketDataService.js';
import type { HistoryRequest, RawBar } from './backfillScheduler.js';

const DAY_MS = 86_400_000;
/** A hole in stored bars longer than this is reported as missing. Shorter
 *  ones are weekends and holidays, which no broker has bars for. */
export const GAP_DAYS = 5;
/** The most bars one run may load: over 5 years of 1-minute FX. */
export const MAX_BARS = 2_000_000;
const MAX_GAPS = 50;

/** The view of bars built from 1-minute bars, per timeframe (migration 008). */
export const BUILT_VIEWS: Record<string, string> = {
  '5min': 'bars_5min',
  '15min': 'bars_15min',
  '30min': 'bars_30min',
  '1hour': 'bars_1hour',
  '4hour': 'bars_4hour',
  '1day': 'bars_1day',
};
/**
 * The timeframes a backtest may run on built bars. Built bars start on UTC
 * boundaries, which is where every broker starts these. A broker's 4-hour and
 * daily bars follow its server or session time, so a built one is a different
 * bar from the one a live strategy sees; those two are never substituted.
 */
export const BUILT_FOR_BACKTESTS = new Set(['5min', '15min', '30min', '1hour']);
/**
 * Which bars a backtest uses when both kinds cover its range: the broker's
 * own for the timeframe (what a live strategy reads), or the built ones.
 * Either way the other kind is used when the preferred one has holes.
 */
export const PREFER: 'broker' | 'built' = 'broker';

export class BacktestDataError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface DataRange {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface Instrument {
  broker: string;
  /** Undefined: whichever account the instrument's bars are stored under. */
  account?: string;
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
}

export interface MissingRange {
  from: string;
  to: string;
}

export interface Coverage {
  contract_id: number | null;
  timeframe: string;
  requested: { start: string; end: string };
  bars: number;
  first_bar: string | null;
  last_bar: string | null;
  /** Stretches longer than GAP_DAYS with no stored bar. */
  missing: MissingRange[];
  complete: boolean;
  /** Set when this describes the 1-minute bars the timeframe's bars would be
   *  built from; `bars` then counts 1-minute bars. */
  built_from?: '1min';
  /** How many of the bars carry the broker's bid-to-ask spread (E-15). */
  spread_bars?: number;
}

/** Bars as the broker service takes them: one array per field, oldest first. */
export interface BarColumns {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /**
   * The bid-to-ask spread on each bar, null where it is not known. Present
   * only when at least one bar has one, so bars without spreads look (and
   * hash) exactly as they did before spreads were stored.
   */
  s?: Array<number | null>;
}

/** Seconds in one bar of each timeframe a replay can show. */
export const REPLAY_SECONDS: Record<string, number> = {
  '1min': 60,
  '5min': 300,
  '15min': 900,
  '30min': 1800,
  '1hour': 3600,
  '4hour': 14_400,
  '1day': 86_400,
};
/** The most 1-minute bars one replay loads: about five weeks of FX. */
export const REPLAY_MAX_MINUTES = 50_000;
/** Bars shown before the replay starts, for context. */
export const REPLAY_HISTORY_BARS = 300;

/** What a bar replay plays (E-04). */
export interface ReplayBars {
  contract_id: number;
  timeframe: string;
  /** Where the replay starts: the asked-for time, moved back to the start of
   *  its bar so the first candle forms whole. */
  start: string;
  /** Bars of the timeframe before `start`, oldest first. */
  history: BarColumns;
  /** The 1-minute bars from `start`, oldest first. */
  minutes: BarColumns;
  /** True when more 1-minute bars are stored after the last one sent. */
  more: boolean;
  /** The first and last 1-minute bar stored for the instrument at all. */
  stored: { first: string | null; last: string | null };
}

export interface LoadedBars {
  bars: BarColumns;
  count: number;
  first_bar: string | null;
  last_bar: string | null;
  /** sha256 of the loaded rows; the same bars always give the same hash. */
  hash: string;
}

const PERIOD_DAYS: Record<string, number> = { D: 1, W: 7, M: 30.4375, Y: 365.25 };

/**
 * The range a request means: both dates (YYYY-MM-DD, end exclusive), or a
 * period such as 6M or 2Y counted back from now.
 */
export function resolveRange(
  input: { period?: unknown; start_date?: unknown; end_date?: unknown },
  now = new Date()
): DataRange {
  const { start_date: from, end_date: to } = input;
  if (from || to) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (typeof from !== 'string' || typeof to !== 'string' || !day.test(from) || !day.test(to)) {
      throw new BacktestDataError('start_date and end_date must both be dates, YYYY-MM-DD.');
    }
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BacktestDataError('start_date and end_date must both be dates, YYYY-MM-DD.');
    }
    if (start >= end) throw new BacktestDataError('start_date must be before end_date.');
    return { start, end: end > now ? now : end };
  }
  const period = String(input.period || '1Y').toUpperCase();
  const m = /^(\d{1,3})([DWMY])$/.exec(period);
  if (!m || Number(m[1]) === 0) {
    throw new BacktestDataError('period must be a number and D, W, M or Y, such as 6M or 2Y.');
  }
  const days = Number(m[1]) * PERIOD_DAYS[m[2]];
  return { start: new Date(now.getTime() - Math.round(days * DAY_MS)), end: now };
}

/** The hash of a set of bars: every field of every row, in order. */
export function barsHash(bars: BarColumns): string {
  const hash = createHash('sha256');
  for (let i = 0; i < bars.t.length; i++) {
    const spread = bars.s ? `,${bars.s[i] ?? ''}` : '';
    hash.update(
      `${bars.t[i]},${bars.o[i]},${bars.h[i]},${bars.l[i]},${bars.c[i]},${bars.v[i]}${spread}\n`
    );
  }
  return hash.digest('hex');
}

/** Rows of t, o, h, l, c, v as one array per field. */
function columns(rows: Array<Record<string, unknown>>): BarColumns {
  const bars: BarColumns = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const r of rows) {
    bars.t.push(Number(r.t));
    bars.o.push(Number(r.o));
    bars.h.push(Number(r.h));
    bars.l.push(Number(r.l));
    bars.c.push(Number(r.c));
    bars.v.push(Number(r.v ?? 0));
  }
  if (rows.some((r) => r.s != null)) {
    bars.s = rows.map((r) => (r.s == null ? null : Number(r.s)));
  }
  return bars;
}

export interface BacktestDataDeps {
  db: Querier;
  getOrCreateContract(contract: Contract): Promise<number>;
  fetchHistory(req: HistoryRequest): Promise<RawBar[]>;
  storeCandlestickData(
    contractId: number,
    timeframe: string,
    bars: CandlestickBar[]
  ): Promise<{ inserted: number; updated: number; errors: number }>;
  /** Whole days one broker request should span for this timeframe. */
  chunkDays(timeframe: string): number;
}

interface ContractRow {
  id: number;
  account: string;
  secType: string;
  exchange: string | null;
  currency: string | null;
}

export class BacktestData {
  constructor(private readonly deps: BacktestDataDeps) {}

  /**
   * The contract an instrument's bars are stored under. The backtest form's
   * type, exchange and currency rarely match how the instrument was first
   * stored (a collected OANDA pair is CASH with no exchange), so the match is
   * on broker, symbol and, when given, account; among several, the one with
   * the most bars in the range wins.
   */
  private async findContract(
    inst: Instrument,
    timeframe: string,
    range: DataRange
  ): Promise<ContractRow | null> {
    const { rows } = await this.deps.db.query(
      `SELECT c.id, c.broker_account, c.sec_type, c.exchange, c.currency,
              (SELECT count(*) FROM candlestick_data cd
                WHERE cd.contract_id = c.id AND cd.timeframe = $4
                  AND cd.timestamp >= $5 AND cd.timestamp < $6) AS bars
         FROM contracts c
        WHERE c.broker = $1 AND c.symbol = $2 AND ($3::text IS NULL OR c.broker_account = $3)
        ORDER BY bars DESC, (c.sec_type = $7) DESC, c.id
        LIMIT 1`,
      [
        inst.broker,
        inst.symbol.toUpperCase(),
        inst.account ?? null,
        timeframe,
        range.start,
        range.end,
        inst.secType,
      ]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      account: r.broker_account,
      secType: r.sec_type,
      exchange: r.exchange ?? null,
      currency: r.currency ?? null,
    };
  }

  /**
   * How well stored bars cover a range, for the kind of bars a run would use:
   * the preferred kind when it covers the range, the other kind when only
   * that one does, and otherwise the broker's own (the kind a fetch fills).
   */
  async coverage(
    inst: Instrument,
    timeframe: string,
    range: DataRange,
    prefer: 'broker' | 'built' = PREFER
  ): Promise<Coverage> {
    const own = await this.ownCoverage(inst, timeframe, range);
    if (!BUILT_FOR_BACKTESTS.has(timeframe)) return own;
    if (prefer === 'broker' && own.complete) return own;
    const built = await this.builtCoverage(inst, timeframe, range);
    if (built.complete) return built;
    return own;
  }

  /** Coverage by the broker's own bars for the timeframe. */
  private async ownCoverage(
    inst: Instrument,
    timeframe: string,
    range: DataRange
  ): Promise<Coverage> {
    const contract = await this.findContract(inst, timeframe, range);
    return this.coverageOf(contract?.id ?? null, timeframe, range);
  }

  /** Coverage by the 1-minute bars a timeframe's bars are built from. */
  private async builtCoverage(
    inst: Instrument,
    timeframe: string,
    range: DataRange
  ): Promise<Coverage> {
    const contract = await this.findContract(inst, '1min', range);
    const base = await this.coverageOf(contract?.id ?? null, '1min', range);
    return { ...base, timeframe, built_from: '1min' };
  }

  private async coverageOf(
    contractId: number | null,
    timeframe: string,
    range: DataRange
  ): Promise<Coverage> {
    const requested = { start: range.start.toISOString(), end: range.end.toISOString() };
    const whole = [{ from: requested.start, to: requested.end }];
    if (contractId === null) {
      return {
        contract_id: null,
        timeframe,
        requested,
        bars: 0,
        first_bar: null,
        last_bar: null,
        missing: whole,
        complete: false,
      };
    }
    const where = `contract_id = $1 AND timeframe = $2 AND timestamp >= $3 AND timestamp < $4`;
    const params = [contractId, timeframe, range.start, range.end];
    const summary = await this.deps.db.query(
      `SELECT count(*)::int AS bars, min(timestamp) AS first, max(timestamp) AS last
         FROM candlestick_data WHERE ${where}`,
      params
    );
    const { bars, first, last } = summary.rows[0] ?? { bars: 0, first: null, last: null };
    if (!bars) {
      return {
        contract_id: contractId,
        timeframe,
        requested,
        bars: 0,
        first_bar: null,
        last_bar: null,
        missing: whole,
        complete: false,
      };
    }
    const holes = await this.deps.db.query(
      `SELECT prev, ts FROM (
         SELECT timestamp AS ts, lag(timestamp) OVER (ORDER BY timestamp) AS prev
           FROM candlestick_data WHERE ${where}) g
        WHERE ts - prev > make_interval(days => $5::int)
        ORDER BY ts
        LIMIT ${MAX_GAPS}`,
      [...params, GAP_DAYS]
    );
    const firstMs = new Date(first).getTime();
    const lastMs = new Date(last).getTime();
    const gap = GAP_DAYS * DAY_MS;
    const missing: MissingRange[] = [];
    if (firstMs - range.start.getTime() > gap) {
      missing.push({ from: requested.start, to: new Date(firstMs).toISOString() });
    }
    for (const h of holes.rows) {
      missing.push({ from: new Date(h.prev).toISOString(), to: new Date(h.ts).toISOString() });
    }
    if (range.end.getTime() - lastMs > gap) {
      missing.push({ from: new Date(lastMs).toISOString(), to: requested.end });
    }
    return {
      contract_id: contractId,
      timeframe,
      requested,
      bars: Number(bars),
      first_bar: new Date(firstMs).toISOString(),
      last_bar: new Date(lastMs).toISOString(),
      missing,
      complete: missing.length === 0,
    };
  }

  /**
   * Fetches every missing stretch from the broker and stores it, a chunk at a
   * time, then says what is covered now. A stretch the broker has no bars for
   * (it predates the broker's history) stays missing.
   *
   * With `all`, the whole range is fetched again whatever is stored: the
   * broker's bars replace the stored ones, which is how bars stored before
   * spreads were kept (E-15) gain theirs.
   */
  async fetchMissing(
    inst: Instrument,
    timeframe: string,
    range: DataRange,
    opts: { all?: boolean } = {}
  ): Promise<Coverage> {
    if (!opts.all) {
      const chosen = await this.coverage(inst, timeframe, range);
      if (chosen.complete) return chosen;
    }
    let contract = await this.findContract(inst, timeframe, range);
    const before = await this.coverageOf(contract?.id ?? null, timeframe, range);
    const stretches = opts.all
      ? [{ from: range.start.toISOString(), to: range.end.toISOString() }]
      : before.missing;

    if (!contract) {
      const account = inst.account ?? 'default';
      // Stored as the data collection table stores it, so both use one contract.
      const exchange = inst.broker === 'ib' ? inst.exchange : undefined;
      const id = await this.deps.getOrCreateContract({
        broker: inst.broker,
        brokerAccount: account,
        symbol: inst.symbol.toUpperCase(),
        secType: inst.secType,
        exchange,
        currency: inst.currency,
      });
      contract = {
        id,
        account,
        secType: inst.secType,
        exchange: exchange ?? null,
        currency: inst.currency ?? null,
      };
    }

    const chunkMs = this.deps.chunkDays(timeframe) * DAY_MS;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    for (const stretch of stretches) {
      // Whole UTC days, end exclusive, as the history route takes them.
      const from = Math.floor(new Date(stretch.from).getTime() / DAY_MS) * DAY_MS;
      const to = Math.ceil(new Date(stretch.to).getTime() / DAY_MS) * DAY_MS;
      for (let start = from; start < to; start += chunkMs) {
        const end = Math.min(to, start + chunkMs);
        const raw = await this.deps.fetchHistory({
          broker: inst.broker,
          brokerAccount: contract.account,
          symbol: inst.symbol.toUpperCase(),
          timeframe,
          period: 'CUSTOM',
          secType: contract.secType,
          exchange: contract.exchange || undefined,
          currency: contract.currency || undefined,
          startDate: day(start),
          endDate: day(end),
        });
        if (raw.length) {
          await this.deps.storeCandlestickData(
            contract.id,
            timeframe,
            raw.map((b) => ({
              timestamp: new Date(b.timestamp * 1000),
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              wap: b.wap,
              spread: b.spread,
              count: b.count,
            }))
          );
        }
      }
    }
    return this.coverageOf(contract.id, timeframe, range);
  }

  /**
   * The stored bars of a contract in a range, oldest first, with their hash.
   * With `builtFrom`, the bars built from the contract's 1-minute bars.
   */
  async load(
    contractId: number,
    timeframe: string,
    range: DataRange,
    builtFrom?: '1min'
  ): Promise<LoadedBars> {
    const fields = `open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c,
              volume::float8 AS v`;
    let rows: Array<Record<string, unknown>>;
    if (builtFrom) {
      const view = BUILT_VIEWS[timeframe];
      if (!view) throw new BacktestDataError(`No built bars for timeframe ${timeframe}.`);
      await this.refreshBuilt(view, range);
      ({ rows } = await this.deps.db.query(
        `SELECT extract(epoch FROM bucket)::bigint AS t, ${fields}
           FROM ${view}
          WHERE contract_id = $1 AND bucket >= $2 AND bucket < $3
          ORDER BY bucket
          LIMIT ${MAX_BARS + 1}`,
        [contractId, range.start, range.end]
      ));
    } else {
      ({ rows } = await this.deps.db.query(
        `SELECT extract(epoch FROM timestamp)::bigint AS t, ${fields}, spread::float8 AS s
           FROM candlestick_data
          WHERE contract_id = $1 AND timeframe = $2 AND timestamp >= $3 AND timestamp < $4
          ORDER BY timestamp
          LIMIT ${MAX_BARS + 1}`,
        [contractId, timeframe, range.start, range.end]
      ));
    }
    if (rows.length > MAX_BARS) {
      throw new BacktestDataError(
        `That range holds more than ${MAX_BARS.toLocaleString('en-US')} bars. Shorten the range or use a longer timeframe.`
      );
    }
    const bars = columns(rows);
    const iso = (s: number | undefined) =>
      s === undefined ? null : new Date(s * 1000).toISOString();
    return {
      bars,
      count: bars.t.length,
      first_bar: iso(bars.t[0]),
      last_bar: iso(bars.t[bars.t.length - 1]),
      hash: barsHash(bars),
    };
  }

  /**
   * The stored 1-minute bars of an instrument in a range, for filling a stop
   * inside each bar of a longer timeframe (E-03). Null when none are stored;
   * holes are fine, because a bar with no minutes fills on its own range.
   */
  async minutes(inst: Instrument, range: DataRange): Promise<LoadedBars | null> {
    const contract = await this.findContract(inst, '1min', range);
    if (!contract) return null;
    const loaded = await this.load(contract.id, '1min', range);
    return loaded.count ? loaded : null;
  }

  /**
   * The bars for a bar replay (E-04): the stored 1-minute bars from `start`,
   * which the page plays one at a time, and the bars of the timeframe before
   * it for context. Those come from the views built from the same 1-minute
   * bars, on the same UTC boundaries the page forms its candles on, so the
   * replayed candles continue the history exactly.
   */
  async replay(
    inst: Instrument,
    timeframe: string,
    start: Date,
    limit = REPLAY_MAX_MINUTES
  ): Promise<ReplayBars> {
    const seconds = REPLAY_SECONDS[timeframe];
    if (!seconds) {
      throw new BacktestDataError(
        `A replay can show ${Object.keys(REPLAY_SECONDS).join(', ')}; not ${timeframe}.`
      );
    }
    if (Number.isNaN(start.getTime())) {
      throw new BacktestDataError('start must be a date and time.');
    }
    const count = Math.max(1, Math.min(REPLAY_MAX_MINUTES, Math.floor(limit) || 1));
    const from = new Date(Math.floor(start.getTime() / (seconds * 1000)) * seconds * 1000);
    const where = `${inst.symbol.toUpperCase()} at ${inst.broker}`;

    // The contract with the most 1-minute bars in the stretch about to play.
    const contract = await this.findContract(inst, '1min', {
      start: from,
      end: new Date(from.getTime() + 60 * DAY_MS),
    });
    if (!contract) {
      throw new BacktestDataError(`No 1 minute bars are stored for ${where}.`, 404);
    }
    const span = await this.deps.db.query(
      `SELECT min(timestamp) AS first, max(timestamp) AS last
         FROM candlestick_data WHERE contract_id = $1 AND timeframe = '1min'`,
      [contract.id]
    );
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    const stored = { first: iso(span.rows[0]?.first), last: iso(span.rows[0]?.last) };

    const fields = `open::float8 AS o, high::float8 AS h, low::float8 AS l, close::float8 AS c,
              volume::float8 AS v`;
    const minuteRows = await this.deps.db.query(
      `SELECT extract(epoch FROM timestamp)::bigint AS t, ${fields}
         FROM candlestick_data
        WHERE contract_id = $1 AND timeframe = '1min' AND timestamp >= $2
        ORDER BY timestamp
        LIMIT ${count + 1}`,
      [contract.id, from]
    );
    if (!minuteRows.rows.length) {
      const day = (v: string | null) => (v ? v.slice(0, 10) : '?');
      throw new BacktestDataError(
        stored.first
          ? `No 1 minute bars are stored for ${where} from ${from.toISOString().slice(0, 16).replace('T', ' ')} UTC. They are stored from ${day(stored.first)} to ${day(stored.last)}.`
          : `No 1 minute bars are stored for ${where}.`,
        404
      );
    }

    const view = BUILT_VIEWS[timeframe];
    const historyRows = view
      ? await this.deps.db.query(
          `SELECT extract(epoch FROM bucket)::bigint AS t, ${fields}
             FROM ${view}
            WHERE contract_id = $1 AND bucket < $2
            ORDER BY bucket DESC
            LIMIT ${REPLAY_HISTORY_BARS}`,
          [contract.id, from]
        )
      : await this.deps.db.query(
          `SELECT extract(epoch FROM timestamp)::bigint AS t, ${fields}
             FROM candlestick_data
            WHERE contract_id = $1 AND timeframe = '1min' AND timestamp < $2
            ORDER BY timestamp DESC
            LIMIT ${REPLAY_HISTORY_BARS}`,
          [contract.id, from]
        );

    const more = minuteRows.rows.length > count;
    return {
      contract_id: contract.id,
      timeframe,
      start: from.toISOString(),
      history: columns([...historyRows.rows].reverse()),
      minutes: columns(more ? minuteRows.rows.slice(0, count) : minuteRows.rows),
      more,
      stored,
    };
  }

  /**
   * Brings a view up to date over a range before it is read. The view computes
   * recent bars on the fly, but 1-minute bars stored or replaced further back
   * (a backfill, the nightly reconcile) only show once that stretch is
   * refreshed, which the view's own policy does on a schedule. A refresh with
   * nothing to do returns at once. It cannot run inside a transaction.
   */
  private async refreshBuilt(view: string, range: DataRange): Promise<void> {
    // Whole UTC days cover whole buckets of every timeframe.
    const from = Math.floor(range.start.getTime() / DAY_MS) * DAY_MS;
    const to = (Math.floor(range.end.getTime() / DAY_MS) + 1) * DAY_MS;
    await this.deps.db.query(
      `CALL refresh_continuous_aggregate('${view}', $1::timestamptz, $2::timestamptz)`,
      [new Date(from), new Date(to)]
    );
  }
}
