/**
 * Startup guard for the connection-identity migration (Component C — C-4/C7).
 *
 * C-0 widened `order_executions`' uniqueness from `(broker, exec_id)` to
 * `(broker, broker_account, exec_id)`, because **fill ids are only unique
 * within an account**: MT5 allocates deal tickets per terminal starting low,
 * so two accounts genuinely both report deal `12345`.
 *
 * That migration has an ordering hazard which is silent in the worst way. If a
 * second connection is configured while the schema still carries the old key,
 * every colliding fill is swallowed as a duplicate — the row is never written,
 * the position is wrong, realised P&L is wrong, and `max_daily_loss` (measured
 * from that table) under-counts losses and therefore keeps trading. Widening
 * the constraint afterwards recovers nothing: the losing rows were never
 * stored, and only re-polling a window that still covers them would bring them
 * back.
 *
 * So the combination "more than one connection configured" + "pre-C-0 schema"
 * is refused loudly at startup rather than discovered from a P&L that quietly
 * disagrees with the broker.
 */

import type { Querier } from './backtestRunRepository.js';
import { logger } from './logger.js';

export interface SchemaGuardResult {
  ok: boolean;
  /** Set when the check itself could not run — not the same as a failure. */
  indeterminate?: boolean;
  reason?: string;
}

/** Whether `order_executions` carries the connection-scoped unique key. */
async function hasConnectionScopedExecKey(db: Querier): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conrelid = 'order_executions'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (broker, broker_account, exec_id)'
      LIMIT 1`,
    []
  );
  return (result.rows?.length ?? 0) > 0;
}

/**
 * Refuse to run multi-connection on a pre-C-0 schema.
 *
 * `connectionCount` comes from the broker service's configured topology, not
 * from what has traded — the damage happens the moment a second connection
 * starts reporting fills, which is before any row proves it exists.
 */
export async function checkConnectionSchema(
  db: Querier,
  connectionCount: number
): Promise<SchemaGuardResult> {
  let migrated: boolean;
  try {
    migrated = await hasConnectionScopedExecKey(db);
  } catch (err) {
    // An unreachable database is not evidence of a bad schema. Report it as
    // indeterminate so the caller can warn rather than refusing to boot over
    // a transient outage — the app is unusable without a database anyway, and
    // that failure reports itself.
    return {
      ok: true,
      indeterminate: true,
      reason: `could not verify the order_executions unique key: ${String(
        (err as Error)?.message ?? err
      )}`,
    };
  }

  if (migrated) return { ok: true };
  if (connectionCount <= 1) {
    // Single connection on the old schema is exactly the pre-C-0 state, and
    // it is safe: fill ids are unique within one account.
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `${connectionCount} connections are configured, but order_executions still uses the ` +
      'pre-C-0 unique key (broker, exec_id). Fill ids are only unique within an account, so ' +
      'the second account’s colliding fills would be silently dropped — corrupting ' +
      'positions, realised P&L and the max_daily_loss cap. Apply the schema migration before ' +
      'running more than one connection.',
  };
}

/** Log the guard's outcome. Returns false when the process must not continue. */
export function reportSchemaGuard(result: SchemaGuardResult): boolean {
  if (result.indeterminate) {
    logger.warn({ reason: result.reason }, 'connection schema check could not run');
    return true;
  }
  if (!result.ok) {
    logger.error(
      { reason: result.reason },
      'refusing to start: unsafe schema for multi-connection'
    );
    return false;
  }
  return true;
}
