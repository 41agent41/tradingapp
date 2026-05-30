'use client';

import React, { useCallback, useEffect, useState } from 'react';
import BackToHome from '../components/BackToHome';
import ChartSkeleton from '../components/ChartSkeleton';
import DataframeViewer from '../components/DataframeViewer';
import EquityCurveChart, { EquityPoint } from '../components/EquityCurveChart';
import { apiFetch } from '../lib/api';

interface StrategyInfo {
  name: string;
  indicators: string[];
  description: string;
}

interface TradeSummary {
  entry_time: string;
  exit_time: string | null;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  order_type: string;
  pnl: number;
  pnl_percent: number;
  duration_hours: number | null;
  entry_reason: string;
  exit_reason: string | null;
}

interface BacktestResults {
  symbol: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  final_capital: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_return: number;
  total_return_percent: number;
  max_drawdown: number;
  sharpe_ratio: number;
  win_rate: number;
  average_win: number;
  average_loss: number;
  profit_factor: number;
  equity_curve: EquityPoint[];
  trades_summary: TradeSummary[];
}

interface BacktestResponse {
  success: boolean;
  results: BacktestResults;
  data_points: number;
  timeframe: string;
  period: string;
  persisted_id?: number | null;
}

interface PersistedRunSummary {
  id: number;
  strategy: string;
  symbol: string;
  timeframe: string;
  period: string | null;
  initial_capital: string | number;
  commission: string | number;
  trade_count: number;
  final_equity: string | number | null;
  metrics: Record<string, unknown>;
  created_at: string;
}

interface PersistedRunFull extends PersistedRunSummary {
  start_date: string | null;
  end_date: string | null;
  params: Record<string, unknown>;
  params_hash: string;
  equity_curve: EquityPoint[];
  trades: TradeSummary[];
}

const TIMEFRAMES = ['5min', '15min', '30min', '1hour', '4hour', '8hour', '1day'];
const PERIODS = ['1M', '3M', '6M', '1Y'];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(digits);
}

export default function BacktestPage() {
  const [strategies, setStrategies] = useState<Record<string, StrategyInfo>>({});
  const [strategiesError, setStrategiesError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState('MSFT');
  const [strategy, setStrategy] = useState('');
  const [timeframe, setTimeframe] = useState('1day');
  const [period, setPeriod] = useState('1Y');
  const [initialCapital, setInitialCapital] = useState('100000');
  const [commission, setCommission] = useState('0.001');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<BacktestResponse | null>(null);

  const [previousRuns, setPreviousRuns] = useState<PersistedRunSummary[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const loadPreviousRuns = useCallback(async () => {
    try {
      const res = await apiFetch('/api/backtesting/runs?limit=20');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      setPreviousRuns(body.runs ?? []);
      setRunsError(null);
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load previous runs');
    }
  }, []);

  useEffect(() => {
    loadPreviousRuns();
  }, [loadPreviousRuns]);

  const replayRun = useCallback(async (runId: number) => {
    try {
      const res = await apiFetch(`/api/backtesting/runs/${runId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      const row = (await res.json()) as PersistedRunFull;

      // Project the persisted row back into the same BacktestResponse shape the
      // form produces, so the existing results UI just works.
      const m = row.metrics as Record<string, number | string>;
      const replayed: BacktestResponse = {
        success: true,
        timeframe: row.timeframe,
        period: row.period ?? 'CUSTOM',
        data_points: Number((row.params as { data_points?: number })?.data_points) || 0,
        persisted_id: row.id,
        results: {
          symbol: row.symbol,
          start_date: String(m.start_date ?? row.start_date ?? ''),
          end_date: String(m.end_date ?? row.end_date ?? ''),
          initial_capital: Number(m.initial_capital ?? row.initial_capital),
          final_capital: Number(m.final_capital ?? row.final_equity ?? 0),
          total_trades: Number(m.total_trades ?? row.trade_count),
          winning_trades: Number(m.winning_trades ?? 0),
          losing_trades: Number(m.losing_trades ?? 0),
          total_return: Number(m.total_return ?? 0),
          total_return_percent: Number(m.total_return_percent ?? 0),
          max_drawdown: Number(m.max_drawdown ?? 0),
          sharpe_ratio: Number(m.sharpe_ratio ?? 0),
          win_rate: Number(m.win_rate ?? 0),
          average_win: Number(m.average_win ?? 0),
          average_loss: Number(m.average_loss ?? 0),
          profit_factor: Number(m.profit_factor ?? 0),
          equity_curve: row.equity_curve ?? [],
          trades_summary: row.trades ?? [],
        },
      };
      setResponse(replayed);
      setSelectedRunId(runId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load run');
    }
  }, []);

  // Load available strategies once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/backtesting/strategies', {
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        const list: Record<string, StrategyInfo> = data.strategies || {};
        setStrategies(list);
        const firstKey = Object.keys(list)[0];
        if (firstKey) setStrategy((prev) => prev || firstKey);
      } catch (err) {
        if (!cancelled) {
          setStrategiesError(err instanceof Error ? err.message : 'Failed to load strategies');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runBacktest = useCallback(async () => {
    if (!symbol.trim() || !strategy) {
      setError('Symbol and strategy are required');
      return;
    }
    setRunning(true);
    setError(null);
    setResponse(null);

    try {
      const res = await apiFetch('/api/backtesting/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          strategy,
          timeframe,
          period,
          initial_capital: Number(initialCapital),
          commission: Number(commission),
        }),
        signal: AbortSignal.timeout(125000),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      const next = body as BacktestResponse;
      setResponse(next);
      setSelectedRunId(next.persisted_id ?? null);
      loadPreviousRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run backtest');
    } finally {
      setRunning(false);
    }
  }, [symbol, strategy, timeframe, period, initialCapital, commission, loadPreviousRuns]);

  const results = response?.results;
  const returnPositive = (results?.total_return_percent ?? 0) >= 0;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4 py-4 sm:py-6">
            <BackToHome />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Backtesting</h1>
              <p className="text-xs sm:text-sm text-gray-600 mt-1">
                Test technical-analysis strategies against historical IB data
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Configuration form */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-lg font-semibold mb-4">Configuration</h2>

          {strategiesError && (
            <div className="mb-4 text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200">
              Could not load strategies: {strategiesError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Symbol</span>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
                placeholder="MSFT"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Strategy</span>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
              >
                {Object.keys(strategies).length === 0 && <option value="">Loading…</option>}
                {Object.entries(strategies).map(([key, info]) => (
                  <option key={key} value={key}>
                    {info.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Timeframe</span>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Period</span>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Initial Capital</span>
              <input
                type="number"
                min="1"
                step="1000"
                value={initialCapital}
                onChange={(e) => setInitialCapital(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Commission (fraction)</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.0001"
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
              />
            </label>
          </div>

          {strategy && strategies[strategy] && (
            <p className="mt-3 text-sm text-gray-500">
              {strategies[strategy].description?.trim()}
              {strategies[strategy].indicators?.length > 0 && (
                <span className="ml-1">
                  (indicators: {strategies[strategy].indicators.join(', ')})
                </span>
              )}
            </p>
          )}

          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={runBacktest}
              disabled={running}
              className="px-5 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 flex items-center gap-2"
            >
              {running ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Running…
                </>
              ) : (
                'Run Backtest'
              )}
            </button>
            {running && (
              <span className="text-sm text-gray-500">
                Fetching historical data and simulating — this can take a while.
              </span>
            )}
          </div>

          {error && (
            <div className="mt-4 text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200">
              ❌ {error}
            </div>
          )}
        </div>

        {/* Previous Runs */}
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Previous Runs</h2>
            <button
              onClick={loadPreviousRuns}
              className="text-xs text-blue-600 hover:text-blue-800"
              type="button"
            >
              Refresh
            </button>
          </div>
          {runsError && (
            <div className="mb-3 text-sm text-amber-700 bg-amber-50 p-3 rounded border border-amber-200">
              Could not load previous runs: {runsError}
            </div>
          )}
          {previousRuns.length === 0 && !runsError ? (
            <p className="text-sm text-gray-500">No runs persisted yet. Run a backtest to populate this list.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="text-left text-gray-600 border-b">
                  <tr>
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Strategy</th>
                    <th className="py-2 pr-3 font-medium">Symbol</th>
                    <th className="py-2 pr-3 font-medium">TF</th>
                    <th className="py-2 pr-3 font-medium">Period</th>
                    <th className="py-2 pr-3 font-medium text-right">Return %</th>
                    <th className="py-2 pr-3 font-medium text-right">Sharpe</th>
                    <th className="py-2 pr-3 font-medium text-right">Trades</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {previousRuns.map((run) => {
                    const ret = Number(
                      (run.metrics as { total_return_percent?: number })?.total_return_percent ?? 0,
                    );
                    const sharpe = Number((run.metrics as { sharpe_ratio?: number })?.sharpe_ratio ?? 0);
                    const isSelected = selectedRunId === run.id;
                    return (
                      <tr
                        key={run.id}
                        className={`hover:bg-blue-50 cursor-pointer ${isSelected ? 'bg-blue-50' : ''}`}
                        onClick={() => replayRun(run.id)}
                      >
                        <td className="py-2 pr-3 text-gray-700 whitespace-nowrap">
                          {new Date(run.created_at).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3">{run.strategy}</td>
                        <td className="py-2 pr-3 font-medium">{run.symbol}</td>
                        <td className="py-2 pr-3 text-gray-700">{run.timeframe}</td>
                        <td className="py-2 pr-3 text-gray-700">{run.period ?? '—'}</td>
                        <td
                          className={`py-2 pr-3 text-right ${ret >= 0 ? 'text-green-600' : 'text-red-600'}`}
                        >
                          {formatNumber(ret)}%
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-700">
                          {Number.isFinite(sharpe) ? formatNumber(sharpe) : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-700">{run.trade_count}</td>
                        <td className="py-2 text-right">
                          <span className="text-xs text-blue-600">Load →</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* In-flight skeleton — shown while a backtest is running and we don't have
            results yet to render. The Previous Runs panel stays visible above. */}
        {running && !results && (
          <div className="bg-white p-6 rounded-lg shadow space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-gray-50 p-4 rounded">
                  <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
                  <div className="mt-2 h-5 w-24 rounded bg-gray-200 animate-pulse" />
                </div>
              ))}
            </div>
            <ChartSkeleton height={320} label={`Running ${strategy || 'strategy'} on ${symbol}…`} />
          </div>
        )}

        {/* Results */}
        {results && (
          <>
            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-lg font-semibold">Results</h2>
                <span className="text-sm text-gray-500">
                  {results.symbol} · {response?.timeframe} · {response?.period} ·{' '}
                  {response?.data_points} bars
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                <Metric
                  label="Total Return"
                  value={`${formatNumber(results.total_return_percent)}%`}
                  highlight={returnPositive ? 'pos' : 'neg'}
                />
                <Metric label="Final Capital" value={formatCurrency(results.final_capital)} />
                <Metric label="Total Trades" value={String(results.total_trades)} />
                <Metric label="Win Rate" value={`${formatNumber(results.win_rate)}%`} />
                <Metric
                  label="Max Drawdown"
                  value={`${formatNumber(results.max_drawdown)}%`}
                  highlight="neg"
                />
                <Metric label="Sharpe Ratio" value={formatNumber(results.sharpe_ratio)} />
                <Metric label="Profit Factor" value={formatNumber(results.profit_factor)} />
                <Metric
                  label="Wins / Losses"
                  value={`${results.winning_trades} / ${results.losing_trades}`}
                />
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-base font-semibold mb-3">Equity Curve</h3>
              {results.equity_curve?.length > 0 ? (
                <EquityCurveChart data={results.equity_curve} />
              ) : (
                <p className="text-sm text-gray-500">No equity-curve data returned.</p>
              )}
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-base font-semibold mb-3">
                Trades ({results.trades_summary?.length || 0})
              </h3>
              {results.trades_summary?.length > 0 ? (
                <DataframeViewer
                  data={results.trades_summary.map((t) => ({
                    entry_time: t.entry_time,
                    exit_time: t.exit_time,
                    order_type: t.order_type,
                    quantity: t.quantity,
                    entry_price: t.entry_price,
                    exit_price: t.exit_price,
                    pnl: Number(t.pnl?.toFixed(2)),
                    pnl_percent: Number(t.pnl_percent?.toFixed(2)),
                    duration_hours:
                      t.duration_hours != null ? Number(t.duration_hours.toFixed(1)) : null,
                    entry_reason: t.entry_reason,
                    exit_reason: t.exit_reason,
                  }))}
                  title="Trade List"
                  description={`${results.trades_summary.length} trades from the backtest`}
                  maxHeight="400px"
                  showExport={true}
                  showPagination={true}
                  itemsPerPage={20}
                />
              ) : (
                <p className="text-sm text-gray-500">
                  No trades were generated for this configuration.
                </p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: 'pos' | 'neg';
}) {
  const color =
    highlight === 'pos' ? 'text-green-600' : highlight === 'neg' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className="bg-gray-50 p-4 rounded">
      <span className="text-xs text-gray-500">{label}</span>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
