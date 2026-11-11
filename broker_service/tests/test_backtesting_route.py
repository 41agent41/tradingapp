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


# --------------------------------------------------------------------------- #
# Bars supplied with the request (read from the database by the backend)
# --------------------------------------------------------------------------- #


def _columns(n: int = 60, step: int = 3600) -> dict:
    start = 1_700_000_000
    closes = [100.0 + i for i in range(n)]
    return {
        "t": [start + i * step for i in range(n)],
        "o": [c - 0.5 for c in closes],
        "h": [c + 1 for c in closes],
        "l": [c - 1 for c in closes],
        "c": closes,
        "v": [1000.0] * n,
    }


def _no_broker_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A client for which any fetch from a broker is a test failure."""

    def refuse(*_args, **_kwargs):
        raise AssertionError("bars were supplied; nothing should be fetched")

    monkeypatch.setattr(bt_routes, "get_ib_connection", refuse)
    monkeypatch.setattr(adapters, "get_market_data_adapter", refuse)
    app = FastAPI()
    app.include_router(bt_routes.router)
    return TestClient(app)


def test_run_uses_supplied_bars_and_fetches_nothing(monkeypatch):
    client = _no_broker_client(monkeypatch)
    res = client.post(
        "/backtesting/run",
        params={"symbol": "EURUSD", "timeframe": "1hour", "source": "ib"},
        json={"rule_set": MA_RULES, "bars": _columns()},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["data_points"] == 60
    # The equity curve runs over the supplied bars' own times.
    curve = body["results"]["equity_curve"]
    assert curve[0]["time"] >= 1_700_000_000
    assert curve[-1]["time"] == 1_700_000_000 + 59 * 3600


def test_supplied_bars_may_span_more_than_a_year(monkeypatch):
    client = _no_broker_client(monkeypatch)
    res = client.post(
        "/backtesting/run",
        params={
            "symbol": "EURUSD",
            "strategy": "ma_crossover",
            "timeframe": "1day",
            "start_date": "2020-01-01",
            "end_date": "2024-01-01",
        },
        json={"bars": _columns(n=800, step=86_400)},
    )
    assert res.status_code == 200, res.text
    assert res.json()["data_points"] == 800


@pytest.mark.parametrize(
    "change, message",
    [
        (lambda b: b["c"].pop(), "same length"),
        (lambda b: b["v"].pop(), "v must be"),
        (lambda b: b["t"].__setitem__(5, b["t"][4]), "strictly increasing"),
    ],
)
def test_supplied_bars_that_do_not_line_up_are_refused(monkeypatch, change, message):
    client = _no_broker_client(monkeypatch)
    bars = _columns()
    change(bars)
    res = client.post(
        "/backtesting/run",
        params={"symbol": "EURUSD", "strategy": "ma_crossover"},
        json={"bars": bars},
    )
    assert res.status_code == 400
    assert message in res.json()["detail"]


def test_too_few_supplied_bars_is_insufficient_data(monkeypatch):
    client = _no_broker_client(monkeypatch)
    res = client.post(
        "/backtesting/run",
        params={"symbol": "EURUSD", "strategy": "ma_crossover"},
        json={"bars": _columns(n=10)},
    )
    assert res.status_code == 400
    assert "insufficient" in res.json()["detail"].lower()


# --------------------------------------------------------------------------- #
# 1-minute bars supplied for stop fills
# --------------------------------------------------------------------------- #

STOP_RULES = {
    "name": "Stop rules",
    # In on the bar that closes at 110; never out by rule.
    "entry": {
        "all": [
            {"left": "close", "op": ">=", "right": 110},
            {"left": "close", "op": "<=", "right": 110},
        ]
    },
    "exit": {"all": [{"left": "close", "op": "<", "right": 0}]},
    "sizing": {"type": "fixed", "size": 10},
    "stop": {"type": "fixed", "distance": 2},
}


def test_supplied_minute_bars_decide_where_a_stop_fills(monkeypatch):
    client = _no_broker_client(monkeypatch)
    bars = _columns()
    # Bar 10 closes at 110 and enters with a stop at 108. Bar 11 dips to 107.
    bars["l"][11] = 107.0
    start = bars["t"][11]
    minute_bars = {
        "t": [start, start + 60, start + 120],
        "o": [110.5, 110.4, 107.5],
        "h": [110.6, 110.5, 107.6],
        "l": [110.3, 109.0, 107.0],
        "c": [110.4, 109.2, 107.2],
        "v": [1.0, 1.0, 1.0],
    }
    params = {"symbol": "EURUSD", "timeframe": "1hour"}

    on_bars = client.post(
        "/backtesting/run", params=params, json={"rule_set": STOP_RULES, "bars": bars}
    )
    assert on_bars.status_code == 200, on_bars.text
    results = on_bars.json()["results"]
    assert results["trades_summary"][0]["exit_price"] == 108.0
    assert results["fills"]["model"] == "bar"

    on_minutes = client.post(
        "/backtesting/run",
        params=params,
        json={"rule_set": STOP_RULES, "bars": bars, "minute_bars": minute_bars},
    )
    assert on_minutes.status_code == 200, on_minutes.text
    results = on_minutes.json()["results"]
    # The third minute opened below the stop, so the fill is that open.
    assert results["trades_summary"][0]["exit_price"] == 107.5
    assert results["fills"]["model"] == "1min"
    assert results["fills"]["stop_exits_on_minutes"] == 1


def test_minute_bars_that_do_not_line_up_are_refused(monkeypatch):
    client = _no_broker_client(monkeypatch)
    res = client.post(
        "/backtesting/run",
        params={"symbol": "EURUSD", "timeframe": "1hour"},
        json={
            "rule_set": STOP_RULES,
            "bars": _columns(),
            "minute_bars": {
                "t": [1, 2],
                "o": [1.0],
                "h": [1.0, 1.0],
                "l": [1.0, 1.0],
                "c": [1.0, 1.0],
            },
        },
    )
    assert res.status_code == 400
    assert "minute_bars: t, o, h, l and c" in res.json()["detail"]


# --------------------------------------------------------------------------- #
# Bars that carry the broker's spread (E-15)
# --------------------------------------------------------------------------- #
ALWAYS_IN = {
    "name": "always-in",
    "entry": {"all": [{"left": "close", "op": ">", "right": 0}]},
    "exit": {"all": [{"left": "close", "op": "<", "right": 0}]},
    "sizing": {"type": "fixed", "size": 10},
}


def _run_with(monkeypatch, bars, **params):
    client = _no_broker_client(monkeypatch)
    return client.post(
        "/backtesting/run",
        params={"symbol": "EURUSD", "timeframe": "1hour", "source": "ib", **params},
        json={"rule_set": ALWAYS_IN, "bars": bars},
    )


def test_supplied_spreads_fill_at_the_bid_and_ask(monkeypatch):
    bars = {**_columns(), "s": [0.2] * 59 + [None]}
    res = _run_with(monkeypatch, bars)
    assert res.status_code == 200, res.text
    results = res.json()["results"]
    assert results["spread"]["applied"] is True
    assert results["spread"]["bars_with_spread"] == 59
    # Bought on the first bar (close 100) at the ask.
    assert results["trades_summary"][0]["entry_price"] == pytest.approx(100.1)


def test_use_spread_false_fills_at_the_bars_own_price(monkeypatch):
    bars = {**_columns(), "s": [0.2] * 60}
    res = _run_with(monkeypatch, bars, use_spread="false")
    assert res.status_code == 200, res.text
    results = res.json()["results"]
    assert "spread" not in results
    assert results["trades_summary"][0]["entry_price"] == 100.0


def test_bars_without_spreads_report_none(monkeypatch):
    res = _run_with(monkeypatch, {**_columns(), "s": [None] * 60})
    assert res.status_code == 200, res.text
    assert "spread" not in res.json()["results"]


def test_spreads_that_do_not_line_up_are_refused(monkeypatch):
    res = _run_with(monkeypatch, {**_columns(), "s": [0.2] * 3})
    assert res.status_code == 400
    assert "s must be empty or as long as t" in res.json()["detail"]
