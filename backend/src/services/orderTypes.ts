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
export const ORDER_MAX_QUANTITY = Math.max(
  1,
  Number(process.env.ORDER_MAX_QUANTITY) || 100_000,
);
export const ORDER_MAX_PRICE = Math.max(0.01, Number(process.env.ORDER_MAX_PRICE) || 1_000_000);

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

export interface ValidatedOrder extends Required<Pick<OrderInput, 'symbol' | 'action' | 'quantity' | 'order_type' | 'tif' | 'account_mode'>> {
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
export function validateOrder(raw: unknown): { ok: true; value: ValidatedOrder } | { ok: false; errors: string[] } {
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
 * ib_service/orders.py mirrors this — both must agree before any
 * real-money order reaches IB.
 */
export function isLiveTradingEnabled(): boolean {
  return (process.env.LIVE_TRADING_ENABLED ?? 'false').toLowerCase() === 'true';
}
