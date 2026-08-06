"""
Route tests for ``GET /market-data/history`` — the historical-data
assembly path (GAP_ANALYSIS §10 test-coverage-expansion item).

A ``FakeIBApp`` stands in for the real ``EClient``/``EWrapper`` pair:
``reqContractDetails``/``reqHistoricalData`` populate ``contracts``/
``historical_data`` synchronously instead of asynchronously via TWS
callbacks on a background thread, so the route's polling loop
(``while len(ib.historical_data) == 0 ...``) resolves on the first
check. ``routes.market_data.get_ib_connection`` is monkeypatched to
return it and ``time.sleep`` is stubbed out so the test doesn't pay for
the route's real inter-call delays. No IB Gateway, network or thread is
touched — this exercises exactly the assembly/validation logic in
``get_historical_data`` plus the ``bars_processing`` it hands off to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import market_data


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

    def isConnected(self) -> bool:  # noqa: N802 (matches ibapi's EClient method name)
        return self.connected

    def reqContractDetails(self, reqId, contract) -> None:  # noqa: N802, ARG002
        if self.contract_found:
            self.contracts.append(FakeContract(symbol=contract.symbol))

    def reqMarketDataType(self, market_data_type) -> None:  # noqa: N802, ARG002
        pass

    def reqHistoricalData(self, *args, **kwargs) -> None:  # noqa: N802, ARG002
        self.historical_data.extend(self.bars)


def _rising_bars(n: int = 5) -> List[FakeBar]:
    return [FakeBar(date=f"2025010{i + 1}", close=100.0 + i) for i in range(n)]


def _client(monkeypatch: pytest.MonkeyPatch, fake_ib: FakeIBApp) -> TestClient:
    monkeypatch.setattr(market_data, "get_ib_connection", lambda: fake_ib)
    monkeypatch.setattr(market_data.time, "sleep", lambda _seconds: None)
    app = FastAPI()
    app.include_router(market_data.router)
    return TestClient(app)


def test_history_assembles_bars_from_the_fake_ib_client(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={"symbol": "MSFT", "timeframe": "1day", "period": "1Y"},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 5
    assert body["symbol"] == "MSFT"
    # process_bars_with_indicators returns newest-first.
    assert body["bars"][0]["close"] == 104.0
    assert body["bars"][-1]["close"] == 100.0


def test_history_uses_the_qualified_contract_symbol(monkeypatch):
    """The route re-uses ``ib.contracts[0]`` (the qualified contract) rather
    than the raw query param when placing the historical-data request."""
    fake_ib = FakeIBApp(bars=_rising_bars(n=1))
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={"symbol": "msft", "timeframe": "1day", "period": "1Y"},
    )

    assert res.status_code == 200
    # reqContractDetails saw the uppercased symbol the route built the
    # contract with.
    assert fake_ib.contracts[0].symbol == "MSFT"


def test_history_404s_when_the_symbol_does_not_resolve_to_a_contract(monkeypatch):
    fake_ib = FakeIBApp(contract_found=False, bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={"symbol": "NOTREAL", "timeframe": "1day", "period": "1Y"},
    )

    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()


def test_history_404s_when_ib_gateway_returns_no_bars(monkeypatch):
    fake_ib = FakeIBApp(bars=[])
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={"symbol": "MSFT", "timeframe": "1day", "period": "1Y"},
    )

    assert res.status_code == 404
    assert "no historical data" in res.json()["detail"].lower()


def test_history_503s_when_the_ib_connection_is_not_actually_connected(monkeypatch):
    fake_ib = FakeIBApp(connected=False, bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={"symbol": "MSFT", "timeframe": "1day", "period": "1Y"},
    )

    assert res.status_code == 503


def test_history_rejects_both_period_and_date_range(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars())
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={
            "symbol": "MSFT",
            "timeframe": "1day",
            "period": "1Y",
            "start_date": "2025-01-01",
            "end_date": "2025-02-01",
        },
    )

    assert res.status_code == 400
    assert "cannot specify both" in res.json()["detail"].lower()


def test_history_with_explicit_date_range_uses_the_date_range_assembly_path(monkeypatch):
    fake_ib = FakeIBApp(bars=_rising_bars(n=3))
    client = _client(monkeypatch, fake_ib)

    res = client.get(
        "/market-data/history",
        params={
            "symbol": "MSFT",
            "timeframe": "1day",
            "period": "CUSTOM",
            "start_date": "2025-01-01",
            "end_date": "2025-02-01",
        },
    )

    assert res.status_code == 200
    assert res.json()["count"] == 3
