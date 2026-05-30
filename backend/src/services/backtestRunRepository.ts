/**
 * Persistence for backtest runs (GAP_ANALYSIS §5).
 *
 * Single-table store keyed on the `backtest_runs` schema. The DB layer is
 * abstracted behind a small `Querier` interface so the route can unit-test
 * the SQL generation without touching Postgres.
 */
import { createHash } from 'crypto';

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface BacktestRunInput {
  strategy: string;
  symbol: string;
  timeframe: string;
  period?: string;
  start_date?: string | null;
  end_date?: string | null;
  initial_capital: number;
  commission: number;
  params?: Record<string, unknown>;
  metrics: Record<string, unknown>;
  equity_curve: unknown[];
  trades: unknown[];
}

export interface BacktestRunRow {
  id: number;
  strategy: string;
  symbol: string;
  timeframe: string;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  initial_capital: string;
  commission: string;
  params: Record<string, unknown>;
  params_hash: string;
  metrics: Record<string, unknown>;
  equity_curve: unknown[];
  trades: unknown[];
  trade_count: number;
  final_equity: string | null;
  created_at: string;
}

/**
 * Stable identifier for an input configuration. Used by callers that want
 * to suppress duplicate runs ("re-running identical params? show the cached
 * row instead"). Only the *input* — symbol/strategy/params — feeds the hash,
 * not the output metrics, so the same hash holds regardless of engine
 * non-determinism.
 */
export function paramsHash(input: BacktestRunInput): string {
  const canonical = {
    strategy: input.strategy,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    period: input.period ?? null,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    initial_capital: Number(input.initial_capital),
    commission: Number(input.commission),
    params: input.params ?? {},
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function finalEquity(input: BacktestRunInput): number | null {
  const curve = input.equity_curve;
  if (!Array.isArray(curve) || curve.length === 0) return null;
  const last = curve[curve.length - 1] as { value?: unknown; equity?: unknown };
  const v = (last?.value ?? last?.equity) as number | undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface ListFilter {
  symbol?: string;
  strategy?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export class BacktestRunRepository {
  constructor(private db: Querier) {}

  async insert(input: BacktestRunInput): Promise<BacktestRunRow> {
    const hash = paramsHash(input);
    const params = input.params ?? {};
    const trades = Array.isArray(input.trades) ? input.trades : [];
    const equity = Array.isArray(input.equity_curve) ? input.equity_curve : [];

    const sql = `
      INSERT INTO backtest_runs (
        strategy, symbol, timeframe, period, start_date, end_date,
        initial_capital, commission, params, params_hash, metrics,
        equity_curve, trades, trade_count, final_equity
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9::jsonb, $10, $11::jsonb,
        $12::jsonb, $13::jsonb, $14, $15
      )
      RETURNING *
    `;
    const values = [
      input.strategy,
      input.symbol.toUpperCase(),
      input.timeframe,
      input.period ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.initial_capital,
      input.commission,
      JSON.stringify(params),
      hash,
      JSON.stringify(input.metrics ?? {}),
      JSON.stringify(equity),
      JSON.stringify(trades),
      trades.length,
      finalEquity(input),
    ];
    const result = await this.db.query(sql, values);
    return result.rows[0] as BacktestRunRow;
  }

  /**
   * List runs. The trades / equity curve / metrics blobs can be large, so the
   * list view returns a slim row — callers fetch the full record via findById.
   */
  async list(filter: ListFilter = {}): Promise<Array<Omit<BacktestRunRow, 'trades' | 'equity_curve'>>> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.symbol) {
      params.push(filter.symbol.toUpperCase());
      where.push(`symbol = $${params.length}`);
    }
    if (filter.strategy) {
      params.push(filter.strategy);
      where.push(`strategy = $${params.length}`);
    }

    const limit = Math.min(Math.max(Number(filter.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    params.push(limit, offset);

    const sql = `
      SELECT id, strategy, symbol, timeframe, period, start_date, end_date,
             initial_capital, commission, params, params_hash, metrics,
             trade_count, final_equity, created_at
      FROM backtest_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async findById(id: number): Promise<BacktestRunRow | null> {
    const result = await this.db.query('SELECT * FROM backtest_runs WHERE id = $1', [id]);
    return (result.rows[0] as BacktestRunRow | undefined) ?? null;
  }
}
