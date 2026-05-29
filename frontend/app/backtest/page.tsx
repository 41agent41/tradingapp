'use client';

import React, { useCallback, useEffect, useState } from 'react';
import BackToHome from '../components/BackToHome';
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
      setResponse(body as BacktestResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run backtest');
    } finally {
      setRunning(false);
    }
  }, [symbol, strategy, timeframe, period, initialCapital, commission]);

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
