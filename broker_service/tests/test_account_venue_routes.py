"""
Route tests for the venue-aware account endpoints.

``/account/positions`` became broker-aware first (covered in
``test_account_positions_route.py``); this file covers the rest of the family
closing the same gap — ``/account/executions`` (the new fills feed),
``/account/summary``, ``/account/orders`` and the combined ``/account/all``.
Every one of them used to read IB unconditionally, so a strategy run on
MT5 / Alpaca / OANDA saw the wrong venue's account.

They share one dispatch contract: ``broker=ib`` takes the synchronous IB path,
everything else goes through the adapter registry, an unknown broker is a 400
and a recognised-but-unconfigured one a 501.

The registry and the IB sync helpers are monkeypatched, so neither an IB
Gateway nor a venue HTTP call is touched.
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
        self.days: List[int] = []

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        self.days.append(days)
        return self.rows


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(account.router)
    return TestClient(app)


IB_ROWS = [
    {
        "exec_id": "0000e1a7.68f2c0a1.01.01",
        "order_id": "42",
        "symbol": "MSFT",
        "side": "BUY",
        "quantity": 100.0,
        "price": 410.25,
        "commission": 1.0,
        "realized_pnl": None,
        "executed_at": "2026-08-07T13:30:00+00:00",
        "account": "DU1234567",
        "currency": "USD",
        "broker": "ib",
    }
]

ALPACA_ROWS = [
    {
        "exec_id": "20260807133000000::abc",
        "order_id": "order-1",
        "symbol": "AAPL",
        "side": "SELL",
        "quantity": 40.0,
        "price": 190.5,
        "commission": 0.0,
        "realized_pnl": None,
        "executed_at": "2026-08-07T13:30:00+00:00",
        "account": None,
        "currency": "USD",
        "broker": "alpaca",
    }
]


def test_defaults_to_ib(monkeypatch):
    monkeypatch.setattr(account, "get_executions_sync", lambda days: IB_ROWS)

    res = _client().get("/account/executions")

    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["exec_id"] == "0000e1a7.68f2c0a1.01.01"
    assert body[0]["side"] == "BUY"


def test_non_ib_broker_dispatches_to_that_venues_adapter(monkeypatch):
    adapter = FakeBrokerAdapter(ALPACA_ROWS)
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker, account=None: adapter)

    def _fail(days: int) -> None:  # pragma: no cover - must never run
        raise AssertionError("the IB path must not be used for broker=alpaca")

    monkeypatch.setattr(account, "get_executions_sync", _fail)

    res = _client().get("/account/executions", params={"broker": "alpaca", "days": 3})

    assert res.status_code == 200
    assert adapter.days == [3]
    assert res.json()[0]["symbol"] == "AAPL"


def test_days_is_passed_through_to_the_ib_path(monkeypatch):
    seen: List[int] = []

    def _sync(days: int):
        seen.append(days)
        return IB_ROWS

    monkeypatch.setattr(account, "get_executions_sync", _sync)

    assert _client().get("/account/executions", params={"days": 5}).status_code == 200
    assert seen == [5]


@pytest.mark.parametrize("days", [0, -1, 31])
def test_days_outside_the_supported_window_is_rejected(monkeypatch, days):
    """A window is bounded on both ends: 0 would fetch nothing and an
    unbounded one would ask a venue to replay history it doesn't serve."""
    monkeypatch.setattr(account, "get_executions_sync", lambda days: IB_ROWS)

    res = _client().get("/account/executions", params={"days": days})

    assert res.status_code == 422


def test_unknown_broker_is_a_400(monkeypatch):
    monkeypatch.setattr(account, "get_executions_sync", lambda days: IB_ROWS)
    res = _client().get("/account/executions", params={"broker": "nope"})
    assert res.status_code == 400


def test_recognised_but_unconfigured_broker_is_a_501(monkeypatch):
    def _unavailable(broker: str, account: str | None = None):
        raise HTTPException(status_code=501, detail=f"{broker} is not configured")

    monkeypatch.setattr("adapters.get_broker_adapter", _unavailable)
    monkeypatch.setattr(account, "get_executions_sync", lambda days: IB_ROWS)

    res = _client().get("/account/executions", params={"broker": "oanda"})

    assert res.status_code == 501


# --------------------------------------------------------------------------- #
# `/account/summary` and `/account/orders` broker dispatch
# --------------------------------------------------------------------------- #
class FakeAccountAdapter:
    """Adapter stand-in returning the app-shaped payloads each venue normalises to."""

    def __init__(self) -> None:
        self.calls: List[str] = []

    def account_summary(self) -> Dict[str, Any]:
        self.calls.append("account_summary")
        return {
            "account_id": "ALPACA-1",
            "net_liquidation": 100_000.0,
            "currency": "USD",
            "last_updated": "2026-08-07T13:30:00+00:00",
            "total_cash_value": 25_000.0,
            "buying_power": 200_000.0,
            "maintenance_margin": 0.0,
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        self.calls.append("open_orders")
        return [
            {
                "order_id": "9f0f2a4e-0c2d-4d2b-9a7e-000000000001",
                "symbol": "AAPL",
                "action": "BUY",
                "quantity": 10.0,
                "order_type": "LMT",
                "status": "new",
                "filled_quantity": 0.0,
                "remaining_quantity": 10.0,
                "avg_fill_price": None,
            }
        ]

    def positions(self) -> List[Dict[str, Any]]:
        self.calls.append("positions")
        return []


def test_summary_dispatches_to_the_named_venue(monkeypatch):
    """A run on another venue reading IB's account is simply the wrong account
    — and this endpoint is where pct_equity sizing gets its equity."""
    adapter = FakeAccountAdapter()
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker, account=None: adapter)

    def _fail():  # pragma: no cover - must never run
        raise AssertionError("the IB path must not be used for broker=alpaca")

    monkeypatch.setattr(account, "get_account_summary_sync", _fail)

    res = _client().get("/account/summary", params={"broker": "alpaca"})

    assert res.status_code == 200
    assert res.json()["net_liquidation"] == 100_000.0
    assert adapter.calls == ["account_summary"]


def test_summary_defaults_to_ib(monkeypatch):
    from models import AccountSummary

    monkeypatch.setattr(
        account,
        "get_account_summary_sync",
        lambda: AccountSummary(
            account_id="DU1", currency="USD", last_updated="2026-08-07T13:30:00+00:00"
        ),
    )

    res = _client().get("/account/summary")

    assert res.status_code == 200
    assert res.json()["account_id"] == "DU1"


def test_orders_dispatch_to_the_named_venue(monkeypatch):
    adapter = FakeAccountAdapter()
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker, account=None: adapter)

    def _fail():  # pragma: no cover - must never run
        raise AssertionError("the IB path must not be used for broker=alpaca")

    monkeypatch.setattr(account, "get_orders_sync", _fail)

    res = _client().get("/account/orders", params={"broker": "alpaca"})

    assert res.status_code == 200
    body = res.json()
    # A non-numeric venue order id round-trips — the reason `Order.order_id`
    # is a string rather than an int.
    assert body[0]["order_id"] == "9f0f2a4e-0c2d-4d2b-9a7e-000000000001"
    assert adapter.calls == ["open_orders"]


def test_all_dispatches_every_section_to_the_same_venue(monkeypatch):
    adapter = FakeAccountAdapter()
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker, account=None: adapter)

    for name in ("get_account_summary_sync", "get_positions_sync", "get_orders_sync"):

        def _fail():  # pragma: no cover - must never run
            raise AssertionError("the IB path must not be used for broker=alpaca")

        monkeypatch.setattr(account, name, _fail)

    res = _client().get("/account/all", params={"broker": "alpaca"})

    assert res.status_code == 200
    assert sorted(adapter.calls) == ["account_summary", "open_orders", "positions"]


# --------------------------------------------------------------------------- #
# `/instrument/spec`
# --------------------------------------------------------------------------- #
def test_instrument_spec_dispatches_to_the_named_venue(monkeypatch):
    """What one unit of quantity *means* is a per-venue fact — 100 is 100
    shares on IB but 100 lots on MT5."""

    class SpecAdapter:
        def __init__(self) -> None:
            self.symbols: List[str] = []

        def instrument_spec(self, symbol: str) -> Dict[str, Any]:
            self.symbols.append(symbol)
            return {
                "symbol": symbol.upper(),
                "broker": "mt5",
                "unit": "lots",
                "min_size": 0.01,
                "size_step": 0.01,
                "max_size": 100.0,
                "contract_size": 100000.0,
                "currency": "USD",
            }

    adapter = SpecAdapter()
    monkeypatch.setattr("adapters.get_broker_adapter", lambda broker, account=None: adapter)

    res = _client().get("/instrument/spec", params={"symbol": "eurusd", "broker": "mt5"})

    assert res.status_code == 200
    assert adapter.symbols == ["eurusd"]
    body = res.json()
    assert body["unit"] == "lots"
    assert body["contract_size"] == 100000.0


def test_instrument_spec_requires_a_symbol():
    assert _client().get("/instrument/spec").status_code == 422


def test_instrument_spec_unknown_broker_is_a_400():
    assert (
        _client().get("/instrument/spec", params={"symbol": "MSFT", "broker": "nope"}).status_code
        == 400
    )


# --------------------------------------------------------------------------- #
# Connection routing (C-1) — the account reaches the adapter, over HTTP
# --------------------------------------------------------------------------- #
def test_account_param_selects_the_connection(monkeypatch):
    """Two accounts on one platform must reach two different adapters. This is
    the whole point of C-1: before it, `broker=mt5` had exactly one slot, so
    both accounts' traffic went to whichever sidecar was configured."""
    import adapters

    live = FakeBrokerAdapter([{**ALPACA_ROWS[0], "exec_id": "from-live"}])
    demo = FakeBrokerAdapter([{**ALPACA_ROWS[0], "exec_id": "from-demo"}])
    by_account = {"icmarkets-live": live, "pepperstone-demo": demo}
    seen: list[str | None] = []

    def _resolve(broker, account=None, **kwargs):
        seen.append(account)
        return by_account[account]

    monkeypatch.setattr(adapters, "get_broker_adapter", _resolve)

    client = _client()
    a = client.get("/account/executions", params={"broker": "mt5", "account": "icmarkets-live"})
    b = client.get("/account/executions", params={"broker": "mt5", "account": "pepperstone-demo"})

    assert a.status_code == 200
    assert b.status_code == 200
    assert a.json()[0]["exec_id"] == "from-live"
    assert b.json()[0]["exec_id"] == "from-demo"
    assert seen == ["icmarkets-live", "pepperstone-demo"]


def test_omitted_account_is_passed_as_none_for_the_registry_to_default(monkeypatch):
    """The route must not invent a default of its own — resolving the platform
    default is the registry's job, and two places deciding it would drift."""
    import adapters

    adapter = FakeBrokerAdapter(ALPACA_ROWS)
    seen: list[str | None] = []

    def _resolve(broker, account=None, **kwargs):
        seen.append(account)
        return adapter

    monkeypatch.setattr(adapters, "get_broker_adapter", _resolve)

    res = _client().get("/account/executions", params={"broker": "mt5"})

    assert res.status_code == 200
    assert seen == [None]
