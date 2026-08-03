/**
 * Persistence for the order_audit table.
 *
 * Every order submission attempt — paper or live — gets one row
 * recorded here. The table is an audit log, not a copy of IB's order
 * book: status transitions are written as they come back from the IB
 * service. Used by the blotter UI and by compliance / diagnostics.
 *
 * Mirrors the `Querier` shape used by `backtestRunRepository` so the
 * tests can inject a fake DB.
 */

import type { Querier } from './backtestRunRepository.js';
import type { OrderOperation, ValidatedOrder } from './orderTypes.js';

export interface AuditCreateInput extends ValidatedOrder {
  operation: OrderOperation;
  request_id?: string | null;
}

export interface AuditUpdateInput {
  id: number;
  ib_order_id?: number | null;
  status?: string;
  last_error?: string | null;
  raw_response?: Record<string, unknown> | null;
}

export interface OrderAuditRow {
  id: number;
  submitted_at: string;
  account_mode: string;
  action: string;
  symbol: string;
  sec_type: string;
  exchange: string;
  currency: string;
  quantity: string;
  order_type: string;
  tif: string;
  limit_price: string | null;
  stop_price: string | null;
  operation: string;
  ib_order_id: number | null;
  request_id: string | null;
  status: string;
  last_error: string | null;
  raw_response: Record<string, unknown>;
  updated_at: string;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export class OrderAuditRepository {
  constructor(private db: Querier) {}

  async create(input: AuditCreateInput): Promise<OrderAuditRow> {
    const sql = `
      INSERT INTO order_audit (
        account_mode, action, symbol, sec_type, exchange, currency,
        quantity, order_type, tif, limit_price, stop_price,
        operation, request_id, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, 'submitted'
      )
      RETURNING *
    `;
    const result = await this.db.query(sql, [
      input.account_mode,
      input.action,
      input.symbol,
      input.sec_type,
      input.exchange,
      input.currency,
      input.quantity,
      input.order_type,
      input.tif,
      input.limit_price,
      input.stop_price,
      input.operation,
      input.request_id ?? null,
    ]);
    return result.rows[0] as OrderAuditRow;
  }

  async update(input: AuditUpdateInput): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.ib_order_id !== undefined) {
      params.push(input.ib_order_id);
      sets.push(`ib_order_id = $${params.length}`);
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    if (input.last_error !== undefined) {
      params.push(input.last_error);
      sets.push(`last_error = $${params.length}`);
    }
    if (input.raw_response !== undefined) {
      params.push(JSON.stringify(input.raw_response ?? {}));
      sets.push(`raw_response = $${params.length}::jsonb`);
    }
    if (sets.length === 0) return;
    params.push(input.id);
    const sql = `UPDATE order_audit SET ${sets.join(', ')} WHERE id = $${params.length}`;
    await this.db.query(sql, params);
  }

  /**
   * Net signed exposure for a (symbol, account_mode) implied by the audit
   * log, used by the opt-in position-limit guard.
   *
   * This is a *soft* estimate, not an authoritative IB position:
   *   - Only rows that reached IB (`ib_order_id IS NOT NULL`) are counted;
   *     an order in flight for a few seconds before its id is recorded does
   *     not move the number.
   *   - A modify writes a *new* MODIFY row sharing the original's
   *     `ib_order_id`, so we keep only the latest row per `ib_order_id`
   *     (`DISTINCT ON`) to avoid double-counting a modified order.
   *   - Dead orders (rejected / cancelled / inactive) are excluded.
   *   - Only orders submitted within `lookbackHours` count, so long-expired
   *     DAY orders don't inflate the net.
   *
   * BUY contributes +quantity, SELL −quantity. Returns 0 when nothing matches.
   */
  async netExposure(symbol: string, accountMode: string, lookbackHours: number): Promise<number> {
    const sql = `
      WITH latest AS (
        SELECT DISTINCT ON (ib_order_id) action, quantity, status
        FROM order_audit
        WHERE symbol = $1
          AND account_mode = $2
          AND ib_order_id IS NOT NULL
          AND submitted_at >= NOW() - ($3 * INTERVAL '1 hour')
        ORDER BY ib_order_id, submitted_at DESC
      )
      SELECT COALESCE(
        SUM(CASE WHEN action = 'BUY' THEN quantity ELSE -quantity END), 0
      ) AS net
      FROM latest
      WHERE status NOT IN (
        'rejected', 'cancel_requested', 'cancelled', 'Cancelled', 'ApiCancelled', 'Inactive'
      )
    `;
    const result = await this.db.query(sql, [symbol.toUpperCase(), accountMode, lookbackHours]);
    return Number(result.rows[0]?.net ?? 0);
  }

  async list(
    filter: {
      symbol?: string;
      account_mode?: string;
      status?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<OrderAuditRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.symbol) {
      params.push(filter.symbol.toUpperCase());
      where.push(`symbol = $${params.length}`);
    }
    if (filter.account_mode) {
      params.push(filter.account_mode);
      where.push(`account_mode = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(Math.max(Number(filter.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    params.push(limit, offset);
    const sql = `
      SELECT * FROM order_audit
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY submitted_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await this.db.query(sql, params);
    return result.rows as OrderAuditRow[];
  }
}
