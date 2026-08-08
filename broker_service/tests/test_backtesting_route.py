"""
Route tests for ``POST /backtesting/run`` — rule-set and instrument support
(Systematic Trading roadmap: create → backtest → deploy loop).

Follows the ``FakeIBApp`` pattern from ``test_market_data_history_route.py``:
``get_ib_connection`` / ``verify_connection_health`` / ``time.sleep`` are
monkeypatched so no IB Gateway, network or background thread is touched. The
suite exercises exactly the selection/validation logic (registered key vs.
inline rule-set), the instrument parameters, and the adapter dispatch for a
non-IB ``source=``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import adapters
from routes import backtesting as bt_routes


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
    conId: int = 12345  # noqa: N815 (matches ibapi's Contract field name)


@dataclass
class FakeIBApp:
    """Synchronous stand-in for ``ib_client.IBApp``."""

    connected: bool = True
    contract_found: bool = True
    bars: List[FakeBar] = field(default_factory=list)
    contracts: List[FakeContract] = field(default_factory=list)
    historical_data: List[FakeBar] = field(default_factory=list)
    requested_contract: Any = None

    def isConnected(self) -> bool:  # noqa: N802 (matches ibapi's EClient method name)
        return self.connected

    def reqContractDetails(self, reqId, contract) -> None:  # noqa: N802, ARG002
        self.requested_contract = contract
        if self.contract_found:
            self.contracts.append(FakeContract(symbol=contract.symbol))

    def reqHistoricalData(self, *args, **kwargs) -> None:  # noqa: N802, ARG002
        self.historical_data.extend(self.bars)


def _rising_bars(n: int = 60) -> List[FakeBar]:
    # Enough bars to clear MIN_BARS and warm up sma_50; strictly rising closes.
    return [
        FakeBar(date=f"{2025}{1 + i // 28:02d}{1 + i % 28:02d}", close=100.0 + i) for i in range(n)
    ]


def _client(monkeypatch: pytest.MonkeyPatch, fake_ib: FakeIBApp) -> TestClient:
    monkeypatch.setattr(bt_routes, "get_ib_connection", lambda: fake_ib)
    monkeypatch.setattr(bt_routes, "verify_connection_health", lambda ib: ib.isConnected())
    monkeypatch.setattr(bt_routes.time, "sleep", lambda _seconds: None)
    app = FastAPI()
    app.include_router(bt_routes.router)
    return TestClient(app)


MA_RULES = {
    "name": "MA rules",
    "entry": {"all": [{"left": "sma_20", "op": ">", "right": "sma_50"}]},
    "exit": {"all": [{"left": "sma_20", "op": "<", "right": "sma_50"}]},
}


def test_run_with_registered_strategy_key(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.post(
        "/backtesting/run",
        params={"symbol": "MSFT", "strategy": "ma_crossover", "timeframe": "1day"},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["data_points"] == 60
    assert body["results"]["symbol"] == "MSFT"


def test_run_with_inline_rule_set_body(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.post(
        "/backtesting/run",
        params={"symbol": "MSFT", "timeframe": "1day"},
        json={"rule_set": MA_RULES},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["strategy"] == "MA rules"


def test_run_rejects_both_strategy_and_rule_set(monkeypatch):
    client = _client(monkeypatch, FakeIBApp(bars=_rising_bars()))
    res = client.post(
        "/backtesting/run",
        params={"symbol": "MSFT", "strategy": "ma_crossover"},
        json={"rule_set": MA_RULES},
    )
    assert res.status_code == 400
    assert "exactly one" in res.json()["detail"].lower()


def test_run_rejects_neither_strategy_nor_rule_set(monkeypatch):
    client = _client(monkeypatch, FakeIBApp(bars=_rising_bars()))
    res = client.post("/backtesting/run", params={"symbol": "MSFT"})
    assert res.status_code == 400
    assert "exactly one" in res.json()["detail"].lower()


def test_run_400s_on_a_rule_set_that_fails_to_compile(monkeypatch):
    client = _client(monkeypatch, FakeIBApp(bars=_rising_bars()))
    res = client.post(
        "/backtesting/run",
        params={"symbol": "MSFT"},
        json={"rule_set": {"entry": {"all": [{"left": "not_an_operand", "op": ">", "right": 1}]}}},
    )
    assert res.status_code == 400
    assert "operand" in res.json()["detail"].lower()


def test_run_threads_instrument_fields_into_the_contract(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.post(
        "/backtesting/run",
        params={
            "symbol": "eur.usd",
            "strategy": "ma_crossover",
            "timeframe": "1hour",
            "sec_type": "CASH",
            "exchange": "IDEALPRO",
            "currency": "USD",
        },
    )

    assert res.status_code == 200
    contract = fake_ib.requested_contract
    assert contract.symbol == "EUR.USD"
    assert contract.secType == "CASH"
    assert contract.exchange == "IDEALPRO"
    assert contract.currency == "USD"


def test_run_404s_when_the_contract_does_not_qualify(monkeypatch):
    fake_ib = FakeIBApp(contract_found=False, bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.post(
        "/backtesting/run",
        params={"symbol": "NOTREAL", "strategy": "ma_crossover"},
    )

    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()


def test_run_400s_on_insufficient_bars(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars(n=10))
    client = _client(monkeypatch, fake_ib)

    res = client.post(
        "/backtesting/run",
        params={"symbol": "MSFT", "strategy": "ma_crossover"},
    )

    assert res.status_code == 400
    assert "insufficient" in res.json()["detail"].lower()


def test_run_dispatches_a_non_ib_source_through_the_adapter(monkeypatch):
    """``source=mt5`` fetches bars from the venue's data adapter, not IB."""

    start = 1_700_000_000
    adapter_bars = [
        SimpleNamespace(
            timestamp=start + i * 3600,
            open=100.0 + i,
            high=101.0 + i,
            low=99.0 + i,
            close=100.5 + i,
            volume=1000,
        )
        for i in range(60)
    ]

    class FakeAdapter:
        def historical_bars(self, symbol, timeframe, period, **kwargs):
            assert symbol == "EURUSD"
            return SimpleNamespace(bars=adapter_bars)

    monkeypatch.setattr(
        adapters, "get_market_data_adapter", lambda source, account=None: FakeAdapter()
    )

    # No IB monkeypatching needed — the IB path must not be touched at all.
    app = FastAPI()
    app.include_router(bt_routes.router)
    client = TestClient(app)

    res = client.post(
        "/backtesting/run",
        params={"symbol": "eurusd", "strategy": "ma_crossover", "source": "mt5"},
    )

    assert res.status_code == 200
    assert res.json()["data_points"] == 60
