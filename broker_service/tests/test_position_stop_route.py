"""
Route tests for ``POST /positions/{symbol}/stop`` (E-3's trail).

The backend's runner moves a position's stop through this route; the MT5
adapter already knew how (``modify_position_stop``) but nothing exposed it, so
every trail update answered 404 and the stop never moved.
"""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import FastAPI
from fastapi.testclient import TestClient

import orders


class StopAdapter:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def modify_position_stop(self, symbol: str, *, stop_loss=None, take_profit=None):
        self.calls.append({"symbol": symbol, "stop_loss": stop_loss, "take_profit": take_profit})
        return {"symbol": symbol.upper(), "status": "modified", "sl": stop_loss, "tp": take_profit}


class NoStopAdapter:
    pass


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(orders.router)
    return TestClient(app)


def test_moves_the_stop_on_the_named_connection(monkeypatch):
    adapter = StopAdapter()
    seen: Dict[str, Any] = {}

    def _get(broker, account=None, **_kw):
        seen.update(broker=broker, account=account)
        return adapter

    monkeypatch.setattr("adapters.get_broker_adapter", _get)

    res = _client().post(
        "/positions/EURUSD.a/stop",
        params={"broker": "mt5", "account": "broker-a-demo"},
        json={"stop_loss": 1.0852},
    )

    assert res.status_code == 200
    assert res.json()["sl"] == 1.0852
    assert seen == {"broker": "mt5", "account": "broker-a-demo"}
    assert adapter.calls == [{"symbol": "EURUSD.a", "stop_loss": 1.0852, "take_profit": None}]


def test_a_venue_without_position_stops_is_a_501(monkeypatch):
    monkeypatch.setattr(
        "adapters.get_broker_adapter", lambda broker, account=None, **_kw: NoStopAdapter()
    )

    res = _client().post(
        "/positions/MSFT/stop", params={"broker": "alpaca"}, json={"stop_loss": 400}
    )

    assert res.status_code == 501


def test_a_stop_is_required(monkeypatch):
    monkeypatch.setattr(
        "adapters.get_broker_adapter", lambda broker, account=None, **_kw: StopAdapter()
    )

    assert _client().post("/positions/EURUSD/stop", json={}).status_code == 422
    assert _client().post("/positions/EURUSD/stop", json={"stop_loss": 0}).status_code == 422
