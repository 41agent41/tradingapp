"""
Route tests for ``GET /account/positions`` broker dispatch (B1 close-out).

The endpoint used to call the IB client unconditionally, so a strategy run on
MT5 / Alpaca / OANDA read *IB's* positions. It now resolves ``broker=`` through
the adapter registry. These tests monkeypatch the registry (and the IB sync
helper) so neither an IB Gateway nor a venue HTTP call is touched.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from routes import account


class FakeBrokerAdapter:
    def __init__(self, rows: List[Dict[str, Any]]) -> None:
        self.rows = rows
        self.calls = 0

    def positions(self) -> List[Dict[str, Any]]:
        self.calls += 1
        return self.rows


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(account.router)
    return TestClient(app)


IB_ROWS = [
    {
        "symbol": "MSFT",
        "position": 100.0,
        "market_price": None,
        "market_value": None,
        "average_cost": 410.25,
        "unrealized_pnl": None,
        "currency": "USD",
    }
]

MT5_ROWS = [
    {
        "symbol": "EURUSD",
        "position": -0.5,
        "market_price": 1.15,
        "market_value": None,
        "average_cost": 1.2,
        "unrealized_pnl": 25.0,
        "currency": "USD",
    }
]


def test_defaults_to_ib_and_keeps_the_existing_sync_path(monkeypatch):
    monkeypatch.setattr(account, "get_positions_sync", lambda: IB_ROWS)

    res = _client().get("/account/positions")

    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["symbol"] == "MSFT"
    assert body[0]["average_cost"] == 410.25


def test_non_ib_broker_dispatches_to_that_venues_adapter(monkeypatch):
    adapter = FakeBrokerAdapter(MT5_ROWS)
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker: adapter)

    def _fail() -> None:  # pragma: no cover - must never run
        raise AssertionError("the IB path must not be used for broker=mt5")

    monkeypatch.setattr(account, "get_positions_sync", _fail)

    res = _client().get("/account/positions", params={"broker": "mt5"})

    assert res.status_code == 200
    assert adapter.calls == 1
    body = res.json()
    assert body[0]["symbol"] == "EURUSD"
    assert body[0]["position"] == -0.5
    assert body[0]["average_cost"] == 1.2


def test_unknown_broker_is_a_400(monkeypatch):
    monkeypatch.setattr(account, "get_positions_sync", lambda: IB_ROWS)
    res = _client().get("/account/positions", params={"broker": "nope"})
    assert res.status_code == 400


def test_recognised_but_unconfigured_broker_is_a_501(monkeypatch):
    def _unavailable(broker: str):
        raise HTTPException(status_code=501, detail=f"{broker} is not configured")

    monkeypatch.setattr("adapters.get_broker_adapter", _unavailable)
    monkeypatch.setattr(account, "get_positions_sync", lambda: IB_ROWS)

    res = _client().get("/account/positions", params={"broker": "alpaca"})

    assert res.status_code == 501


@pytest.mark.parametrize("broker", ["ib", "IB", ""])
def test_ib_aliases_all_take_the_ib_path(monkeypatch, broker):
    monkeypatch.setattr(account, "get_positions_sync", lambda: IB_ROWS)
    res = _client().get("/account/positions", params={"broker": broker})
    assert res.status_code == 200
    assert res.json()[0]["symbol"] == "MSFT"
