/**
 * Shared order-submission core (Systematic Trading roadmap — A3).
 *
 * The audited create-order path lived inline in `routes/orders.ts`. A3 needs
 * the systematic engine to place orders through *exactly* the same path —
 * same position-limit guard, same `order_audit` write-before-send, same
 * `broker_service` `/orders` hop, same status transitions — without duplicating
 * it. So the core is extracted here and both callers share it:
 *
 *   - `routes/orders.ts`  (the HTTP surface, behind `orderAuth` RBAC/MFA)
 *   - `services/executionEngine.ts`  (the engine, behind the systematic gate)
 *
 * The function is a pure orchestrator over injected dependencies (audit repo +
 * IB POST), returning a discriminated outcome the caller maps to its own shape
 * (an HTTP response, or an `acted`/`order_audit_id` link). It never throws for
 * an expected failure — every abort is a typed outcome — so both callers fail
 * closed in the same way the route always has.
 */
import axios from 'axios';

import { dbService } from './database.js';
import { OrderAuditRepository } from './orderAuditRepository.js';
import {
  isLiveTradingEnabled,
  positionCap,
  positionLookbackHours,
  checkPositionLimit,
  type ValidatedOrder,
} from './orderTypes.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

/** The outcome of a create-order submission. `ok` splits success from the
 *  five distinct failure modes the route has always distinguished. */
export type SubmitCreateOutcome =
  | { ok: true; auditId: number; ibBody: Record<string, unknown> }
  | { ok: false; kind: 'live_disabled' }
  | {
      ok: false;
      kind: 'position_limit';
      currentNet: number;
      projected: number;
      cap: number;
      detail?: string;
    }
  | { ok: false; kind: 'position_check_failed' }
  | { ok: false; kind: 'audit_failed' }
  | { ok: false; kind: 'ib_error'; error: unknown; auditId: number };

export interface SubmitCreateDeps {
  audit: Pick<OrderAuditRepository, 'create' | 'update' | 'netExposure'>;
  /** POST the IB-shaped payload to the IB service; defaults to axios. */
  ibPost: (payload: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
  /** Structured warn logger for best-effort audit updates. */
  warn: (obj: Record<string, unknown>, msg: string) => void;
  /** Structured error logger for hard aborts. */
  error: (obj: Record<string, unknown>, msg: string) => void;
}

function defaultDeps(): SubmitCreateDeps {
  return {
    audit: new OrderAuditRepository(dbService),
    ibPost: (payload) =>
      axios.post(`${BROKER_SERVICE_URL}/orders`, payload, { timeout: 30_000 }) as Promise<{
        data: Record<string, unknown>;
      }>,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * Place a validated CREATE order through the audited path. Mirrors the logic
 * that used to live in `POST /api/orders`, step for step:
 *
 *   1. live-trading gate (only `account_mode='live'` is affected)
 *   2. opt-in position-limit guard (fails closed if the net can't be computed)
 *   3. `order_audit` insert *before* the IB hop (refuses to send if it fails)
 *   4. IB `/orders` POST; audit row updated with the outcome either way
 */
export async function submitCreateOrder(
  order: ValidatedOrder,
  requestId: string | null,
  overrides: Partial<SubmitCreateDeps> = {}
): Promise<SubmitCreateOutcome> {
  const deps = { ...defaultDeps(), ...overrides };

  // 1. Live gate — a live order needs LIVE_TRADING_ENABLED. Paper always passes.
  if (order.account_mode === 'live' && !isLiveTradingEnabled()) {
    return { ok: false, kind: 'live_disabled' };
  }

  // 2. Position-limit guard. Runs before we persist or forward — a breach never
  //    reaches IB and (like a validation failure) writes no audit row.
  const cap = positionCap();
  if (cap > 0) {
    let net: number;
    try {
      net = await deps.audit.netExposure(
        order.symbol,
        order.account_mode,
        positionLookbackHours(),
        order.broker
      );
    } catch (limitErr) {
      deps.error(
        { err: String((limitErr as Error)?.message ?? limitErr) },
        'position-limit check failed — refusing to place order'
      );
      return { ok: false, kind: 'position_check_failed' };
    }
    const decision = checkPositionLimit(net, order.action, order.quantity, cap);
    if (!decision.ok) {
      return {
        ok: false,
        kind: 'position_limit',
        currentNet: net,
        projected: decision.projected,
        cap,
        detail: decision.detail,
      };
    }
  }

  // 3. Persist the attempt before we call IB so failures still leave a trail.
  let auditId: number;
  try {
    const row = await deps.audit.create({ ...order, operation: 'CREATE', request_id: requestId });
    auditId = row.id;
  } catch (auditErr) {
    deps.error(
      { err: String((auditErr as Error)?.message ?? auditErr) },
      'order_audit insert failed — refusing to forward to IB'
    );
    return { ok: false, kind: 'audit_failed' };
  }

  // 4. Forward to IB and record the outcome on the audit row.
  try {
    const ibResp = await deps.ibPost({
      symbol: order.symbol,
      action: order.action,
      quantity: order.quantity,
      order_type: order.order_type,
      tif: order.tif,
      limit_price: order.limit_price,
      stop_price: order.stop_price,
      account_mode: order.account_mode,
      broker: order.broker,
      secType: order.sec_type,
      exchange: order.exchange,
      currency: order.currency,
      audit_id: auditId,
    });
    const ibBody = ibResp.data ?? {};
    await deps.audit
      .update({
        id: auditId,
        ib_order_id: (ibBody.order_id as number) ?? null,
        status: (ibBody.status as string) ?? 'submitted',
        raw_response: ibBody,
      })
      .catch((e) => deps.warn({ err: String(e) }, 'audit update after place failed'));
    return { ok: true, auditId, ibBody };
  } catch (error) {
    await deps.audit
      .update({
        id: auditId,
        status: 'rejected',
        last_error:
          (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          (error as Error)?.message ??
          'unknown',
      })
      .catch((e) => deps.warn({ err: String(e) }, 'audit update after reject failed'));
    return { ok: false, kind: 'ib_error', error, auditId };
  }
}
