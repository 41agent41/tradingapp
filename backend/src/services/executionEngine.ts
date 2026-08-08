/**
 * Systematic execution engine (Systematic Trading roadmap — A3).
 *
 * Turns a recorded strategy signal into a gated, audited **paper** order. It
 * adds no broker code — it maps a signal to an `OrderInput`, validates it
 * (inheriting `ORDER_MAX_*`) and submits it through the shared audited path
 * (`submitCreateOrder`), which enforces the live gate, the position-limit cap
 * and the `order_audit` write-before-send. On top of those it layers the
 * engine-level guards the roadmap calls for:
 *
 *   - `SYSTEMATIC_EXECUTION_ENABLED` gate (distinct from `LIVE_TRADING_ENABLED`)
 *   - a kill-switch re-check of the run's status *immediately* before placing
 *   - per-run `max_orders_per_day` and a global `SYSTEMATIC_MAX_ORDERS_PER_DAY`
 *   - per-run `max_daily_loss`, measured against **realised P&L from fills**
 *   - signal→order dedupe (the `acted`/`order_audit_id` link on the signal row)
 *
 * Every abort is a fail-closed, auditable *reason* — never an order. A pure
 * orchestrator over injected dependencies, so the whole decision tree is
 * unit-testable with no DB, IB service or network.
 */

import { resolveOrderQuantity, roundToStep, type InstrumentSpec } from './orderSizing.js';
import {
  connectionOf,
  validateOrder,
  type Connection,
  type OrderAction,
  type ValidatedOrder,
} from './orderTypes.js';
import type { SubmitCreateOutcome } from './orderService.js';
import type { ActiveRun } from './strategyRepository.js';
import { runSymbol } from './strategyRunner.js';
import type { PositionState, RawBar } from './strategyRunner.js';

export interface ExecutionContext {
  run: ActiveRun;
  signalId: number | null;
  /** 'long' | 'short' | 'flat' | 'none' (pre-E1: 'buy' | 'sell'). */
  signal: string;
  barTime: string;
  position: PositionState;
  /** The newest closed bar — its close drives notional/pct sizing. */
  lastBar: RawBar;
  /** Protective stop the rule engine resolved for this entry (E-2), or null
   *  when the strategy declares none. */
  stopPrice?: number | null;
  /** Set when a stop **was** declared but could not be resolved. Distinct from
   *  a null price: this must refuse the entry, not place it unprotected. */
  stopError?: string | null;
  /** Whether the strategy declares a stop rule at all. */
  hasStopRule?: boolean;
}

export type ExecutionResult =
  | {
      placed: true;
      orderAuditId: number;
      action: OrderAction;
      quantity: number;
      /** The protective stop this order went out with, if any (E-5). */
      stopLoss: number | null;
      ibBody: Record<string, unknown>;
    }
  | { placed: false; reason: string };

export interface ExecutionEngineDeps {
  executionEnabled(): boolean;
  globalMaxOrdersPerDay(): number;
  getRunStatus(runId: number): Promise<string | null>;
  countOrdersToday(runId: number): Promise<number>;
  countOrdersTodayAllRuns(): Promise<number>;
  submitOrder(order: ValidatedOrder, requestId: string | null): Promise<SubmitCreateOutcome>;
  markActed(signalId: number, orderAuditId: number): Promise<{ updated: boolean }>;
  /** Realised P&L for this run today, derived from its fills. Only called when
   *  the run declares a `max_daily_loss`; throwing fails the check closed. */
  realisedPnlToday?(runId: number): Promise<number>;
  /** Net liquidation at the run's **connection**, for `pct_equity` sizing.
   *  Only called when the sizing block actually needs it; `null` means the
   *  venue reported none and the sizer refuses rather than guessing a size.
   *  Keyed by connection, not platform: two accounts on one platform have
   *  different equity, and sizing off the wrong one is silent (C-0). */
  accountEquity?(connection: Connection): Promise<number | null>;
  /** The connection's unit semantics and size constraints for the instrument —
   *  what makes "100" mean 100 shares on IB but 100 *lots* on MT5. Lot step
   *  and minimum differ per broker for the same pair, so this is per
   *  connection too. `null` falls back to whole shares. */
  instrumentSpec?(connection: Connection, symbol: string): Promise<InstrumentSpec | null>;

  // -- Connection- and portfolio-level caps (C-4) --------------------------- //
  /** The caps declared for a connection, or null when it has none. */
  connectionLimits?(connection: Connection): Promise<ConnectionLimits | null>;
  /** Orders placed today across every run on this connection. */
  countOrdersTodayForConnection?(connection: Connection): Promise<number>;
  /** Realised P&L today for the whole connection, including fills that belong
   *  to no run — a manual trade is a real loss against an account budget. */
  realisedPnlTodayForConnection?(connection: Connection): Promise<number>;
  /** Portfolio-wide caps, or null when none are configured. */
  portfolioLimits?(): Promise<PortfolioLimits | null>;
  /** Realised P&L today across every connection. Only sound when they share a
   *  currency — `portfolioLimits` reports whether they do. */
  realisedPnlTodayPortfolio?(): Promise<number>;
}

/** Account-level caps. This is the level a broker — and a prop firm — actually
 *  enforces at, so it is the level a breach has to be detected at. */
export interface ConnectionLimits {
  max_orders_per_day?: number;
  max_daily_loss?: number;
}

/** Fleet-wide caps. */
export interface PortfolioLimits {
  max_daily_loss?: number;
  /** False when the fleet's connections do not all report one currency, in
   *  which case any aggregate is meaningless and must not be computed. */
  currency_consistent: boolean;
  currencies?: string[];
}

/** What a signal asks the engine to do, once the vocabulary is normalised. */
export type SignalIntent = 'long' | 'short' | 'flat';

/**
 * Map a recorded signal onto an intent, or null when it is not actionable.
 *
 * `buy` / `sell` are the pre-E1 spelling of `long` / `flat`. They stay
 * accepted because `strategy_signals` rows written before E1 use them, and a
 * stored signal outlives the deploy that produced it.
 */
export function normaliseSignal(signal: string): SignalIntent | null {
  switch (signal) {
    case 'long':
    case 'buy':
      return 'long';
    case 'short':
      return 'short';
    case 'flat':
    case 'sell':
      return 'flat';
    default:
      return null;
  }
}

function isEntry(intent: SignalIntent): boolean {
  return intent === 'long' || intent === 'short';
}

/**
 * The venue's minimum distance between the market and a stop, in price terms.
 *
 * MT5 reports `stops_level` in **points**, so it needs the instrument's point
 * size to become a price distance. A venue that reports neither yields 0,
 * which disables the check rather than inventing a band — refusing entries
 * against a limit we do not actually know would be worse than letting the
 * venue reject the rare order that breaches it.
 */
function minimumStopDistance(spec: InstrumentSpec | null, _price: number): number {
  const level = Number(spec?.stopsLevel) || 0;
  const point = Number(spec?.point) || 0;
  return level > 0 && point > 0 ? level * point : 0;
}

export class ExecutionEngine {
  constructor(private readonly deps: ExecutionEngineDeps) {}

  /** Decide-and-place for one actionable signal. Returns why it did or didn't
   *  place; never throws for an expected abort. */
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    // Global gate — the engine places nothing until explicitly enabled. This is
    // also the global kill switch: flipping the env off halts every run.
    if (!this.deps.executionEnabled()) {
      return {
        placed: false,
        reason: 'systematic execution disabled (SYSTEMATIC_EXECUTION_ENABLED)',
      };
    }

    // Normalise the signal vocabulary (E1). The rule engine now emits
    // `long` / `short` / `flat`; `buy` / `sell` are the pre-E1 spelling of
    // `long` / `flat` and are still accepted, because `strategy_signals` rows
    // written before E1 use them and a stored signal outlives a deploy.
    const intent = normaliseSignal(ctx.signal);
    if (intent === null) {
      return { placed: false, reason: 'non-actionable signal' };
    }
    if (ctx.signalId == null) {
      return {
        placed: false,
        reason: 'signal was not persisted; refusing to place an unlinked order',
      };
    }

    const { run } = ctx;

    // Per-run kill switch: re-read the run's status right before acting so a
    // run stopped mid-cycle (after the pass started) can't still fire.
    const status = await this.deps.getRunStatus(run.id);
    if (status !== 'running') {
      return { placed: false, reason: `run is '${status ?? 'missing'}', not running` };
    }

    // Per-run daily order cap.
    const perRunCap = Math.max(0, Number((run.risk ?? {}).max_orders_per_day) || 0);
    if (perRunCap > 0) {
      const placedToday = await this.deps.countOrdersToday(run.id);
      if (placedToday >= perRunCap) {
        return { placed: false, reason: `per-run max_orders_per_day (${perRunCap}) reached` };
      }
    }

    // Global daily backstop across all runs.
    const globalCap = this.deps.globalMaxOrdersPerDay();
    if (globalCap > 0) {
      const placedTodayAll = await this.deps.countOrdersTodayAllRuns();
      if (placedTodayAll >= globalCap) {
        return {
          placed: false,
          reason: `global SYSTEMATIC_MAX_ORDERS_PER_DAY (${globalCap}) reached`,
        };
      }
    }

    // ---- Connection-level caps (C-4) ------------------------------------ //
    //
    // Distinct from the per-run caps above, and not a duplicate of them: a
    // connection hosting several runs can breach an account-level limit while
    // every individual run sits comfortably inside its own. It is also the
    // level a broker or prop firm enforces at, so it is the level a breach has
    // to be caught at.
    const connection = connectionOf(run);
    if (this.deps.connectionLimits) {
      let limits: ConnectionLimits | null;
      try {
        limits = await this.deps.connectionLimits(connection);
      } catch (err) {
        // Fail closed, like every other guard here: a cap we cannot read must
        // block the order, never wave it through.
        return {
          placed: false,
          reason: `connection limits unavailable (${String((err as Error)?.message ?? err)})`,
        };
      }

      const connOrderCap = Math.max(0, Number(limits?.max_orders_per_day) || 0);
      if (connOrderCap > 0) {
        if (!this.deps.countOrdersTodayForConnection) {
          return {
            placed: false,
            reason: `connection max_orders_per_day (${connOrderCap}) declared but not measurable`,
          };
        }
        let placed: number;
        try {
          placed = await this.deps.countOrdersTodayForConnection(connection);
        } catch (err) {
          return {
            placed: false,
            reason: `connection order-count check failed (${String((err as Error)?.message ?? err)})`,
          };
        }
        if (placed >= connOrderCap) {
          return {
            placed: false,
            reason: `connection max_orders_per_day (${connOrderCap}) reached on ${connection.broker}:${connection.brokerAccount}`,
          };
        }
      }

      // Loss caps gate **entries only**, for the same reason the per-run one
      // does: blocking an exit because the day went badly strands the position
      // in the trade that caused the loss.
      const connLossCap = Math.abs(Number(limits?.max_daily_loss) || 0);
      if (connLossCap > 0 && isEntry(intent)) {
        if (!this.deps.realisedPnlTodayForConnection) {
          return {
            placed: false,
            reason: `connection max_daily_loss (${connLossCap}) declared but not measurable`,
          };
        }
        let realised: number;
        try {
          realised = await this.deps.realisedPnlTodayForConnection(connection);
        } catch (err) {
          return {
            placed: false,
            reason: `connection loss check failed (${String((err as Error)?.message ?? err)})`,
          };
        }
        if (!Number.isFinite(realised)) {
          return { placed: false, reason: 'connection loss check returned a non-finite P&L' };
        }
        if (realised <= -connLossCap) {
          return {
            placed: false,
            reason: `connection max_daily_loss (${connLossCap}) reached on ${connection.broker}:${connection.brokerAccount} (realised ${realised.toFixed(2)})`,
          };
        }
      }
    }

    // ---- Portfolio-level cap (C-4) --------------------------------------- //
    //
    // With one strategy across several accounts there is no diversification:
    // every leg takes the same trade at the same moment, so the fleet's total
    // risk is N times one account's. This is the backstop for that.
    if (this.deps.portfolioLimits && isEntry(intent)) {
      let portfolio: PortfolioLimits | null;
      try {
        portfolio = await this.deps.portfolioLimits();
      } catch (err) {
        return {
          placed: false,
          reason: `portfolio limits unavailable (${String((err as Error)?.message ?? err)})`,
        };
      }

      const portfolioLossCap = Math.abs(Number(portfolio?.max_daily_loss) || 0);
      if (portfolio && portfolioLossCap > 0) {
        // Summing mixed denominations produces a number that adds up and means
        // nothing, so a currency mismatch refuses rather than aggregating.
        if (!portfolio.currency_consistent) {
          return {
            placed: false,
            reason:
              'portfolio max_daily_loss declared but connections report different currencies ' +
              `(${(portfolio.currencies ?? []).join(', ')}) — refusing to aggregate`,
          };
        }
        if (!this.deps.realisedPnlTodayPortfolio) {
          return {
            placed: false,
            reason: `portfolio max_daily_loss (${portfolioLossCap}) declared but not measurable`,
          };
        }
        let realised: number;
        try {
          realised = await this.deps.realisedPnlTodayPortfolio();
        } catch (err) {
          return {
            placed: false,
            reason: `portfolio loss check failed (${String((err as Error)?.message ?? err)})`,
          };
        }
        if (!Number.isFinite(realised)) {
          return { placed: false, reason: 'portfolio loss check returned a non-finite P&L' };
        }
        if (realised <= -portfolioLossCap) {
          return {
            placed: false,
            reason: `portfolio max_daily_loss (${portfolioLossCap}) reached (realised ${realised.toFixed(2)})`,
          };
        }
      }
    }

    // Per-run daily loss cap. Declared `max_daily_loss` used to be accepted by
    // the schema and the rule builder and enforced nowhere — a silent no-op,
    // the same failure shape as a stop rule that never fires. It is measured
    // against **realised P&L from this run's fills**, not from submitted
    // orders: a loss is only a loss once it has actually traded.
    //
    // It gates **entries only**. Blocking an exit because the day went badly
    // would strand the position in the trade that caused the loss — the exact
    // opposite of what a loss limit is for. So a breached cap stops the run
    // taking on new risk and leaves its exits (and the strategy's own stop
    // rules) free to run.
    const lossCap = Math.abs(Number((run.risk ?? {}).max_daily_loss) || 0);
    if (lossCap > 0 && isEntry(intent)) {
      if (!this.deps.realisedPnlToday) {
        return {
          placed: false,
          reason: `max_daily_loss (${lossCap}) declared but realised P&L is unavailable`,
        };
      }
      let realised: number;
      try {
        realised = await this.deps.realisedPnlToday(run.id);
      } catch (err) {
        // Fail closed, exactly like the position-limit guard: a cap we can't
        // evaluate must block the order, never wave it through.
        return {
          placed: false,
          reason: `max_daily_loss check failed (${String((err as Error)?.message ?? err)})`,
        };
      }
      if (!Number.isFinite(realised)) {
        return { placed: false, reason: 'max_daily_loss check returned a non-finite P&L' };
      }
      if (realised <= -lossCap) {
        return {
          placed: false,
          reason: `per-run max_daily_loss (${lossCap}) reached (realised ${realised.toFixed(2)})`,
        };
      }
    }

    // Resolve the concrete action + quantity.
    //
    // An entry opens in the signal's direction, sized from the sizing block;
    // `flat` closes whatever is held, in whichever direction closes it. Under
    // MT5 netting a position is one signed number, so "close" means trading
    // the opposite side of its sign — a short is covered with a BUY.
    let action: OrderAction;
    let quantity: number;
    // Hoisted: the stop check below needs the same spec the sizer used, and
    // re-fetching it would be a second round trip for the same answer.
    let entrySpec: InstrumentSpec | null = null;
    if (isEntry(intent)) {
      // E12: no direct reversal. An entry signal while a position is open is
      // refused rather than flipping — the strategy exits first and re-enters
      // on a later bar. Silently reversing would double the traded size and
      // take a position the rules never asked for on this bar.
      if (ctx.position.size !== 0) {
        return {
          placed: false,
          reason: `${intent} entry while a position of ${ctx.position.size} is open — reversal is not supported`,
        };
      }
      action = intent === 'long' ? 'BUY' : 'SELL';
      // Equity is only fetched when the sizing block asks for it — every other
      // sizing type resolves from the bar price alone, and a venue round-trip
      // per signal would be pure cost.
      let equity: number | null = null;
      const sizingType = (run.sizing ?? {}).type;
      if ((sizingType === 'pct_equity' || sizingType === 'risk_pct') && this.deps.accountEquity) {
        try {
          equity = await this.deps.accountEquity(connectionOf(run));
        } catch {
          // Leave it null: the sizer then refuses with a clear reason rather
          // than sizing off a stale or invented equity figure.
          equity = null;
        }
      }
      // The venue's unit semantics. Fetched for every sizing type, because
      // even a `fixed` size has to conform to the venue's step and minimum.
      if (this.deps.instrumentSpec) {
        try {
          entrySpec = await this.deps.instrumentSpec(connectionOf(run), runSymbol(run));
        } catch {
          // Whole shares is the safe fallback: it is what every equity venue
          // uses, and on a lot-based venue a `fixed` size still has to clear
          // the minimum, so a wrong guess errs toward refusing.
          entrySpec = null;
        }
      }
      // `risk_pct` sizes from the distance to the stop, so the stop has to be
      // known *before* the size is computed (E-4). Declaring risk_pct without
      // a stop rule is refused rather than silently falling back to another
      // sizing type.
      if (sizingType === 'risk_pct') {
        if (!ctx.hasStopRule) {
          return {
            placed: false,
            reason: 'risk_pct sizing requires a `stop` block on the rule-set',
          };
        }
        if (ctx.stopError) {
          return { placed: false, reason: `stop rule failed to resolve: ${ctx.stopError}` };
        }
      }

      const sized = resolveOrderQuantity(run.sizing ?? {}, {
        price: ctx.lastBar.close,
        broker: run.broker,
        equity,
        spec: entrySpec,
        stopPrice: ctx.stopPrice ?? null,
      });
      if (!sized.ok) return { placed: false, reason: `sizing: ${sized.reason}` };
      quantity = sized.quantity;
    } else {
      // Close whatever is held: a long is closed with a SELL, a short with a
      // BUY. Reading the direction from the position's sign rather than
      // assuming long is the whole of E1 on the exit side.
      if (ctx.position.size === 0) {
        return { placed: false, reason: 'exit signal but no open position to close' };
      }
      action = ctx.position.size > 0 ? 'SELL' : 'BUY';

      // Close exactly what is held, rounded onto the venue's step — flooring
      // to a whole number would strand a fractional lot open forever.
      let spec: InstrumentSpec | null = null;
      if (this.deps.instrumentSpec) {
        try {
          spec = await this.deps.instrumentSpec(connectionOf(run), runSymbol(run));
        } catch {
          spec = null;
        }
      }
      const step = Number(spec?.sizeStep) > 0 ? Number(spec?.sizeStep) : 1;
      quantity = roundToStep(Math.abs(ctx.position.size), step);
      if (quantity <= 0) {
        return { placed: false, reason: 'exit signal but no open position to close' };
      }
    }

    // ---- Protective stop (E-2) ------------------------------------------- //
    //
    // An unprotected position is never an acceptable resting state, so a
    // strategy that declares a stop must get one or not trade at all. The
    // three cases are deliberately distinct:
    //
    //   - no stop rule           → place without one (unchanged behaviour)
    //   - stop rule, resolved    → attach it to the entry
    //   - stop rule, unresolved  → refuse the entry
    //
    // Collapsing the third into the first is the failure this guards against:
    // it places a position the operator believes is protected.
    let stopLoss: number | null = null;
    if (isEntry(intent) && ctx.hasStopRule) {
      if (ctx.stopError) {
        return { placed: false, reason: `stop rule failed to resolve: ${ctx.stopError}` };
      }
      if (ctx.stopPrice == null || !Number.isFinite(ctx.stopPrice) || ctx.stopPrice <= 0) {
        return {
          placed: false,
          reason: 'strategy declares a stop but none was resolved — refusing to open unprotected',
        };
      }
      stopLoss = ctx.stopPrice;

      // Brokers reject a stop sitting inside their minimum distance from the
      // market. Catching it here means a refused entry with a clear reason
      // rather than an order we already knew the venue would bounce.
      const minDistance = minimumStopDistance(entrySpec, ctx.lastBar.close);
      if (minDistance > 0 && Math.abs(ctx.lastBar.close - stopLoss) < minDistance) {
        return {
          placed: false,
          reason:
            `stop ${stopLoss} is within the venue's minimum distance (${minDistance}) of ` +
            `${ctx.lastBar.close}`,
        };
      }
    }

    // Build + validate the order (inherits the ORDER_MAX_* fat-finger caps).
    const v = validateOrder({
      // The connection's native symbol (C-2) — the order goes to a venue that
      // has never heard of the canonical one.
      symbol: runSymbol(run),
      action,
      quantity,
      order_type: 'MKT',
      tif: 'DAY',
      account_mode: run.account_mode,
      broker: run.broker,
      broker_account: run.broker_account,
      stop_loss: stopLoss,
    });
    if (!v.ok) {
      return { placed: false, reason: `order validation failed: ${v.errors.join('; ')}` };
    }

    // Submit through the shared audited path. `requestId` ties the order_audit
    // row back to the run + signal for traceability.
    const requestId = `sys:run${run.id}:sig${ctx.signalId}`;
    const outcome = await this.deps.submitOrder(v.value, requestId);
    if (!outcome.ok) {
      return { placed: false, reason: `order not placed (${outcome.kind})` };
    }

    // Durable dedupe: mark the signal acted and link the audit row.
    await this.deps.markActed(ctx.signalId, outcome.auditId);
    return {
      placed: true,
      orderAuditId: outcome.auditId,
      action,
      quantity,
      stopLoss,
      ibBody: outcome.ibBody,
    };
  }
}
