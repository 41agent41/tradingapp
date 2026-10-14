/**
 * Gathers the evidence the promotion gate judges (see `promotionGate.ts`):
 * persisted backtests of a definition, and its paper runs with their fills
 * and their account's equity.
 */
import axios from 'axios';

import {
  type BacktestEvidence,
  type DefinitionFacts,
  type PaperRunEvidence,
  type PromotionDecision,
  type PromotionStage,
  evaluatePromotion,
  promotionThresholds,
  realisedDrawdown,
} from './promotionGate.js';
import type { Fill } from './realisedPnl.js';
import { configService } from '../config/configService.js';

export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type EquityReader = (broker: string, account: string) => Promise<number | null>;

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

/** A paper account's current net liquidation from the broker service. */
export const brokerEquity: EquityReader = async (broker, account) => {
  try {
    const response = await axios.get(`${BROKER_SERVICE_URL}/account/summary`, {
      params: { broker, account },
      timeout: 30000,
      headers: { Connection: 'close' },
    });
    const value = Number(response.data?.net_liquidation);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

/** Backtests through `definition_id` are persisted with this strategy label. */
export function definitionLabel(id: number): string {
  return `rules:def:${id}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class PromotionService {
  constructor(
    private readonly db: Querier,
    private readonly equity: EquityReader = brokerEquity
  ) {}

  /** Backtests per definition id, newest first. Trades are averaged in SQL so
   *  the (possibly large) trade lists never leave the database. */
  async backtests(definitionIds: number[]): Promise<Map<number, BacktestEvidence[]>> {
    const out = new Map<number, BacktestEvidence[]>();
    if (definitionIds.length === 0) return out;
    const labels = definitionIds.map(definitionLabel);
    const result = await this.db.query(
      `SELECT id, strategy, symbol, timeframe, trade_count, created_at,
              COALESCE(metrics->>'start_date', start_date::text) AS data_start,
              metrics->>'max_drawdown' AS max_drawdown,
              (SELECT AVG((t->>'pnl')::numeric)
                 FROM jsonb_array_elements(trades) t
                WHERE t->>'pnl' IS NOT NULL) AS avg_trade_pnl
         FROM backtest_runs
        WHERE strategy = ANY($1)
        ORDER BY created_at DESC
        LIMIT 500`,
      [labels]
    );
    for (const row of result.rows) {
      const id = Number(String(row.strategy).split(':').pop());
      const list = out.get(id) ?? [];
      list.push({
        id: Number(row.id),
        symbol: String(row.symbol),
        timeframe: String(row.timeframe),
        data_start: row.data_start ? String(row.data_start) : null,
        trade_count: Number(row.trade_count) || 0,
        max_drawdown: toNumber(row.max_drawdown),
        avg_trade_pnl: toNumber(row.avg_trade_pnl),
        created_at: new Date(row.created_at).toISOString(),
      });
      out.set(id, list);
    }
    return out;
  }

  async paperRuns(definitionId: number): Promise<PaperRunEvidence[]> {
    const runs = await this.db.query(
      `SELECT id, broker, broker_account, status, started_at, stopped_at
         FROM strategy_runs
        WHERE definition_id = $1 AND account_mode = 'paper'
        ORDER BY started_at DESC
        LIMIT 20`,
      [definitionId]
    );
    const evidence: PaperRunEvidence[] = [];
    for (const run of runs.rows) {
      const fills = await this.db.query(
        `SELECT symbol, side, quantity, price, commission
           FROM order_executions
          WHERE run_id = $1
          ORDER BY executed_at ASC, id ASC`,
        [run.id]
      );
      evidence.push({
        run_id: Number(run.id),
        connection: `${run.broker}:${run.broker_account}`,
        status: String(run.status),
        started_at: new Date(run.started_at).toISOString(),
        stopped_at: run.stopped_at ? new Date(run.stopped_at).toISOString() : null,
        trade_fills: fills.rows.length,
        max_drawdown_amount: realisedDrawdown(fills.rows as Fill[]),
        equity: await this.equity(String(run.broker), String(run.broker_account)),
      });
    }
    return evidence;
  }

  /** The decision for deploying `definition` at `stage`. */
  async check(definition: DefinitionFacts, stage: PromotionStage): Promise<PromotionDecision> {
    const thresholds = promotionThresholds(configService.asEnv());
    const backtests = (await this.backtests([definition.id])).get(definition.id) ?? [];
    const paper = stage === 'live' ? await this.paperRuns(definition.id) : [];
    return evaluatePromotion(definition, stage, backtests, paper, thresholds);
  }

  /** Paper-stage decisions for a page of definitions, in one query. */
  async paperStatus(definitions: DefinitionFacts[]): Promise<Map<number, PromotionDecision>> {
    const thresholds = promotionThresholds(configService.asEnv());
    const backtests = await this.backtests(definitions.map((d) => d.id));
    const out = new Map<number, PromotionDecision>();
    for (const d of definitions) {
      out.set(d.id, evaluatePromotion(d, 'paper', backtests.get(d.id) ?? [], [], thresholds));
    }
    return out;
  }
}
