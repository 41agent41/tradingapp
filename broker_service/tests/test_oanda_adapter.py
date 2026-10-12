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
    # No audit id, no client extensions.
    assert "clientExtensions" not in body["order"]


def test_place_order_tags_the_order_with_its_audit_id(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"orderFillTransaction": {"id": "42"}}
    )
    _adapter(oanda).place_order(_OrderReq(audit_id=17))
    _method, _url, _headers, _params, body = FakeClient.calls[0]
    assert body["order"]["clientExtensions"] == {"id": "audit-17", "tag": "tradingapp"}


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
    # Normalised to the app's AccountSummary shape — OANDA's `NAV` is its
    # name for net liquidation.
    summary = adapter.account_summary()
    assert summary["net_liquidation"] == 10100.0
    assert summary["total_cash_value"] == 10000.0


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


# --------------------------------------------------------------------------- #
# executions (fills)
# --------------------------------------------------------------------------- #
_TX_BASE = "https://api-fxpractice.oanda.com/v3/accounts/101-001-999999-001/transactions"


def _fills_handler(pages, transactions):
    """Serve the page-index request, then the page URLs OANDA points at."""

    def handler(method, url, params, json):
        if url.endswith("/transactions"):
            return FakeResponse({"pages": pages})
        return FakeResponse({"transactions": transactions})

    return handler


def test_executions_walk_the_transaction_pages(oanda):
    FakeClient.handler = _fills_handler(
        [f"{_TX_BASE}/idrange?from=1&to=2"],
        [
            {
                "id": "44",
                "type": "ORDER_FILL",
                "orderID": "43",
                "instrument": "EUR_USD",
                "units": "-1000",
                "price": "1.09250",
                "commission": "0.15",
                "pl": "-2.40",
                "time": "2026-08-07T13:30:00.123456789Z",
                "accountID": "101-001-999999-001",
                "clientOrderID": "audit-17",
            }
        ],
    )

    rows = _adapter(oanda).executions(days=1)

    # The index request asks for ORDER_FILL only, then the page is fetched.
    assert FakeClient.calls[0][3]["type"] == "ORDER_FILL"
    assert FakeClient.calls[1][1].startswith(_TX_BASE)

    assert len(rows) == 1
    row = rows[0]
    # Signed `units` becomes side + magnitude — the inverse of place_order().
    assert row["side"] == "SELL"
    assert row["quantity"] == 1000.0
    # Instruments come back underscored and map to the app's dotted form.
    assert row["symbol"] == "EUR.USD"
    assert row["price"] == 1.0925
    assert row["commission"] == 0.15
    assert row["realized_pnl"] == -2.40
    assert row["executed_at"].startswith("2026-08-07T13:30:00")
    assert row["broker"] == "oanda"
    # The client order id links the fill to the order the app sent (B9).
    assert row["audit_id"] == 17


def test_executions_ignore_non_fill_transactions(oanda):
    FakeClient.handler = _fills_handler(
        [f"{_TX_BASE}/idrange?from=1&to=3"],
        [
            {"id": "1", "type": "DAILY_FINANCING", "financing": "0.02"},
            {
                "id": "2",
                "type": "ORDER_FILL",
                "instrument": "EUR_USD",
                "units": "500",
                "price": "1.1",
            },
        ],
    )

    rows = _adapter(oanda).executions()

    assert [r["exec_id"] for r in rows] == ["2"]


def test_executions_refuse_an_off_host_page_url(oanda):
    """Page links are venue-supplied data; following one off-host would send
    the account token somewhere it doesn't belong."""
    FakeClient.handler = _fills_handler(["https://evil.example.com/steal"], [])

    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).executions()

    assert exc.value.status_code == 502


def test_open_orders_split_signed_units_into_side_and_size(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "orders": [
                {
                    "id": "77",
                    "instrument": "EUR_USD",
                    "units": "-2000",
                    "type": "LIMIT",
                    "state": "PENDING",
                }
            ]
        }
    )

    rows = _adapter(oanda).open_orders()

    assert FakeClient.calls[-1][1].endswith("/pendingOrders")
    assert rows == [
        {
            "order_id": "77",
            "symbol": "EUR.USD",
            "action": "SELL",
            "quantity": 2000.0,
            "order_type": "LMT",
            "status": "PENDING",
            "filled_quantity": None,
            "remaining_quantity": 2000.0,
            "avg_fill_price": None,
        }
    ]


def test_instrument_spec_derives_the_step_from_units_precision(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {
            "instruments": [
                {
                    "name": "EUR_USD",
                    "tradeUnitsPrecision": 0,
                    "minimumTradeSize": "1",
                    "maximumOrderUnits": "100000000",
                }
            ]
        }
    )

    spec = _adapter(oanda).instrument_spec("EUR.USD")

    assert FakeClient.calls[-1][3]["instruments"] == "EUR_USD"
    assert spec["symbol"] == "EUR.USD"
    assert spec["unit"] == "units"
    assert spec["size_step"] == 1
    assert spec["min_size"] == 1
    assert spec["max_size"] == 100000000
    # An OANDA "unit" already IS one unit of the base currency, unlike a lot.
    assert spec["contract_size"] == 1.0
    assert spec["currency"] == "USD"


def test_instrument_spec_handles_fractional_units_precision(oanda):
    FakeClient.handler = lambda method, url, params, json: FakeResponse(
        {"instruments": [{"name": "XAU_USD", "tradeUnitsPrecision": 2}]}
    )

    spec = _adapter(oanda).instrument_spec("XAU.USD")

    assert spec["size_step"] == 0.01
    # No minimumTradeSize reported: the step is the floor.
    assert spec["min_size"] == 0.01


# --------------------------------------------------------------------------- #
# protection: stop loss / take profit on fill, per-trade stops
# --------------------------------------------------------------------------- #
class _ProtectedReq(_OrderReq):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.stop_loss = kw.get("stop_loss")
        self.take_profit = kw.get("take_profit")


def _order_handler(order_response, precision=5):
    def handler(method, url, params, json):
        if url.endswith("/instruments"):
            return FakeResponse({"instruments": [{"displayPrecision": precision}]})
        return FakeResponse(order_response)

    return handler


def test_place_order_attaches_stop_and_target_on_fill(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = _order_handler(
        {
            "orderCreateTransaction": {
                "id": "41",
                "stopLossOnFill": {"price": "1.08000"},
                "takeProfitOnFill": {"price": "1.12000"},
            },
            "orderFillTransaction": {"id": "42", "tradeOpened": {"tradeID": "42"}},
        }
    )
    out = _adapter(oanda).place_order(_ProtectedReq(stop_loss=1.079999999, take_profit=1.12))
    order = [c for c in FakeClient.calls if c[1].endswith("/orders")][0][4]["order"]
    # Rounded to the instrument's precision; OANDA rejects excess decimals.
    assert order["stopLossOnFill"] == {"price": "1.08000", "timeInForce": "GTC"}
    assert order["takeProfitOnFill"] == {"price": "1.12000", "timeInForce": "GTC"}
    # Echoed from OANDA's record of the order, so the caller can verify it.
    assert out["sl"] == 1.08 and out["tp"] == 1.12
    assert out["status"] == "filled"


def test_place_order_without_protection_skips_the_precision_lookup(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = _order_handler({"orderFillTransaction": {"id": "42"}})
    out = _adapter(oanda).place_order(_ProtectedReq())
    assert len(FakeClient.calls) == 1
    assert "stopLossOnFill" not in FakeClient.calls[0][4]["order"]
    assert out["sl"] is None


def test_place_order_reports_no_stop_when_oanda_did_not_record_one(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = _order_handler({"orderFillTransaction": {"id": "42"}})
    out = _adapter(oanda).place_order(_ProtectedReq(stop_loss=1.08))
    assert out["sl"] is None


def test_place_order_cancelled_at_once_is_an_error_not_submitted(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    FakeClient.handler = _order_handler(
        {
            "orderCreateTransaction": {"id": "41"},
            "orderCancelTransaction": {"id": "42", "reason": "STOP_LOSS_ON_FILL_LOSS"},
        }
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).place_order(_ProtectedReq(stop_loss=1.2))
    assert exc.value.status_code == 422
    assert "STOP_LOSS_ON_FILL_LOSS" in exc.value.detail


def test_place_order_refuses_a_stop_when_precision_is_unknown(oanda, monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)

    def handler(method, url, params, json):
        if url.endswith("/instruments"):
            return FakeResponse({"instruments": []})
        raise AssertionError("no order may be sent")

    FakeClient.handler = handler
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).place_order(_ProtectedReq(stop_loss=1.08))
    assert exc.value.status_code == 502


def _trade(trade_id, units, sl=None, tp=None, instrument="EUR_USD"):
    row = {"id": trade_id, "instrument": instrument, "currentUnits": str(units)}
    if sl is not None:
        row["stopLossOrder"] = {"price": str(sl)}
    if tp is not None:
        row["takeProfitOrder"] = {"price": str(tp)}
    return row


def _positions_handler(units, trades):
    def handler(method, url, params, json):
        if url.endswith("/openPositions"):
            return FakeResponse(
                {
                    "positions": [
                        {
                            "instrument": "EUR_USD",
                            "long": {"units": str(max(units, 0)), "averagePrice": "1.10"},
                            "short": {"units": str(min(units, 0)), "averagePrice": "1.10"},
                        }
                    ]
                }
            )
        if url.endswith("/openTrades"):
            return FakeResponse({"trades": trades})
        return FakeResponse({})

    return handler


def test_positions_report_the_least_protective_stop_of_the_trades(oanda):
    FakeClient.handler = _positions_handler(
        3000,
        [
            _trade("1", 1000, sl=1.0900, tp=1.13),
            _trade("2", 2000, sl=1.0850, tp=1.12),
            _trade("3", 500, sl=1.2, instrument="GBP_USD"),
        ],
    )
    row = _adapter(oanda).positions()[0]
    assert row["stop_loss"] == 1.0850
    assert row["take_profit"] == 1.12


def test_positions_short_least_protective_stop_is_the_highest(oanda):
    FakeClient.handler = _positions_handler(
        -2000, [_trade("1", -1000, sl=1.12), _trade("2", -1000, sl=1.11)]
    )
    assert _adapter(oanda).positions()[0]["stop_loss"] == 1.12


def test_positions_one_unprotected_trade_makes_the_position_unprotected(oanda):
    FakeClient.handler = _positions_handler(2000, [_trade("1", 1000, sl=1.09), _trade("2", 1000)])
    assert _adapter(oanda).positions()[0]["stop_loss"] is None


def test_positions_fail_when_the_trades_cannot_be_read(oanda):
    def handler(method, url, params, json):
        if url.endswith("/openTrades"):
            return FakeResponse({}, status_code=500)
        return _positions_handler(1000, [])(method, url, params, json)

    FakeClient.handler = handler
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).positions()
    assert exc.value.status_code == 502


def _modify_handler(trades):
    puts = []

    def handler(method, url, params, json):
        if url.endswith("/openTrades"):
            return FakeResponse({"trades": trades})
        if url.endswith("/instruments"):
            return FakeResponse({"instruments": [{"displayPrecision": 5}]})
        if method == "PUT":
            puts.append((url, json))
            out = {}
            if "stopLoss" in json:
                out["stopLossOrderTransaction"] = {"price": json["stopLoss"]["price"]}
            if "takeProfit" in json:
                out["takeProfitOrderTransaction"] = {"price": json["takeProfit"]["price"]}
            return FakeResponse(out)
        raise AssertionError(url)

    return handler, puts


def test_modify_position_stop_moves_each_trade_and_never_loosens_one(oanda):
    handler, puts = _modify_handler(
        [
            _trade("1", 1000, sl=1.0900),  # looser than the new stop: moved
            _trade("2", 1000, sl=1.0980),  # tighter than the new stop: kept
            _trade("3", -500, sl=1.2),  # the hedged opposite leg: untouched
        ]
    )
    FakeClient.handler = handler
    out = _adapter(oanda).modify_position_stop("EUR.USD", stop_loss=1.095)
    assert [u.rsplit("/", 2)[-2] for u, _ in puts] == ["1"]
    assert puts[0][1] == {"stopLoss": {"price": "1.09500", "timeInForce": "GTC"}}
    assert out["sl"] == 1.095
    assert out["broker"] == "oanda"


def test_modify_position_stop_reports_none_when_oanda_did_not_confirm(oanda):
    def handler(method, url, params, json):
        if url.endswith("/openTrades"):
            return FakeResponse({"trades": [_trade("1", 1000, sl=1.09)]})
        if url.endswith("/instruments"):
            return FakeResponse({"instruments": [{"displayPrecision": 5}]})
        return FakeResponse({})

    FakeClient.handler = handler
    out = _adapter(oanda).modify_position_stop("EUR.USD", stop_loss=1.095)
    assert out["sl"] is None


def test_modify_position_stop_without_trades_is_404(oanda):
    handler, _puts = _modify_handler([])
    FakeClient.handler = handler
    with pytest.raises(HTTPException) as exc:
        _adapter(oanda).modify_position_stop("EUR.USD", stop_loss=1.095)
    assert exc.value.status_code == 404
