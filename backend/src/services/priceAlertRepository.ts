/**
 * Persistence for the `price_alerts` table.
 *
 * In-app-only price alerts on a watchlist symbol — no delivery channel
 * lives here. The frontend evaluates `condition`/`target_price` against
 * the quote it already polls for the row and calls `trigger()` when
 * crossed; this repository just tracks state so a triggered alert survives
 * a refresh / another tab. Mirrors the `Querier` shape used by
 * `watchlistRepository` so the SQL can be unit-tested without Postgres.
 */

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type AlertCondition = 'above' | 'below';
export type AlertStatus = 'active' | 'triggered' | 'dismissed';

export const ALERT_CONDITIONS: readonly AlertCondition[] = ['above', 'below'];

export interface PriceAlertInput {
  watchlist_item_id: number;
  condition: AlertCondition;
  target_price: number;
}

export interface PriceAlertRow {
  id: number;
  watchlist_item_id: number;
  condition: AlertCondition;
  target_price: string;
  status: AlertStatus;
  triggered_at: string | null;
  triggered_price: string | null;
  created_at: string;
}

export interface PriceAlertListFilter {
  watchlist_item_id?: number;
  status?: AlertStatus;
}

export class PriceAlertRepository {
  constructor(private db: Querier) {}

  async create(input: PriceAlertInput): Promise<PriceAlertRow> {
    const sql = `
      INSERT INTO price_alerts (watchlist_item_id, condition, target_price)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await this.db.query(sql, [
      input.watchlist_item_id,
      input.condition,
      input.target_price,
    ]);
    return result.rows[0] as PriceAlertRow;
  }

  async list(filter: PriceAlertListFilter = {}): Promise<PriceAlertRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.watchlist_item_id !== undefined) {
      params.push(filter.watchlist_item_id);
      where.push(`watchlist_item_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const sql = `
      SELECT * FROM price_alerts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
    `;
    const result = await this.db.query(sql, params);
    return result.rows as PriceAlertRow[];
  }

  async find(id: number): Promise<PriceAlertRow | null> {
    const result = await this.db.query('SELECT * FROM price_alerts WHERE id = $1', [id]);
    return (result.rows[0] as PriceAlertRow | undefined) ?? null;
  }

  /**
   * Flip an active alert to 'triggered'. Only transitions rows that are
   * still 'active' — the `WHERE status = 'active'` guard makes a second
   * trigger call for the same crossing (e.g. two open tabs) a no-op
   * instead of overwriting `triggered_at`/`triggered_price`.
   */
  async trigger(id: number, triggeredPrice: number): Promise<PriceAlertRow | null> {
    const result = await this.db.query(
      `UPDATE price_alerts
          SET status = 'triggered', triggered_at = NOW(), triggered_price = $2
        WHERE id = $1 AND status = 'active'
        RETURNING *`,
      [id, triggeredPrice]
    );
    return (result.rows[0] as PriceAlertRow | undefined) ?? null;
  }

  async dismiss(id: number): Promise<PriceAlertRow | null> {
    const result = await this.db.query(
      `UPDATE price_alerts SET status = 'dismissed' WHERE id = $1 RETURNING *`,
      [id]
    );
    return (result.rows[0] as PriceAlertRow | undefined) ?? null;
  }

  async remove(id: number): Promise<{ removed: boolean }> {
    const result = await this.db.query('DELETE FROM price_alerts WHERE id = $1 RETURNING id', [id]);
    return { removed: (result.rows?.length ?? 0) > 0 };
  }
}
