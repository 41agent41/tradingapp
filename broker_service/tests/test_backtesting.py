"""
Unit tests for `backtesting.py` serialization (GAP_ANALYSIS §5).

These cover the two things the `/backtest` UI depends on and that have no
live-IB dependency:

  1. `BacktestResults.to_dict()` emits a JSON-safe payload — in particular an
     infinite `profit_factor` (no losing trades) must not blow up Starlette's
     `allow_nan=False` encoder.
  2. The new `equity_curve` field is a list of `{time, value}` points with
     unix-second timestamps the chart can consume.
"""

from __future__ import annotations

import json

import pandas as pd

from backtesting import BacktestEngine, BacktestResults, SimpleMAStrategy


def _make_results(profit_factor: float) -> BacktestResults:
    idx = pd.to_datetime([1_700_000_000, 1_700_003_600], unit="s")
    equity = pd.Series([100_000.0, 101_000.0], index=idx)
    return BacktestResults(
        symbol="TEST",
        start_date=idx[0].to_pydatetime(),
        end_date=idx[1].to_pydatetime(),
        initial_capital=100_000.0,
        final_capital=101_000.0,
        total_trades=1,
        winning_trades=1,
        losing_trades=0,
        total_return=1_000.0,
        total_return_percent=1.0,
        max_drawdown=0.0,
        sharpe_ratio=0.0,
        win_rate=100.0,
        average_win=1_000.0,
        average_loss=0.0,
        profit_factor=profit_factor,
        trades=[],
        equity_curve=equity,
    )


class TestToDict:
    def test_infinite_profit_factor_becomes_none_and_is_json_safe(self) -> None:
        payload = _make_results(float("inf")).to_dict()
        assert payload["profit_factor"] is None
        # allow_nan=False mirrors Starlette's JSONResponse encoder.
        json.dumps(payload, allow_nan=False)

    def test_finite_profit_factor_is_preserved(self) -> None:
        payload = _make_results(2.5).to_dict()
        assert payload["profit_factor"] == 2.5

    def test_equity_curve_serializes_unix_second_points(self) -> None:
        payload = _make_results(2.5).to_dict()
        assert payload["equity_curve"] == [
            {"time": 1_700_000_000, "value": 100_000.0},
            {"time": 1_700_003_600, "value": 101_000.0},
        ]


class TestEngineSmoke:
    def test_run_backtest_output_is_json_serializable(self, synthetic_ohlcv: pd.DataFrame) -> None:
        df = synthetic_ohlcv.copy()
        df.index = pd.date_range("2024-01-01", periods=len(df), freq="h")

        engine = BacktestEngine(initial_capital=100_000, commission=0.001)
        results = engine.run_backtest(df, SimpleMAStrategy(), symbol="TEST")
        payload = results.to_dict()

        # Must survive the strict encoder even when no trades fire (profit_factor inf).
        json.dumps(payload, allow_nan=False)
        assert payload["symbol"] == "TEST"
        assert len(payload["equity_curve"]) == len(df)
