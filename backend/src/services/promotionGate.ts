/**
 * The promotion gate: a strategy reaches paper only through a passing
 * backtest, and live only through a passing backtest **and** a long enough,
 * well-behaved paper run of the same definition.
 *
 * A definition is the unit of promotion. Its rule-set, instrument and
 * timeframe are frozen in the database once written, so evidence gathered on
 * definition 12 is evidence about exactly what definition 12 will trade.
 *
 * Everything here is pure: the evidence is fetched elsewhere
 * (`promotionService.ts`) so the rules can be tested without a database.
 *
 * The thresholds are the same whatever the capital at risk.
 */
import { type Fill, realisedPnl } from './realisedPnl.js';

export type PromotionStage = 'paper' | 'live';

export interface PromotionThresholds {
  /** Minimum closed trades in a qualifying backtest. */
  minTrades: number;
  /** A qualifying backtest's max drawdown must be below this (percent). */
  maxBacktestDrawdownPct: number;
  /** Minimum length of a qualifying paper run, in days. */
  minPaperDays: number;
  /** Paper drawdown may be at most this multiple of the backtest's. */
  paperDrawdownRatio: number;
  /** When false, paper deployment skips the backtest check (smoke tests). */
  enforcePaper: boolean;
}

function envNumber(env: Record<string, string | undefined>, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function promotionThresholds(
  env: Record<string, string | undefined> = process.env
): PromotionThresholds {
  return {
    minTrades: envNumber(env, 'PROMOTION_MIN_TRADES', 30),
    maxBacktestDrawdownPct: envNumber(env, 'PROMOTION_MAX_BACKTEST_DRAWDOWN_PCT', 20),
    minPaperDays: envNumber(env, 'PROMOTION_MIN_PAPER_DAYS', 28),
    paperDrawdownRatio: envNumber(env, 'PROMOTION_PAPER_DRAWDOWN_RATIO', 1.5),
    enforcePaper: (env.PROMOTION_PAPER_GATE ?? '').trim().toLowerCase() !== 'off',
  };
}

export interface DefinitionFacts {
  id: number;
  symbol: string;
  timeframe: string;
  /** First day of data the strategy was not designed on. */
  holdout_start: string | Date | null;
}

/** One persisted backtest of a definition, reduced to what the gate reads. */
export interface BacktestEvidence {
  id: number;
  symbol: string;
  timeframe: string;
  /** First bar the backtest actually used (ISO date or timestamp). */
  data_start: string | null;
  trade_count: number;
  /** Percent, as the engine reports it (negative, e.g. -12.5). */
  max_drawdown: number | null;
  /** Mean P&L per closed trade, in account currency. */
  avg_trade_pnl: number | null;
  created_at: string;
}

/** One paper run of a definition. */
export interface PaperRunEvidence {
  run_id: number;
  connection: string;
  status: string;
  started_at: string;
  stopped_at: string | null;
  trade_fills: number;
  /** Peak-to-trough fall of the run's cumulative realised P&L, in currency. */
  max_drawdown_amount: number;
  /** The paper account's current equity; null when it could not be read. */
  equity: number | null;
}

export interface BacktestCheck {
  backtest_id: number;
  qualifies: boolean;
  reasons: string[];
}

export interface PromotionDecision {
  definition_id: number;
  stage: PromotionStage;
  allowed: boolean;
  /** Why it is not allowed; empty when allowed. */
  reasons: string[];
  /** The backtest the decision rests on, when one qualifies. */
  backtest_id: number | null;
  /** The paper run the live decision rests on, when one qualifies. */
  paper_run_id: number | null;
  backtests_checked: BacktestCheck[];
  thresholds: PromotionThresholds;
}

const DAY_MS = 86_400_000;

/**
 * YYYY-MM-DD from an ISO string or a Date. node-postgres turns a DATE column
 * into a Date at local midnight, so its local fields are the stored day.
 */
export function isoDay(value: string | Date): string {
  if (value instanceof Date) {
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

const day = isoDay;

/** Every reason a backtest does not count; empty means it qualifies. */
export function checkBacktest(
  definition: DefinitionFacts,
  backtest: BacktestEvidence,
  t: PromotionThresholds
): string[] {
  const reasons: string[] = [];
  if (backtest.symbol.toUpperCase() !== definition.symbol.toUpperCase()) {
    reasons.push(`ran on ${backtest.symbol}, not ${definition.symbol}`);
  }
  if (backtest.timeframe !== definition.timeframe) {
    reasons.push(`ran on ${backtest.timeframe} bars, not ${definition.timeframe}`);
  }
  if (!definition.holdout_start) {
    reasons.push('the definition has no holdout start date');
  } else if (!backtest.data_start) {
    reasons.push('the backtest did not record where its data started');
  } else if (day(backtest.data_start) < day(definition.holdout_start)) {
    reasons.push(
      `uses data from ${day(backtest.data_start)}, before the holdout start ` +
        `${day(definition.holdout_start)}`
    );
  }
  if (backtest.trade_count < t.minTrades) {
    reasons.push(`${backtest.trade_count} trades, fewer than ${t.minTrades}`);
  }
  if (backtest.avg_trade_pnl == null || !(backtest.avg_trade_pnl > 0)) {
    reasons.push('expectancy is not positive');
  }
  const dd = backtest.max_drawdown == null ? null : Math.abs(backtest.max_drawdown);
  if (dd == null) {
    reasons.push('no max drawdown recorded');
  } else if (dd >= t.maxBacktestDrawdownPct) {
    reasons.push(`max drawdown ${dd.toFixed(1)}%, not under ${t.maxBacktestDrawdownPct}%`);
  }
  return reasons;
}

function newest<T extends { created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Days a run has been running (or ran, if stopped). */
export function paperDays(run: PaperRunEvidence, now: Date): number {
  const start = Date.parse(run.started_at);
  const end = run.stopped_at ? Date.parse(run.stopped_at) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / DAY_MS);
}

/** Every reason a paper run does not count towards live; empty means it does. */
export function checkPaperRun(
  run: PaperRunEvidence,
  backtestDrawdownPct: number,
  t: PromotionThresholds,
  now: Date
): string[] {
  const reasons: string[] = [];
  if (run.status === 'error' || run.status === 'pending') {
    reasons.push(`run ${run.run_id} is ${run.status}`);
  }
  const days = paperDays(run, now);
  if (days < t.minPaperDays) {
    reasons.push(
      `run ${run.run_id} has ${days.toFixed(1)} days of paper, fewer than ${t.minPaperDays}`
    );
  }
  if (run.equity == null || !(run.equity > 0)) {
    reasons.push(`run ${run.run_id}: the paper account's equity could not be read`);
  } else {
    const ddPct = (run.max_drawdown_amount / run.equity) * 100;
    const limit = backtestDrawdownPct * t.paperDrawdownRatio;
    if (ddPct > limit) {
      reasons.push(
        `run ${run.run_id} drew down ${ddPct.toFixed(1)}%, more than ${t.paperDrawdownRatio}× ` +
          `the backtest's ${backtestDrawdownPct.toFixed(1)}%`
      );
    }
  }
  return reasons;
}

export function evaluatePromotion(
  definition: DefinitionFacts,
  stage: PromotionStage,
  backtests: BacktestEvidence[],
  paperRuns: PaperRunEvidence[],
  t: PromotionThresholds,
  now: Date = new Date()
): PromotionDecision {
  const checked = newest(backtests).map((b) => {
    const reasons = checkBacktest(definition, b, t);
    return { backtest_id: b.id, qualifies: reasons.length === 0, reasons, row: b };
  });
  const passing = checked.find((c) => c.qualifies)?.row ?? null;
  const decision: PromotionDecision = {
    definition_id: definition.id,
    stage,
    allowed: false,
    reasons: [],
    backtest_id: passing?.id ?? null,
    paper_run_id: null,
    backtests_checked: checked.map(({ row: _row, ...rest }) => rest),
    thresholds: t,
  };

  if (stage === 'paper' && !t.enforcePaper) {
    decision.allowed = true;
    return decision;
  }

  if (!passing) {
    if (!definition.holdout_start) {
      decision.reasons.push(
        'set a holdout start date on the definition, then backtest it on data from that date'
      );
    } else if (checked.length === 0) {
      decision.reasons.push(
        `no backtest of definition ${definition.id} yet; run one from ` +
          `${day(definition.holdout_start)} onwards`
      );
    } else {
      decision.reasons.push(
        `no backtest of definition ${definition.id} passes; the latest ` +
          `(#${checked[0].backtest_id}): ${checked[0].reasons.join('; ')}`
      );
    }
    return decision;
  }

  if (stage === 'paper') {
    decision.allowed = true;
    return decision;
  }

  const backtestDd = Math.abs(passing.max_drawdown ?? 0);
  const paperChecks = paperRuns.map((run) => ({
    run,
    reasons: checkPaperRun(run, backtestDd, t, now),
  }));
  const paper = paperChecks.find((c) => c.reasons.length === 0);
  if (paper) {
    decision.allowed = true;
    decision.paper_run_id = paper.run.run_id;
    return decision;
  }
  if (paperChecks.length === 0) {
    decision.reasons.push(
      `no paper run of definition ${definition.id} yet; it needs ${t.minPaperDays} days on paper`
    );
  } else {
    // The run closest to qualifying explains the gap best: the longest one.
    const best = [...paperChecks].sort((a, b) => paperDays(b.run, now) - paperDays(a.run, now))[0];
    decision.reasons.push(...best.reasons);
  }
  return decision;
}

/**
 * Peak-to-trough fall of cumulative realised P&L over a time-ordered fill
 * list, in account currency. Floating P&L is not included: paper evidence is
 * built from what actually traded.
 */
export function realisedDrawdown(fills: Fill[]): number {
  let peak = 0;
  let worst = 0;
  for (let i = 1; i <= fills.length; i += 1) {
    const value = realisedPnl(fills.slice(0, i)).realised;
    peak = Math.max(peak, value);
    worst = Math.max(worst, peak - value);
  }
  return worst;
}
