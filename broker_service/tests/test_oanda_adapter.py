"""
Tests for the OANDA adapter — market data + execution (FX/CFD).

OANDA's REST layer is faked (no network): a stub `httpx.Client` records the
request (including the Bearer auth header) and returns canned JSON, so the
adapter's mapping (symbol normalisation, granularity, signed-units direction,
error translation) is verified in isolation. Registry availability is
exercised by toggling OANDA_API_TOKEN/OANDA_ACCOUNT_ID.
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
def oanda(monkeypatch):
    import oanda_adapter

    importlib.reload(oanda_adapter)
    FakeClient.calls = []
    FakeClient.handler = None
    monkeypatch.setattr(oanda_adapter.httpx, "Client", FakeClient)
    return oanda_adapter


def _adapter(oanda_mod, environment="practice"):
    return oanda_mod.OANDAAdapter("token-abc", "101-001-999999-001", environment=environment)


# --------------------------------------------------------------------------- #
# symbol normalisation
# --------------------------------------------------------------------------- #
def test_to_instrument_variants(oanda):
    f = oanda._to_instrument
    assert f("EUR.USD") == "EUR_USD"
    assert f("EURUSD") == "EUR_USD"
    assert f("eur_usd") == "EUR_USD"
    assert f("EUR/USD") == "EUR_USD"


def test_from_instrument(oanda):
    assert oanda._from_instrument("EUR_USD") == "EUR.USD"


# --------------------------------------------------------------------------- #
# base URL selection + auth headers
# --------------------------------------------------------------------------- #
def test_practice_vs_live_base(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"account": {}})
    _adapter(oanda, environment="practice").account_summary()
    assert FakeClient.calls[-1][1].startswith("https://api-fxpractice.oanda.com")

    FakeClient.calls.clear()
    _adapter(oanda, environment="live").account_summary()
    assert FakeClient.calls[-1][1].startswith("https://api-fxtrade.oanda.com")


def test_auth_header_sent(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"account": {}})
    _adapter(oanda).account_summary()
    _method, _url, headers, _params, _json = FakeClient.calls[0]
    assert headers["Authorization"] == "Bearer token-abc"


# --------------------------------------------------------------------------- #
# historical_bars
# --------------------------------------------------------------------------- #
def test_historical_bars_maps_granularity_including_8hour(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "candles": [
                {
                    "time": "2023-11-14T22:00:00.000000000Z",
                    "complete": True,
                    "volume": 120,
                    "mid": {"o": "1.07", "h": "1.08", "l": "1.06", "c": "1.075"},
                }
            ]
        }
    )
    resp = _adapter(oanda).historical_bars("EUR.USD", "8hour", "1M")

    _method, url, _headers, params, _json = FakeClient.calls[0]
    assert "EUR_USD" in url
    assert params["granularity"] == "H8"
    assert resp.symbol == "EUR.USD"
    assert resp.count == 1
    assert resp.bars[0].volume == 120


def test_historical_bars_skips_incomplete_candles(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "candles": [
                {
                    "time": "2023-11-14T22:00:00Z",
                    "complete": False,
                    "mid": {"o": "1", "h": "1", "l": "1", "c": "1"},
                },
                {
                    "time": "2023-11-14T21:00:00Z",
                    "complete": True,
                    "volume": 5,
                    "mid": {"o": "1", "h": "1", "l": "1", "c": "1"},
                },
            ]
        }
    )
    resp = _adapter(oanda).historical_bars("EUR.USD", "1hour", "1D")
    assert resp.count == 1


def test_historical_bars_date_range_sets_custom_period(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({"candles": []})
    resp = _adapter(oanda).historical_bars(
        "EUR.USD", "1hour", "1Y", start_date="2024-01-01", end_date="2024-02-01"
    )
    _method, _url, _headers, params, _json = FakeClient.calls[0]
    assert params["from"] == "2024-01-01T00:00:00Z"
    assert params["to"] == "2024-02-01T00:00:00Z"
    assert "count" not in params
    assert resp.period == "CUSTOM"


def test_unsupported_timeframe_is_400(oanda):
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).historical_bars("EUR.USD", "tick", "1D")
    assert exc.value.status_code == 400


# --------------------------------------------------------------------------- #
# quotes / ticks / search
# --------------------------------------------------------------------------- #
def test_realtime_quote_maps_bid_ask_midpoint(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "prices": [
                {
                    "bids": [{"price": "1.0700"}],
                    "asks": [{"price": "1.0702"}],
                    "time": "2023-11-14T22:13:20.123456789Z",
                }
            ]
        }
    )
    q = _adapter(oanda).realtime_quote("EUR.USD")
    assert q.symbol == "EUR.USD"
    assert q.bid == 1.07 and q.ask == 1.0702
    assert q.last == pytest.approx(1.0701, abs=1e-4)


def test_tick_reuses_realtime_quote(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"prices": [{"bids": [{"price": "1.07"}], "asks": [{"price": "1.0702"}]}]}
    )
    t = _adapter(oanda).tick("EUR.USD")
    assert t["broker"] == "oanda"
    assert t["bid"] == 1.07


def test_search_contracts_filters_and_tags_broker(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "instruments": [
                {"name": "EUR_USD", "displayName": "Euro/US Dollar", "type": "CURRENCY"},
                {"name": "GBP_USD", "displayName": "British Pound/US Dollar", "type": "CURRENCY"},
            ]
        }
    )

    class Req:
        symbol = "eur"
        max_results = 10

    out = _adapter(oanda).search_contracts(Req())
    assert out["count"] == 1
    assert out["results"][0]["symbol"] == "EUR.USD"
    assert out["results"][0]["broker"] == "oanda"


# --------------------------------------------------------------------------- #
# error translation
# --------------------------------------------------------------------------- #
def test_unreachable_is_503(oanda):
    def boom(method, url, params, json):
        raise oanda.httpx.ConnectError("refused")

    FakeClient.handler = boom
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).account_summary()
    assert exc.value.status_code == 503


def test_5xx_is_502(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {}, status_code=500, text="boom"
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).account_summary()
    assert exc.value.status_code == 502


# --------------------------------------------------------------------------- #
# registry availability
# --------------------------------------------------------------------------- #
def test_registry_registers_oanda_when_credentials_set(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("OANDA_API_TOKEN", "token-abc")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "101-001-999999-001")
    adapters.reset_registry()

    md = adapters.get_market_data_adapter("oanda")
    assert md.name == "oanda"
    assert adapters.get_broker_adapter("oanda").name == "oanda"
    health = adapters.provider_health()
    assert health["providers"]["oanda"]["available"] is True


def test_registry_oanda_unavailable_without_credentials(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.delenv("OANDA_API_TOKEN", raising=False)
    monkeypatch.delenv("OANDA_ACCOUNT_ID", raising=False)
    adapters.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter("oanda")
    assert exc.value.status_code == 501
    with pytest.raises(HTTPException) as exc2:
        adapters.get_broker_adapter("oanda")
    assert exc2.value.status_code == 501


# --------------------------------------------------------------------------- #
# execution
# --------------------------------------------------------------------------- #
class _OrderReq:
    def __init__(self, **kw):
        self.symbol = kw.get("symbol", "EUR.USD")
        self.action = kw.get("action", "BUY")
        self.quantity = kw.get("quantity", 1000)
        self.order_type = kw.get("order_type", "MKT")
        self.tif = kw.get("tif", "DAY")
        self.limit_price = kw.get("limit_price")
        self.stop_price = kw.get("stop_price")
        self.account_mode = kw.get("account_mode", "paper")
        self.audit_id = kw.get("audit_id")


def test_place_order_buy_sends_positive_units(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"orderFillTransaction": {"id": "42"}}
    )
    out = _adapter(oanda).place_order(_OrderReq(action="BUY", quantity=1000))

    method, url, _headers, _params, body = FakeClient.calls[0]
    assert method == "POST" and url.endswith("/orders")
    assert body["order"]["units"] == "1000"
    assert body["order"]["instrument"] == "EUR_USD"
    assert out["order_id"] == "42"
    assert out["status"] == "filled"
    assert out["broker"] == "oanda"


def test_place_order_sell_sends_negative_units(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"orderCreateTransaction": {"id": "43"}}
    )
    _adapter(oanda).place_order(_OrderReq(action="SELL", quantity=1000))
    _method, _url, _headers, _params, body = FakeClient.calls[0]
    assert body["order"]["units"] == "-1000"


def test_place_order_market_folds_day_tif_to_fok(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    _adapter(oanda).place_order(_OrderReq(order_type="MKT", tif="DAY"))
    _method, _url, _headers, _params, body = FakeClient.calls[0]
    # OANDA rejects GFD/GTC on a MARKET order; DAY folds to FOK.
    assert body["order"]["timeInForce"] == "FOK"


def test_place_order_limit_keeps_gfd_tif(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    _adapter(oanda).place_order(_OrderReq(order_type="LMT", tif="DAY", limit_price=1.08))
    _method, _url, _headers, _params, body = FakeClient.calls[0]
    assert body["order"]["timeInForce"] == "GFD"
    assert body["order"]["price"] == "1.08"


def test_place_order_stop_limit_is_400(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).place_order(_OrderReq(order_type="STP_LMT", limit_price=1.08))
    assert exc.value.status_code == 400
    assert FakeClient.calls == []


def test_place_order_limit_without_price_is_400(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).place_order(_OrderReq(order_type="LMT"))
    assert exc.value.status_code == 400


def test_place_order_live_blocked_without_gate(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).place_order(_OrderReq(account_mode="live"))
    assert exc.value.status_code == 403
    assert FakeClient.calls == []


def test_cancel_uses_put_cancel_verb(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse({})
    out = _adapter(oanda).cancel_order(42)
    method, url, _headers, _params, _json = FakeClient.calls[0]
    assert method == "PUT" and url.endswith("/orders/42/cancel")
    assert out["status"] == "cancel_requested"


def test_modify_replaces_and_returns_new_order_id(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"orderCreateTransaction": {"id": "99"}}
    )
    out = _adapter(oanda).modify_order(42, _OrderReq(quantity=500))
    method, url, _headers, _params, _json = FakeClient.calls[0]
    assert method == "PUT" and url.endswith("/orders/42")
    assert out["order_id"] == "99"


def test_positions_and_account(oanda):
    def handler(method, url, params, json):
        if url.endswith("/openPositions"):
            return FakeResponse(
                {
                    "positions": [
                        {
                            "instrument": "EUR_USD",
                            "long": {"units": "1000", "averagePrice": "1.1050"},
                            "short": {"units": "0"},
                            "unrealizedPL": "12.5",
                        }
                    ]
                }
            )
        if url.endswith("/summary"):
            return FakeResponse({"account": {"balance": "10000", "NAV": "10100"}})
        return FakeResponse({})

    FakeClient.handler = handler
    adapter = _adapter(oanda)
    row = adapter.positions()[0]
    # Normalised to the app's Position shape + dotted symbol form.
    assert row["symbol"] == "EUR.USD"
    assert row["position"] == 1000.0
    assert row["average_cost"] == 1.1050
    assert row["unrealized_pnl"] == 12.5
    assert adapter.account_summary()["NAV"] == "10100"


def test_positions_net_the_long_and_short_legs(oanda):
    """OANDA reports each instrument as independent legs; short units are
    already negative, so a net-short instrument reports a negative size and
    takes its average price from the short leg."""

    def handler(method, url, params, json):
        if url.endswith("/openPositions"):
            return FakeResponse(
                {
                    "positions": [
                        {
                            "instrument": "GBP_USD",
                            "long": {"units": "500", "averagePrice": "1.30"},
                            "short": {"units": "-800", "averagePrice": "1.25"},
                        },
                        # Fully closed instrument — not a position.
                        {
                            "instrument": "USD_JPY",
                            "long": {"units": "0"},
                            "short": {"units": "0"},
                        },
                    ]
                }
            )
        return FakeResponse({})

    FakeClient.handler = handler
    rows = _adapter(oanda).positions()
    assert len(rows) == 1
    assert rows[0]["symbol"] == "GBP.USD"
    assert rows[0]["position"] == -300.0
    assert rows[0]["average_cost"] == 1.25
