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
 *   strategy_runs (running) ─▶ runner ─▶ ib_service /market-data/history
 *                                            │
 *                                            ▼
 *                             ib_service /strategies/evaluate  ─▶ {signal,…}
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
import { StrategyRepository, type ActiveRun } from './strategyRepository.js';
import { OrderAuditRepository } from './orderAuditRepository.js';
import { submitCreateOrder } from './orderService.js';
import { isSystematicExecutionEnabled, systematicMaxOrdersPerDay } from './orderTypes.js';
import { ExecutionEngine, type ExecutionContext, type ExecutionResult } from './executionEngine.js';

const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

const SYSTEMATIC_ENABLED = (process.env.SYSTEMATIC_ENABLED ?? 'false').toLowerCase() === 'true';
const SYSTEMATIC_INTERVAL_SECONDS = Math.max(
  5,
  parseInt(process.env.SYSTEMATIC_INTERVAL_SECONDS || '60', 10) || 60
);
const SYSTEMATIC_INITIAL_DELAY_MS = Math.max(
  0,
  parseInt(process.env.SYSTEMATIC_INITIAL_DELAY_MS || '15000', 10) || 15000
);
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
  fetchHistory(symbol: string, timeframe: string): Promise<RawBar[]>;
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
}

export interface StrategyRunnerOptions {
  deps?: Partial<StrategyRunnerDeps>;
  enabled?: boolean;
  intervalSeconds?: number;
  initialDelayMs?: number;
  emit?: (runId: number, payload: Record<string, unknown>) => void;
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

function defaultDeps(
  emit: (runId: number, payload: Record<string, unknown>) => void
): StrategyRunnerDeps {
  const repo = new StrategyRepository(dbService);
  const auditRepo = new OrderAuditRepository(dbService);
  const engine = new ExecutionEngine({
    executionEnabled: isSystematicExecutionEnabled,
    globalMaxOrdersPerDay: systematicMaxOrdersPerDay,
    getRunStatus: (id) => repo.getRunStatus(id),
    countOrdersToday: (id) => repo.countActedSignalsToday(id),
    countOrdersTodayAllRuns: () => repo.countActedSignalsTodayAllRuns(),
    submitOrder: (order, requestId) => submitCreateOrder(order, requestId),
    markActed: (signalId, orderAuditId) => repo.markSignalActed(signalId, orderAuditId),
  });
  return {
    listActiveRuns: () => repo.listActiveRuns(),
    fetchHistory: async (symbol, timeframe) => {
      const response = await axios.get(`${IB_SERVICE_URL}/market-data/history`, {
        params: { symbol, timeframe, period: historyPeriodFor(timeframe) },
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
      // Net signed exposure from the order-audit log for this symbol +
      // account_mode. avg_price isn't tracked in the audit log, so it stays 0
      // (position.unrealized_pct therefore reads 0 until A3 threads fills).
      try {
        const size = await auditRepo.netExposure(
          run.symbol,
          run.account_mode,
          POSITION_LOOKBACK_HOURS,
          run.broker
        );
        return { size: Number.isFinite(size) ? size : 0, avg_price: 0 };
      } catch {
        return { size: 0, avg_price: 0 };
      }
    },
    evaluate: async (bars, ruleSet, position) => {
      const response = await axios.post(
        `${IB_SERVICE_URL}/strategies/evaluate`,
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
  };
}

export class StrategyRunner {
  private readonly deps: StrategyRunnerDeps;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;

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

  constructor(opts: StrategyRunnerOptions = {}) {
    const emit = opts.emit ?? (() => undefined);
    this.deps = { ...defaultDeps(emit), ...opts.deps } as StrategyRunnerDeps;
    this.enabled = opts.enabled ?? SYSTEMATIC_ENABLED;
    this.intervalMs = (opts.intervalSeconds ?? SYSTEMATIC_INTERVAL_SECONDS) * 1000;
    this.initialDelayMs = opts.initialDelayMs ?? SYSTEMATIC_INITIAL_DELAY_MS;
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
      for (const run of activeRuns) {
        await this.evaluateRun(run);
      }
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, 'systematic run failed');
    } finally {
      this.lastRunAt = this.deps.now();
      this.running = false;
    }
  }

  private async evaluateRun(run: ActiveRun): Promise<void> {
    try {
      const bars = await this.deps.fetchHistory(run.symbol, run.timeframe);
      if (!bars || bars.length === 0) {
        logger.warn({ run_id: run.id, symbol: run.symbol }, 'no bars for strategy run');
        return;
      }

      const position = await this.deps.getPosition(run);
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
      logger.error({ run_id: run.id, err: this.lastError }, 'strategy run evaluation failed');
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
      },
    };
  }
}

export function createStrategyRunner(opts: StrategyRunnerOptions = {}): StrategyRunner {
  return new StrategyRunner(opts);
}
