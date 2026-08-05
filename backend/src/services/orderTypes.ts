/**
 * Shared order-domain types and validation constants.
 *
 * Used by both the validation in `routes/orders.ts` and the audit
 * repository. Kept dependency-free so the frontend can import from a
 * generated mirror if we ever extract it.
 */

export const ORDER_ACTIONS = ['BUY', 'SELL'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

export const ORDER_TYPES = ['MKT', 'LMT', 'STP', 'STP_LMT'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const TIME_IN_FORCE = ['DAY', 'GTC', 'IOC', 'FOK'] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

export const ACCOUNT_MODES = ['paper', 'live'] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

/**
 * Execution venues (Systematic Trading roadmap — B1). Instruments are
 * broker-scoped (no cross-broker symbol reconciliation), so `broker` is a
 * first-class dimension on every order and on the net-exposure key. Defaults
 * to `ib`. Each of `mt5` / `alpaca` / `oanda` is accepted here but only
 * served once its adapter is configured on the broker service (see
 * `broker_service/adapters.py`) — otherwise a request for it resolves to a
 * clean 501, not a 400.
 */
export const BROKERS = ['ib', 'mt5', 'alpaca', 'oanda'] as const;
export type Broker = (typeof BROKERS)[number];
export const DEFAULT_BROKER: Broker =
  (process.env.DEFAULT_BROKER as Broker) &&
  (BROKERS as readonly string[]).includes(process.env.DEFAULT_BROKER as string)
    ? (process.env.DEFAULT_BROKER as Broker)
    : 'ib';

export const ORDER_OPERATIONS = ['CREATE', 'CANCEL', 'MODIFY'] as const;
export type OrderOperation = (typeof ORDER_OPERATIONS)[number];

export interface OrderInput {
  symbol: string;
  action: OrderAction;
  quantity: number;
  order_type: OrderType;
  tif: TimeInForce;
  limit_price?: number | null;
  stop_price?: number | null;
  account_mode: AccountMode;
  broker?: Broker;
  sec_type?: string;
  exchange?: string;
  currency?: string;
}

/**
 * Quantity / price safety caps. Bigger orders are not *wrong* but you don't
 * want a fat-finger sending 1e6 shares of MSFT by accident.
 *
 * Override with env vars:
 *   ORDER_MAX_QUANTITY  (defaults to 100_000)
 *   ORDER_MAX_PRICE     (defaults to 1_000_000)
 */
export const ORDER_MAX_QUANTITY = Math.max(1, Number(process.env.ORDER_MAX_QUANTITY) || 100_000);
export const ORDER_MAX_PRICE = Math.max(0.01, Number(process.env.ORDER_MAX_PRICE) || 1_000_000);

/**
 * Position-limit guard (opt-in). Caps the *net* signed exposure per
 * (symbol, account_mode) that the order_audit log knows about, so a stuck
 * automation or a fat-finger can't accumulate an unbounded position one
 * order at a time. Read live from the environment (mirrors
 * `isLiveTradingEnabled`) so tests can toggle them per-case.
 *
 *   ORDER_MAX_POSITION             — absolute net share cap; 0 (default)
 *                                    disables the guard entirely.
 *   ORDER_POSITION_LOOKBACK_HOURS  — only orders submitted within this
 *                                    window count toward the net (default 24).
 *
 * This is a *soft* guard built on submitted orders, not authoritative IB
 * fills — see `OrderAuditRepository.netExposure`.
 */
export function positionCap(): number {
  return Math.max(0, Number(process.env.ORDER_MAX_POSITION) || 0);
}

export function positionLookbackHours(): number {
  return Math.max(1, Number(process.env.ORDER_POSITION_LOOKBACK_HOURS) || 24);
}

export function isPositionLimitEnabled(): boolean {
  return positionCap() > 0;
}

export interface PositionLimitDecision {
  ok: boolean;
  /** Net signed position the order would produce (BUY +, SELL −). */
  projected: number;
  cap: number;
  detail?: string;
}

/**
 * Pure decision: would adding `quantity` of `action` to `currentNet` push the
 * absolute net beyond `cap`? A non-positive cap means the guard is disabled
 * (always ok). Kept dependency-free so it is trivially unit-testable.
 */
export function checkPositionLimit(
  currentNet: number,
  action: OrderAction,
  quantity: number,
  cap: number = positionCap()
): PositionLimitDecision {
  if (cap <= 0) return { ok: true, projected: currentNet, cap };
  const projected = currentNet + (action === 'BUY' ? quantity : -quantity);
  if (Math.abs(projected) > cap) {
    return {
      ok: false,
      projected,
      cap,
      detail: `Order would move net position to ${projected} for this symbol (cap ±${cap}); current net ${currentNet}`,
    };
  }
  return { ok: true, projected, cap };
}

export function isOrderType(v: unknown): v is OrderType {
  return typeof v === 'string' && (ORDER_TYPES as readonly string[]).includes(v);
}
export function isTimeInForce(v: unknown): v is TimeInForce {
  return typeof v === 'string' && (TIME_IN_FORCE as readonly string[]).includes(v);
}
export function isOrderAction(v: unknown): v is OrderAction {
  return typeof v === 'string' && (ORDER_ACTIONS as readonly string[]).includes(v);
}
export function isAccountMode(v: unknown): v is AccountMode {
  return typeof v === 'string' && (ACCOUNT_MODES as readonly string[]).includes(v);
}
export function isBroker(v: unknown): v is Broker {
  return typeof v === 'string' && (BROKERS as readonly string[]).includes(v);
}

export interface ValidatedOrder extends Required<
  Pick<OrderInput, 'symbol' | 'action' | 'quantity' | 'order_type' | 'tif' | 'account_mode'>
> {
  broker: Broker;
  limit_price: number | null;
  stop_price: number | null;
  sec_type: string;
  exchange: string;
  currency: string;
}

/**
 * Pure validation. Returns the validated, normalised order or a list of
 * error strings. The caller decides whether to translate that into a 400.
 */
export function validateOrder(
  raw: unknown
): { ok: true; value: ValidatedOrder } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
  if (!symbol) errors.push('symbol is required');
  if (symbol.length > 32) errors.push('symbol too long');

  const action = r.action;
  if (!isOrderAction(action)) errors.push(`action must be one of ${ORDER_ACTIONS.join(', ')}`);

  const quantityNum = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity);
  if (!Number.isFinite(quantityNum) || quantityNum <= 0) {
    errors.push('quantity must be a positive number');
  } else if (quantityNum > ORDER_MAX_QUANTITY) {
    errors.push(`quantity exceeds ORDER_MAX_QUANTITY (${ORDER_MAX_QUANTITY})`);
  }

  const orderType = r.order_type;
  if (!isOrderType(orderType)) errors.push(`order_type must be one of ${ORDER_TYPES.join(', ')}`);

  const tif = r.tif ?? 'DAY';
  if (!isTimeInForce(tif)) errors.push(`tif must be one of ${TIME_IN_FORCE.join(', ')}`);

  const accountMode = r.account_mode ?? 'paper';
  if (!isAccountMode(accountMode)) {
    errors.push(`account_mode must be one of ${ACCOUNT_MODES.join(', ')}`);
  }

  const broker = r.broker ?? DEFAULT_BROKER;
  if (!isBroker(broker)) {
    errors.push(`broker must be one of ${BROKERS.join(', ')}`);
  }

  const needsLimit = orderType === 'LMT' || orderType === 'STP_LMT';
  const needsStop = orderType === 'STP' || orderType === 'STP_LMT';

  let limitPrice: number | null = null;
  if (needsLimit) {
    const lp = typeof r.limit_price === 'number' ? r.limit_price : Number(r.limit_price);
    if (!Number.isFinite(lp) || lp <= 0) {
      errors.push(`limit_price is required and must be > 0 for order_type=${orderType}`);
    } else if (lp > ORDER_MAX_PRICE) {
      errors.push(`limit_price exceeds ORDER_MAX_PRICE (${ORDER_MAX_PRICE})`);
    } else {
      limitPrice = lp;
    }
  } else if (r.limit_price !== undefined && r.limit_price !== null && r.limit_price !== '') {
    errors.push(`limit_price must not be set for order_type=${orderType}`);
  }

  let stopPrice: number | null = null;
  if (needsStop) {
    const sp = typeof r.stop_price === 'number' ? r.stop_price : Number(r.stop_price);
    if (!Number.isFinite(sp) || sp <= 0) {
      errors.push(`stop_price is required and must be > 0 for order_type=${orderType}`);
    } else if (sp > ORDER_MAX_PRICE) {
      errors.push(`stop_price exceeds ORDER_MAX_PRICE (${ORDER_MAX_PRICE})`);
    } else {
      stopPrice = sp;
    }
  } else if (r.stop_price !== undefined && r.stop_price !== null && r.stop_price !== '') {
    errors.push(`stop_price must not be set for order_type=${orderType}`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      symbol,
      action: action as OrderAction,
      quantity: quantityNum,
      order_type: orderType as OrderType,
      tif: tif as TimeInForce,
      account_mode: accountMode as AccountMode,
      broker: broker as Broker,
      limit_price: limitPrice,
      stop_price: stopPrice,
      sec_type: typeof r.sec_type === 'string' && r.sec_type ? r.sec_type : 'STK',
      exchange: typeof r.exchange === 'string' && r.exchange ? r.exchange : 'SMART',
      currency: typeof r.currency === 'string' && r.currency ? r.currency : 'USD',
    },
  };
}

/**
 * Live-trading gate. Returns the (frozen) decision used by both the
 * backend route and the IB-service handler. A second copy in
 * broker_service/orders.py mirrors this — both must agree before any
 * real-money order reaches IB.
 */
export function isLiveTradingEnabled(): boolean {
  return (process.env.LIVE_TRADING_ENABLED ?? 'false').toLowerCase() === 'true';
}

/**
 * Systematic auto-execution gate (Systematic Trading roadmap — A3).
 *
 * Distinct from `LIVE_TRADING_ENABLED`: this one gates the *engine's* ability
 * to turn a signal into an order at all. Paper auto-trading needs only this;
 * live (real-money) auto-trading needs this AND `LIVE_TRADING_ENABLED`. Both
 * default off (defence in depth) — the engine places nothing until an operator
 * explicitly opts in. Read live from the environment so tests (and a global
 * kill) can toggle it per-case.
 */
export function isSystematicExecutionEnabled(): boolean {
  return (process.env.SYSTEMATIC_EXECUTION_ENABLED ?? 'false').toLowerCase() === 'true';
}

/**
 * Global backstop on the number of engine-placed orders per calendar day,
 * across *all* runs. 0 (default) disables the global cap — per-run
 * `max_orders_per_day` still applies. A last-resort circuit breaker so a
 * misbehaving fleet of runs can't flood the broker.
 */
export function systematicMaxOrdersPerDay(): number {
  return Math.max(0, Number(process.env.SYSTEMATIC_MAX_ORDERS_PER_DAY) || 0);
}
