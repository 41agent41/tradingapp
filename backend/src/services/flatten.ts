/**
 * Flatten a connection: close every position the venue reports on it (E-6).
 *
 * The last step of the kill switch's escalation (notify, halt, flatten). With
 * `KILL_SWITCH_ACTION=flatten`, a critical trigger halts new entries on the
 * connection and then closes what is open, at market. The operator can also
 * do it by hand from the Fleet panel.
 *
 * The account is the unit, not the run: every trigger describes the account
 * (its stops, its fills, its equity), so a position a run did not open, a
 * manual trade included, is closed too.
 *
 * Each close goes through the same audited order path as any other order, so
 * it is in `order_audit` and its fill is ingested like any exit. Positions are
 * read fresh from the venue: closing a stale size would open a position the
 * other way. When the venue cannot be read, nothing is sent and the caller is
 * told, because an unreadable account is not a flat one.
 */

import axios from 'axios';
import { roundToStep, type InstrumentSpec } from './orderSizing.js';
import { validateOrder, type Connection, type ValidatedOrder } from './orderTypes.js';
import { submitCreateOrder, type SubmitCreateOutcome } from './orderService.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

export interface FlattenDeps {
  /** Every open position at the venue, signed. Throws when it cannot be read. */
  positions(connection: Connection): Promise<Array<{ symbol: string; size: number }>>;
  /** The size step to close on. Null falls back to whole units. */
  instrumentSpec?(connection: Connection, symbol: string): Promise<InstrumentSpec | null>;
  submitOrder(order: ValidatedOrder, requestId: string | null): Promise<SubmitCreateOutcome>;
}

export interface FlattenResult {
  closed: Array<{ symbol: string; action: 'BUY' | 'SELL'; quantity: number; audit_id: number }>;
  failed: Array<{ symbol: string; error: string }>;
  /** Set when the positions could not be read, so nothing was attempted. */
  error: string | null;
}

/** Close every open position on the connection. Never throws. */
export async function flattenConnection(
  deps: FlattenDeps,
  connection: Connection,
  accountMode: string,
  requestTag: string
): Promise<FlattenResult> {
  const result: FlattenResult = { closed: [], failed: [], error: null };
  let positions: Array<{ symbol: string; size: number }>;
  try {
    positions = await deps.positions(connection);
  } catch (err) {
    result.error = `positions could not be read (${errorText(err)})`;
    return result;
  }

  for (const { symbol, size } of positions) {
    if (!Number.isFinite(size) || size === 0) continue;
    const action = size > 0 ? 'SELL' : 'BUY';
    let spec: InstrumentSpec | null = null;
    try {
      spec = deps.instrumentSpec ? await deps.instrumentSpec(connection, symbol) : null;
    } catch {
      spec = null;
    }
    const step = Number(spec?.sizeStep) > 0 ? Number(spec?.sizeStep) : 1;
    const quantity = roundToStep(Math.abs(size), step);
    if (quantity <= 0) {
      result.failed.push({ symbol, error: `size ${size} rounds to nothing on step ${step}` });
      continue;
    }
    const v = validateOrder({
      symbol,
      action,
      quantity,
      order_type: 'MKT',
      tif: 'DAY',
      account_mode: accountMode,
      broker: connection.broker,
      broker_account: connection.brokerAccount,
    });
    if (!v.ok) {
      result.failed.push({ symbol, error: `validation failed: ${v.errors.join('; ')}` });
      continue;
    }
    try {
      const outcome = await deps.submitOrder(v.value, `${requestTag}:flatten:${symbol}`);
      if (outcome.ok) result.closed.push({ symbol, action, quantity, audit_id: outcome.auditId });
      else result.failed.push({ symbol, error: `not placed (${outcome.kind})` });
    } catch (err) {
      result.failed.push({ symbol, error: errorText(err) });
    }
  }
  return result;
}

/** One line for an alert or a log: what was closed and what was not. */
export function describeFlatten(result: FlattenResult): string {
  if (result.error) return `Nothing was closed: ${result.error}. Close the positions by hand.`;
  const parts: string[] = [];
  if (result.closed.length === 0 && result.failed.length === 0)
    parts.push('No positions were open.');
  if (result.closed.length > 0) {
    parts.push(
      'Closed at market: ' +
        result.closed.map((c) => `${c.symbol} ${c.action} ${c.quantity}`).join(', ') +
        '.'
    );
  }
  if (result.failed.length > 0) {
    parts.push(
      'NOT closed, close by hand: ' +
        result.failed.map((f) => `${f.symbol} (${f.error})`).join(', ') +
        '.'
    );
  }
  return parts.join(' ');
}

export function flattenSucceeded(result: FlattenResult): boolean {
  return !result.error && result.failed.length === 0;
}

/** The venue-backed dependencies, read through the broker service. */
export function defaultFlattenDeps(): FlattenDeps {
  return {
    positions: async (connection) => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/account/positions`, {
        params: { broker: connection.broker, account: connection.brokerAccount },
        timeout: 30000,
        headers: { Connection: 'close' },
      });
      if (!Array.isArray(response.data)) throw new Error('positions response is not a list');
      return response.data.map((pos: any) => ({
        symbol: String(pos?.symbol ?? ''),
        size: Number(pos?.position),
      }));
    },
    instrumentSpec: async (connection, symbol) => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/instrument/spec`, {
        params: { broker: connection.broker, account: connection.brokerAccount, symbol },
        timeout: 30000,
        headers: { Connection: 'close' },
      });
      const data = response.data ?? {};
      return {
        unit: String(data.unit || 'shares'),
        minSize: Number(data.min_size) || 1,
        sizeStep: Number(data.size_step) || 1,
        maxSize: data.max_size == null ? null : Number(data.max_size),
        contractSize: Number(data.contract_size) || 1,
      };
    },
    submitOrder: (order, requestId) => submitCreateOrder(order, requestId),
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
