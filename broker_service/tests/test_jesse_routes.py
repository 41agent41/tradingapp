"""Jesse strategies through the service's HTTP surface.

* the shared catalogue (``AVAILABLE_STRATEGIES`` / ``GET /backtesting/strategies``)
* ``POST /backtesting/run`` with a ``jesse_…`` key or an ``{"engine": "jesse"}`` body
* ``POST /strategies/evaluate`` with an ``{"engine": "jesse"}`` definition
* the ``/jesse/*`` authoring endpoints

IB is faked exactly as in ``test_backtesting_route.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backtesting import AVAILABLE_STRATEGIES, BacktestResults, backtest_engine
from jesse import registry
from jesse.adapter import (
    JesseStrategyAdapter,
    compile_jesse_definition,
    is_jesse_definition,
)
from jesse.models import StrategyError
from jesse_strategies.sma_crossover import SMACrossover
from routes import backtesting as bt_routes
from routes import jesse as jesse_routes
from routes import strategies as strat_routes

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@dataclass
class FakeBar:
    date: Any
    open: float = 100.0
    high: float = 101.0
    low: float = 99.0
    close: float = 100.5
    volume: int = 1000


@dataclass
class FakeContract:
    symbol: str
    conId: int = 1  # noqa: N815


@dataclass
class FakeIBApp:
    connected: bool = True
    bars: List[FakeBar] = field(default_factory=list)
    contracts: List[FakeContract] = field(default_factory=list)
    historical_data: List[FakeBar] = field(default_factory=list)

    def isConnected(self):  # noqa: N802
        return self.connected

    def reqContractDetails(self, reqId, contract):  # noqa: N802
        self.contracts.append(FakeContract(symbol=contract.symbol))

    def reqHistoricalData(self, *args, **kwargs):  # noqa: N802
        self.historical_data.extend(self.bars)


def _wavy_daily_bars(n: int = 260) -> List[FakeBar]:
    """A year of daily bars with a cycle so crossovers actually happen."""

    rng = np.random.default_rng(11)
    i = np.arange(n)
    close = 300 + 30 * np.sin(i / 20) + np.cumsum(rng.normal(0, 1.0, n))
    out = []
    start = np.datetime64("2024-01-02")
    for k in range(n):
        day = start + np.timedelta64(int(k * 7 // 5), "D")  # skip weekends roughly
        date = str(day).replace("-", "")
        c = float(close[k])
        out.append(
            FakeBar(date=date, open=c - 0.5, high=c + 2, low=c - 2, close=c, volume=1_000_000)
        )
    return out


def _bars_json(n: int = 260, step: int = 86_400) -> list[dict]:
    rng = np.random.default_rng(5)
    i = np.arange(n)
    close = 300 + 30 * np.sin(i / 20) + np.cumsum(rng.normal(0, 1.0, n))
    start = 1_700_000_000
    return [
        {
            "timestamp": start + k * step,
            "open": float(close[k]) - 0.5,
            "high": float(close[k]) + 2,
            "low": float(close[k]) - 2,
            "close": float(close[k]),
            "volume": 1_000_000.0,
        }
        for k in range(n)
    ]


def _bt_client(monkeypatch, fake_ib) -> TestClient:
    monkeypatch.setattr(bt_routes, "get_ib_connection", lambda: fake_ib)
    monkeypatch.setattr(bt_routes, "verify_connection_health", lambda ib: ib.isConnected())
    monkeypatch.setattr(bt_routes.time, "sleep", lambda _s: None)
    app = FastAPI()
    app.include_router(bt_routes.router)
    return TestClient(app)


def _client(router) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# --------------------------------------------------------------------------- #
# Registry + adapter
# --------------------------------------------------------------------------- #


class TestRegistry:
    def test_shipped_strategies_are_discovered(self):
        keys = set(registry.all_strategies())
        assert {
            "jesse_sma_crossover",
            "jesse_rsi_mean_reversion",
            "jesse_bollinger_breakout",
            "jesse_msft_trend_follower",
        } <= keys

    def test_lookup_accepts_key_or_class_name(self):
        assert registry.get("jesse_sma_crossover") is SMACrossover
        assert registry.get("sma_crossover") is SMACrossover
        assert registry.get("SMACrossover") is SMACrossover

    def test_unknown_strategy(self):
        with pytest.raises(StrategyError, match="Unknown jesse strategy"):
            registry.get("NotAStrategy")

    def test_catalogue_contains_jesse_entries_alongside_the_others(self):
        assert "jesse_sma_crossover" in AVAILABLE_STRATEGIES
        assert "ma_crossover" in AVAILABLE_STRATEGIES  # built-in untouched
        assert "rule_ma_crossover" in AVAILABLE_STRATEGIES  # rule engine untouched
        adapter = AVAILABLE_STRATEGIES["jesse_sma_crossover"]()
        assert isinstance(adapter, JesseStrategyAdapter)
        assert adapter.engine == "jesse" and adapter.indicators == []


class TestAdapter:
    def test_compile_definition_with_hyperparameters(self):
        adapter = compile_jesse_definition(
            {
                "engine": "jesse",
                "strategy": "SMACrossover",
                "hyperparameters": {"fast": 5, "slow": 15},
            }
        )
        assert adapter.hyperparameters["fast"] == 5 and adapter.hyperparameters["slow"] == 15
        assert adapter.hyperparameters["atr_period"] == 14  # default kept

    def test_compile_rejects_unknown_hyperparameter(self):
        with pytest.raises(StrategyError, match="Unknown hyperparameter"):
            compile_jesse_definition(
                {"engine": "jesse", "strategy": "SMACrossover", "hyperparameters": {"fsat": 5}}
            )

    def test_compile_rejects_bad_shapes(self):
        with pytest.raises(StrategyError):
            compile_jesse_definition({"engine": "jesse"})
        with pytest.raises(StrategyError):
            compile_jesse_definition(
                {"engine": "jesse", "strategy": "SMACrossover", "warmup_candles": -1}
            )
        with pytest.raises(StrategyError):
            compile_jesse_definition(
                {"engine": "jesse", "strategy": "SMACrossover", "timeframe": "3min"}
            )
        assert not is_jesse_definition({"entry": {"all": []}})

    def test_engine_delegates_to_the_jesse_runner(self):
        import pandas as pd

        df = pd.DataFrame(_bars_json())
        df.index = pd.to_datetime(df["timestamp"], unit="s")
        adapter = compile_jesse_definition(
            {
                "engine": "jesse",
                "strategy": "SMACrossover",
                "hyperparameters": {"fast": 5, "slow": 15},
            }
        )
        adapter.timeframe = "1day"
        results = backtest_engine.run_backtest(df, adapter, "MSFT")
        assert isinstance(results, BacktestResults)
        assert results.total_trades > 0
        assert results.metrics["engine"] == "jesse"
        assert results.metrics["hyperparameters"]["fast"] == 5
        assert adapter.last_result is not None


# --------------------------------------------------------------------------- #
# Shared backtesting routes
# --------------------------------------------------------------------------- #


class TestBacktestingRoutes:
    def test_catalogue_marks_engine_and_hyperparameters(self):
        res = _client(bt_routes.router).get("/backtesting/strategies")
        assert res.status_code == 200
        strategies = res.json()["strategies"]
        assert strategies["jesse_sma_crossover"]["engine"] == "jesse"
        assert strategies["jesse_sma_crossover"]["class_name"] == "SMACrossover"
        names = {hp["name"] for hp in strategies["jesse_sma_crossover"]["hyperparameters"]}
        assert {"fast", "slow", "risk_pct"} <= names
        assert strategies["ma_crossover"]["engine"] == "rules"

    def test_run_by_key(self, monkeypatch):
        client = _bt_client(monkeypatch, FakeIBApp(bars=_wavy_daily_bars()))
        res = client.post(
            "/backtesting/run",
            params={"symbol": "MSFT", "strategy": "jesse_sma_crossover", "timeframe": "1day"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["engine"] == "jesse"
        assert body["strategy"] == "jesse_sma_crossover"
        results = body["results"]
        assert results["symbol"] == "MSFT"
        assert results["total_trades"] > 0
        assert results["metrics"]["engine"] == "jesse"
        assert "sortino_ratio" in results["metrics"]
        assert results["trades_summary"][0]["entry_reason"].startswith("SMACrossover")
        assert len(results["equity_curve"]) > 0

    def test_run_with_definition_body_and_overrides(self, monkeypatch):
        client = _bt_client(monkeypatch, FakeIBApp(bars=_wavy_daily_bars()))
        res = client.post(
            "/backtesting/run",
            params={"symbol": "MSFT", "timeframe": "1day", "initial_capital": 50_000},
            json={
                "rule_set": {
                    "engine": "jesse",
                    "strategy": "SMACrossover",
                    "hyperparameters": {"fast": 5, "slow": 20},
                    "warmup_candles": 30,
                }
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["engine"] == "jesse"
        m = body["results"]["metrics"]
        assert m["hyperparameters"]["fast"] == 5 and m["warmup_candles"] == 30
        assert body["results"]["initial_capital"] == 50_000

    def test_run_400s_on_bad_hyperparameter(self, monkeypatch):
        client = _bt_client(monkeypatch, FakeIBApp(bars=_wavy_daily_bars()))
        res = client.post(
            "/backtesting/run",
            params={"symbol": "MSFT"},
            json={
                "rule_set": {
                    "engine": "jesse",
                    "strategy": "SMACrossover",
                    "hyperparameters": {"fast": 1},
                }
            },
        )
        assert res.status_code == 400
        assert "below its min" in res.json()["detail"]

    def test_run_400s_on_unknown_jesse_strategy(self, monkeypatch):
        client = _bt_client(monkeypatch, FakeIBApp(bars=_wavy_daily_bars()))
        res = client.post(
            "/backtesting/run",
            params={"symbol": "MSFT"},
            json={"rule_set": {"engine": "jesse", "strategy": "Nope"}},
        )
        assert res.status_code == 400
        assert "Unknown jesse strategy" in res.json()["detail"]

    def test_rule_sets_still_compile(self, monkeypatch):
        client = _bt_client(monkeypatch, FakeIBApp(bars=_wavy_daily_bars()))
        res = client.post(
            "/backtesting/run",
            params={"symbol": "MSFT", "timeframe": "1day"},
            json={
                "rule_set": {
                    "name": "MA",
                    "entry": {"all": [{"left": "sma_20", "op": ">", "right": "sma_50"}]},
                }
            },
        )
        assert res.status_code == 200
        assert res.json()["engine"] == "rules"


# --------------------------------------------------------------------------- #
# Live evaluate route
# --------------------------------------------------------------------------- #


class TestEvaluateRoute:
    def test_jesse_definition_evaluates(self):
        client = _client(strat_routes.router)
        res = client.post(
            "/strategies/evaluate",
            json={
                "bars": _bars_json(120),
                "rule_set": {
                    "engine": "jesse",
                    "strategy": "SMACrossover",
                    "hyperparameters": {"fast": 5, "slow": 15},
                },
                "symbol": "MSFT",
                "timeframe": "1day",
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["success"] is True
        assert body["engine"] == "jesse"
        assert body["signal"] in ("long", "short", "none")
        assert body["bars_evaluated"] == 120
        assert body["strategy"] == "SMACrossover"
        assert body["trail"] == {"stop_price": None, "direction": None, "error": None}
        assert isinstance(body["watch_list"], list)

    def test_jesse_registered_key_with_open_position_returns_trail(self):
        client = _client(strat_routes.router)
        bars = _bars_json(120)
        res = client.post(
            "/strategies/evaluate",
            json={
                "bars": bars,
                "strategy": "jesse_bollinger_breakout",
                "position": {"size": 10, "avg_price": bars[-5]["close"]},
                "timeframe": "1day",
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["signal"] in ("none", "flat")
        assert body["trail"]["direction"] in ("long", None)
        assert body["position"] == {"size": 10, "avg_price": bars[-5]["close"]}

    def test_bad_definition_400s(self):
        client = _client(strat_routes.router)
        res = client.post(
            "/strategies/evaluate",
            json={"bars": _bars_json(30), "rule_set": {"engine": "jesse", "strategy": "Nope"}},
        )
        assert res.status_code == 400

    def test_rule_set_path_unchanged(self):
        client = _client(strat_routes.router)
        res = client.post(
            "/strategies/evaluate",
            json={
                "bars": _bars_json(60),
                "rule_set": {
                    "name": "MA",
                    "entry": {"all": [{"left": "sma_20", "op": ">", "right": "sma_50"}]},
                },
            },
        )
        assert res.status_code == 200
        assert "engine" not in res.json()


# --------------------------------------------------------------------------- #
# /jesse/* authoring routes
# --------------------------------------------------------------------------- #


class TestJesseRoutes:
    def test_list(self):
        res = _client(jesse_routes.router).get("/jesse/strategies")
        assert res.status_code == 200
        body = res.json()
        assert body["count"] >= 4
        entry = body["strategies"]["jesse_msft_trend_follower"]
        assert entry["class_name"] == "MSFTTrendFollower"
        assert entry["hyperparameters"][0]["name"] == "anchor_ema"
        assert "5min" in body["timeframes"] and "1day" in body["timeframes"]
        assert body["definition_example"]["engine"] == "jesse"

    def test_detail_includes_source(self):
        res = _client(jesse_routes.router).get("/jesse/strategies/SMACrossover")
        assert res.status_code == 200
        body = res.json()
        assert body["key"] == "jesse_sma_crossover"
        assert "class SMACrossover(Strategy)" in body["source"]

    def test_detail_404(self):
        assert _client(jesse_routes.router).get("/jesse/strategies/nope").status_code == 404

    def test_indicators(self):
        res = _client(jesse_routes.router).get("/jesse/indicators")
        assert res.status_code == 200
        names = {i["name"] for i in res.json()["indicators"]}
        assert {"sma", "ema", "rsi", "atr", "macd", "bollinger_bands", "supertrend"} <= names

    def test_backtest_on_supplied_bars(self):
        res = _client(jesse_routes.router).post(
            "/jesse/backtest",
            json={
                "strategy": "SMACrossover",
                "bars": _bars_json(200),
                "timeframe": "1day",
                "hyperparameters": {"fast": 5, "slow": 15},
                "starting_balance": 25_000,
                "include_orders": True,
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["success"] is True
        assert body["starting_balance"] == 25_000
        assert body["metrics"]["total"] > 0
        assert body["metrics"]["total"] == len(body["trades"])
        assert "orders" in body and "logs" not in body
        assert body["results"]["total_trades"] == body["metrics"]["total"]
        assert body["results"]["metrics"]["engine"] == "jesse"

    def test_backtest_validation(self):
        client = _client(jesse_routes.router)
        res = client.post(
            "/jesse/backtest",
            json={"strategy": "SMACrossover", "bars": _bars_json(5), "timeframe": "1day"},
        )
        assert res.status_code == 400
        res = client.post(
            "/jesse/backtest",
            json={"strategy": "Nope", "bars": _bars_json(50), "timeframe": "1day"},
        )
        assert res.status_code == 404
        res = client.post(
            "/jesse/backtest",
            json={"strategy": "SMACrossover", "bars": _bars_json(50), "timeframe": "7min"},
        )
        assert res.status_code == 400
        res = client.post(
            "/jesse/backtest",
            json={
                "strategy": "SMACrossover",
                "bars": _bars_json(50),
                "timeframe": "1day",
                "hyperparameters": {"fast": "abc"},
            },
        )
        assert res.status_code == 400

    def test_msft_trend_follower_runs_with_anchor_timeframe(self):
        # 5-minute bars -> 30-minute anchor via get_candles; exercises the
        # resample + no-look-ahead path through the HTTP surface.
        res = _client(jesse_routes.router).post(
            "/jesse/backtest",
            json={
                "strategy": "MSFTTrendFollower",
                "bars": _bars_json(600, step=300),
                "timeframe": "5min",
                "symbol": "msft",
            },
        )
        assert res.status_code == 200, res.text
        assert res.json()["symbol"] == "MSFT"
