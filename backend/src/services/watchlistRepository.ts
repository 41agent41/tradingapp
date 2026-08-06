/**
 * Persistence for the `watchlist_items` table.
 *
 * A single flat watchlist (no per-user scoping — see the schema comment).
 * The DB layer is abstracted behind the same small `Querier` shape used by
 * `strategyRepository` / `backtestRunRepository` so the SQL can be
 * unit-tested without Postgres.
 */

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface WatchlistItemInput {
  symbol: string;
  broker?: string;
  sec_type?: string;
  exchange?: string;
  currency?: string;
  notes?: string | null;
}

export interface WatchlistItemRow {
  id: number;
  broker: string;
  symbol: string;
  sec_type: string;
  exchange: string;
  currency: string;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export class WatchlistRepository {
  constructor(private db: Querier) {}

  async list(): Promise<WatchlistItemRow[]> {
    const result = await this.db.query(
      'SELECT * FROM watchlist_items ORDER BY sort_order ASC, id ASC'
    );
    return result.rows as WatchlistItemRow[];
  }

  /**
   * Add a symbol. `ON CONFLICT ... DO UPDATE` on the
   * `(broker, symbol, sec_type, exchange, currency)` unique constraint makes
   * this idempotent — adding an already-watched contract returns the
   * existing row (touching `notes` if a new one was supplied) rather than
   * erroring, and `added` reports which happened so the route can pick the
   * right status code.
   */
  async add(input: WatchlistItemInput): Promise<{ added: boolean; row: WatchlistItemRow }> {
    const sql = `
      INSERT INTO watchlist_items (broker, symbol, sec_type, exchange, currency, notes, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6,
        COALESCE((SELECT MAX(sort_order) + 1 FROM watchlist_items), 0))
      ON CONFLICT ON CONSTRAINT watchlist_items_unique
        DO UPDATE SET notes = COALESCE(EXCLUDED.notes, watchlist_items.notes)
      RETURNING *, (xmax = 0) AS inserted
    `;
    const values = [
      input.broker ?? 'ib',
      input.symbol.toUpperCase(),
      input.sec_type ?? 'STK',
      input.exchange ?? 'SMART',
      input.currency ?? 'USD',
      input.notes ?? null,
    ];
    const result = await this.db.query(sql, values);
    const { inserted, ...row } = result.rows[0] as WatchlistItemRow & { inserted: boolean };
    return { added: inserted, row: row as WatchlistItemRow };
  }

  async remove(id: number): Promise<{ removed: boolean }> {
    const result = await this.db.query('DELETE FROM watchlist_items WHERE id = $1 RETURNING id', [
      id,
    ]);
    return { removed: (result.rows?.length ?? 0) > 0 };
  }
}
