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

import { resolveOrderQuantity } from './orderSizing.js';
import { validateOrder, type OrderAction, type ValidatedOrder } from './orderTypes.js';
import type { SubmitCreateOutcome } from './orderService.js';
import type { ActiveRun } from './strategyRepository.js';
import type { PositionState, RawBar } from './strategyRunner.js';

export interface ExecutionContext {
  run: ActiveRun;
  signalId: number | null;
  signal: string; // 'buy' | 'sell' | 'none'
  barTime: string;
  position: PositionState;
  /** The newest closed bar — its close drives notional/pct sizing. */
  lastBar: RawBar;
}

export type ExecutionResult =
  | {
      placed: true;
      orderAuditId: number;
      action: OrderAction;
      quantity: number;
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
  /** Net liquidation at the run's venue, for `pct_equity` sizing. Only called
   *  when the sizing block actually needs it; `null` means the venue reported
   *  none and the sizer refuses rather than guessing a size. */
  accountEquity?(broker: string): Promise<number | null>;
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

    if (ctx.signal !== 'buy' && ctx.signal !== 'sell') {
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
    if (lossCap > 0 && ctx.signal === 'buy') {
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

    // Resolve the concrete action + quantity. A `buy` opens (size from the
    // sizing block); a `sell` exits, closing the current long position.
    let action: OrderAction;
    let quantity: number;
    if (ctx.signal === 'buy') {
      action = 'BUY';
      // Equity is only fetched when the sizing block asks for it — every other
      // sizing type resolves from the bar price alone, and a venue round-trip
      // per signal would be pure cost.
      let equity: number | null = null;
      if ((run.sizing ?? {}).type === 'pct_equity' && this.deps.accountEquity) {
        try {
          equity = await this.deps.accountEquity(run.broker);
        } catch {
          // Leave it null: the sizer then refuses with a clear reason rather
          // than sizing off a stale or invented equity figure.
          equity = null;
        }
      }
      const sized = resolveOrderQuantity(run.sizing ?? {}, {
        price: ctx.lastBar.close,
        broker: run.broker,
        equity,
      });
      if (!sized.ok) return { placed: false, reason: `sizing: ${sized.reason}` };
      quantity = sized.quantity;
    } else {
      action = 'SELL';
      quantity = Math.floor(Math.abs(ctx.position.size));
      if (quantity < 1) {
        return { placed: false, reason: 'exit signal but no open long position to close' };
      }
    }

    // Build + validate the order (inherits the ORDER_MAX_* fat-finger caps).
    const v = validateOrder({
      symbol: run.symbol,
      action,
      quantity,
      order_type: 'MKT',
      tif: 'DAY',
      account_mode: run.account_mode,
      broker: run.broker,
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
      ibBody: outcome.ibBody,
    };
  }
}
