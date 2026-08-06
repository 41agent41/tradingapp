/**
 * Backtesting proxy routes (GAP_ANALYSIS §5 + Systematic Trading roadmap A1).
 *
 * The backtesting engine and strategies live in the IB service
 * (`broker_service/backtesting.py`, exposed at `/backtesting/*`). Going through
 * the backend keeps the feature behind the same auth/CORS perimeter as the
 * rest of the API and gives the frontend a single origin to talk to.
 *
 * A run is selected by exactly one of:
 *   - `strategy`      — a registered strategy key (the original path), or
 *   - `definition_id` — a saved `strategy_definitions` row, whose rule-set,
 *     symbol, timeframe and instrument fields become the defaults, or
 *   - `rule_set`      — an inline declarative rule-set object.
 * This is what closes the create → backtest → deploy loop: a user-created
 * definition can be validated in the backtester before it is run live.
 *
 *   GET  /api/backtesting/strategies — list available strategies (cached)
 *   POST /api/backtesting/run        — run a backtest over historical data
 *   GET  /api/backtesting/runs       — list persisted runs (slim rows)
 *   GET  /api/backtesting/runs/:id   — full record for one persisted run
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { cacheService } from '../services/cache.js';
import { dbService } from '../services/database.js';
import { BacktestRunRepository } from '../services/backtestRunRepository.js';
import { StrategyRepository } from '../services/strategyRepository.js';
import { backtestRunsPersisted } from '../services/metrics.js';

const router = express.Router();
const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

const VALID_TIMEFRAMES = [
  'tick',
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '1day',
];

const VALID_SEC_TYPES = new Set([
  'STK',
  'OPT',
  'FUT',
  'CASH',
  'BOND',
  'CFD',
  'CMDTY',
  'CRYPTO',
  'WAR',
  'FUND',
  'IND',
  'BAG',
]);

const runs = new BacktestRunRepository(dbService);
const definitions = new StrategyRepository(dbService);

// Translate an axios error from the IB service into a client response using
// the same shape the other proxy routes use.
function sendProxyError(res: Response, error: any, label: string) {
  let errorMessage = 'Unknown error';
  let statusCode = 500;

  if (error.code === 'ECONNREFUSED') {
    errorMessage = 'IB Service connection refused - service may be starting up';
    statusCode = 503;
  } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
    errorMessage = 'IB Service timeout - backtest may be fetching a large history';
    statusCode = 504;
  } else if (error.response) {
    errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
    statusCode = error.response.status;
  } else {
    errorMessage = error.message || 'Failed to connect to IB Service';
  }

  res.status(statusCode).json({
    error: label,
    detail: errorMessage,
    broker_service_status: statusCode,
    timestamp: new Date().toISOString(),
  });
}

// List the strategies the engine knows about. The catalogue is static for a
// given deployment, so it is cached for an hour.
router.get('/strategies', async (_req: Request, res: Response) => {
  try {
    const data = await cacheService.wrap('backtesting:strategies', 3600, async () => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/backtesting/strategies`, {
        timeout: 5000,
      });
      return response.data;
    });
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching backtesting strategies:', error);
    sendProxyError(res, error, 'Failed to fetch backtesting strategies');
  }
});

// Run a backtest. The IB service endpoint takes its parameters as query
// params (they are plain FastAPI function args, not a request body), so the
// validated values are forwarded via `params` on a bodyless POST.
router.post('/run', async (req: Request, res: Response) => {
  try {
    const {
      symbol: rawSymbol,
      strategy,
      definition_id,
      rule_set: inlineRuleSet,
      timeframe: rawTimeframe,
      period = '1Y',
      initial_capital = 100000,
      commission = 0.001,
      start_date,
      end_date,
      sec_type: rawSecType,
      exchange: rawExchange,
      currency: rawCurrency,
      source: rawSource,
    } = req.body || {};

    // Exactly one way to pick the strategy: a registered key, a saved
    // definition, or an inline rule-set.
    const selectors = [strategy, definition_id, inlineRuleSet].filter(
      (v) => v !== undefined && v !== null && v !== ''
    );
    if (selectors.length !== 1) {
      return res.status(400).json({
        error: "Provide exactly one of 'strategy', 'definition_id' or 'rule_set'",
        received: {
          strategy: strategy ?? null,
          definition_id: definition_id ?? null,
          rule_set: inlineRuleSet ? '<object>' : null,
        },
      });
    }

    // Resolve a saved definition: its rule-set always applies; its symbol,
    // timeframe, broker and instrument fields are defaults the request can
    // override.
    let ruleSet: Record<string, unknown> | null = null;
    let strategyLabel: string;
    let symbol = rawSymbol;
    let timeframe = rawTimeframe;
    let secType = rawSecType;
    let exchange = rawExchange;
    let currency = rawCurrency;
    let source = rawSource;

    if (definition_id !== undefined && definition_id !== null && definition_id !== '') {
      const defId = Number(definition_id);
      if (!Number.isInteger(defId) || defId <= 0) {
        return res.status(400).json({ error: 'definition_id must be a positive integer' });
      }
      const definition = await definitions.findDefinition(defId);
      if (!definition) {
        return res.status(404).json({ error: 'Definition not found', definition_id: defId });
      }
      ruleSet = definition.rule_set ?? {};
      strategyLabel = `rules:def:${defId}`;
      symbol = symbol || definition.symbol;
      timeframe = timeframe || definition.timeframe;
      secType = secType || definition.sec_type;
      exchange = exchange || definition.exchange;
      currency = currency || definition.currency;
      source = source || definition.broker;
    } else if (inlineRuleSet !== undefined && inlineRuleSet !== null) {
      if (typeof inlineRuleSet !== 'object' || Array.isArray(inlineRuleSet)) {
        return res.status(400).json({ error: 'rule_set must be an object' });
      }
      ruleSet = inlineRuleSet as Record<string, unknown>;
      strategyLabel = 'rules:inline';
      symbol = symbol || (ruleSet.symbol as string | undefined);
      timeframe = timeframe || (ruleSet.timeframe as string | undefined);
    } else {
      strategyLabel = String(strategy);
    }

    timeframe = timeframe || '1hour';
    secType = String(secType || 'STK').toUpperCase();
    exchange = String(exchange || 'SMART').toUpperCase();
    currency = String(currency || 'USD').toUpperCase();
    source = String(source || 'ib').toLowerCase();

    if (!symbol) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol'],
        received: { symbol: symbol ?? null },
      });
    }

    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        valid: VALID_TIMEFRAMES,
        received: timeframe,
      });
    }

    if (!VALID_SEC_TYPES.has(secType)) {
      return res.status(400).json({
        error: 'Invalid sec_type',
        valid: [...VALID_SEC_TYPES],
        received: secType,
      });
    }

    const capital = Number(initial_capital);
    if (!Number.isFinite(capital) || capital <= 0) {
      return res.status(400).json({ error: 'initial_capital must be a positive number' });
    }

    const comm = Number(commission);
    if (!Number.isFinite(comm) || comm < 0 || comm > 1) {
      return res.status(400).json({ error: 'commission must be a fraction between 0 and 1' });
    }

    // A custom date range is optional; only forward it when both ends are set.
    const hasRange = Boolean(start_date && end_date);

    console.log(
      `Running backtest: ${symbol} ${strategyLabel} ${timeframe} ` +
        `(${secType}/${exchange}/${currency}, source=${source}) ` +
        (hasRange ? `${start_date}..${end_date}` : period)
    );

    const response = await axios.post(
      `${BROKER_SERVICE_URL}/backtesting/run`,
      ruleSet ? { rule_set: ruleSet } : null,
      {
        params: {
          symbol,
          ...(ruleSet ? {} : { strategy }),
          timeframe,
          period,
          initial_capital: capital,
          commission: comm,
          sec_type: secType,
          exchange,
          currency,
          source,
          ...(hasRange ? { start_date, end_date } : {}),
        },
        timeout: 120000, // backtests pull historical data from IB and can be slow
        headers: { Connection: 'close' },
      }
    );

    const payload = response.data ?? {};
    const results = payload.results ?? {};

    // The IB service returns the equity curve + trade list inline inside
    // `results` (see `BacktestResults.to_dict` in `broker_service/backtesting.py`).
    // Split them out for storage so they can be queried independently of the
    // scalar metrics — the metrics blob keeps everything else from `results`.
    const { equity_curve, trades_summary, ...metrics } = results as Record<string, unknown>;

    // Persist the run. We intentionally do not fail the request if the
    // insert errors — the run itself succeeded; the persistence is a side
    // effect, not the user's contract.
    let persisted_id: number | null = null;
    try {
      const row = await runs.insert({
        strategy: strategyLabel,
        symbol,
        timeframe,
        period: hasRange ? 'CUSTOM' : period,
        start_date: hasRange ? start_date : null,
        end_date: hasRange ? end_date : null,
        initial_capital: capital,
        commission: comm,
        params: {
          data_points: payload.data_points ?? null,
          sec_type: secType,
          exchange,
          currency,
          source,
          ...(ruleSet ? { rule_set: ruleSet } : {}),
        },
        metrics,
        equity_curve: Array.isArray(equity_curve) ? equity_curve : [],
        trades: Array.isArray(trades_summary) ? trades_summary : [],
      });
      persisted_id = row.id;
      backtestRunsPersisted.labels(strategyLabel, String(symbol).toUpperCase()).inc();
    } catch (persistError: any) {
      console.error('Failed to persist backtest run:', persistError?.message ?? persistError);
    }

    res.json({ ...payload, persisted_id });
  } catch (error: any) {
    console.error('Error running backtest:', error);
    sendProxyError(res, error, 'Failed to run backtest');
  }
});

router.get('/runs', async (req: Request, res: Response) => {
  try {
    const rows = await runs.list({
      symbol: typeof req.query.symbol === 'string' ? req.query.symbol : undefined,
      strategy: typeof req.query.strategy === 'string' ? req.query.strategy : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined,
    });
    res.json({ runs: rows, count: rows.length });
  } catch (error: any) {
    console.error('Error listing backtest runs:', error);
    res.status(500).json({
      error: 'Failed to list backtest runs',
      detail: error?.message ?? 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }
  try {
    const row = await runs.findById(id);
    if (!row) return res.status(404).json({ error: 'Backtest run not found', id });
    res.json(row);
  } catch (error: any) {
    console.error('Error fetching backtest run:', error);
    res.status(500).json({
      error: 'Failed to fetch backtest run',
      detail: error?.message ?? 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
