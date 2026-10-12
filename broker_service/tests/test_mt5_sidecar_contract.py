"""
The MT5 adapter against the real sidecar code, end to end.

``test_mt5_adapter.py`` checks the adapter against canned responses, and
``mt5_sidecar/tests`` checks the sidecar on its own. This file joins them: the
adapter's HTTP calls go to the sidecar app (backed by the in-memory fake
terminal), so a change on either side of the contract that the other does not
understand fails here.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

_SIDECAR = Path(__file__).resolve().parents[2] / "mt5_sidecar"
for _path in (_SIDECAR, _SIDECAR / "tests"):
    if str(_path) not in sys.path:
        sys.path.append(str(_path))

from config import load_config  # noqa: E402
from fake_mt5 import FakeMT5  # noqa: E402
from server import create_app  # noqa: E402
from terminal import Terminal  # noqa: E402

BASE = "http://mt5-host:9100"
SECRET = "c" * 32


@pytest.fixture
def wired(monkeypatch):
    import mt5_adapter

    importlib.reload(mt5_adapter)
    fake = FakeMT5(symbols=["EURUSDm", "GBPUSD.a"])
    terminal = Terminal(fake, load_config({"MT5_BRIDGE_SECRET": SECRET}))
    terminal.connect()
    app = create_app(terminal)
    monkeypatch.setattr(mt5_adapter.httpx, "Client", lambda *a, **k: TestClient(app, base_url=BASE))
    adapter = mt5_adapter.MT5Adapter(BASE, shared_secret=SECRET)
    return fake, adapter


def _order(**overrides):
    base = {
        "symbol": "EURUSDm",
        "action": "BUY",
        "quantity": 0.1,
        "order_type": "MKT",
        "tif": "DAY",
        "limit_price": None,
        "stop_price": None,
        "stop_loss": 1.075,
        "take_profit": None,
        "account_mode": "paper",
        "audit_id": 42,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_wrong_secret_is_refused(wired):
    from fastapi import HTTPException

    _, adapter = wired
    adapter._shared_secret = "wrong" * 6
    with pytest.raises(HTTPException) as exc:
        adapter.account_summary()
    assert "401" in str(exc.value.detail)


def test_market_data(wired):
    _, adapter = wired
    search = adapter.search_contracts(SimpleNamespace(symbol="gbp", max_results=5))
    assert [r["symbol"] for r in search["results"]] == ["GBPUSD.a"]

    bars = adapter.historical_bars("EURUSDm", "5min", "1D")
    assert bars.count == 400
    assert bars.bars[-1].close == 1.0805

    quote = adapter.realtime_quote("EURUSDm")
    assert (quote.bid, quote.ask) == (1.08, 1.0801)

    spec = adapter.instrument_spec("GBPUSD.a")
    assert spec["min_size"] == 0.01
    assert spec["stops_level"] == 10
    assert spec["tick_value"] == 1.0
    assert spec["contract_size"] == 100000.0


def test_entry_exit_and_fills_round_trip(wired):
    fake, adapter = wired
    placed = adapter.place_order(_order())
    assert placed["status"] == "filled"
    assert placed["sl"] == 1.075  # the app checks this to confirm protection

    [position] = adapter.positions()
    assert position["symbol"] == "EURUSDM"
    assert position["position"] == 0.1
    assert position["stop_loss"] == 1.075

    moved = adapter.modify_position_stop("EURUSDm", stop_loss=1.076)
    assert moved["sl"] == 1.076
    assert adapter.positions()[0]["stop_loss"] == 1.076

    adapter.place_order(_order(action="SELL", stop_loss=None, audit_id=43))
    assert adapter.positions() == []

    fills = adapter.executions(days=1)
    assert [(f["side"], f["audit_id"]) for f in fills] == [("BUY", 42), ("SELL", 43)]
    assert all(f["quantity"] == 0.1 for f in fills)

    summary = adapter.account_summary()
    assert summary["account_id"] == "5001"
    assert summary["net_liquidation"] == 10_000.0


def test_dropped_stop_is_flagged_by_the_adapter_result(wired):
    fake, adapter = wired
    fake.drop_sl = True
    assert adapter.place_order(_order())["sl"] is None


def test_venue_rejection_surfaces_as_an_error(wired):
    from fastapi import HTTPException

    _, adapter = wired
    with pytest.raises(HTTPException) as exc:
        adapter.place_order(_order(stop_loss=1.07999))
    assert "10016" in str(exc.value.detail)


def test_working_orders(wired):
    _, adapter = wired
    placed = adapter.place_order(_order(order_type="LMT", limit_price=1.07, tif="GTC"))
    [working] = adapter.open_orders()
    assert working["order_type"] == "LMT"
    assert working["action"] == "BUY"
    assert adapter.cancel_order(int(placed["order_id"]))["status"] == "cancelled"
    assert adapter.open_orders() == []
