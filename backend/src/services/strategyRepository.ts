/**
 * Persistence for systematic strategies (Systematic Trading roadmap — Phase 2 / A2).
 *
 * Three tables, one repository:
 *   - `strategy_definitions` — a declarative rule-set (shared by backtest + live).
 *   - `strategy_runs`        — a definition pinned to a broker/account_mode + status.
 *   - `strategy_signals`     — every evaluation the runner makes (signal-only in P2).
 *
 * The DB layer is abstracted behind a small `Querier` so the SQL can be
 * unit-tested without Postgres (mirrors `backtestRunRepository.ts`).
 */

import { DEFAULT_BROKER_ACCOUNT } from './orderTypes.js';

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  /** Optional so unit-test fakes stay a single method. `dbService` supplies it;
   *  see `StrategyRepository.inTransaction` for what its absence means. */
  transaction?<T>(callback: (client: Querier) => Promise<T>): Promise<T>;
}

// --------------------------------------------------------------------------- //
// Row / input shapes
// --------------------------------------------------------------------------- //

export interface StrategyDefinitionInput {
  name: string;
  symbol: string;
  timeframe: string;
  broker?: string;
  broker_account?: string;
  sec_type?: string;
  exchange?: string;
  currency?: string;
  rule_set: Record<string, unknown>;
}

export interface StrategyDefinitionRow {
  id: number;
  name: string;
  broker: string;
  broker_account: string;
  symbol: string;
  sec_type: string;
  exchange: string;
  currency: string;
  timeframe: string;
  rule_set: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StrategyRunInput {
  definition_id: number;
  broker?: string;
  broker_account?: string;
  /** The connection's own name for the definition's canonical symbol (C-2),
   *  resolved at deploy time. Omitted means "use the definition's symbol". */
  native_symbol?: string | null;
  account_mode?: string;
  sizing?: Record<string, unknown>;
  risk?: Record<string, unknown>;
}

export interface StrategyRunRow {
  id: number;
  definition_id: number;
  broker: string;
  broker_account: string;
  native_symbol: string | null;
  run_group_id: number | null;
  is_canary: boolean;
  account_mode: string;
  status: string;
  sizing: Record<string, unknown>;
  risk: Record<string, unknown>;
  last_evaluated_at: string | null;
  last_error: string | null;
  started_at: string;
  stopped_at: string | null;
}

/** A run joined with the fields of its definition the runner needs. The
 *  run-level `sizing`/`risk` blocks (carried from the definition at run
 *  creation) drive the A3 execution layer. The instrument fields
 *  (`sec_type`/`exchange`/`currency`) scope the history fetch to the actual
 *  contract, and `broker` doubles as the data source for the evaluation. */
export interface ActiveRun {
  id: number;
  definition_id: number;
  broker: string;
  /** The account within `broker` this run executes on (C-0). One run is one
   *  instrument on one connection. */
  broker_account: string;
  /** What this connection calls the definition's symbol (C-2). Null on runs
   *  created before C-2, which fall back to the definition's own symbol. */
  native_symbol: string | null;
  /** The group this leg belongs to (C-3); null for a standalone run. */
  run_group_id: number | null;
  account_mode: string;
  symbol: string;
  sec_type: string;
  exchange: string;
  currency: string;
  timeframe: string;
  rule_set: Record<string, unknown>;
  sizing: Record<string, unknown>;
  risk: Record<string, unknown>;
}

export interface StrategySignalInput {
  run_id: number;
  bar_time: string; // ISO 8601
  signal: string; // 'buy' | 'sell' | 'none'
  reason?: string | null;
  entry?: boolean;
  exit?: boolean;
  in_session?: boolean;
  position_size?: number;
}

export interface StrategySignalRow {
  id: number;
  run_id: number;
  bar_time: string;
  signal: string;
  reason: string | null;
  entry: boolean;
  exit: boolean;
  in_session: boolean;
  position_size: string;
  acted: boolean;
  order_audit_id: number | null;
  created_at: string;
}

// --------------------------------------------------------------------------- //
// Run groups (C-3)
// --------------------------------------------------------------------------- //

/** One leg of a deploy: which connection, trading what, sized how. */
export interface DeployLeg {
  broker: string;
  broker_account: string;
  native_symbol: string;
  account_mode?: string;
  sizing?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  /** Exactly one leg per deploy must be the canary. */
  is_canary?: boolean;
}

export interface StrategyRunGroupRow {
  id: number;
  definition_id: number;
  status: string; // 'staging' | 'running' | 'stopped'
  settle_seconds: number;
  admitted_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** A group whose canary is running and whose siblings are still pending. */
export interface StagingGroup {
  id: number;
  settle_seconds: number;
  canary_run_id: number;
  canary_status: string;
  canary_started_at: string;
  canary_last_evaluated_at: string | null;
  canary_last_error: string | null;
  pending_legs: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  return n > 0 ? Math.min(Math.max(n, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

export class StrategyRepository {
  constructor(private db: Querier) {}

  /**
   * Run a callback inside a DB transaction when the querier supports one.
   *
   * Every caller here needs atomicity for a real reason — a half-created group
   * means some accounts trade a definition others never got. `dbService`
   * always provides `transaction`, so production is always transactional; the
   * fallback exists only for the single-method fakes the SQL tests inject,
   * where there is no concurrent writer to be atomic against.
   */
  private async inTransaction<T>(callback: (client: Querier) => Promise<T>): Promise<T> {
    if (typeof this.db.transaction === 'function') {
      return this.db.transaction(callback);
    }
    return callback(this.db);
  }

  // ---- definitions ------------------------------------------------------- //

  async createDefinition(input: StrategyDefinitionInput): Promise<StrategyDefinitionRow> {
    const sql = `
      INSERT INTO strategy_definitions
        (name, broker, broker_account, symbol, sec_type, exchange, currency, timeframe, rule_set)
      VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING *
    `;
    const values = [
      input.name,
      input.broker ?? 'ib',
      input.symbol.toUpperCase(),
      (input.sec_type ?? 'STK').toUpperCase(),
      (input.exchange ?? 'SMART').toUpperCase(),
      (input.currency ?? 'USD').toUpperCase(),
      input.timeframe,
      JSON.stringify(input.rule_set ?? {}),
      input.broker_account ?? DEFAULT_BROKER_ACCOUNT,
    ];
    const result = await this.db.query(sql, values);
    return result.rows[0] as StrategyDefinitionRow;
  }

  async listDefinitions(limit?: number, offset?: number): Promise<StrategyDefinitionRow[]> {
    const sql = `
      SELECT * FROM strategy_definitions
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await this.db.query(sql, [clampLimit(limit), Math.max(Number(offset) || 0, 0)]);
    return result.rows as StrategyDefinitionRow[];
  }

  async findDefinition(id: number): Promise<StrategyDefinitionRow | null> {
    const result = await this.db.query('SELECT * FROM strategy_definitions WHERE id = $1', [id]);
    return (result.rows[0] as StrategyDefinitionRow | undefined) ?? null;
  }

  // ---- runs -------------------------------------------------------------- //

  async createRun(input: StrategyRunInput): Promise<StrategyRunRow> {
    const sql = `
      INSERT INTO strategy_runs
        (definition_id, broker, broker_account, native_symbol, account_mode, sizing, risk)
      VALUES ($1, $2, $6, $7, $3, $4::jsonb, $5::jsonb)
      RETURNING *
    `;
    const values = [
      input.definition_id,
      input.broker ?? 'ib',
      input.account_mode ?? 'paper',
      JSON.stringify(input.sizing ?? {}),
      JSON.stringify(input.risk ?? {}),
      input.broker_account ?? DEFAULT_BROKER_ACCOUNT,
      input.native_symbol ?? null,
    ];
    const result = await this.db.query(sql, values);
    return result.rows[0] as StrategyRunRow;
  }

  async listRuns(
    filter: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<StrategyRunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(clampLimit(filter.limit), Math.max(Number(filter.offset) || 0, 0));
    const sql = `
      SELECT * FROM strategy_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await this.db.query(sql, params);
    return result.rows as StrategyRunRow[];
  }

  async findRun(id: number): Promise<StrategyRunRow | null> {
    const result = await this.db.query('SELECT * FROM strategy_runs WHERE id = $1', [id]);
    return (result.rows[0] as StrategyRunRow | undefined) ?? null;
  }

  /** Runs the live runner should evaluate: status='running', joined with the
   *  definition fields it needs (symbol, timeframe, rule_set). */
  async listActiveRuns(): Promise<ActiveRun[]> {
    const sql = `
      SELECT r.id, r.definition_id, r.broker, r.broker_account, r.native_symbol,
             r.run_group_id, r.account_mode, r.sizing, r.risk,
             d.symbol, d.sec_type, d.exchange, d.currency, d.timeframe, d.rule_set
      FROM strategy_runs r
      JOIN strategy_definitions d ON d.id = r.definition_id
      WHERE r.status = 'running'
      ORDER BY r.id ASC
    `;
    const result = await this.db.query(sql, []);
    return result.rows as ActiveRun[];
  }

  /** Move a run to a terminal/paused status. `stopped_at` is set when leaving
   *  'running'; clearing back to 'running' is not supported here (start a new run). */
  async updateRunStatus(id: number, status: string): Promise<StrategyRunRow | null> {
    const sql = `
      UPDATE strategy_runs
      SET status = $2,
          stopped_at = CASE WHEN $2 <> 'running' AND stopped_at IS NULL THEN NOW() ELSE stopped_at END
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.db.query(sql, [id, status]);
    return (result.rows[0] as StrategyRunRow | undefined) ?? null;
  }

  async markRunEvaluated(id: number, atIso: string): Promise<void> {
    await this.db.query(
      'UPDATE strategy_runs SET last_evaluated_at = $2, last_error = NULL WHERE id = $1',
      [id, atIso]
    );
  }

  async markRunError(id: number, error: string): Promise<void> {
    await this.db.query('UPDATE strategy_runs SET last_error = $2 WHERE id = $1', [id, error]);
  }

  // ---- run groups (C-3) --------------------------------------------------- //

  /**
   * Create a group and all its legs **in one transaction**.
   *
   * Atomic creation and staged starting are deliberately different things. A
   * half-created group is broken state — some accounts trading a definition
   * others never got — so creation is all-or-nothing. But *starting* every leg
   * at once means a bad rule-set edit reaches every account simultaneously, so
   * only the canary starts; the rest are created `pending` and admitted later
   * by `admitSettledGroups`.
   *
   * The caller must have resolved each leg's native symbol first (C-2): a leg
   * that cannot resolve is refused before this is called, not created broken.
   */
  async createGroup(input: {
    definition_id: number;
    legs: DeployLeg[];
    settle_seconds?: number;
  }): Promise<{ group: StrategyRunGroupRow; runs: StrategyRunRow[] }> {
    const legs = input.legs ?? [];
    if (legs.length === 0) {
      throw new Error('a deploy needs at least one leg');
    }
    const canaries = legs.filter((l) => l.is_canary);
    if (canaries.length !== 1) {
      // Not a defaultable choice: the canary is the account that takes the
      // first real risk from an unproven edit, so it is named explicitly.
      throw new Error(`exactly one leg must be the canary (got ${canaries.length})`);
    }

    return this.inTransaction(async (client) => {
      const groupResult = await client.query(
        `INSERT INTO strategy_run_groups (definition_id, settle_seconds, status)
         VALUES ($1, $2, 'staging') RETURNING *`,
        [input.definition_id, Math.max(0, Number(input.settle_seconds) || 0)]
      );
      const group = groupResult.rows[0] as StrategyRunGroupRow;

      const runs: StrategyRunRow[] = [];
      for (const leg of legs) {
        const runResult = await client.query(
          `INSERT INTO strategy_runs
             (definition_id, broker, broker_account, native_symbol, account_mode,
              sizing, risk, run_group_id, is_canary, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
           RETURNING *`,
          [
            input.definition_id,
            leg.broker,
            leg.broker_account,
            leg.native_symbol,
            leg.account_mode ?? 'paper',
            JSON.stringify(leg.sizing ?? {}),
            JSON.stringify(leg.risk ?? {}),
            group.id,
            Boolean(leg.is_canary),
            leg.is_canary ? 'running' : 'pending',
          ]
        );
        runs.push(runResult.rows[0] as StrategyRunRow);
      }
      return { group, runs };
    });
  }

  /** Groups whose canary is running and whose siblings are still pending. */
  async listStagingGroups(): Promise<StagingGroup[]> {
    const sql = `
      SELECT g.id,
             g.settle_seconds,
             c.id                 AS canary_run_id,
             c.status             AS canary_status,
             c.started_at         AS canary_started_at,
             c.last_evaluated_at  AS canary_last_evaluated_at,
             c.last_error         AS canary_last_error,
             (SELECT COUNT(*) FROM strategy_runs p
               WHERE p.run_group_id = g.id AND p.status = 'pending') AS pending_legs
        FROM strategy_run_groups g
        JOIN strategy_runs c ON c.run_group_id = g.id AND c.is_canary
       WHERE g.status = 'staging'
       ORDER BY g.id ASC
    `;
    const result = await this.db.query(sql, []);
    return (result.rows as any[]).map((r) => ({
      id: Number(r.id),
      settle_seconds: Number(r.settle_seconds),
      canary_run_id: Number(r.canary_run_id),
      canary_status: String(r.canary_status),
      canary_started_at: String(r.canary_started_at),
      canary_last_evaluated_at: r.canary_last_evaluated_at
        ? String(r.canary_last_evaluated_at)
        : null,
      canary_last_error: r.canary_last_error ? String(r.canary_last_error) : null,
      pending_legs: Number(r.pending_legs) || 0,
    }));
  }

  /** Promote a group's pending legs to running. Returns how many started. */
  async admitGroup(groupId: number): Promise<number> {
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `UPDATE strategy_runs
            SET status = 'running', started_at = NOW()
          WHERE run_group_id = $1 AND status = 'pending'`,
        [groupId]
      );
      await client.query(
        `UPDATE strategy_run_groups
            SET status = 'running', admitted_at = NOW()
          WHERE id = $1`,
        [groupId]
      );
      return (result as { rowCount?: number }).rowCount ?? 0;
    });
  }

  /**
   * Abandon a staging group whose canary failed: its pending legs are stopped
   * rather than left to start later.
   *
   * The canary exists to catch exactly this, so a failure must **not** fall
   * through to admission — the whole point is that the remaining accounts
   * never take the risk.
   */
  async abandonGroup(groupId: number, reason: string): Promise<number> {
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `UPDATE strategy_runs
            SET status = 'stopped', stopped_at = NOW(), last_error = $2
          WHERE run_group_id = $1 AND status = 'pending'`,
        [groupId, reason]
      );
      await client.query(
        `UPDATE strategy_run_groups SET status = 'stopped', last_error = $2 WHERE id = $1`,
        [groupId, reason]
      );
      return (result as { rowCount?: number }).rowCount ?? 0;
    });
  }

  /** Stop every leg of a group — the group-level kill switch. */
  async stopGroup(groupId: number): Promise<number> {
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `UPDATE strategy_runs
            SET status = 'stopped', stopped_at = NOW()
          WHERE run_group_id = $1 AND status IN ('pending', 'running')`,
        [groupId]
      );
      await client.query(`UPDATE strategy_run_groups SET status = 'stopped' WHERE id = $1`, [
        groupId,
      ]);
      return (result as { rowCount?: number }).rowCount ?? 0;
    });
  }

  /**
   * Stop every run on one connection — the per-connection panic stop.
   *
   * Deliberately not group-scoped: when an account is misbehaving the operator
   * wants everything on *that account* halted, whichever groups the legs
   * belong to.
   */
  async stopConnection(broker: string, brokerAccount: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE strategy_runs
          SET status = 'stopped', stopped_at = NOW()
        WHERE broker = $1 AND broker_account = $2 AND status IN ('pending', 'running')`,
      [broker, brokerAccount]
    );
    return (result as { rowCount?: number }).rowCount ?? 0;
  }

  async listGroupRuns(groupId: number): Promise<StrategyRunRow[]> {
    const result = await this.db.query(
      'SELECT * FROM strategy_runs WHERE run_group_id = $1 ORDER BY is_canary DESC, id ASC',
      [groupId]
    );
    return result.rows as StrategyRunRow[];
  }

  // ---- signals ----------------------------------------------------------- //

  /**
   * Insert a signal. The `(run_id, bar_time)` unique constraint enforces the
   * "one decision per closed bar" invariant at the DB level, so a duplicate
   * insert is a no-op — `inserted` reports whether a row was actually written.
   */
  async insertSignal(
    input: StrategySignalInput
  ): Promise<{ inserted: boolean; row: StrategySignalRow | null }> {
    const sql = `
      INSERT INTO strategy_signals
        (run_id, bar_time, signal, reason, entry, exit, in_session, position_size)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (run_id, bar_time) DO NOTHING
      RETURNING *
    `;
    const values = [
      input.run_id,
      input.bar_time,
      input.signal,
      input.reason ?? null,
      input.entry ?? false,
      input.exit ?? false,
      input.in_session ?? true,
      input.position_size ?? 0,
    ];
    const result = await this.db.query(sql, values);
    const row = (result.rows[0] as StrategySignalRow | undefined) ?? null;
    return { inserted: row !== null, row };
  }

  async listSignals(runId: number, limit?: number): Promise<StrategySignalRow[]> {
    const sql = `
      SELECT * FROM strategy_signals
      WHERE run_id = $1
      ORDER BY bar_time DESC
      LIMIT $2
    `;
    const result = await this.db.query(sql, [runId, clampLimit(limit)]);
    return result.rows as StrategySignalRow[];
  }

  async latestSignalBarTime(runId: number): Promise<string | null> {
    const result = await this.db.query(
      'SELECT bar_time FROM strategy_signals WHERE run_id = $1 ORDER BY bar_time DESC LIMIT 1',
      [runId]
    );
    const row = result.rows[0] as { bar_time: string } | undefined;
    return row?.bar_time ?? null;
  }

  // ---- A3 execution layer ------------------------------------------------ //

  /**
   * Link a signal to the order it produced. `acted=true` + `order_audit_id`
   * is the durable dedupe: a restart mid-cycle can't double-fire because the
   * signal row already records that it was executed. Idempotent — only flips
   * a row that hasn't already acted, and reports whether it did.
   */
  async markSignalActed(signalId: number, orderAuditId: number): Promise<{ updated: boolean }> {
    const result = await this.db.query(
      `UPDATE strategy_signals
         SET acted = TRUE, order_audit_id = $2
       WHERE id = $1 AND acted = FALSE
       RETURNING id`,
      [signalId, orderAuditId]
    );
    return { updated: (result.rows?.length ?? 0) > 0 };
  }

  /**
   * How many orders this run has placed today (calendar day, DB clock). Backs
   * the per-run `max_orders_per_day` cap; counts only signals that actually
   * acted (i.e. produced an order), so a day full of `none` signals doesn't
   * consume the budget.
   */
  async countActedSignalsToday(runId: number): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS n
         FROM strategy_signals
        WHERE run_id = $1
          AND acted = TRUE
          AND created_at >= date_trunc('day', NOW())`,
      [runId]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Total orders placed across all runs today — backs the global backstop
   *  (`SYSTEMATIC_MAX_ORDERS_PER_DAY`). */
  async countActedSignalsTodayAllRuns(): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS n
         FROM strategy_signals
        WHERE acted = TRUE
          AND created_at >= date_trunc('day', NOW())`,
      []
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Current status of a run — the kill switch re-check the engine makes
   *  immediately before placing, so a run stopped mid-cycle can't fire. */
  async getRunStatus(id: number): Promise<string | null> {
    const result = await this.db.query('SELECT status FROM strategy_runs WHERE id = $1', [id]);
    const row = result.rows[0] as { status: string } | undefined;
    return row?.status ?? null;
  }
}
