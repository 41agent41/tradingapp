/**
 * Strategy runner (Systematic Trading roadmap — Phase 2 / A2 + Phase 3 / A3).
 *
 * For every `status='running'` strategy run, on a timer, pull the latest
 * closed bars for the run's symbol/timeframe, ask the IB service to evaluate
 * the rule-set against the newest bar (threading the run's current position),
 * persist the resulting signal and fan it out over Socket.IO.
 *
 * A3 adds execution: a newly-recorded **actionable** signal is handed to the
 * `ExecutionEngine`, which (behind the `SYSTEMATIC_EXECUTION_ENABLED` gate and
 * a battery of fail-closed risk caps) maps it to a gated, audited **paper**
 * order through the shared order path and links it back to the signal row.
 * Both gates default off, so with only `SYSTEMATIC_ENABLED=true` the runner is
 * still strictly signal-only.
 *
 *   strategy_runs (running) ─▶ runner ─▶ broker_service /market-data/history
 *                                            │
 *                                            ▼
 *                             broker_service /strategies/evaluate  ─▶ {signal,…}
 *                                            │
 *                                            ▼
 *                      strategy_signals (dedupe: one per closed bar)
 *                                            │
 *                                            ▼
 *                        Socket.IO room  strategy:<runId>
 *
 * Design mirrors `backfillScheduler.ts`: opt-in (`SYSTEMATIC_ENABLED`), a
 * non-overlapping timer, and fully-injected dependencies so the orchestration
 * is unit-testable with no DB, IB Gateway or network.
 */

import axios from 'axios';
import { logger } from './logger.js';
import { dbService } from './database.js';
import { StrategyRepository, type ActiveRun, type StagingGroup } from './strategyRepository.js';
import { ExecutionRepository } from './executionRepository.js';
import { submitCreateOrder } from './orderService.js';
import { isSystematicExecutionEnabled, systematicMaxOrdersPerDay } from './orderTypes.js';
import type { InstrumentSpec } from './orderSizing.js';
import {
  DEFAULT_BROKER_ACCOUNT,
  connectionLabel,
  connectionOf,
  type Connection,
} from './orderTypes.js';
import { ExecutionEngine, type ExecutionContext, type ExecutionResult } from './executionEngine.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

const SYSTEMATIC_ENABLED = (process.env.SYSTEMATIC_ENABLED ?? 'false').toLowerCase() === 'true';
const SYSTEMATIC_INTERVAL_SECONDS = Math.max(
  5,
  parseInt(process.env.SYSTEMATIC_INTERVAL_SECONDS || '60', 10) || 60
);
const SYSTEMATIC_INITIAL_DELAY_MS = Math.max(
  0,
  parseInt(process.env.SYSTEMATIC_INITIAL_DELAY_MS || '15000', 10) || 15000
);
// Connections are processed concurrently, bounded. Under ~10 connections this
// is ample; materially beyond that the runner wants a work-queue instead.
const SYSTEMATIC_MAX_CONNECTION_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.SYSTEMATIC_MAX_CONNECTION_CONCURRENCY || '4', 10) || 4
);
const SYSTEMATIC_BREAKER_THRESHOLD = Math.max(
  1,
  parseInt(process.env.SYSTEMATIC_CONNECTION_BREAKER_THRESHOLD || '3', 10) || 3
);
const SYSTEMATIC_BREAKER_COOLDOWN_SECONDS = Math.max(
  10,
  parseInt(process.env.SYSTEMATIC_CONNECTION_BREAKER_COOLDOWN_SECONDS || '300', 10) || 300
);
// Fractional lot sizes do not compare exactly, so the reconciliation check
// needs a tolerance rather than strict equality.
const RECONCILIATION_TOLERANCE = Number(process.env.POSITION_RECONCILIATION_TOLERANCE || '0.0001');
const POSITION_LOOKBACK_HOURS = Math.max(
  1,
  parseInt(process.env.ORDER_POSITION_LOOKBACK_HOURS || '168', 10) || 168
);

export interface RawBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PositionState {
  size: number;
  avg_price: number;
  /** What the app's own fills imply it holds, for the reconciliation check.
   *  Null when unavailable. Never used as the position itself (E-0). */
  derived_size?: number | null;
}

/** One position as the venue reports it. */
interface VenuePosition {
  size: number;
  avgPrice: number;
}

export interface EvaluateResult {
  signal: string; // 'buy' | 'sell' | 'none'
  entry: boolean;
  exit: boolean;
  entry_reason?: string;
  exit_reason?: string;
  in_session: boolean;
  bar_time: string;
}

export interface StrategySignalRecord {
  run_id: number;
  bar_time: string;
  signal: string;
  reason: string | null;
  entry: boolean;
  exit: boolean;
  in_session: boolean;
  position_size: number;
}

/** Everything the runner needs from the outside world. Defaults wire to the
 *  repository, the IB service over HTTP and the order-audit net exposure. */
export interface StrategyRunnerDeps {
  listActiveRuns(): Promise<ActiveRun[]>;
  /** Latest closed bars for the run's instrument, fetched from the run's own
   *  broker (`source=run.broker`) so an MT5/Alpaca/OANDA run never evaluates
   *  IB data, with the definition's sec_type/exchange/currency scoping the
   *  contract beyond default US stocks. */
  fetchHistory(run: ActiveRun): Promise<RawBar[]>;
  getPosition(run: ActiveRun): Promise<PositionState>;
  evaluate(
    bars: RawBar[],
    ruleSet: Record<string, unknown>,
    position: PositionState
  ): Promise<EvaluateResult>;
  latestSignalBarTime(runId: number): Promise<string | null>;
  insertSignal(record: StrategySignalRecord): Promise<{ inserted: boolean; id?: number | null }>;
  markEvaluated(runId: number, atIso: string): Promise<void>;
  markError(runId: number, error: string): Promise<void>;
  emit(runId: number, payload: Record<string, unknown>): void;
  now(): number;
  /** A3 execution: map an actionable signal to a gated, audited paper order.
   *  Optional so the signal-only path (and its tests) run without it. */
  executeSignal?(ctx: ExecutionContext): Promise<ExecutionResult>;
  /** C-3 staged deploy. Optional so a runner without groups behaves as before. */
  listStagingGroups?(): Promise<StagingGroup[]>;
  admitGroup?(groupId: number): Promise<number>;
  abandonGroup?(groupId: number, reason: string): Promise<number>;
}

export interface StrategyRunnerOptions {
  deps?: Partial<StrategyRunnerDeps>;
  enabled?: boolean;
  intervalSeconds?: number;
  initialDelayMs?: number;
  emit?: (runId: number, payload: Record<string, unknown>) => void;
  maxConnectionConcurrency?: number;
  breakerThreshold?: number;
  breakerCooldownSeconds?: number;
}

// Fetch a history window generous enough that the longest indicator (e.g.
// sma_50) and any higher-timeframe operand have plenty of warmup bars.
export function historyPeriodFor(timeframe: string): string {
  switch (timeframe) {
    case '1day':
      return '1Y';
    case '8hour':
    case '4hour':
      return '6M';
    case '1hour':
      return '1M';
    case 'tick':
      return '1D';
    default: // 1min / 5min / 15min / 30min
      return '10D';
  }
}

/** The symbol a run actually trades at its connection.
 *
 * A definition names a **canonical** instrument; each connection resolves that
 * to its own native symbol at deploy time (C-2) — EURUSD may be `EURUSD.a`
 * here and `EURUSD_i` on the next account. Runs created before C-2 have no
 * resolved symbol and fall back to the definition's, which is exactly the
 * single-connection behaviour they were created under.
 */
export function runSymbol(run: Pick<ActiveRun, 'symbol' | 'native_symbol'>): string {
  const native = (run.native_symbol ?? '').trim();
  return native || run.symbol;
}

function defaultDeps(
  emit: (runId: number, payload: Record<string, unknown>) => void
): StrategyRunnerDeps {
  const repo = new StrategyRepository(dbService);
  const executionRepo = new ExecutionRepository(dbService);
  const engine = new ExecutionEngine({
    executionEnabled: isSystematicExecutionEnabled,
    globalMaxOrdersPerDay: systematicMaxOrdersPerDay,
    getRunStatus: (id) => repo.getRunStatus(id),
    countOrdersToday: (id) => repo.countActedSignalsToday(id),
    countOrdersTodayAllRuns: () => repo.countActedSignalsTodayAllRuns(),
    submitOrder: (order, requestId) => submitCreateOrder(order, requestId),
    markActed: (signalId, orderAuditId) => repo.markSignalActed(signalId, orderAuditId),
    // Backs the `max_daily_loss` cap. Reads this run's own fills, so a second
    // run on the same symbol or a manual trade never consumes its budget.
    realisedPnlToday: async (runId) => (await executionRepo.realisedPnlTodayForRun(runId)).realised,
    // Backs `pct_equity` sizing, from the run's own connection.
    accountEquity: (connection) => venueEquity(connection),
    // Backs broker-native sizing: what one quantity unit means at this
    // connection and what sizes it accepts.
    instrumentSpec: (connection, symbol) => venueInstrumentSpec(connection, symbol),
  });
  // Venue caches, keyed per **connection** (platform + account), not per
  // platform. Two accounts on one platform have different equity, different
  // positions, and — because the same instrument carries a different suffix
  // and lot step at every broker — different instrument specs. Keying on the
  // platform alone would serve account A's numbers to account B (C-0).
  //
  // `/account/positions` costs a round-trip, so one fetch serves every run on
  // that connection inside a short window instead of one per run per tick.
  // Fail-soft — an unreachable or unconfigured connection just means avg_price
  // stays 0, exactly as this behaved before the endpoint became venue-aware.
  const positionCache = new Map<string, { at: number; bySymbol: Map<string, VenuePosition> }>();
  const POSITION_TTL_MS = 30_000;
  // Equity cache, same shape and rationale: one `/account/summary` round-trip
  // serves every equity-sized run on that connection inside a short window.
  // Fail-soft to null — the sizer then refuses with a reason rather than
  // sizing off an invented equity figure.
  const equityCache = new Map<string, { at: number; equity: number | null }>();
  const EQUITY_TTL_MS = 60_000;
  // Instrument specs barely change, so they are cached for far longer than
  // equity or average cost — a lot step is a property of the instrument at
  // that broker, not of the account balance.
  const specCache = new Map<string, { at: number; spec: InstrumentSpec | null }>();
  const SPEC_TTL_MS = 15 * 60_000;
  const venueInstrumentSpec = async (
    connection: Connection,
    symbol: string
  ): Promise<InstrumentSpec | null> => {
    const key = `${connectionLabel(connection.broker, connection.brokerAccount)}:${symbol.toUpperCase()}`;
    const cached = specCache.get(key);
    if (cached && Date.now() - cached.at <= SPEC_TTL_MS) return cached.spec;
    let spec: InstrumentSpec | null = null;
    try {
      const response = await axios.get(`${BROKER_SERVICE_URL}/instrument/spec`, {
        params: { broker: connection.broker, account: connection.brokerAccount, symbol },
        timeout: 30000,
        headers: { Connection: 'close' },
      });
      const data = response.data ?? {};
      spec = {
        unit: String(data.unit || 'shares'),
        minSize: Number(data.min_size) || 1,
        sizeStep: Number(data.size_step) || 1,
        maxSize: data.max_size == null ? null : Number(data.max_size),
        contractSize: Number(data.contract_size) || 1,
      };
    } catch {
      spec = null;
    }
    specCache.set(key, { at: Date.now(), spec });
    return spec;
  };
  const venueEquity = async (connection: Connection): Promise<number | null> => {
    const key = connectionLabel(connection.broker, connection.brokerAccount);
    const cached = equityCache.get(key);
    if (cached && Date.now() - cached.at <= EQUITY_TTL_MS) return cached.equity;
    let equity: number | null = null;
    try {
      const response = await axios.get(`${BROKER_SERVICE_URL}/account/summary`, {
        params: { broker: connection.broker, account: connection.brokerAccount },
        timeout: 30000,
        headers: { Connection: 'close' },
      });
      const value = Number(response.data?.net_liquidation);
      equity = Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      equity = null;
    }
    equityCache.set(key, { at: Date.now(), equity });
    return equity;
  };
  /** Every position the venue reports for a connection, keyed by symbol.
   *
   *  Throws rather than returning empty on failure. An unreachable venue is
   *  **not evidence of a flat account** — see `getPosition` below, where
   *  treating it as flat is the difference between holding a position and
   *  opening a second one on top of it. */
  const venuePositions = async (connection: Connection): Promise<Map<string, VenuePosition>> => {
    const key = connectionLabel(connection.broker, connection.brokerAccount);
    const cached = positionCache.get(key);
    if (cached && Date.now() - cached.at <= POSITION_TTL_MS) return cached.bySymbol;

    const response = await axios.get(`${BROKER_SERVICE_URL}/account/positions`, {
      params: { broker: connection.broker, account: connection.brokerAccount },
      timeout: 30000,
      headers: { Connection: 'close' },
    });
    const bySymbol = new Map<string, VenuePosition>();
    for (const pos of Array.isArray(response.data) ? response.data : []) {
      const symbol = String(pos?.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const size = Number(pos?.position);
      const cost = Number(pos?.average_cost);
      bySymbol.set(symbol, {
        size: Number.isFinite(size) ? size : 0,
        avgPrice: Number.isFinite(cost) && cost > 0 ? cost : 0,
      });
    }
    positionCache.set(key, { at: Date.now(), bySymbol });
    return bySymbol;
  };

  return {
    listActiveRuns: () => repo.listActiveRuns(),
    fetchHistory: async (run) => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/history`, {
        params: {
          // The connection's own name for the instrument (C-2). EURUSD is
          // EURUSD.a at one broker and EURUSD_i at the next, so fetching the
          // definition's canonical symbol would 404 — or worse, silently
          // return a different instrument's bars.
          symbol: runSymbol(run),
          timeframe: run.timeframe,
          period: historyPeriodFor(run.timeframe),
          secType: run.sec_type || 'STK',
          exchange: run.exchange || 'SMART',
          currency: run.currency || 'USD',
          source: run.broker || 'ib',
          account: run.broker_account || DEFAULT_BROKER_ACCOUNT,
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
      }));
    },
    getPosition: async (run) => {
      // **The venue is the source of truth** (Component E — E-0).
      //
      // This used to derive the position from the run's own recorded fills
      // plus its working orders, deliberately scoped by `runId` so a second
      // run on the same symbol could not interfere. Two things changed:
      //
      //  - E10 makes that isolation unnecessary — one strategy per instrument
      //    per account means the venue's net position for this connection and
      //    symbol *is* this run's position, with no attribution to do.
      //  - E-2 puts stops at the broker, so **the broker closes positions the
      //    app did not close**. A fills-derived figure counting only orders
      //    this run placed would never see that exit, and the run would keep
      //    trading against a position that no longer exists.
      //
      // It also means a manual intervention — closing a trade yourself in the
      // terminal — is picked up correctly on the next bar instead of
      // desynchronising the run.
      const connection = connectionOf(run);
      const symbol = runSymbol(run).toUpperCase();

      // No try/catch. An unreachable venue must **fail the evaluation**, not
      // report flat: flat is an actionable state that would let the strategy
      // open a position on top of one it already holds. The caller records the
      // error on the run and counts it against the connection's breaker.
      const positions = await venuePositions(connection);
      const venue = positions.get(symbol) ?? { size: 0, avgPrice: 0 };

      // Reconciliation, not authority. The fills-derived figure is what the
      // app *believes* it holds; a persistent disagreement means fills are
      // being missed — exactly the class of bug C-0 addressed — so it is
      // surfaced rather than silently reconciled away. Fail-soft: losing the
      // check must not stop trading on a position the venue reported fine.
      let derived: number | null = null;
      try {
        const size = await executionRepo.netPositionWithOpenOrders({
          broker: connection.broker,
          brokerAccount: connection.brokerAccount,
          symbol,
          accountMode: run.account_mode,
          runId: run.id,
          lookbackHours: POSITION_LOOKBACK_HOURS,
        });
        derived = Number.isFinite(size) ? size : null;
      } catch {
        derived = null;
      }

      return { size: venue.size, avg_price: venue.avgPrice, derived_size: derived };
    },
    evaluate: async (bars, ruleSet, position) => {
      const response = await axios.post(
        `${BROKER_SERVICE_URL}/strategies/evaluate`,
        { bars, rule_set: ruleSet, position },
        { timeout: 30000, headers: { Connection: 'close' } }
      );
      return response.data as EvaluateResult;
    },
    latestSignalBarTime: (runId) => repo.latestSignalBarTime(runId),
    insertSignal: async (record) => {
      const { inserted, row } = await repo.insertSignal(record);
      return { inserted, id: row?.id ?? null };
    },
    markEvaluated: (runId, atIso) => repo.markRunEvaluated(runId, atIso),
    markError: (runId, error) => repo.markRunError(runId, error),
    emit,
    now: () => Date.now(),
    executeSignal: (ctx) => engine.execute(ctx),
    listStagingGroups: () => repo.listStagingGroups(),
    admitGroup: (groupId) => repo.admitGroup(groupId),
    abandonGroup: (groupId, reason) => repo.abandonGroup(groupId, reason),
  };
}

export class StrategyRunner {
  private readonly deps: StrategyRunnerDeps;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;

  private readonly maxConnectionConcurrency: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  /** Consecutive failures and cooldown deadline, keyed by connection label. */
  private readonly breakers = new Map<string, { failures: number; openUntil: number }>();

  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  // Diagnostics.
  public runs = 0;
  public runsEvaluated = 0;
  public signalsRecorded = 0;
  public ordersPlaced = 0;
  public errors = 0;
  public skipped = 0;
  public groupsAdmitted = 0;
  public groupsAbandoned = 0;
  public positionDivergences = 0;
  /** Runs whose venue and fills-derived positions currently disagree. */
  private readonly divergentRuns = new Map<
    number,
    { connection: string; symbol: string; venue: number; derived: number }
  >();

  constructor(opts: StrategyRunnerOptions = {}) {
    const emit = opts.emit ?? (() => undefined);
    this.deps = { ...defaultDeps(emit), ...opts.deps } as StrategyRunnerDeps;
    this.enabled = opts.enabled ?? SYSTEMATIC_ENABLED;
    this.intervalMs = (opts.intervalSeconds ?? SYSTEMATIC_INTERVAL_SECONDS) * 1000;
    this.initialDelayMs = opts.initialDelayMs ?? SYSTEMATIC_INITIAL_DELAY_MS;
    this.maxConnectionConcurrency =
      opts.maxConnectionConcurrency ?? SYSTEMATIC_MAX_CONNECTION_CONCURRENCY;
    this.breakerThreshold = opts.breakerThreshold ?? SYSTEMATIC_BREAKER_THRESHOLD;
    this.breakerCooldownMs =
      (opts.breakerCooldownSeconds ?? SYSTEMATIC_BREAKER_COOLDOWN_SECONDS) * 1000;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  start(): void {
    if (!this.enabled) {
      logger.info(
        'systematic runner disabled via SYSTEMATIC_ENABLED (set SYSTEMATIC_ENABLED=true to enable)'
      );
      return;
    }
    if (this.started) return;
    this.started = true;
    logger.info(
      {
        interval_seconds: this.intervalMs / 1000,
        first_run_seconds: Math.round(this.initialDelayMs / 1000),
      },
      'systematic strategy runner enabled (signal-only)'
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

  // -------------------------------------------------------------------
  // Work
  // -------------------------------------------------------------------
  /** One evaluation pass over every running strategy. Never throws — per-run
   *  failures are isolated, counted and recorded on the run. */
  async runOnce(): Promise<void> {
    if (this.running) {
      logger.warn('previous systematic run still in progress — skipping this tick');
      return;
    }
    this.running = true;
    this.runs++;
    try {
      const activeRuns = await this.deps.listActiveRuns();
      await this.evaluateByConnection(activeRuns);
      // After evaluation, so a canary that just produced its first clean
      // decision can admit its siblings on the same tick rather than waiting
      // a full interval.
      await this.admitSettledGroups();
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, 'systematic run failed');
    } finally {
      this.lastRunAt = this.deps.now();
      this.running = false;
    }
  }

  /**
   * Evaluate every active run, grouped by connection (C-3 / C6).
   *
   * Connections run **concurrently**, bounded; runs within one connection run
   * **sequentially**. That split is the point: one MT5 sidecar is one terminal,
   * so hammering it in parallel helps nothing — but a sidecar that is powered
   * on and not answering (the common failure, since the terminal is a GUI app
   * that can sit at a login dialog) used to cost its full timeout *per run,
   * per tick*, with every other account's runs queued behind it. Three stuck
   * runs on the default 60s interval meant the healthy accounts stopped
   * evaluating altogether.
   */
  private async evaluateByConnection(runs: ActiveRun[]): Promise<void> {
    const byConnection = new Map<string, ActiveRun[]>();
    for (const run of runs) {
      const conn = connectionOf(run);
      const key = connectionLabel(conn.broker, conn.brokerAccount);
      const bucket = byConnection.get(key);
      if (bucket) bucket.push(run);
      else byConnection.set(key, [run]);
    }

    const queue = [...byConnection.entries()];
    const width = Math.max(1, Math.min(this.maxConnectionConcurrency, queue.length));

    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const [label, connectionRuns] = next;
        if (this.breakerIsOpen(label)) {
          this.skipped += connectionRuns.length;
          continue;
        }
        for (const run of connectionRuns) {
          await this.evaluateRun(run, label);
        }
      }
    };

    await Promise.all(Array.from({ length: width }, () => worker()));
  }

  /**
   * Compare what the venue says this run holds against what its own fills
   * imply (E-0).
   *
   * The venue is authoritative, so a mismatch never changes the position used
   * for the decision — it is a **signal that the fills feed is wrong**, which
   * is the class of bug that silently corrupts realised P&L and therefore the
   * `max_daily_loss` cap. Divergence is expected and benign in two cases: a
   * broker-side stop or take-profit closed the position (the app placed no
   * order, so no fill is attributed to the run), and a manual trade. Both are
   * worth seeing; neither is worth halting for, which is why this reports
   * rather than refuses.
   */
  private checkReconciliation(run: ActiveRun, position: PositionState, label: string): void {
    const derived = position.derived_size;
    if (derived == null) return;
    // A tolerance, because fractional lot sizes do not compare exactly.
    if (Math.abs(derived - position.size) <= RECONCILIATION_TOLERANCE) {
      this.divergentRuns.delete(run.id);
      return;
    }
    this.positionDivergences++;
    this.divergentRuns.set(run.id, {
      connection: label,
      symbol: runSymbol(run),
      venue: position.size,
      derived,
    });
    logger.warn(
      {
        run_id: run.id,
        connection: label,
        symbol: runSymbol(run),
        venue_position: position.size,
        fills_derived_position: derived,
      },
      'position reconciliation mismatch — venue is authoritative, fills feed may be incomplete'
    );
  }

  // -------------------------------------------------------------------
  // Per-connection circuit breaker
  // -------------------------------------------------------------------
  /** Whether this connection is currently being skipped, and for how long. */
  private breakerIsOpen(label: string): boolean {
    const state = this.breakers.get(label);
    if (!state || state.failures < this.breakerThreshold) return false;
    if (this.deps.now() >= state.openUntil) {
      // Cooldown elapsed — let one tick through to probe. Failures are not
      // reset yet: a still-broken connection re-opens immediately rather than
      // getting a fresh budget of full-timeout attempts every cooldown.
      return false;
    }
    return true;
  }

  private recordConnectionFailure(label: string): void {
    const state = this.breakers.get(label) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.breakerThreshold) {
      state.openUntil = this.deps.now() + this.breakerCooldownMs;
      logger.warn(
        { connection: label, failures: state.failures },
        'connection breaker open — skipping its runs until cooldown elapses'
      );
    }
    this.breakers.set(label, state);
  }

  private recordConnectionSuccess(label: string): void {
    if (this.breakers.has(label)) this.breakers.delete(label);
  }

  /**
   * Start the pending legs of any staging group whose canary has settled.
   *
   * The canary must have **evaluated at least once without error** and have
   * been running for `settle_seconds`. Both conditions matter: elapsed time
   * alone would admit a leg that started and immediately errored, and a clean
   * evaluation alone would admit before a full bar has closed on the slowest
   * timeframe in the group.
   *
   * A failed canary **abandons** the group rather than falling through to
   * admission — catching a bad edit before it reaches every account is the
   * entire purpose.
   */
  private async admitSettledGroups(): Promise<void> {
    if (!this.deps.listStagingGroups || !this.deps.admitGroup || !this.deps.abandonGroup) return;
    let groups;
    try {
      groups = await this.deps.listStagingGroups();
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, 'failed to list staging groups');
      return;
    }

    for (const group of groups) {
      try {
        if (group.pending_legs === 0) continue;

        if (group.canary_status !== 'running' || group.canary_last_error) {
          const reason =
            group.canary_last_error ??
            `canary run ${group.canary_run_id} is '${group.canary_status}', not running`;
          await this.deps.abandonGroup(group.id, `canary failed: ${reason}`);
          this.groupsAbandoned++;
          logger.warn({ group_id: group.id, reason }, 'run group abandoned — canary failed');
          continue;
        }

        if (!group.canary_last_evaluated_at) continue; // not yet evaluated once
        const elapsedMs = this.deps.now() - new Date(group.canary_started_at).getTime();
        if (elapsedMs < group.settle_seconds * 1000) continue;

        const started = await this.deps.admitGroup(group.id);
        this.groupsAdmitted++;
        logger.info({ group_id: group.id, legs_started: started }, 'run group admitted');
      } catch (err) {
        this.errors++;
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ group_id: group.id, err: this.lastError }, 'group admission failed');
      }
    }
  }

  private async evaluateRun(run: ActiveRun, connectionLabelOrNull?: string): Promise<void> {
    const label =
      connectionLabelOrNull ??
      connectionLabel(connectionOf(run).broker, connectionOf(run).brokerAccount);
    try {
      const bars = await this.deps.fetchHistory(run);
      if (!bars || bars.length === 0) {
        logger.warn({ run_id: run.id, symbol: runSymbol(run) }, 'no bars for strategy run');
        return;
      }

      const position = await this.deps.getPosition(run);
      this.checkReconciliation(run, position, label);
      const result = await this.deps.evaluate(bars, run.rule_set, position);

      // Dedupe: one decision per closed bar. Skip if we already recorded this
      // bar for the run (the timer can fire faster than the bar cadence).
      const latest = await this.deps.latestSignalBarTime(run.id);
      if (latest && new Date(latest).getTime() === new Date(result.bar_time).getTime()) {
        this.runsEvaluated++;
        await this.deps.markEvaluated(run.id, new Date(this.deps.now()).toISOString());
        return;
      }

      const reason =
        result.signal === 'buy'
          ? result.entry_reason || null
          : result.signal === 'sell'
            ? result.exit_reason || null
            : null;

      const { inserted, id } = await this.deps.insertSignal({
        run_id: run.id,
        bar_time: result.bar_time,
        signal: result.signal,
        reason,
        entry: result.entry,
        exit: result.exit,
        in_session: result.in_session,
        position_size: position.size,
      });

      this.runsEvaluated++;
      this.recordConnectionSuccess(label);
      await this.deps.markEvaluated(run.id, new Date(this.deps.now()).toISOString());

      if (inserted) {
        this.signalsRecorded++;

        // A3 execution: only newly-recorded, actionable (buy/sell) signals are
        // considered. Everything else short-circuits inside the engine, gated
        // and fail-closed; a per-signal failure is isolated like an eval error.
        let execution: ExecutionResult | null = null;
        const actionable = result.signal === 'buy' || result.signal === 'sell';
        if (actionable && this.deps.executeSignal) {
          try {
            execution = await this.deps.executeSignal({
              run,
              signalId: id ?? null,
              signal: result.signal,
              barTime: result.bar_time,
              position,
              lastBar: bars[bars.length - 1],
            });
            if (execution.placed) {
              this.ordersPlaced++;
              logger.info(
                {
                  run_id: run.id,
                  symbol: run.symbol,
                  action: execution.action,
                  quantity: execution.quantity,
                  order_audit_id: execution.orderAuditId,
                },
                'strategy order placed'
              );
            } else {
              logger.info(
                { run_id: run.id, symbol: run.symbol, reason: execution.reason },
                'strategy signal not executed'
              );
            }
          } catch (execErr) {
            this.errors++;
            const msg = execErr instanceof Error ? execErr.message : String(execErr);
            this.lastError = msg;
            execution = { placed: false, reason: `execution error: ${msg}` };
            logger.error({ run_id: run.id, err: msg }, 'strategy order execution failed');
          }
        }

        const payload = {
          run_id: run.id,
          symbol: run.symbol,
          timeframe: run.timeframe,
          bar_time: result.bar_time,
          signal: result.signal,
          reason,
          entry: result.entry,
          exit: result.exit,
          in_session: result.in_session,
          position_size: position.size,
          acted: execution?.placed ?? false,
          order_audit_id: execution?.placed ? execution.orderAuditId : null,
          execution_reason: execution && !execution.placed ? execution.reason : null,
        };
        this.deps.emit(run.id, payload);
        logger.info(
          { run_id: run.id, symbol: run.symbol, signal: result.signal, bar_time: result.bar_time },
          'strategy signal recorded'
        );
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      // A run-level failure counts against its *connection*: the overwhelming
      // cause is the venue being unreachable, and that is a property of the
      // connection rather than of this one strategy.
      this.recordConnectionFailure(label);
      logger.error(
        { run_id: run.id, connection: label, err: this.lastError },
        'strategy run evaluation failed'
      );
      await this.deps.markError(run.id, this.lastError).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------
  status() {
    return {
      enabled: this.enabled,
      execution_enabled: isSystematicExecutionEnabled(),
      running: this.running,
      interval_seconds: this.intervalMs / 1000,
      last_run: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      last_error: this.lastError,
      totals: {
        runs: this.runs,
        runs_evaluated: this.runsEvaluated,
        signals_recorded: this.signalsRecorded,
        orders_placed: this.ordersPlaced,
        errors: this.errors,
        skipped: this.skipped,
        groups_admitted: this.groupsAdmitted,
        groups_abandoned: this.groupsAbandoned,
        position_divergences: this.positionDivergences,
      },
      divergent_runs: Object.fromEntries(this.divergentRuns),
      max_connection_concurrency: this.maxConnectionConcurrency,
      breakers: Object.fromEntries(
        [...this.breakers.entries()].map(([label, state]) => [
          label,
          { failures: state.failures, open: this.breakerIsOpen(label) },
        ])
      ),
    };
  }
}

export function createStrategyRunner(opts: StrategyRunnerOptions = {}): StrategyRunner {
  return new StrategyRunner(opts);
}
