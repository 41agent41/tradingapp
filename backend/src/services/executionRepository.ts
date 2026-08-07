/**
 * Persistence for the `order_executions` table — the fills feed.
 *
 * `order_audit` is a log of submissions; this is a log of **fills**. Keeping
 * them in separate tables (rather than folding fills into the audit row) is
 * deliberate: one order can produce many fills, and a fill can exist with no
 * order of ours behind it at all — a trade placed by hand at the venue is real
 * and belongs in the position.
 *
 * Two invariants live here:
 *
 *  - **Idempotent ingest.** The poller re-fetches an overlapping window every
 *    tick, so `(broker, exec_id)` conflicts are expected, not exceptional. A
 *    conflicting row updates only the fields that legitimately arrive late
 *    (commission, realised P&L, the attribution links) and never rewrites the
 *    trade itself.
 *  - **Attribution is resolved in SQL, at write time.** A fill knows only the
 *    venue's order id; the chain to a strategy run is
 *    `broker_order_id → order_audit.ib_order_id → strategy_signals.order_audit_id
 *    → run_id`. Doing it in the insert means a reader never has to re-derive it,
 *    and `relinkOrphans()` closes the race where a fill is polled before its
 *    audit row has recorded the venue's order id.
 *
 * Mirrors the `Querier` shape used by the other repositories so the SQL is
 * unit-testable with a fake DB.
 */

import type { Querier } from './backtestRunRepository.js';
import { realisedPnl, netPositions, type Fill, type RealisedPnlResult } from './realisedPnl.js';

export interface ExecutionInput {
  broker: string;
  account_mode: string;
  exec_id: string;
  broker_order_id?: string | null;
  symbol: string;
  side: string; // 'BUY' | 'SELL'
  quantity: number;
  price: number;
  commission?: number | null;
  realized_pnl?: number | null;
  currency?: string;
  executed_at: string; // ISO 8601
  raw?: Record<string, unknown> | null;
}

export interface ExecutionRow {
  id: number;
  broker: string;
  account_mode: string;
  exec_id: string;
  broker_order_id: string | null;
  order_audit_id: number | null;
  run_id: number | null;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  commission: string | null;
  realized_pnl: string | null;
  currency: string;
  executed_at: string;
  created_at: string;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  return n > 0 ? Math.min(Math.max(n, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

export class ExecutionRepository {
  constructor(private db: Querier) {}

  /**
   * Insert one fill, resolving its attribution links from the venue's order id.
   *
   * Returns whether the row was newly inserted — the poller reports that as
   * "new fills this tick", which is only meaningful because a re-delivered fill
   * updates instead of inserting.
   *
   * The conflict path updates commission / realised P&L / the links with
   * `COALESCE(EXCLUDED.…, existing)`: IB reports a fill's commission on a
   * separate callback that can land a poll later, so a late value must be able
   * to fill a NULL — but a later poll that has *lost* the value must never
   * blank one already recorded.
   */
  async upsert(input: ExecutionInput): Promise<{ inserted: boolean; row: ExecutionRow | null }> {
    const sql = `
      WITH audit AS (
        SELECT id, account_mode FROM order_audit
         WHERE broker = $1
           AND ib_order_id IS NOT NULL
           AND ib_order_id::text = $4
         ORDER BY submitted_at DESC
         LIMIT 1
      ), attribution AS (
        SELECT a.id AS audit_id,
               a.account_mode,
               (SELECT s.run_id FROM strategy_signals s
                 WHERE s.order_audit_id = a.id
                 ORDER BY s.id DESC LIMIT 1) AS run_id
          FROM audit a
      )
      INSERT INTO order_executions (
        broker, account_mode, exec_id, broker_order_id, order_audit_id, run_id,
        symbol, side, quantity, price, commission, realized_pnl, currency,
        executed_at, raw
      )
      SELECT $1,
             -- A venue reports fills without saying which account mode they
             -- belong to, so the linked order is the authority when there is
             -- one; otherwise (a manual trade) fall back to the poller's
             -- configured default.
             COALESCE((SELECT account_mode FROM attribution), $2),
             $3, $4,
             (SELECT audit_id FROM attribution),
             (SELECT run_id FROM attribution),
             $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
      ON CONFLICT (broker, exec_id) DO UPDATE SET
        commission     = COALESCE(EXCLUDED.commission, order_executions.commission),
        realized_pnl   = COALESCE(EXCLUDED.realized_pnl, order_executions.realized_pnl),
        order_audit_id = COALESCE(order_executions.order_audit_id, EXCLUDED.order_audit_id),
        run_id         = COALESCE(order_executions.run_id, EXCLUDED.run_id)
      RETURNING *, (xmax = 0) AS inserted
    `;
    const result = await this.db.query(sql, [
      input.broker,
      input.account_mode,
      input.exec_id,
      input.broker_order_id ?? null,
      input.symbol.toUpperCase(),
      String(input.side).toUpperCase(),
      Math.abs(Number(input.quantity)),
      Number(input.price),
      input.commission ?? null,
      input.realized_pnl ?? null,
      (input.currency ?? 'USD').toUpperCase(),
      input.executed_at,
      JSON.stringify(input.raw ?? {}),
    ]);
    const row = (result.rows[0] as (ExecutionRow & { inserted?: boolean }) | undefined) ?? null;
    return { inserted: row?.inserted === true, row };
  }

  /**
   * Resolve the attribution links for fills that arrived before their audit
   * row recorded the venue's order id.
   *
   * Without this, a fill polled inside the few seconds between "order sent" and
   * "venue order id written" would stay permanently unattributed — its P&L
   * would never count against the run that caused it, which is precisely the
   * cap `max_daily_loss` is meant to enforce. Returns the number of rows linked.
   */
  async relinkOrphans(lookbackHours = 48): Promise<number> {
    const sql = `
      UPDATE order_executions e
         SET order_audit_id = a.id,
             run_id = (
               SELECT s.run_id FROM strategy_signals s
                WHERE s.order_audit_id = a.id
                ORDER BY s.id DESC LIMIT 1
             )
        FROM order_audit a
       WHERE e.order_audit_id IS NULL
         AND e.broker_order_id IS NOT NULL
         AND e.executed_at >= NOW() - ($1 * INTERVAL '1 hour')
         AND a.broker = e.broker
         AND a.ib_order_id IS NOT NULL
         AND a.ib_order_id::text = e.broker_order_id
    `;
    const result = await this.db.query(sql, [lookbackHours]);
    return (result as { rowCount?: number }).rowCount ?? result.rows?.length ?? 0;
  }

  /** Fills in **execution order** — the order the P&L reducer requires. */
  async listForPnl(filter: {
    broker?: string;
    account_mode?: string;
    symbol?: string;
    run_id?: number;
    since?: string;
  }): Promise<Fill[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.broker) {
      params.push(filter.broker);
      where.push(`broker = $${params.length}`);
    }
    if (filter.account_mode) {
      params.push(filter.account_mode);
      where.push(`account_mode = $${params.length}`);
    }
    if (filter.symbol) {
      params.push(filter.symbol.toUpperCase());
      where.push(`symbol = $${params.length}`);
    }
    if (filter.run_id != null) {
      params.push(filter.run_id);
      where.push(`run_id = $${params.length}`);
    }
    if (filter.since) {
      params.push(filter.since);
      where.push(`executed_at >= $${params.length}`);
    }
    const sql = `
      SELECT symbol, side, quantity, price, commission
        FROM order_executions
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY executed_at ASC, id ASC
    `;
    const result = await this.db.query(sql, params);
    return result.rows as Fill[];
  }

  /**
   * Realised P&L for a run **today** (calendar day, DB clock) — what the
   * `max_daily_loss` cap is measured against.
   *
   * Scoped to fills attributed to this run, not to the whole account: a second
   * run on the same symbol, or a manual trade, is not this run's loss and must
   * not consume its budget.
   */
  async realisedPnlTodayForRun(runId: number): Promise<RealisedPnlResult> {
    const result = await this.db.query(
      `SELECT symbol, side, quantity, price, commission
         FROM order_executions
        WHERE run_id = $1
          AND executed_at >= date_trunc('day', NOW())
        ORDER BY executed_at ASC, id ASC`,
      [runId]
    );
    return realisedPnl(result.rows as Fill[]);
  }

  /**
   * Fill-authoritative net position for one (broker, symbol, account_mode).
   *
   * Note this is the **account's** position at that venue, not one run's share
   * of it — a fill with no `run_id` (a manual trade) counts, because it really
   * is exposure. Callers that need per-run attribution scope by `run_id`.
   */
  async netPosition(broker: string, symbol: string, accountMode: string): Promise<number> {
    const fills = await this.listForPnl({ broker, symbol, account_mode: accountMode });
    return netPositions(fills)[symbol.toUpperCase()] ?? 0;
  }

  async list(
    filter: {
      broker?: string;
      account_mode?: string;
      symbol?: string;
      run_id?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<ExecutionRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.broker) {
      params.push(filter.broker);
      where.push(`broker = $${params.length}`);
    }
    if (filter.account_mode) {
      params.push(filter.account_mode);
      where.push(`account_mode = $${params.length}`);
    }
    if (filter.symbol) {
      params.push(filter.symbol.toUpperCase());
      where.push(`symbol = $${params.length}`);
    }
    if (filter.run_id != null) {
      params.push(filter.run_id);
      where.push(`run_id = $${params.length}`);
    }
    params.push(clampLimit(filter.limit), Math.max(Number(filter.offset) || 0, 0));
    const sql = `
      SELECT * FROM order_executions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY executed_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await this.db.query(sql, params);
    return result.rows as ExecutionRow[];
  }

  /** Distinct venues the app has actually traded at recently — what the poller
   *  iterates, so an unconfigured broker is never polled. */
  async activeBrokers(lookbackHours = 168): Promise<string[]> {
    const result = await this.db.query(
      `SELECT DISTINCT broker FROM order_audit
        WHERE submitted_at >= NOW() - ($1 * INTERVAL '1 hour')
        UNION
       SELECT DISTINCT broker FROM strategy_runs WHERE status = 'running'`,
      [lookbackHours]
    );
    return (result.rows as { broker: string }[]).map((r) => r.broker).filter(Boolean);
  }
}
