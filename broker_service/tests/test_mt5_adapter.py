"""
Tests for the MT5 adapter — market data (B2a) and execution (B2b).

The sidecar HTTP layer is faked (no network): a stub `httpx.Client` records the
request and returns canned JSON, so the adapter's mapping (timeframe, timestamp
normalisation, response shaping, order placement + gate, error translation) is
verified in isolation. Registry availability is exercised by toggling
MT5_BRIDGE_URL.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


# --------------------------------------------------------------------------- #
# Fake httpx client
# --------------------------------------------------------------------------- #
class FakeResponse:
    def __init__(self, payload, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text or str(payload)

    def json(self):
        if self._payload is _NON_JSON:
            raise ValueError("not json")
        return self._payload


_NON_JSON = object()


class FakeClient:
    """Context-manager stand-in for httpx.Client. `calls` records
    (method, url, params, json, headers); `handler(method, url, params, json)`
    returns a FakeResponse (or raises httpx.HTTPError)."""

    calls = []
    handler = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def request(self, method, url, params=None, json=None, headers=None):
        FakeClient.calls.append((method, url, params or {}, json, headers))
        return FakeClient.handler(method, url, params or {}, json)


@pytest.fixture
def mt5(monkeypatch):
    import mt5_adapter

    importlib.reload(mt5_adapter)
    FakeClient.calls = []
    FakeClient.handler = None
    monkeypatch.setattr(mt5_adapter.httpx, "Client", FakeClient)
    return mt5_adapter


def _adapter(mt5_mod):
    return mt5_mod.MT5Adapter("http://mt5-host:9100/")


# --------------------------------------------------------------------------- #
# Timestamp coercion
# --------------------------------------------------------------------------- #
def test_to_unix_seconds_variants(mt5):
    f = mt5._to_unix_seconds
    assert f(1_700_000_000) == 1_700_000_000
    assert f(1_700_000_000_000) == 1_700_000_000  # millis -> seconds
    assert f("1700000000") == 1_700_000_000
    assert f("2023-11-14T22:13:20Z") == pytest.approx(1_700_000_000, abs=1)


# --------------------------------------------------------------------------- #
# historical_bars
# --------------------------------------------------------------------------- #
def test_historical_bars_maps_timeframe_and_normalises(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "bars": [
                # deliberately out of order + mixed time units
                {"time": 1_700_000_300, "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 5},
                {
                    "time": 1_700_000_000_000,
                    "open": 1,
                    "high": 2,
                    "low": 0.5,
                    "close": 1.5,
                    "tick_volume": 9,
                },
            ]
        }
    )
    resp = _adapter(mt5).historical_bars("eurusd", "5min", "1M")

    # Sent MT5-native timeframe + a bounded count.
    _, _url, params, _body, _headers = FakeClient.calls[0]
    assert params["timeframe"] == "M5"
    assert params["symbol"] == "EURUSD"
    assert "count" in params

    assert resp.symbol == "EURUSD"
    assert resp.timeframe == "5min"
    assert resp.count == 2
    # Sorted ascending, millis coerced to seconds.
    assert resp.bars[0].timestamp == 1_700_000_000
    assert resp.bars[1].timestamp == 1_700_000_300
    assert resp.bars[0].volume == 9  # tick_volume fallback


def test_historical_bars_date_range_sets_custom_period(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"bars": []})
    resp = _adapter(mt5).historical_bars(
        "EURUSD", "1hour", "1Y", start_date="2024-01-01", end_date="2024-02-01"
    )
    _, _url, params, _body, _headers = FakeClient.calls[0]
    assert params["timeframe"] == "H1"
    assert params["start"] == "2024-01-01" and params["end"] == "2024-02-01"
    assert "count" not in params
    assert resp.period == "CUSTOM"


def test_historical_bars_computes_requested_indicators(mt5):
    bars = [
        {
            "time": 1_700_000_000 + i * 60,
            "open": 10 + i,
            "high": 11 + i,
            "low": 9 + i,
            "close": 10 + i,
            "volume": 100,
        }
        for i in range(30)
    ]
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"bars": bars})
    resp = _adapter(mt5).historical_bars("EURUSD", "1min", "1D", indicators=["sma_20"])
    assert resp.count == 30
    # The same calculator the IB path uses populates sma_20 on the bars.
    assert resp.bars[-1].sma_20 is not None
    # A 20-period average of a linear ramp trails the latest close.
    assert resp.bars[-1].sma_20 < resp.bars[-1].close


def test_unsupported_timeframe_is_400(mt5):
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).historical_bars("EURUSD", "tick", "1D")
    assert exc.value.status_code == 400


# --------------------------------------------------------------------------- #
# quotes / ticks / search
# --------------------------------------------------------------------------- #
def test_realtime_quote_maps_fields(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"bid": 1.2345, "ask": 1.2347, "last": 1.2346, "volume": 1000, "time": 1_700_000_000}
    )
    q = _adapter(mt5).realtime_quote("eurusd")
    assert q.symbol == "EURUSD"
    assert q.bid == 1.2345 and q.ask == 1.2347 and q.last == 1.2346
    assert q.volume == 1000


def test_search_contracts_tags_broker_mt5(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"results": [{"symbol": "EURUSD", "description": "Euro vs USD"}]}
    )

    class Req:
        symbol = "eur"
        max_results = 10

    out = _adapter(mt5).search_contracts(Req())
    assert out["count"] == 1
    assert out["results"][0]["symbol"] == "EURUSD"
    assert out["results"][0]["broker"] == "mt5"
    assert out["broker"] == "mt5"


# --------------------------------------------------------------------------- #
# error translation
# --------------------------------------------------------------------------- #
def test_bridge_unreachable_is_503(mt5):
    def boom(method, url, params, json):
        raise mt5.httpx.ConnectError("refused")

    FakeClient.handler = boom
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).realtime_quote("EURUSD")
    assert exc.value.status_code == 503


def test_bridge_5xx_is_502(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {}, status_code=500, text="boom"
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).realtime_quote("EURUSD")
    assert exc.value.status_code == 502


# --------------------------------------------------------------------------- #
# shared-secret auth (X-MT5-Bridge-Secret)
# --------------------------------------------------------------------------- #
def test_no_secret_configured_sends_no_auth_header(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"bid": 1.0, "ask": 1.0, "last": 1.0, "volume": 0, "time": 1_700_000_000}
    )
    mt5.MT5Adapter("http://mt5-host:9100/").realtime_quote("EURUSD")
    _, _url, _params, _body, headers = FakeClient.calls[0]
    assert headers is None


def test_secret_configured_sends_auth_header(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"bid": 1.0, "ask": 1.0, "last": 1.0, "volume": 0, "time": 1_700_000_000}
    )
    adapter = mt5.MT5Adapter("http://mt5-host:9100/", shared_secret="s3cr3t")
    adapter.realtime_quote("EURUSD")
    _, _url, _params, _body, headers = FakeClient.calls[0]
    assert headers == {"X-MT5-Bridge-Secret": "s3cr3t"}


def test_registry_wires_bridge_secret_into_adapter(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://mt5-host:9100")
    monkeypatch.setenv("MT5_BRIDGE_SECRET", "s3cr3t")
    adapters.reset_registry()

    md = adapters.get_market_data_adapter("mt5")
    assert md._shared_secret == "s3cr3t"


# --------------------------------------------------------------------------- #
# registry availability
# --------------------------------------------------------------------------- #
def test_registry_registers_mt5_when_bridge_url_set(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://mt5-host:9100")
    adapters.reset_registry()

    md = adapters.get_market_data_adapter("mt5")
    assert md.name == "mt5"
    # Both sides register when the bridge is configured (B2a data + B2b exec).
    assert adapters.get_broker_adapter("mt5").name == "mt5"
    health = adapters.provider_health()
    assert health["providers"]["mt5"]["market_data"] is True
    assert health["providers"]["mt5"]["broker"] is True
    assert health["providers"]["mt5"]["available"] is True


def test_registry_mt5_unavailable_without_bridge_url(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.delenv("MT5_BRIDGE_URL", raising=False)
    adapters.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter("mt5")
    assert exc.value.status_code == 501
    # Broker side is likewise unavailable without the bridge.
    with pytest.raises(HTTPException) as exc2:
        adapters.get_broker_adapter("mt5")
    assert exc2.value.status_code == 501


# --------------------------------------------------------------------------- #
# execution (B2b)
# --------------------------------------------------------------------------- #
class _OrderReq:
    def __init__(self, **kw):
        self.symbol = kw.get("symbol", "EURUSD")
        self.action = kw.get("action", "BUY")
        self.quantity = kw.get("quantity", 1)
        self.order_type = kw.get("order_type", "MKT")
        self.tif = kw.get("tif", "DAY")
        self.limit_price = kw.get("limit_price")
        self.stop_price = kw.get("stop_price")
        self.account_mode = kw.get("account_mode", "paper")
        self.audit_id = kw.get("audit_id")


def test_place_order_paper_posts_to_bridge_and_shapes_result(mt5, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"ticket": 555, "status": "submitted"}
    )
    out = _adapter(mt5).place_order(_OrderReq(symbol="eurusd", quantity=2, audit_id=9))

    method, url, _params, body, _headers = FakeClient.calls[0]
    assert method == "POST" and url.endswith("/orders")
    assert body["symbol"] == "EURUSD" and body["quantity"] == 2 and body["audit_id"] == 9
    # IB-shaped result so order_audit reconciles uniformly.
    assert out["order_id"] == 555
    assert out["status"] == "submitted"
    assert out["broker"] == "mt5"


def test_place_order_live_blocked_without_gate(mt5, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"ticket": 1})
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).place_order(_OrderReq(account_mode="live"))
    assert exc.value.status_code == 403
    # Gate fails closed — nothing reached the bridge.
    assert FakeClient.calls == []


def test_cancel_and_positions_and_account(mt5):
    calls = {"n": 0}

    def handler(method, url, params, json):
        calls["n"] += 1
        if method == "DELETE":
            return FakeResponse({"status": "cancel_requested"})
        if url.endswith("/positions"):
            return FakeResponse({"positions": [{"symbol": "EURUSD", "position": 2}]})
        if url.endswith("/account"):
            return FakeResponse({"balance": 10000, "equity": 10100})
        return FakeResponse({})

    FakeClient.handler = handler
    adapter = _adapter(mt5)
    assert adapter.cancel_order(555)["status"] == "cancel_requested"
    assert adapter.positions() == [{"symbol": "EURUSD", "position": 2}]
    assert adapter.account_summary()["equity"] == 10100
