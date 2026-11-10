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
 * Bars come from the database by default (E-02, services/backtestData.ts):
 * the backend checks how well the stored bars cover the range, and sends the
 * bars to the broker service with the run. When bars are missing the request
 * is answered 409 with the coverage, and the caller repeats it with
 * `on_missing: 'fetch'` (fetch what is missing from the broker, store it, then
 * run) or `on_missing: 'use_stored'` (run on what is there). `data: 'broker'`
 * has the broker service fetch the bars itself and stores nothing, as before.
 *
 *   GET  /api/backtesting/strategies — list available strategies (cached)
 *   GET  /api/backtesting/coverage   — how well stored bars cover a range
 *   POST /api/backtesting/run        — run a backtest over historical data
 *   GET  /api/backtesting/runs       — list persisted runs (slim rows)
 *   GET  /api/backtesting/runs/:id   — full record for one persisted run
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { cacheService } from '../services/cache.js';
import { dbService } from '../services/database.js';
import { BacktestRunRepository, type BacktestRunData } from '../services/backtestRunRepository.js';
import { StrategyRepository } from '../services/strategyRepository.js';
import { backtestRunsPersisted } from '../services/metrics.js';
import { defaultBroker } from '../services/orderTypes.js';
import { storedBars as barData } from '../services/storedBars.js';
import {
  BacktestDataError,
  resolveRange,
  type Coverage,
  type LoadedBars,
} from '../services/backtestData.js';

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

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** In words, for the 409 and the page: what is stored and what is not. */
function coverageMessage(c: Coverage): string {
  if (c.bars === 0) return 'No bars are stored for this instrument, timeframe and range.';
  const day = (iso: string) => iso.slice(0, 10);
  const holes = c.missing.map((m) => `${day(m.from)} to ${day(m.to)}`).join('; ');
  return `Stored bars do not cover the whole range. Missing: ${holes}.`;
}

// How well the stored bars cover a range, before a run is asked for.
router.get('/coverage', async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const symbol = text(q.symbol).toUpperCase();
    const timeframe = text(q.timeframe) || '1hour';
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ error: 'Invalid timeframe', valid: VALID_TIMEFRAMES });
    }
    const range = resolveRange(q);
    const coverage = await barData.coverage(
      {
        broker: (text(q.source) || defaultBroker()).toLowerCase(),
        account: text(q.account).toLowerCase() || undefined,
        symbol,
        secType: (text(q.sec_type) || 'STK').toUpperCase(),
      },
      timeframe,
      range
    );
    res.json({ coverage, message: coverage.complete ? null : coverageMessage(coverage) });
  } catch (error: any) {
    if (error instanceof BacktestDataError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error checking backtest coverage:', error);
    res.status(500).json({ error: 'Failed to check stored bars', detail: error?.message });
  }
});

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
      account: rawAccount,
      data: rawData,
      on_missing: rawOnMissing,
      intrabar: rawIntrabar,
      save: rawSave,
    } = req.body || {};

    const dataMode = String(rawData || 'stored');
    if (dataMode !== 'stored' && dataMode !== 'broker') {
      return res.status(400).json({ error: "data must be 'stored' or 'broker'" });
    }
    const onMissing = String(rawOnMissing || 'ask');
    if (!['ask', 'fetch', 'use_stored'].includes(onMissing)) {
      return res.status(400).json({ error: "on_missing must be 'fetch' or 'use_stored'" });
    }

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
      // A Jesse definition names a strategy class rather than rule groups, so
      // the persisted label keeps that name instead of a generic 'inline'.
      strategyLabel =
        String(ruleSet.engine ?? '').toLowerCase() === 'jesse' && ruleSet.strategy
          ? `jesse:${String(ruleSet.strategy)}`
          : 'rules:inline';
      symbol = symbol || (ruleSet.symbol as string | undefined);
      timeframe = timeframe || (ruleSet.timeframe as string | undefined);
    } else {
      strategyLabel = String(strategy);
    }

    timeframe = timeframe || '1hour';
    secType = String(secType || 'STK').toUpperCase();
    exchange = String(exchange || 'SMART').toUpperCase();
    currency = String(currency || 'USD').toUpperCase();
    source = String(source || defaultBroker()).toLowerCase();

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

    // Stored bars: check the range is covered, fetch what is missing if
    // asked to, and load the bars to send with the run.
    let coverage: Coverage | null = null;
    let loaded: LoadedBars | null = null;
    let minutes: LoadedBars | null = null;
    let minutesSkipped: string | null = null;
    if (dataMode === 'stored') {
      const range = resolveRange({ period, start_date, end_date });
      const instrument = {
        broker: source,
        account: text(rawAccount).toLowerCase() || undefined,
        symbol: String(symbol).toUpperCase(),
        secType,
        exchange,
        currency,
      };
      coverage = await barData.coverage(instrument, timeframe, range);
      if (!coverage.complete && onMissing === 'ask') {
        return res.status(409).json({
          error: 'coverage_incomplete',
          detail: coverageMessage(coverage),
          coverage,
          choices: ['fetch', 'use_stored'],
        });
      }
      if (!coverage.complete && onMissing === 'fetch') {
        coverage = await barData.fetchMissing(instrument, timeframe, range);
      }
      if (coverage.contract_id === null || coverage.bars === 0) {
        return res.status(400).json({
          error: 'No stored bars',
          detail:
            onMissing === 'fetch'
              ? 'The broker returned no bars for this instrument, timeframe and range.'
              : coverageMessage(coverage),
          coverage,
        });
      }
      loaded = await barData.load(coverage.contract_id, timeframe, range, coverage.built_from);

      // A rule-set with a protective stop fills it inside the bar. Send the
      // stored 1-minute bars with the run so the stop fills on the minute
      // that reached it; without them the bar's own range decides.
      const hasStop = !!ruleSet && typeof ruleSet.stop === 'object' && ruleSet.stop !== null;
      if (hasStop && timeframe !== '1min' && rawIntrabar !== false) {
        try {
          minutes = await barData.minutes(instrument, range);
        } catch (err) {
          if (!(err instanceof BacktestDataError)) throw err;
          // More 1-minute bars than one run may hold: run without them.
          minutesSkipped = err.message;
        }
      }
    }

    const body = {
      ...(ruleSet ? { rule_set: ruleSet } : {}),
      ...(loaded ? { bars: loaded.bars } : {}),
      ...(minutes ? { minute_bars: minutes.bars } : {}),
    };
    const response = await axios.post(
      `${BROKER_SERVICE_URL}/backtesting/run`,
      Object.keys(body).length ? body : null,
      {
        // A long range of small bars is tens of megabytes.
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
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
        timeout: 120000, // a broker fetch, or a long stored range, can be slow
        headers: { Connection: 'close' },
      }
    );

    const payload = response.data ?? {};
    const results = payload.results ?? {};
    const runData: BacktestRunData =
      loaded && coverage
        ? {
            source: 'stored',
            contract_id: coverage.contract_id,
            bars: loaded.count,
            first_bar: loaded.first_bar,
            last_bar: loaded.last_bar,
            hash: loaded.hash,
            complete: coverage.complete,
            ...(coverage.built_from ? { built_from: coverage.built_from } : {}),
            ...(minutes ? { minute_bars: minutes.count, minute_hash: minutes.hash } : {}),
            ...(minutesSkipped ? { minute_bars_skipped: minutesSkipped } : {}),
          }
        : { source: 'broker', bars: payload.data_points ?? null };

    // The IB service returns the equity curve + trade list inline inside
    // `results` (see `BacktestResults.to_dict` in `broker_service/backtesting.py`).
    // Split them out for storage so they can be queried independently of the
    // scalar metrics — the metrics blob keeps everything else from `results`.
    const { equity_curve, trades_summary, ...metrics } = results as Record<string, unknown>;

    // Persist the run. We intentionally do not fail the request if the
    // insert errors — the run itself succeeded; the persistence is a side
    // effect, not the user's contract.
    let persisted_id: number | null = null;
    // `save: false` runs without keeping the run: the bar replay asks for a
    // strategy's trades over a short stretch, which is not a result to list
    // beside real backtests or to count toward a definition's promotion.
    if (rawSave === false) {
      return res.json({ ...payload, persisted_id, data: { ...runData, coverage } });
    }
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
        data: runData,
      });
      persisted_id = row.id;
      backtestRunsPersisted.labels(strategyLabel, String(symbol).toUpperCase()).inc();
    } catch (persistError: any) {
      console.error('Failed to persist backtest run:', persistError?.message ?? persistError);
    }

    res.json({ ...payload, persisted_id, data: { ...runData, coverage } });
  } catch (error: any) {
    if (error instanceof BacktestDataError) {
      return res.status(error.status).json({ error: error.message, detail: error.message });
    }
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
