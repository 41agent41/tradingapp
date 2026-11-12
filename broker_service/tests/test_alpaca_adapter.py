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
    assert params["limit"] == 10000
    assert resp.period == "CUSTOM"


def _paged_bars(pages):
    """A fake Alpaca serving `pages` (lists of bar timestamps) one per
    request, linked by next_page_token."""

    def handler(method, url, params, json):
        index = int(params.get("page_token") or 0)
        body = {
            "bars": [{"t": t, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1} for t in pages[index]],
            "next_page_token": str(index + 1) if index + 1 < len(pages) else None,
        }
        return FakeResponse(body)

    return handler


def test_historical_bars_range_follows_page_tokens(alpaca):
    FakeClient.handler = _paged_bars(
        [["2024-01-02T14:30:00Z"], ["2024-01-03T14:30:00Z"], ["2024-01-04T14:30:00Z"]]
    )
    resp = _adapter(alpaca).historical_bars(
        "AAPL", "1day", "1Y", start_date="2024-01-01", end_date="2024-02-01"
    )
    assert resp.count == 3
    assert [c[3].get("page_token") for c in FakeClient.calls] == [None, "1", "2"]
    assert resp.bars[0].timestamp < resp.bars[-1].timestamp


def test_historical_bars_period_has_a_start_newest_first_and_a_page_cap(alpaca):
    pages = [[f"2024-01-{d:02d}T14:30:00Z"] for d in range(28, 0, -1)]
    FakeClient.handler = _paged_bars(pages)
    resp = _adapter(alpaca).historical_bars("AAPL", "1day", "1M")
    params = FakeClient.calls[0][3]
    assert params["sort"] == "desc" and "start" in params
    assert len(FakeClient.calls) == alpaca._MAX_PERIOD_PAGES
    # The newest bars are kept, returned oldest first.
    assert resp.count == alpaca._MAX_PERIOD_PAGES
    assert resp.bars[-1].timestamp > resp.bars[0].timestamp


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


# --------------------------------------------------------------------------- #
# Streaming (WebSockets)
# --------------------------------------------------------------------------- #
class FakeSocket:
    """A WebSocket that plays ``frames`` and then stays silent. A frame that
    is an exception is raised instead of returned."""

    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []
        self.closed = False

    def recv(self, timeout=None):
        if not self.frames:
            raise TimeoutError
        frame = self.frames.pop(0)
        if isinstance(frame, BaseException):
            raise frame
        return frame

    def send(self, text):
        import json

        self.sent.append(json.loads(text))

    def close(self):
        self.closed = True


def _stream_adapter(monkeypatch, frames, paper=True):
    import json

    import alpaca_adapter

    socket = FakeSocket(
        [f if isinstance(f, (bytes, BaseException)) else json.dumps(f) for f in frames]
    )
    urls = []

    def connect(url, timeout):
        urls.append(url)
        return socket

    monkeypatch.setattr(alpaca_adapter, "_connect", connect)
    adapter = alpaca_adapter.AlpacaAdapter("key-1", "secret-1", paper=paper)
    return adapter, socket, urls


def _until_silent(socket):
    """Stop once every frame has been played."""
    return lambda: not socket.frames


def test_stream_prices_authenticates_subscribes_and_reports_quotes_and_trades(monkeypatch):
    adapter, socket, urls = _stream_adapter(
        monkeypatch,
        [
            [{"T": "success", "msg": "connected"}],
            [{"T": "success", "msg": "authenticated"}],
            [{"T": "subscription", "trades": ["AAPL", "MSFT"], "quotes": ["AAPL", "MSFT"]}],
            [
                {"T": "q", "S": "AAPL", "bp": 189.5, "ap": 189.52},
                {"T": "t", "S": "AAPL", "p": 189.51, "s": 100},
            ],
            [{"T": "q", "S": "MSFT", "bp": 0, "ap": 410.2}, {"T": "t", "S": "TSLA", "p": 1}],
            [{"T": "q", "S": "MSFT", "bp": 0, "ap": 0}],
            [{"T": "t", "S": "MSFT", "p": 410.1}],
        ],
    )
    got = []
    adapter.stream_prices(
        ["aapl", "MSFT"],
        lambda s, b, a, last="mid": got.append((s, b, a, last)),
        _until_silent(socket),
    )

    assert got == [
        ("aapl", 189.5, 189.52, None),
        ("aapl", None, None, 189.51),
        ("MSFT", None, 410.2, None),
        ("MSFT", None, None, 410.1),
    ]
    assert urls == ["wss://stream.data.alpaca.markets/v2/iex"]
    assert socket.sent == [
        {"action": "auth", "key": "key-1", "secret": "secret-1"},
        {"action": "subscribe", "trades": ["AAPL", "MSFT"], "quotes": ["AAPL", "MSFT"]},
    ]
    assert socket.closed is True


def test_stream_prices_raises_alpacas_error_and_closes(monkeypatch):
    adapter, socket, _ = _stream_adapter(
        monkeypatch,
        [
            [{"T": "success", "msg": "connected"}],
            [{"T": "error", "code": 406, "msg": "connection limit exceeded"}],
        ],
    )
    with pytest.raises(HTTPException) as err:
        adapter.stream_prices(["AAPL"], lambda *a, **k: None, lambda: False)
    assert err.value.status_code == 502
    assert "connection limit exceeded" in err.value.detail
    assert socket.closed is True


def test_a_dropped_stream_and_a_refused_connection_are_errors(monkeypatch):
    import alpaca_adapter

    adapter, socket, _ = _stream_adapter(monkeypatch, [OSError("reset by peer")])
    with pytest.raises(HTTPException) as err:
        adapter.stream_prices(["AAPL"], lambda *a, **k: None, lambda: False)
    assert err.value.status_code == 503

    def refuse(url, timeout):
        raise OSError("no route")

    monkeypatch.setattr(alpaca_adapter, "_connect", refuse)
    with pytest.raises(HTTPException) as err:
        adapter.stream_prices(["AAPL"], lambda *a, **k: None, lambda: False)
    assert err.value.status_code == 503


def test_stream_trade_events_fires_on_fills_only(monkeypatch):
    import json

    adapter, socket, urls = _stream_adapter(
        monkeypatch,
        [
            # The trading stream sends binary frames.
            json.dumps({"stream": "authorization", "data": {"status": "authorized"}}).encode(),
            {"stream": "listening", "data": {"streams": ["trade_updates"]}},
            {"stream": "trade_updates", "data": {"event": "new", "order": {}}},
            {"stream": "trade_updates", "data": {"event": "partial_fill", "order": {}}},
            json.dumps({"stream": "trade_updates", "data": {"event": "fill"}}).encode(),
            {"stream": "trade_updates", "data": {"event": "canceled"}},
            b"not json",
        ],
    )
    events = []
    adapter.stream_trade_events(lambda: events.append(1), _until_silent(socket))

    assert len(events) == 2
    assert urls == ["wss://paper-api.alpaca.markets/stream"]
    assert socket.sent == [
        {"action": "auth", "key": "key-1", "secret": "secret-1"},
        {"action": "listen", "data": {"streams": ["trade_updates"]}},
    ]


def test_the_live_account_uses_the_live_trade_stream_and_a_refused_key_raises(monkeypatch):
    adapter, socket, urls = _stream_adapter(
        monkeypatch,
        [{"stream": "authorization", "data": {"status": "unauthorized"}}],
        paper=False,
    )
    with pytest.raises(HTTPException) as err:
        adapter.stream_trade_events(lambda: None, lambda: False)
    assert err.value.status_code == 502
    assert urls == ["wss://api.alpaca.markets/stream"]


# --------------------------------------------------------------------------- #
# Crypto and options (E-14)
# --------------------------------------------------------------------------- #
OPT = "AAPL270115C00190000"


def test_a_symbol_says_what_kind_of_instrument_it_is(alpaca):
    assert alpaca.asset_class("btc/usd") == "crypto"
    assert alpaca.asset_class(OPT) == "option"
    assert alpaca.asset_class("AAPL") == "equity"
    assert alpaca.asset_class("BRK.B") == "equity"
    # Six letters and digits, but not an OCC symbol.
    assert alpaca.asset_class("AAPL270115X00190000") == "equity"


def test_crypto_and_option_bars_come_from_their_own_endpoints_keyed_by_symbol(alpaca):
    def handler(method, url, params, json):
        symbol = params["symbols"]
        return FakeResponse(
            {
                "bars": {
                    symbol: [
                        {"t": "2026-01-05T00:00:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 3.6}
                    ]
                },
                "next_page_token": None,
            }
        )

    FakeClient.handler = handler
    out = _adapter(alpaca).historical_bars("btc/usd", "1hour", "1M")
    _m, url, _h, params, _j = FakeClient.calls[-1]
    assert url == "https://data.alpaca.markets/v1beta3/crypto/us/bars"
    assert params["symbols"] == "BTC/USD" and params["timeframe"] == "1Hour"
    assert "adjustment" not in params
    assert out.symbol == "BTC/USD" and out.bars[0].close == 1.5
    # A fractional volume is stored whole.
    assert out.bars[0].volume == 4

    out = _adapter(alpaca).historical_bars(OPT, "1day", "1M")
    assert FakeClient.calls[-1][1] == "https://data.alpaca.markets/v1beta1/options/bars"
    assert FakeClient.calls[-1][3]["symbols"] == OPT
    assert out.count == 1


def test_crypto_quote_and_option_tick_read_the_keyed_latest_endpoints(alpaca):
    def handler(method, url, params, json):
        symbol = params["symbols"]
        if url.endswith("/latest/quotes") or url.endswith("/quotes/latest"):
            return FakeResponse({"quotes": {symbol: {"bp": 5.1, "ap": 5.3, "bs": 0.4, "t": None}}})
        return FakeResponse({"trades": {symbol: {"p": 5.2, "s": 1}}})

    FakeClient.handler = handler
    quote = _adapter(alpaca).realtime_quote("btc/usd")
    assert FakeClient.calls[-1][1].endswith("/v1beta3/crypto/us/latest/quotes")
    assert (quote.bid, quote.ask, quote.volume) == (5.1, 5.3, 0)

    FakeClient.calls.clear()
    tick = _adapter(alpaca).tick(OPT)
    assert [c[1].rsplit("/v1beta1", 1)[1] for c in FakeClient.calls] == [
        "/options/trades/latest",
        "/options/quotes/latest",
    ]
    # An option's tick carries its quote too.
    assert (tick["bid"], tick["ask"], tick["last"]) == (5.1, 5.3, 5.2)

    FakeClient.calls.clear()
    tick = _adapter(alpaca).tick("BTC/USD")
    assert len(FakeClient.calls) == 1 and tick["bid"] is None and tick["last"] == 5.2


def test_search_lists_crypto_pairs(alpaca):
    FakeClient.handler = lambda m, u, p, j: FakeResponse(
        [
            {"id": "1", "symbol": "BTC/USD", "name": "Bitcoin / US Dollar", "exchange": "CRYPTO"},
            {"id": "2", "symbol": "ETH/BTC", "name": "Ethereum / Bitcoin"},
            {"id": "3", "symbol": "DOGE/USD", "name": "Dogecoin"},
        ]
    )

    class Req:
        symbol = "btc"
        secType = "CRYPTO"

    out = _adapter(alpaca).search_contracts(Req())
    assert FakeClient.calls[-1][3] == {"status": "active", "asset_class": "crypto"}
    assert [(r["symbol"], r["secType"], r["currency"]) for r in out["results"]] == [
        ("BTC/USD", "CRYPTO", "USD"),
        ("ETH/BTC", "CRYPTO", "BTC"),
    ]


def _contract(symbol, expiry, strike, kind, **over):
    return {
        "id": f"id-{symbol}",
        "symbol": symbol,
        "name": f"AAPL {expiry} {strike} {kind}",
        "tradable": True,
        "expiration_date": expiry,
        "underlying_symbol": "AAPL",
        "type": kind,
        "strike_price": str(strike),
        "size": "100",
        **over,
    }


def test_search_lists_option_contracts_with_the_advanced_filters(alpaca):
    FakeClient.handler = lambda m, u, p, j: FakeResponse(
        {
            "option_contracts": [
                _contract("AAPL270219P00190000", "2027-02-19", 190, "put"),
                _contract(OPT, "2027-01-15", 190, "call"),
                _contract("AAPL270115C00200000", "2027-01-15", 200, "call", tradable=False),
            ]
        }
    )

    class Req:
        symbol = "aapl"
        secType = "OPT"
        expiry = "202701"
        strike = 190.0
        right = "C"

    out = _adapter(alpaca).search_contracts(Req())
    _m, url, _h, params, _j = FakeClient.calls[-1]
    assert url.endswith("/v2/options/contracts")
    assert params == {
        "underlying_symbols": "AAPL",
        "limit": 50,
        "expiration_date_gte": "2027-01-01",
        "expiration_date_lte": "2027-01-31",
        "strike_price_gte": 190.0,
        "strike_price_lte": 190.0,
        "type": "call",
    }
    # Nearest expiry first; one that cannot be traded is left out.
    assert [r["symbol"] for r in out["results"]] == [OPT, "AAPL270219P00190000"]
    assert out["results"][0] == {
        "conid": f"id-{OPT}",
        "symbol": OPT,
        "companyName": "AAPL 2027-01-15 190 call",
        "description": "AAPL 2027-01-15 190 call",
        "secType": "OPT",
        "exchange": "OPRA",
        "currency": "USD",
        "localSymbol": OPT,
        "underlying": "AAPL",
        "expiry": "20270115",
        "strike": 190.0,
        "right": "C",
        "multiplier": "100",
        "broker": "alpaca",
    }


def test_option_search_takes_one_day_or_the_next_90_days(alpaca):
    FakeClient.handler = lambda m, u, p, j: FakeResponse({"option_contracts": []})

    class Req:
        symbol = "AAPL"
        secType = "OPT"
        expiry = "2027-01-15"

    _adapter(alpaca).search_contracts(Req())
    assert FakeClient.calls[-1][3]["expiration_date"] == "2027-01-15"

    Req.expiry = ""
    _adapter(alpaca).search_contracts(Req())
    params = FakeClient.calls[-1][3]
    from datetime import date

    span = date.fromisoformat(params["expiration_date_lte"]) - date.fromisoformat(
        params["expiration_date_gte"]
    )
    assert span.days == 90 and "type" not in params and "strike_price_gte" not in params


def test_crypto_orders_are_fractional_and_never_day_or_plain_stop(alpaca, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda m, u, p, j: FakeResponse({"id": "c-1", "status": "accepted"})
    adapter = _adapter(alpaca)
    adapter.place_order(_OrderReq(symbol="btc/usd", quantity=0.0025, tif="GTC"))
    body = FakeClient.calls[-1][4]
    assert body["symbol"] == "BTC/USD" and body["qty"] == "0.0025"
    assert body["time_in_force"] == "gtc"

    for bad in (
        {"tif": "DAY"},
        {"tif": "FOK"},
        {"tif": "GTC", "order_type": "STP", "stop_price": 1},
    ):
        with pytest.raises(HTTPException) as err:
            adapter.place_order(_OrderReq(symbol="BTC/USD", quantity=1, **bad))
        assert err.value.status_code == 400
    assert len(FakeClient.calls) == 1


def test_option_orders_are_whole_contracts_for_the_day_or_gtc(alpaca, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda m, u, p, j: FakeResponse({"id": "o-1", "status": "accepted"})
    adapter = _adapter(alpaca)
    adapter.place_order(
        _OrderReq(symbol=OPT, quantity=2.0, order_type="LMT", limit_price=1.05, tif="GTC")
    )
    body = FakeClient.calls[-1][4]
    assert body["symbol"] == OPT and body["qty"] == "2" and body["limit_price"] == "1.05"

    for bad in ({"quantity": 1.5}, {"tif": "IOC"}, {"tif": "FOK"}):
        with pytest.raises(HTTPException) as err:
            adapter.place_order(_OrderReq(symbol=OPT, **bad))
        assert err.value.status_code == 400
    assert len(FakeClient.calls) == 1


def test_a_crypto_position_gets_its_slash_back(alpaca):
    FakeClient.handler = lambda m, u, p, j: FakeResponse(
        [
            {"symbol": "BTCUSD", "asset_class": "crypto", "qty": "0.5"},
            {"symbol": "ETHUSDT", "asset_class": "crypto", "qty": "2"},
            {"symbol": "LTC/USD", "asset_class": "crypto", "qty": "1"},
            {"symbol": OPT, "asset_class": "us_option", "qty": "-1"},
            {"symbol": "BUSD", "asset_class": "us_equity", "qty": "3"},
        ]
    )
    assert [(p["symbol"], p["position"]) for p in _adapter(alpaca).positions()] == [
        ("BTC/USD", 0.5),
        ("ETH/USDT", 2.0),
        ("LTC/USD", 1.0),
        (OPT, -1.0),
        ("BUSD", 3.0),
    ]


def test_instrument_spec_for_crypto_and_options(alpaca):
    def handler(method, url, params, json):
        if url.endswith("/v2/assets/BTC/USD"):
            return FakeResponse({"min_order_size": "0.0001", "min_trade_increment": "0.00001"})
        assert url.endswith(f"/v2/options/contracts/{OPT}")
        return FakeResponse({"size": "100"})

    FakeClient.handler = handler
    spec = _adapter(alpaca).instrument_spec("btc/usd")
    assert spec == {
        "symbol": "BTC/USD",
        "broker": "alpaca",
        "unit": "units",
        "min_size": 0.0001,
        "size_step": 0.00001,
        "max_size": None,
        "contract_size": 1.0,
        "currency": "USD",
    }
    spec = _adapter(alpaca).instrument_spec(OPT)
    assert (spec["unit"], spec["size_step"], spec["contract_size"]) == ("contracts", 1.0, 100.0)


def test_only_a_stock_fill_has_a_known_zero_commission(alpaca):
    row = {"qty": "1", "price": "10", "side": "buy", "transaction_time": "2026-01-05T00:00:00Z"}
    FakeClient.handler = lambda m, u, p, j: FakeResponse(
        [
            {**row, "id": "a", "symbol": "AAPL"},
            {**row, "id": "b", "symbol": "BTC/USD"},
            {**row, "id": "c", "symbol": OPT},
        ]
    )
    fills = _adapter(alpaca).executions()
    assert [(f["symbol"], f["commission"]) for f in fills] == [
        ("AAPL", 0.0),
        ("BTC/USD", None),
        (OPT, None),
    ]


def test_crypto_streams_from_the_crypto_feed(monkeypatch):
    adapter, socket, urls = _stream_adapter(
        monkeypatch,
        [
            [{"T": "success", "msg": "connected"}],
            [{"T": "success", "msg": "authenticated"}],
            [{"T": "q", "S": "BTC/USD", "bp": 60000.5, "ap": 60001}],
            [{"T": "t", "S": "BTC/USD", "p": 60000.75, "s": 0.01}],
        ],
    )
    got = []
    adapter.stream_prices(
        ["BTC/USD"], lambda s, b, a, last="mid": got.append((s, b, a, last)), _until_silent(socket)
    )
    assert urls == ["wss://stream.data.alpaca.markets/v1beta3/crypto/us"]
    assert socket.sent[1] == {"action": "subscribe", "trades": ["BTC/USD"], "quotes": ["BTC/USD"]}
    assert got == [("BTC/USD", 60000.5, 60001.0, None), ("BTC/USD", None, None, 60000.75)]


def test_options_are_polled_and_a_bad_contract_does_not_stop_the_rest(alpaca, monkeypatch):
    import app_settings

    monkeypatch.setattr(app_settings, "stream_poll_seconds", lambda: 0)
    adapter = _adapter(alpaca)

    def tick(symbol, account_mode="paper"):
        if symbol == "AAPL270115P00190000":
            raise HTTPException(502, "no such contract")
        return {"bid": 1.0, "ask": 1.1, "last": None}

    monkeypatch.setattr(adapter, "tick", tick)
    got = []
    adapter.stream_prices(
        ["AAPL270115P00190000", OPT],
        lambda s, b, a, last="mid": got.append((s, b, a, last)),
        lambda: len(got) >= 2,
    )
    assert got == [(OPT, 1.0, 1.1, None)] * 2


def test_stocks_and_options_stream_side_by_side_and_one_failing_stops_both(alpaca, monkeypatch):
    adapter = _adapter(alpaca)
    seen = {}

    def feed(url, symbols, on_price, should_stop):
        seen["feed"] = (url, symbols)
        on_price(symbols[0], 1.0, 1.2, last=None)
        raise HTTPException(503, "Alpaca stream closed")

    def poll(symbols, on_price, should_stop):
        seen["poll"] = symbols
        # Ends because the other one failed, not on the caller's say-so.
        assert _wait(should_stop)

    monkeypatch.setattr(adapter, "_stream_feed", feed)
    monkeypatch.setattr(adapter, "_poll_options", poll)
    got = []
    with pytest.raises(HTTPException) as err:
        adapter.stream_prices(
            ["AAPL", OPT], lambda s, b, a, last="mid": got.append(s), lambda: False
        )
    assert err.value.status_code == 503
    assert seen == {"feed": ("wss://stream.data.alpaca.markets/v2/iex", ["AAPL"]), "poll": [OPT]}
    assert got == ["AAPL"]


def _wait(predicate, timeout=3.0):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False
