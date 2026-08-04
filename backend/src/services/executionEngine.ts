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

    // Resolve the concrete action + quantity. A `buy` opens (size from the
    // sizing block); a `sell` exits, closing the current long position.
    let action: OrderAction;
    let quantity: number;
    if (ctx.signal === 'buy') {
      action = 'BUY';
      const sized = resolveOrderQuantity(run.sizing ?? {}, {
        price: ctx.lastBar.close,
        broker: run.broker,
        equity: null,
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
