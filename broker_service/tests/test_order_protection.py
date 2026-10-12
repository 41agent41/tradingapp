"""
`POST /orders` and protection (E-2): an entry that asks for a stop is only
sent to an adapter that attaches one, and a stop the venue did not record is
flagged so the backend can close the position.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException


class _Adapter:
    def __init__(self, *, attaches_stops, result=None):
        if attaches_stops is not None:
            self.attaches_stops = attaches_stops
        self.result = result or {}
        self.placed = []

    def place_order(self, req):
        self.placed.append(req)
        return dict(self.result)


@pytest.fixture
def place(monkeypatch):
    import adapters
    import orders

    def run(adapter, **fields):
        monkeypatch.setattr(adapters, "get_broker_adapter", lambda *a, **k: adapter)
        req = orders.PlaceOrderRequest(
            symbol="EURUSD", action="BUY", quantity=1, broker="mt5", **fields
        )
        return asyncio.run(orders.place_order(req))

    return run


def test_a_stop_is_refused_by_an_adapter_that_cannot_attach_one(place):
    adapter = _Adapter(attaches_stops=None)
    with pytest.raises(HTTPException) as exc:
        place(adapter, stop_loss=1.08)
    assert exc.value.status_code == 400
    assert "unprotected" in exc.value.detail
    assert adapter.placed == []


def test_an_entry_without_a_stop_still_reaches_any_adapter(place):
    adapter = _Adapter(attaches_stops=None, result={"status": "filled"})
    assert place(adapter)["status"] == "filled"
    assert len(adapter.placed) == 1


def test_a_recorded_stop_is_not_flagged(place):
    adapter = _Adapter(attaches_stops=True, result={"status": "filled", "sl": 1.08})
    assert "stop_loss_missing" not in place(adapter, stop_loss=1.08)


def test_a_dropped_stop_is_flagged(place):
    adapter = _Adapter(attaches_stops=True, result={"status": "filled", "sl": None})
    assert place(adapter, stop_loss=1.08)["stop_loss_missing"] is True


def test_venue_adapters_declare_stop_support():
    from alpaca_adapter import AlpacaAdapter
    from ib_adapter import IBAdapter
    from mt5_adapter import MT5Adapter
    from oanda_adapter import OANDAAdapter
    from split_account_adapter import SplitAccountAdapter

    assert MT5Adapter.attaches_stops is True
    assert OANDAAdapter.attaches_stops is True
    assert not getattr(IBAdapter, "attaches_stops", False)
    assert not getattr(AlpacaAdapter, "attaches_stops", False)
    split = SplitAccountAdapter(execution=MT5Adapter.__new__(MT5Adapter), account_info=object())
    assert split.attaches_stops is True
