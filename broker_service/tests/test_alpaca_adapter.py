"""
Tests for the Alpaca adapter — market data + execution.

Alpaca's REST layer is faked (no network): a stub `httpx.Client` records the
request (including auth headers) and returns canned JSON, so the adapter's
mapping (timeframe, timestamp normalisation, response shaping, order
placement + gate, error translation) is verified in isolation. Registry
availability is exercised by toggling ALPACA_API_KEY/ALPACA_API_SECRET.
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
    (method, url, headers, params, json); `handler(...)` returns a
    FakeResponse (or raises httpx.HTTPError)."""

    calls = []
    handler = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def request(self, method, url, headers=None, params=None, json=None):
        FakeClient.calls.append((method, url, headers or {}, params or {}, json))
        return FakeClient.handler(method, url, params or {}, json)


@pytest.fixture
def alpaca(monkeypatch):
    import alpaca_adapter

    importlib.reload(alpaca_adapter)
    FakeClient.calls = []
    FakeClient.handler = None
    monkeypatch.setattr(alpaca_adapter.httpx, "Client", FakeClient)
    return alpaca_adapter


def _adapter(alpaca_mod, paper=True):
    return alpaca_mod.AlpacaAdapter("key123", "secret456", paper=paper)


# --------------------------------------------------------------------------- #
# base URL selection + auth headers
# --------------------------------------------------------------------------- #
def test_paper_vs_live_trading_base(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    _adapter(alpaca, paper=True).account_summary()
    assert FakeClient.calls[-1][1].startswith("https://paper-api.alpaca.markets")

    FakeClient.calls.clear()
    _adapter(alpaca, paper=False).account_summary()
    assert FakeClient.calls[-1][1].startswith("https://api.alpaca.markets")


def test_auth_headers_sent(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    _adapter(alpaca).account_summary()
    _method, _url, headers, _params, _json = FakeClient.calls[0]
    assert headers["APCA-API-KEY-ID"] == "key123"
    assert headers["APCA-API-SECRET-KEY"] == "secret456"


# --------------------------------------------------------------------------- #
# historical_bars
# --------------------------------------------------------------------------- #
def test_historical_bars_maps_timeframe_and_normalises(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "bars": [
                {"t": "2023-11-14T22:15:00Z", "o": 2, "h": 3, "l": 1, "c": 2.5, "v": 5},
                {"t": "2023-11-14T22:13:20Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 9},
            ]
        }
    )
    resp = _adapter(alpaca).historical_bars("aapl", "5min", "1M")

    _method, url, _headers, params, _json = FakeClient.calls[0]
    assert url.startswith("https://data.alpaca.markets")
    assert params["timeframe"] == "5Min"
    assert "limit" in params

    assert resp.symbol == "AAPL"
    assert resp.timeframe == "5min"
    assert resp.count == 2
    # Sorted ascending.
    assert resp.bars[0].timestamp < resp.bars[1].timestamp
    assert resp.bars[0].volume == 9


def test_historical_bars_date_range_sets_custom_period(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"bars": []})
    resp = _adapter(alpaca).historical_bars(
        "AAPL", "1hour", "1Y", start_date="2024-01-01", end_date="2024-02-01"
    )
    _method, _url, _headers, params, _json = FakeClient.calls[0]
    assert params["timeframe"] == "1Hour"
    assert params["start"] == "2024-01-01" and params["end"] == "2024-02-01"
    assert "limit" not in params
    assert resp.period == "CUSTOM"


def test_historical_bars_computes_requested_indicators(alpaca):
    bars = [
        {
            "t": f"2023-11-14T{22 - (i // 60):02d}:{i % 60:02d}:00Z",
            "o": 10 + i,
            "h": 11 + i,
            "l": 9 + i,
            "c": 10 + i,
            "v": 100,
        }
        for i in range(30)
    ]
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"bars": bars})
    resp = _adapter(alpaca).historical_bars("AAPL", "1min", "1D", indicators=["sma_20"])
    assert resp.count == 30
    assert resp.bars[-1].sma_20 is not None


def test_unsupported_timeframe_is_400(alpaca):
    with pytest.raises(HTTPException) as exc:
        _adapter(alpaca).historical_bars("AAPL", "8hour", "1D")
    assert exc.value.status_code == 400


# --------------------------------------------------------------------------- #
# quotes / ticks / search
# --------------------------------------------------------------------------- #
def test_realtime_quote_maps_fields(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"quote": {"bp": 189.5, "ap": 189.55, "bs": 100, "t": "2023-11-14T22:13:20Z"}}
    )
    q = _adapter(alpaca).realtime_quote("aapl")
    assert q.symbol == "AAPL"
    assert q.bid == 189.5 and q.ask == 189.55
    assert q.last == 189.55
    assert q.volume == 100


def test_tick_maps_last_trade(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"trade": {"p": 189.52, "s": 50, "t": "2023-11-14T22:13:20Z"}}
    )
    t = _adapter(alpaca).tick("AAPL")
    assert t["last"] == 189.52
    assert t["volume"] == 50
    assert t["broker"] == "alpaca"


def test_search_contracts_filters_and_tags_broker(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        [
            {"id": "1", "symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ"},
            {"id": "2", "symbol": "MSFT", "name": "Microsoft Corp.", "exchange": "NASDAQ"},
        ]
    )

    class Req:
        symbol = "AAP"
        max_results = 10

    out = _adapter(alpaca).search_contracts(Req())
    assert out["count"] == 1
    assert out["results"][0]["symbol"] == "AAPL"
    assert out["results"][0]["broker"] == "alpaca"
    assert out["broker"] == "alpaca"


# --------------------------------------------------------------------------- #
# error translation
# --------------------------------------------------------------------------- #
def test_unreachable_is_503(alpaca):
    def boom(method, url, params, json):
        raise alpaca.httpx.ConnectError("refused")

    FakeClient.handler = boom
    with pytest.raises(HTTPException) as exc:
        _adapter(alpaca).account_summary()
    assert exc.value.status_code == 503


def test_5xx_is_502(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {}, status_code=500, text="boom"
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(alpaca).account_summary()
    assert exc.value.status_code == 502


# --------------------------------------------------------------------------- #
# registry availability
# --------------------------------------------------------------------------- #
def test_registry_registers_alpaca_when_credentials_set(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("ALPACA_API_KEY", "key123")
    monkeypatch.setenv("ALPACA_API_SECRET", "secret456")
    adapters.reset_registry()

    md = adapters.get_market_data_adapter("alpaca")
    assert md.name == "alpaca"
    assert adapters.get_broker_adapter("alpaca").name == "alpaca"
    health = adapters.provider_health()
    assert health["providers"]["alpaca"]["market_data"] is True
    assert health["providers"]["alpaca"]["broker"] is True
    assert health["providers"]["alpaca"]["available"] is True


def test_registry_alpaca_unavailable_without_credentials(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.delenv("ALPACA_API_KEY", raising=False)
    monkeypatch.delenv("ALPACA_API_SECRET", raising=False)
    adapters.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter("alpaca")
    assert exc.value.status_code == 501
    with pytest.raises(HTTPException) as exc2:
        adapters.get_broker_adapter("alpaca")
    assert exc2.value.status_code == 501


def test_registry_alpaca_unavailable_with_only_one_credential(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("ALPACA_API_KEY", "key123")
    monkeypatch.delenv("ALPACA_API_SECRET", raising=False)
    adapters.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter("alpaca")
    assert exc.value.status_code == 501


# --------------------------------------------------------------------------- #
# execution
# --------------------------------------------------------------------------- #
class _OrderReq:
    def __init__(self, **kw):
        self.symbol = kw.get("symbol", "AAPL")
        self.action = kw.get("action", "BUY")
        self.quantity = kw.get("quantity", 1)
        self.order_type = kw.get("order_type", "MKT")
        self.tif = kw.get("tif", "DAY")
        self.limit_price = kw.get("limit_price")
        self.stop_price = kw.get("stop_price")
        self.account_mode = kw.get("account_mode", "paper")
        self.audit_id = kw.get("audit_id")


def test_place_order_paper_posts_and_shapes_result(alpaca, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"id": "abc-123", "status": "accepted"}
    )
    out = _adapter(alpaca).place_order(_OrderReq(symbol="aapl", quantity=2, audit_id=9))

    method, url, _headers, _params, body = FakeClient.calls[0]
    assert method == "POST" and url.endswith("/v2/orders")
    assert body["symbol"] == "AAPL"
    assert body["qty"] == "2"
    assert body["side"] == "buy"
    assert body["type"] == "market"
    assert body["time_in_force"] == "day"
    assert body["client_order_id"] == "audit-9"
    assert out["order_id"] == "abc-123"
    assert out["status"] == "accepted"
    assert out["broker"] == "alpaca"


def test_place_order_stop_limit_maps_type_and_prices(alpaca, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"id": "abc-124", "status": "accepted"}
    )
    _adapter(alpaca).place_order(
        _OrderReq(order_type="STP_LMT", limit_price=190.0, stop_price=189.0)
    )
    _method, _url, _headers, _params, body = FakeClient.calls[0]
    assert body["type"] == "stop_limit"
    assert body["limit_price"] == "190.0"
    assert body["stop_price"] == "189.0"


def test_place_order_live_blocked_without_gate(alpaca, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"id": "x"})
    with pytest.raises(HTTPException) as exc:
        _adapter(alpaca).place_order(_OrderReq(account_mode="live"))
    assert exc.value.status_code == 403
    assert FakeClient.calls == []


def test_cancel_modify_positions_account(alpaca):
    def handler(method, url, params, json):
        if method == "DELETE":
            return FakeResponse({})
        if method == "PATCH":
            return FakeResponse({"status": "replaced"})
        if url.endswith("/v2/positions"):
            return FakeResponse(
                [
                    {
                        "symbol": "AAPL",
                        "qty": "2",
                        "avg_entry_price": "100.5",
                        "current_price": "120.0",
                        "market_value": "240.0",
                        "unrealized_pl": "39.0",
                    },
                    # A flat row is dropped rather than reported as a position.
                    {"symbol": "MSFT", "qty": "0"},
                ]
            )
        if url.endswith("/v2/account"):
            return FakeResponse({"equity": "10100"})
        return FakeResponse({})

    FakeClient.handler = handler
    adapter = _adapter(alpaca)
    assert adapter.cancel_order("abc-123")["status"] == "cancel_requested"
    out = adapter.modify_order("abc-123", _OrderReq(quantity=5))
    assert out["status"] == "replaced"
    # Normalised to the app's Position shape, not Alpaca's raw payload.
    assert adapter.positions() == [
        {
            "symbol": "AAPL",
            "position": 2.0,
            "market_price": 120.0,
            "market_value": 240.0,
            "average_cost": 100.5,
            "unrealized_pnl": 39.0,
            "currency": "USD",
        }
    ]
    # Normalised to the app's AccountSummary shape — `equity` is Alpaca's
    # name for net liquidation, which is what pct_equity sizing reads.
    summary = adapter.account_summary()
    assert summary["net_liquidation"] == 10100.0
    assert summary["currency"] == "USD"


def test_positions_carry_a_short_as_a_negative_size(alpaca):
    def handler(method, url, params, json):
        if url.endswith("/v2/positions"):
            return FakeResponse([{"symbol": "AAPL", "qty": "-3", "avg_entry_price": "99"}])
        return FakeResponse({})

    FakeClient.handler = handler
    row = _adapter(alpaca).positions()[0]
    assert row["position"] == -3.0
    assert row["average_cost"] == 99.0


# --------------------------------------------------------------------------- #
# executions (fills)
# --------------------------------------------------------------------------- #
def test_executions_normalise_fill_activities(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        [
            {
                "id": "20260807133000000::abc",
                "activity_type": "FILL",
                "transaction_time": "2026-08-07T13:30:00Z",
                "type": "fill",
                "price": "250.50",
                "qty": "100",
                "side": "buy",
                "symbol": "msft",
                "order_id": "order-1",
            },
            {
                "id": "20260807140000000::def",
                "activity_type": "FILL",
                "transaction_time": "2026-08-07T14:00:00Z",
                "type": "partial_fill",
                "price": "251.00",
                "qty": "40",
                "side": "sell_short",
                "symbol": "MSFT",
                "order_id": "order-2",
            },
        ]
    )

    rows = _adapter(alpaca).executions(days=2)

    method, url, _headers, params, _json = FakeClient.calls[-1]
    assert method == "GET"
    assert url.endswith("/v2/account/activities/FILL")
    assert "after" in params

    assert [r["exec_id"] for r in rows] == ["20260807133000000::abc", "20260807140000000::def"]
    assert rows[0]["symbol"] == "MSFT"
    assert rows[0]["side"] == "BUY"
    assert rows[0]["quantity"] == 100.0
    assert rows[0]["price"] == 250.5
    # Alpaca charges no equity commission — a definite 0, not an unknown None.
    assert rows[0]["commission"] == 0.0
    assert rows[0]["broker"] == "alpaca"
    # A partial fill is a first-class row (the audit-log estimate this replaces
    # could not see it), and `sell_short` is just a SELL.
    assert rows[1]["side"] == "SELL"
    assert rows[1]["quantity"] == 40.0


def test_executions_skip_rows_without_a_usable_price_or_id(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        [
            {"id": "", "qty": "10", "price": "1", "side": "buy", "symbol": "AAA"},
            {"id": "keep", "qty": "10", "price": "1", "side": "buy", "symbol": "AAA"},
            {"id": "no-price", "qty": "10", "side": "buy", "symbol": "AAA"},
        ]
    )

    rows = _adapter(alpaca).executions()

    assert [r["exec_id"] for r in rows] == ["keep"]


def test_open_orders_normalise_to_the_app_shape(alpaca):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        [
            {
                "id": "9f0f2a4e-0c2d-4d2b-9a7e-000000000001",
                "symbol": "aapl",
                "side": "sell",
                "qty": "10",
                "filled_qty": "4",
                "type": "limit",
                "status": "partially_filled",
                "filled_avg_price": "190.25",
            }
        ]
    )

    rows = _adapter(alpaca).open_orders()

    _method, url, _headers, params, _json = FakeClient.calls[-1]
    assert url.endswith("/v2/orders")
    assert params["status"] == "open"

    assert rows == [
        {
            "order_id": "9f0f2a4e-0c2d-4d2b-9a7e-000000000001",
            "symbol": "AAPL",
            "action": "SELL",
            "quantity": 10.0,
            # Alpaca's lowercase vocabulary maps back to the app's.
            "order_type": "LMT",
            "status": "partially_filled",
            "filled_quantity": 4.0,
            "remaining_quantity": 6.0,
            "avg_fill_price": 190.25,
        }
    ]


def test_instrument_spec_is_whole_shares(alpaca):
    spec = _adapter(alpaca).instrument_spec("aapl")

    assert spec["unit"] == "shares"
    assert spec["min_size"] == 1.0
    assert spec["size_step"] == 1.0
    assert spec["contract_size"] == 1.0
    assert spec["symbol"] == "AAPL"
