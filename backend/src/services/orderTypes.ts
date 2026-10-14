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

import { configService } from '../config/configService.js';
import { BROKERS, type Broker } from './brokers.js';

export { BROKERS };
export type { Broker };

/** A setting from `.env` or the Settings page; see config/configService.ts. */
function setting(key: string): string | undefined {
  return configService.get(key);
}

/**
 * Broker priority, highest first: brokers with a direct API (OANDA, and those
 * that follow it), then MT5, IB and Alpaca. Mirrors `BROKER_PRIORITY` in
 * `broker_service/connections.py`, which owns the choice of default.
 */
export const BROKER_PRIORITY: readonly Broker[] = ['oanda', 'mt5', 'ib', 'alpaca'];

/**
 * What a persisted row with no broker means. Every row written before the
 * `broker` column existed was an IB row (the column's database default is
 * still 'ib'), so this is history, not the default for new work.
 */
export const LEGACY_BROKER: Broker = 'ib';

let resolvedDefaultBroker: Broker | null = null;

/**
 * The broker used when a request names none: `DEFAULT_BROKER` when it names
 * a broker, else the broker service's choice (the highest-priority configured
 * broker, kept current by `services/brokerDefault.ts`), else the top of
 * {@link BROKER_PRIORITY} until the broker service has answered once.
 */
export function defaultBroker(): Broker {
  const explicit = (setting('DEFAULT_BROKER') || '').trim().toLowerCase();
  if (isBroker(explicit)) return explicit;
  return resolvedDefaultBroker ?? BROKER_PRIORITY[0];
}

/** Record the broker service's default. Anything that is not a broker is ignored. */
export function setResolvedDefaultBroker(value: unknown): void {
  if (isBroker(value)) resolvedDefaultBroker = value;
}

/**
 * The **account** within a platform (Component C — C-0). `broker` names the
 * protocol; this names which account on it. Together they address a
 * *connection*: `mt5:pepperstone-live`.
 *
 * This is a separate field rather than an overload of `broker` deliberately.
 * Encoding it as `mt5:alias` would break every `isBroker()` call site, and
 * the column is VARCHAR(16). Keeping the platform enum closed and the account
 * free-form also means adding an account is configuration, while adding a
 * platform stays a code change — which is the right asymmetry.
 *
 * Free-form but constrained: it appears in log lines, request ids and index
 * keys, so it is lowercased and restricted to a URL/identifier-safe charset.
 */
export const DEFAULT_BROKER_ACCOUNT = 'default';
const BROKER_ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const BROKER_ACCOUNT_MAX_LENGTH = 64;

/** Normalise a `broker_account` value, or return null when it is unusable. */
export function normaliseBrokerAccount(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return DEFAULT_BROKER_ACCOUNT;
  if (typeof v !== 'string') return null;
  const account = v.trim().toLowerCase();
  if (!account) return DEFAULT_BROKER_ACCOUNT;
  if (account.length > BROKER_ACCOUNT_MAX_LENGTH) return null;
  return BROKER_ACCOUNT_PATTERN.test(account) ? account : null;
}

/** Canonical `platform:account` label for logs, request ids and UI. */
export function connectionLabel(broker: string, brokerAccount: string): string {
  return `${broker}:${brokerAccount}`;
}

/**
 * One addressable account at one platform — the unit everything venue-facing
 * is keyed by. Camel-cased because it is an in-code value; the database
 * columns stay `broker` / `broker_account`, and repositories map between them.
 */
export interface Connection {
  broker: string;
  brokerAccount: string;
}

/** The connection a persisted row (order, run, fill) belongs to. */
export function connectionOf(row: {
  broker?: string | null;
  broker_account?: string | null;
}): Connection {
  return {
    broker: row.broker || LEGACY_BROKER,
    brokerAccount: row.broker_account || DEFAULT_BROKER_ACCOUNT,
  };
}

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
  /** Protective stop attached to the resulting **position** (E-2). Distinct
   *  from `stop_price`, which is the *trigger* of a STP order. */
  stop_loss?: number | null;
  take_profit?: number | null;
  account_mode: AccountMode;
  broker?: Broker;
  broker_account?: string;
  sec_type?: string;
  exchange?: string;
  currency?: string;
}

/**
 * Quantity / price safety caps. Bigger orders are not *wrong* but you don't
 * want a fat-finger sending 1e6 shares of MSFT by accident.
 *
 * Set on the Settings page (or in .env), read per order:
 *   ORDER_MAX_QUANTITY  (defaults to 100_000)
 *   ORDER_MAX_PRICE     (defaults to 1_000_000)
 */
export function orderMaxQuantity(): number {
  return Math.max(1, Number(setting('ORDER_MAX_QUANTITY')) || 100_000);
}

export function orderMaxPrice(): number {
  return Math.max(0.01, Number(setting('ORDER_MAX_PRICE')) || 1_000_000);
}

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
  return Math.max(0, Number(setting('ORDER_MAX_POSITION')) || 0);
}

export function positionLookbackHours(): number {
  return Math.max(1, Number(setting('ORDER_POSITION_LOOKBACK_HOURS')) || 24);
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
  broker_account: string;
  limit_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
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

  // MT5 symbols are case-sensitive and brokers use lowercase suffixes
  // (`EURUSDm`, `EURUSD.a`), so an MT5 order keeps the venue's spelling.
  // Every other venue gets upper case, as before. Storage and matching inside
  // the app normalise to upper case at the repository layer.
  const rawSymbol = typeof r.symbol === 'string' ? r.symbol.trim() : '';
  const symbol = r.broker === 'mt5' ? rawSymbol : rawSymbol.toUpperCase();
  if (!symbol) errors.push('symbol is required');
  if (symbol.length > 32) errors.push('symbol too long');

  const action = r.action;
  if (!isOrderAction(action)) errors.push(`action must be one of ${ORDER_ACTIONS.join(', ')}`);

  const quantityNum = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity);
  if (!Number.isFinite(quantityNum) || quantityNum <= 0) {
    errors.push('quantity must be a positive number');
  } else if (quantityNum > orderMaxQuantity()) {
    errors.push(`quantity exceeds ORDER_MAX_QUANTITY (${orderMaxQuantity()})`);
  }

  const orderType = r.order_type;
  if (!isOrderType(orderType)) errors.push(`order_type must be one of ${ORDER_TYPES.join(', ')}`);

  const tif = r.tif ?? 'DAY';
  if (!isTimeInForce(tif)) errors.push(`tif must be one of ${TIME_IN_FORCE.join(', ')}`);

  const accountMode = r.account_mode ?? 'paper';
  if (!isAccountMode(accountMode)) {
    errors.push(`account_mode must be one of ${ACCOUNT_MODES.join(', ')}`);
  }

  const broker = r.broker ?? defaultBroker();
  if (!isBroker(broker)) {
    errors.push(`broker must be one of ${BROKERS.join(', ')}`);
  }

  const brokerAccount = normaliseBrokerAccount(r.broker_account);
  if (brokerAccount === null) {
    errors.push(
      `broker_account must be at most ${BROKER_ACCOUNT_MAX_LENGTH} characters ` +
        'of [a-z0-9_-], starting alphanumeric'
    );
  }

  const needsLimit = orderType === 'LMT' || orderType === 'STP_LMT';
  const needsStop = orderType === 'STP' || orderType === 'STP_LMT';

  let limitPrice: number | null = null;
  if (needsLimit) {
    const lp = typeof r.limit_price === 'number' ? r.limit_price : Number(r.limit_price);
    if (!Number.isFinite(lp) || lp <= 0) {
      errors.push(`limit_price is required and must be > 0 for order_type=${orderType}`);
    } else if (lp > orderMaxPrice()) {
      errors.push(`limit_price exceeds ORDER_MAX_PRICE (${orderMaxPrice()})`);
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
    } else if (sp > orderMaxPrice()) {
      errors.push(`stop_price exceeds ORDER_MAX_PRICE (${orderMaxPrice()})`);
    } else {
      stopPrice = sp;
    }
  } else if (r.stop_price !== undefined && r.stop_price !== null && r.stop_price !== '') {
    errors.push(`stop_price must not be set for order_type=${orderType}`);
  }

  // Protective stop / target on the resulting position. Validated like any
  // other price so a fat-fingered stop cannot slip through, but optional —
  // most orders have none.
  const protective = (field: 'stop_loss' | 'take_profit'): number | null => {
    const raw = r[field];
    if (raw === undefined || raw === null || raw === '') return null;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${field} must be a positive price when supplied`);
      return null;
    }
    if (value > orderMaxPrice()) {
      errors.push(`${field} exceeds ORDER_MAX_PRICE (${orderMaxPrice()})`);
      return null;
    }
    return value;
  };
  const stopLoss = protective('stop_loss');
  const takeProfit = protective('take_profit');

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
      broker_account: brokerAccount as string,
      limit_price: limitPrice,
      stop_price: stopPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
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
  if ((setting('LIVE_TRADING_ENABLED') ?? 'false').toLowerCase() !== 'true') return false;
  // Set in .env, the startup check already refuses to run without the trader
  // role and MFA. Set on the Settings page, the save refuses too, but either
  // could be removed later; then the gate closes rather than leave live
  // orders protected by the browser password alone.
  if (configService.source('LIVE_TRADING_ENABLED') === 'environment') return true;
  return liveTradingSafeguardsMissing().length === 0;
}

/**
 * What live trading still needs before the Settings page may turn it on: a
 * trading token (the trader role) and an order MFA secret. Empty when both
 * are set.
 */
export function liveTradingSafeguardsMissing(): string[] {
  const missing: string[] = [];
  if (!(setting('TRADING_TOKENS') || '').split(',').some((t) => t.trim())) {
    missing.push('a trading token');
  }
  if (!(setting('ORDER_MFA_SECRET') || '').trim()) missing.push('an order MFA secret');
  return missing;
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
  return (setting('SYSTEMATIC_EXECUTION_ENABLED') ?? 'false').toLowerCase() === 'true';
}

/**
 * Global backstop on the number of engine-placed orders per calendar day,
 * across *all* runs. 0 (default) disables the global cap — per-run
 * `max_orders_per_day` still applies. A last-resort circuit breaker so a
 * misbehaving fleet of runs can't flood the broker.
 */
export function systematicMaxOrdersPerDay(): number {
  return Math.max(0, Number(setting('SYSTEMATIC_MAX_ORDERS_PER_DAY')) || 0);
}
