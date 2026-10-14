/**
 * Account-level loss limits that include floating P&L.
 *
 * The per-run and per-connection `max_daily_loss` caps measure **realised**
 * P&L from fills. That misses the loss a broker or prop firm actually acts on:
 * an open position deep in the red has realised nothing, yet the account is
 * already past its limit. These limits measure **equity** (balance plus
 * floating P&L) instead:
 *
 *   - daily equity loss: how far equity sits below where it started the
 *     trading day
 *   - drawdown: how far equity sits below its high-water mark
 *
 * Both gate **entries only**, like every other loss cap: blocking an exit
 * strands the position that caused the loss.
 *
 * The marks (start-of-day equity, high-water mark) are only as good as the
 * observations behind them. The runner records equity every pass, so a mark
 * can miss a peak or a rollover that happened while the backend was down.
 * Where that ambiguity exists, the choice made here is the one that reports
 * the **larger** loss: a limit that trips early is an inconvenience, one that
 * trips late is the loss it exists to prevent.
 */

import { configService } from '../config/configService.js';
import type { EnvLike } from '../config/read.js';
import type { ConnectionLimits } from './executionEngine.js';
import type { Connection } from './orderTypes.js';
import { evaluatePropRules, parsePropRules, type PropMarks } from './propRules.js';

/** What the app knows about a connection's equity. */
export interface EquityMarks {
  /** The trading day the start-of-day figure belongs to, `YYYY-MM-DD`. */
  trading_day: string;
  day_start_equity: number;
  high_water_mark: number;
  /** The most recent observation. */
  equity: number;
  /** Balance (closed P&L only), when the venue reports it. Prop firms measure
   *  some rules from it rather than from equity. */
  balance?: number | null;
  day_start_balance?: number | null;
  balance_high_water_mark?: number | null;
}

/** A connection's equity marks as stored. NUMERIC columns arrive as strings. */
export interface ConnectionEquityRow {
  broker: string;
  broker_account: string;
  trading_day: string;
  day_start_equity: string | number;
  high_water_mark: string | number;
  hwm_at: string;
  last_equity: string | number;
  last_at: string;
  day_start_balance?: string | number | null;
  last_balance?: string | number | null;
  balance_hwm?: string | number | null;
}

export function toEquityMarks(row: ConnectionEquityRow): EquityMarks {
  return {
    trading_day: String(row.trading_day).slice(0, 10),
    day_start_equity: Number(row.day_start_equity),
    high_water_mark: Number(row.high_water_mark),
    equity: Number(row.last_equity),
    balance: numberOrNull(row.last_balance),
    day_start_balance: numberOrNull(row.day_start_balance),
    balance_high_water_mark: numberOrNull(row.balance_hwm),
  };
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface AccountLimitBreach {
  kind: 'daily_equity_loss' | 'drawdown' | 'prop_daily_loss' | 'prop_max_loss';
  /** The loss measured, as a positive amount. */
  loss: number;
  limit: number;
  detail: string;
}

/** The env key suffix for a connection: `mt5:sim-a` → `MT5_SIM_A`. */
export function connectionEnvKey(connection: Connection): string {
  return `${connection.broker}_${connection.brokerAccount}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

function positive(raw: string | undefined): number | null {
  const value = Number(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A connection's declared caps, from the environment rather than the
 * connection manifest: the manifest describes *topology* (where an account is
 * and how to reach it), while a cap is a risk decision that changes far more
 * often than the wiring does.
 *
 * Each cap can be set
 * fleet-wide (`CONNECTION_MAX_DRAWDOWN`) or for one connection
 * (`CONNECTION_MAX_DRAWDOWN__MT5_ICMARKETS`), and the per-connection value
 * wins. All are amounts in the account's currency.
 */
export function connectionLimitsFor(
  connection: Connection,
  env: EnvLike = configService.asEnv()
): ConnectionLimits | null {
  const key = connectionEnvKey(connection);
  const read = (name: string) => positive(env[`${name}__${key}`] ?? env[name]);
  const limits: ConnectionLimits = {};
  const orders = read('CONNECTION_MAX_ORDERS_PER_DAY');
  const loss = read('CONNECTION_MAX_DAILY_LOSS');
  const equityLoss = read('CONNECTION_MAX_DAILY_EQUITY_LOSS');
  const drawdown = read('CONNECTION_MAX_DRAWDOWN');
  if (orders != null) limits.max_orders_per_day = orders;
  if (loss != null) limits.max_daily_loss = loss;
  if (equityLoss != null) limits.max_daily_equity_loss = equityLoss;
  if (drawdown != null) limits.max_drawdown = drawdown;
  // Prop rules are per account only: two funded accounts never share a firm's
  // limits, so there is no fleet-wide default to fall back to.
  const prop = env[`PROP_RULES__${key}`];
  if (prop && prop.trim()) {
    try {
      limits.prop = parsePropRules(prop);
    } catch (err) {
      throw new Error(`PROP_RULES__${key} ${(err as Error).message}`);
    }
  }
  return Object.keys(limits).length > 0 ? limits : null;
}

/** Whether the limits include any equity-based cap. */
export function hasEquityLimits(limits: ConnectionLimits | null | undefined): boolean {
  return Boolean(limits && (limits.max_daily_equity_loss || limits.max_drawdown || limits.prop));
}

/**
 * The trading day `at` falls in, as `YYYY-MM-DD`, in `TRADING_DAY_TIMEZONE`
 * (an IANA zone, UTC by default). Brokers and prop firms roll the day at
 * their server's midnight, which is rarely UTC, so this is what lines the
 * app's "today" up with theirs.
 */
export function tradingDay(at: Date, timeZone = tradingDayTimeZone()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function tradingDayTimeZone(env: EnvLike = configService.asEnv()): string {
  return (env.TRADING_DAY_TIMEZONE || 'UTC').trim() || 'UTC';
}

/** Every equity limit the marks breach. Pure. */
export function evaluateAccountLimits(
  marks: EquityMarks,
  limits: ConnectionLimits | null | undefined
): AccountLimitBreach[] {
  const breaches: AccountLimitBreach[] = [];
  if (!limits) return breaches;

  const dailyCap = Number(limits.max_daily_equity_loss) || 0;
  if (dailyCap > 0) {
    const loss = marks.day_start_equity - marks.equity;
    if (loss >= dailyCap) {
      breaches.push({
        kind: 'daily_equity_loss',
        loss,
        limit: dailyCap,
        detail:
          `equity ${round(marks.equity)} is ${round(loss)} below the day's start of ` +
          `${round(marks.day_start_equity)} (limit ${dailyCap})`,
      });
    }
  }

  const drawdownCap = Number(limits.max_drawdown) || 0;
  if (drawdownCap > 0) {
    const loss = marks.high_water_mark - marks.equity;
    if (loss >= drawdownCap) {
      breaches.push({
        kind: 'drawdown',
        loss,
        limit: drawdownCap,
        detail:
          `equity ${round(marks.equity)} is ${round(loss)} below its high-water mark of ` +
          `${round(marks.high_water_mark)} (limit ${drawdownCap})`,
      });
    }
  }

  if (limits.prop) {
    for (const state of evaluatePropRules(propMarks(marks), limits.prop)) {
      if (!state.stopped) continue;
      breaches.push({
        kind: state.kind,
        loss: state.allowance - state.room,
        limit: state.allowance - state.stop_at,
        detail: state.detail,
      });
    }
  }
  return breaches;
}

/** The marks in the shape the prop rules read. */
export function propMarks(marks: EquityMarks): PropMarks {
  return {
    equity: marks.equity,
    balance: marks.balance ?? null,
    day_start_equity: marks.day_start_equity,
    day_start_balance: marks.day_start_balance ?? null,
    equity_high_water_mark: marks.high_water_mark,
    balance_high_water_mark: marks.balance_high_water_mark ?? null,
  };
}

function round(value: number): string {
  return value.toFixed(2);
}
