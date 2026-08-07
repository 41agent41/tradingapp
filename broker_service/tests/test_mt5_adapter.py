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
            return FakeResponse(
                {"positions": [{"symbol": "EURUSD", "position": 2, "average_cost": 1.1}]}
            )
        if url.endswith("/account"):
            return FakeResponse({"balance": 10000, "equity": 10100})
        return FakeResponse({})

    FakeClient.handler = handler
    adapter = _adapter(mt5)
    assert adapter.cancel_order(555)["status"] == "cancel_requested"
    # Normalised to the app's Position shape.
    assert adapter.positions() == [
        {
            "symbol": "EURUSD",
            "position": 2.0,
            "market_price": None,
            "market_value": None,
            "average_cost": 1.1,
            "unrealized_pnl": None,
            "currency": "USD",
        }
    ]
    # Normalised to the app's AccountSummary shape — MT5's `equity` is
    # balance plus floating P&L, i.e. net liquidation.
    summary = adapter.account_summary()
    assert summary["net_liquidation"] == 10100.0


def test_positions_accept_native_mt5_field_names(mt5):
    """A sidecar passing MT5's own PositionInfo fields through verbatim:
    unsigned `volume` with the direction in `type` (0=buy, 1=sell)."""

    def handler(method, url, params, json):
        if url.endswith("/positions"):
            return FakeResponse(
                {
                    "positions": [
                        {
                            "symbol": "EURUSD",
                            "volume": 0.5,
                            "type": 1,  # sell
                            "price_open": 1.2,
                            "price_current": 1.15,
                            "profit": 25.0,
                        },
                        {"symbol": "GBPUSD", "volume": 1.0, "type": 0, "price_open": 1.3},
                    ]
                }
            )
        return FakeResponse({})

    FakeClient.handler = handler
    rows = _adapter(mt5).positions()
    assert rows[0]["position"] == -0.5  # sell -> negative
    assert rows[0]["average_cost"] == 1.2
    assert rows[0]["market_price"] == 1.15
    assert rows[0]["unrealized_pnl"] == 25.0
    assert rows[1]["position"] == 1.0  # buy -> positive


# --------------------------------------------------------------------------- #
# executions (deals)
# --------------------------------------------------------------------------- #
def test_executions_read_mt5_native_deal_fields(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "deals": [
                {
                    "ticket": 5001,
                    "order": 4001,
                    "symbol": "eurusd",
                    "type": 0,  # buy
                    "volume": 1.0,
                    "price": 1.0925,
                    "commission": -0.7,
                    "profit": 0.0,
                    "time": 1786109400,
                },
                {
                    "ticket": 5002,
                    "order": 4002,
                    "symbol": "EURUSD",
                    "type": 1,  # sell
                    "volume": 1.0,
                    "price": 1.0950,
                    "commission": -0.7,
                    "profit": 25.0,
                    "time": 1786113000,
                },
            ]
        }
    )

    rows = _adapter(mt5).executions(days=3)

    method, url, params, _json, _headers = FakeClient.calls[-1]
    assert method == "GET"
    assert url.endswith("/deals")
    assert params["days"] == 3

    assert [r["exec_id"] for r in rows] == ["5001", "5002"]
    # MT5 reports volume unsigned with the direction in `type`.
    assert rows[0]["side"] == "BUY"
    assert rows[1]["side"] == "SELL"
    assert rows[0]["symbol"] == "EURUSD"
    assert rows[1]["realized_pnl"] == 25.0
    assert rows[0]["executed_at"].startswith("2026-08-07T")
    assert rows[0]["broker"] == "mt5"


def test_executions_accept_a_sidecar_that_speaks_the_app_vocabulary(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "deals": [
                {
                    "exec_id": "abc-1",
                    "order": "o-1",
                    "symbol": "EURUSD",
                    "side": "SELL",
                    "quantity": 2.0,
                    "price": 1.1,
                    "commission": -1.4,
                    "realized_pnl": 5.0,
                    "executed_at": "2026-08-07T13:30:00Z",
                }
            ]
        }
    )

    rows = _adapter(mt5).executions()

    assert rows[0]["exec_id"] == "abc-1"
    assert rows[0]["side"] == "SELL"
    assert rows[0]["quantity"] == 2.0


def test_executions_drop_non_trade_deal_entries(mt5):
    """MT5 history includes balance/credit entries (type >= 2) that carry no
    trade — folding those into a position would corrupt it."""
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "deals": [
                {"ticket": 1, "symbol": "", "type": 2, "volume": 0, "price": 0},
                {"ticket": 2, "symbol": "EURUSD", "type": 2, "volume": 1, "price": 1.1},
                {"ticket": 3, "symbol": "EURUSD", "type": 0, "volume": 1, "price": 1.1},
            ]
        }
    )

    rows = _adapter(mt5).executions()

    assert [r["exec_id"] for r in rows] == ["3"]


def test_open_orders_derive_direction_from_the_mt5_type_code(mt5):
    """MT5 order types pair up as buy/sell (0/1 market, 2/3 limit, …), so the
    direction is the low bit when the sidecar hasn't already translated it."""
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "orders": [
                {"ticket": 900, "symbol": "eurusd", "type": 2, "volume_current": 1.5},
                {"ticket": 901, "symbol": "EURUSD", "type": 3, "volume_current": 0.5},
                {"ticket": 902, "symbol": "EURUSD", "action": "SELL", "quantity": 2.0},
            ]
        }
    )

    rows = _adapter(mt5).open_orders()

    assert FakeClient.calls[-1][1].endswith("/orders")
    assert [(r["order_id"], r["action"], r["quantity"]) for r in rows] == [
        ("900", "BUY", 1.5),
        ("901", "SELL", 0.5),
        ("902", "SELL", 2.0),
    ]
    assert rows[0]["symbol"] == "EURUSD"


def test_instrument_spec_reads_mt5_symbol_info(mt5):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "volume_min": 0.01,
            "volume_step": 0.01,
            "volume_max": 100.0,
            "trade_contract_size": 100000.0,
            "currency_profit": "USD",
        }
    )

    spec = _adapter(mt5).instrument_spec("eurusd")

    assert FakeClient.calls[-1][1].endswith("/symbol")
    assert spec == {
        "symbol": "EURUSD",
        "broker": "mt5",
        "unit": "lots",
        "min_size": 0.01,
        "size_step": 0.01,
        "max_size": 100.0,
        # The factor that makes a lot not a share: one lot controls 100k units.
        "contract_size": 100000.0,
        "currency": "USD",
    }


def test_instrument_spec_falls_back_to_mt5_conventional_defaults(mt5):
    """The sidecar is out-of-repo; an incomplete response must still yield a
    usable, conservative spec rather than an error."""
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})

    spec = _adapter(mt5).instrument_spec("EURUSD")

    assert spec["min_size"] == 0.01
    assert spec["size_step"] == 0.01
    assert spec["contract_size"] == 100000.0
    assert spec["max_size"] is None
