"""
Tests for the IG adapter — market data + execution over IG's REST API.

IG's REST layer is faked (no network): a stub `httpx.Client` records every
request with its headers and answers from a per-test handler, so the login
flow, epic mapping, deal confirmation and netting are verified in isolation.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


class FakeResponse:
    def __init__(self, payload=None, status_code=200, headers=None):
        self._payload = payload if payload is not None else {}
        self.status_code = status_code
        self.headers = headers or {}
        self.text = str(self._payload)
        self.content = b"x" if payload is not None else b""

    def json(self):
        return self._payload


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
        path = url.split("/gateway/deal", 1)[1]
        if path == "/session" and method == "POST":
            return FakeResponse(
                {"currentAccountId": "ABC12"},
                headers={"CST": "cst-1", "X-SECURITY-TOKEN": "xst-1"},
            )
        return FakeClient.handler(method, path, params or {}, json)


@pytest.fixture
def ig(monkeypatch):
    import ig_adapter

    importlib.reload(ig_adapter)
    FakeClient.calls = []
    FakeClient.handler = lambda method, path, params, json: FakeResponse({})
    monkeypatch.setattr(ig_adapter.httpx, "Client", FakeClient)
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    return ig_adapter


def _adapter(mod, **kw):
    return mod.IGAdapter("key-1", "trader", "secret", **kw)


def _calls(path, method=None):
    return [
        c for c in FakeClient.calls if c[1].endswith(path) and (method is None or c[0] == method)
    ]


_MARKET = {
    "instrument": {
        "epic": "CS.D.EURUSD.CFD.IP",
        "contractSize": "100000",
        "currencies": [{"code": "AUD"}, {"code": "USD", "isDefault": True}],
    },
    "dealingRules": {"minDealSize": {"value": 0.5}},
    "snapshot": {"bid": 1.1000, "offer": 1.1002},
}


class _OrderReq:
    def __init__(self, **kw):
        self.symbol = kw.get("symbol", "EUR.USD")
        self.action = kw.get("action", "BUY")
        self.quantity = kw.get("quantity", 1)
        self.order_type = kw.get("order_type", "MKT")
        self.tif = kw.get("tif", "DAY")
        self.limit_price = kw.get("limit_price")
        self.stop_price = kw.get("stop_price")
        self.account_mode = kw.get("account_mode", "paper")
        self.audit_id = kw.get("audit_id")
        self.stop_loss = kw.get("stop_loss")
        self.take_profit = kw.get("take_profit")


# --------------------------------------------------------------------------- #
# symbols, session
# --------------------------------------------------------------------------- #
def test_epic_mapping_round_trips(ig):
    assert ig._to_epic("EUR.USD") == "CS.D.EURUSD.CFD.IP"
    assert ig._to_epic("audusd") == "CS.D.AUDUSD.CFD.IP"
    assert ig._to_epic("IX.D.ASX.IFT.IP") == "IX.D.ASX.IFT.IP"
    assert ig._from_epic("CS.D.EURUSD.CFD.IP") == "EUR.USD"
    assert ig._from_epic("IX.D.ASX.IFT.IP") == "IX.D.ASX.IFT.IP"


def test_demo_vs_live_base(ig):
    assert _adapter(ig)._base.startswith("https://demo-api.ig.com")
    assert _adapter(ig, environment="live")._base.startswith("https://api.ig.com")


def test_logs_in_once_and_sends_session_tokens(ig):
    adapter = _adapter(ig)
    adapter.probe()
    adapter.probe()
    assert len(_calls("/session", "POST")) == 1
    login = _calls("/session", "POST")[0]
    assert login[2]["X-IG-API-KEY"] == "key-1"
    assert login[4] == {"identifier": "trader", "password": "secret"}
    _method, _url, headers, _params, _json = _calls("/accounts")[-1]
    assert headers["CST"] == "cst-1" and headers["X-SECURITY-TOKEN"] == "xst-1"


def test_switches_to_the_configured_account(ig):
    _adapter(ig, account_id="XYZ99").probe()
    switch = _calls("/session", "PUT")
    assert switch and switch[0][4] == {"accountId": "XYZ99"}


def test_an_expired_session_logs_in_again(ig):
    answers = iter([FakeResponse({}, status_code=401), FakeResponse({"accounts": []})])
    FakeClient.handler = lambda method, path, params, json: next(answers)
    _adapter(ig).probe()
    assert len(_calls("/session", "POST")) == 2


def test_unreachable_is_503(ig, monkeypatch):
    class Boom(FakeClient):
        def request(self, *a, **kw):
            raise ig.httpx.ConnectError("down")

    monkeypatch.setattr(ig.httpx, "Client", Boom)
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).probe()
    assert exc.value.status_code == 503


def test_venue_error_is_502(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse({}, status_code=500)
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).probe()
    assert exc.value.status_code == 502


# --------------------------------------------------------------------------- #
# market data
# --------------------------------------------------------------------------- #
def test_search_maps_epics(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(
        {
            "markets": [
                {
                    "epic": "CS.D.EURUSD.CFD.IP",
                    "instrumentName": "EUR/USD",
                    "instrumentType": "CURRENCIES",
                },
                {"epic": "IX.D.ASX.IFT.IP", "instrumentName": "Australia 200"},
            ]
        }
    )
    out = _adapter(ig).search_contracts(type("R", (), {"symbol": "EUR"})())
    assert [r["symbol"] for r in out["results"]] == ["EUR.USD", "IX.D.ASX.IFT.IP"]
    assert out["results"][0]["secType"] == "CASH"
    assert out["broker"] == "ig"


def test_historical_bars_period_asks_for_capped_recent_points(ig):
    def handler(method, path, params, json):
        assert path == "/prices/CS.D.EURUSD.CFD.IP"
        return FakeResponse(
            {
                "prices": [
                    {
                        "snapshotTimeUTC": "2026-01-02T00:05:00",
                        "openPrice": {"bid": 1.0, "ask": 1.2},
                        "highPrice": {"bid": 1.3, "ask": 1.5},
                        "lowPrice": {"bid": 0.9, "ask": 1.1},
                        "closePrice": {"bid": 1.1, "ask": 1.3},
                    },
                    {
                        "snapshotTimeUTC": "2026-01-02T00:00:00",
                        "openPrice": {"bid": 1.0, "ask": 1.0},
                        "highPrice": {"bid": 1.0, "ask": 1.0},
                        "lowPrice": {"bid": 1.0, "ask": 1.0},
                        "closePrice": {"bid": 1.0, "ask": 1.0},
                    },
                ],
                "metadata": {"allowance": {"remainingAllowance": 9000}},
            }
        )

    FakeClient.handler = handler
    out = _adapter(ig).historical_bars("EUR.USD", "5min", "1Y")
    _m, _u, headers, params, _j = _calls("/prices/CS.D.EURUSD.CFD.IP")[0]
    assert headers["Version"] == "3"
    assert params["resolution"] == "MINUTE_5"
    assert params["max"] == ig._MAX_PERIOD_POINTS
    assert "from" not in params
    assert out.count == 2
    # Oldest first, mid prices.
    assert out.bars[0].close == 1.0
    assert out.bars[1].open == pytest.approx(1.1)
    assert out.bars[1].high == pytest.approx(1.4)


def test_historical_bars_range_asks_for_the_range(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse({"prices": []})
    out = _adapter(ig).historical_bars(
        "EUR.USD", "1day", start_date="2025-01-01", end_date="2025-02-01"
    )
    params = _calls("/prices/CS.D.EURUSD.CFD.IP")[0][3]
    assert params["from"] == "2025-01-01T00:00:00"
    assert params["to"] == "2025-02-01T00:00:00"
    assert "max" not in params
    assert out.period == "CUSTOM"


def test_eight_hour_bars_are_400(ig):
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).historical_bars("EUR.USD", "8hour")
    assert exc.value.status_code == 400


def test_quote_reads_the_market_snapshot(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(_MARKET)
    quote = _adapter(ig).realtime_quote("EUR.USD")
    assert quote.bid == 1.1 and quote.ask == 1.1002
    assert quote.last == pytest.approx(1.1001)


# --------------------------------------------------------------------------- #
# orders
# --------------------------------------------------------------------------- #
def _deal_handler(confirm):
    def handler(method, path, params, json):
        if path.startswith("/markets/"):
            return FakeResponse(_MARKET)
        if path in ("/positions/otc", "/workingorders/otc") and method == "POST":
            return FakeResponse({"dealReference": json.get("dealReference") or "REF1"})
        if path.startswith("/confirms/"):
            return FakeResponse(confirm)
        return FakeResponse({})

    return handler


def test_market_order_with_protection_forces_open_and_confirms(ig):
    FakeClient.handler = _deal_handler(
        {"dealStatus": "ACCEPTED", "status": "OPEN", "dealId": "DIAAA1", "stopLevel": 1.09}
    )
    out = _adapter(ig).place_order(_OrderReq(quantity=2, stop_loss=1.09, audit_id=17))
    body = _calls("/positions/otc", "POST")[0][4]
    assert body["orderType"] == "MARKET"
    assert body["epic"] == "CS.D.EURUSD.CFD.IP"
    assert body["direction"] == "BUY"
    assert body["size"] == 2.0
    assert body["currencyCode"] == "USD"
    assert body["forceOpen"] is True
    assert body["stopLevel"] == 1.09
    assert body["dealReference"] == "audit-17"
    assert body["timeInForce"] == "FILL_OR_KILL"
    assert out["order_id"] == "DIAAA1"
    assert out["status"] == "filled"
    assert out["sl"] == 1.09


def test_unprotected_market_order_nets(ig):
    FakeClient.handler = _deal_handler({"dealStatus": "ACCEPTED", "status": "CLOSED"})
    _adapter(ig).place_order(_OrderReq(action="SELL"))
    body = _calls("/positions/otc", "POST")[0][4]
    assert body["forceOpen"] is False
    assert "stopLevel" not in body


def test_rejected_deal_is_an_error(ig):
    FakeClient.handler = _deal_handler({"dealStatus": "REJECTED", "reason": "MARKET_CLOSED"})
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).place_order(_OrderReq())
    assert exc.value.status_code == 422
    assert "MARKET_CLOSED" in exc.value.detail


def test_limit_order_is_a_working_order_good_till_end_of_day(ig):
    FakeClient.handler = _deal_handler({"dealStatus": "ACCEPTED", "dealId": "DIW1"})
    out = _adapter(ig).place_order(_OrderReq(order_type="LMT", limit_price=1.05))
    body = _calls("/workingorders/otc", "POST")[0][4]
    assert body["type"] == "LIMIT"
    assert body["level"] == 1.05
    assert body["timeInForce"] == "GOOD_TILL_DATE"
    assert body["goodTillDate"].endswith("23:59:59")
    assert out["status"] == "submitted"


def test_gtc_stop_order(ig):
    FakeClient.handler = _deal_handler({"dealStatus": "ACCEPTED", "dealId": "DIW2"})
    _adapter(ig).place_order(_OrderReq(order_type="STP", tif="GTC", stop_price=1.2))
    body = _calls("/workingorders/otc", "POST")[0][4]
    assert body["type"] == "STOP" and body["timeInForce"] == "GOOD_TILL_CANCELLED"


def test_stop_limit_is_400(ig):
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).place_order(_OrderReq(order_type="STP_LMT", stop_price=1, limit_price=1))
    assert exc.value.status_code == 400
    assert FakeClient.calls == []


def test_live_order_blocked_without_gate(ig):
    with pytest.raises(HTTPException) as exc:
        _adapter(ig).place_order(_OrderReq(account_mode="live"))
    assert exc.value.status_code == 403
    assert FakeClient.calls == []


def test_cancel_deletes_the_working_order(ig):
    out = _adapter(ig).cancel_order("DIW1")
    assert _calls("/workingorders/otc/DIW1", "DELETE")
    assert out["status"] == "cancel_requested"


# --------------------------------------------------------------------------- #
# account
# --------------------------------------------------------------------------- #
def _position(deal_id, direction, size, level, stop=None, limit=None, epic="CS.D.EURUSD.CFD.IP"):
    return {
        "position": {
            "dealId": deal_id,
            "direction": direction,
            "size": size,
            "level": level,
            "stopLevel": stop,
            "limitLevel": limit,
            "currency": "USD",
        },
        "market": {"epic": epic, "bid": 1.1, "offer": 1.1002},
    }


def test_positions_net_deals_per_epic(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(
        {
            "positions": [
                _position("D1", "BUY", 1, 1.0, stop=0.95),
                _position("D2", "BUY", 3, 1.2, stop=0.98),
                _position("D3", "SELL", 2, 1.5, epic="IX.D.ASX.IFT.IP"),
            ]
        }
    )
    rows = {r["symbol"]: r for r in _adapter(ig).positions()}
    eur = rows["EUR.USD"]
    assert eur["position"] == 4
    assert eur["average_cost"] == pytest.approx(1.15)
    # The least protective stop of a long is the lowest.
    assert eur["stop_loss"] == 0.95
    assert eur["market_price"] == pytest.approx(1.1001)
    assert rows["IX.D.ASX.IFT.IP"]["position"] == -2
    assert rows["IX.D.ASX.IFT.IP"]["stop_loss"] is None


def test_modify_position_stop_never_loosens(ig):
    def handler(method, path, params, json):
        if path == "/positions":
            return FakeResponse(
                {
                    "positions": [
                        _position("D1", "BUY", 1, 1.0, stop=0.95),
                        _position("D2", "BUY", 1, 1.0, stop=0.99),
                    ]
                }
            )
        if path.startswith("/positions/otc/"):
            return FakeResponse({"dealReference": "R-" + path.rsplit("/", 1)[1]})
        if path.startswith("/confirms/"):
            return FakeResponse({"dealStatus": "ACCEPTED", "stopLevel": 0.97})
        return FakeResponse({})

    FakeClient.handler = handler
    out = _adapter(ig).modify_position_stop("EUR.USD", stop_loss=0.97)
    updates = _calls("/positions/otc/D1", "PUT")
    assert updates and updates[0][4]["stopLevel"] == 0.97
    # D2's stop is already tighter, so it is left alone.
    assert not _calls("/positions/otc/D2", "PUT")
    assert out["sl"] == 0.97


def test_account_summary_equity_is_balance_plus_open_pnl(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(
        {
            "accounts": [
                {"accountId": "OTHER", "currency": "USD", "balance": {"balance": 1}},
                {
                    "accountId": "ABC12",
                    "preferred": True,
                    "currency": "AUD",
                    "balance": {
                        "balance": 10000,
                        "profitLoss": -250,
                        "available": 8000,
                        "deposit": 1500,
                    },
                },
            ]
        }
    )
    summary = _adapter(ig).account_summary()
    assert summary["account_id"] == "ABC12"
    assert summary["net_liquidation"] == 9750
    assert summary["currency"] == "AUD"
    assert summary["buying_power"] == 8000
    assert summary["maintenance_margin"] == 1500


def test_instrument_spec_reads_dealing_rules(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(_MARKET)
    spec = _adapter(ig).instrument_spec("EUR.USD")
    assert spec["unit"] == "contracts"
    assert spec["min_size"] == 0.5
    assert spec["size_step"] == pytest.approx(0.1)
    assert spec["contract_size"] == 100000
    assert spec["currency"] == "USD"


def test_executions_keep_only_position_deals(ig):
    FakeClient.handler = lambda method, path, params, json: FakeResponse(
        {
            "activities": [
                {
                    "date": "2026-01-02T03:04:05",
                    "epic": "CS.D.EURUSD.CFD.IP",
                    "dealId": "D1",
                    "type": "POSITION",
                    "status": "ACCEPTED",
                    "details": {
                        "direction": "SELL",
                        "size": 2,
                        "level": 1.1,
                        "dealReference": "audit-9",
                        "currency": "USD",
                        "actions": [{"actionType": "POSITION_OPENED"}],
                    },
                },
                {
                    "dealId": "W1",
                    "type": "WORKING_ORDER",
                    "status": "ACCEPTED",
                    "details": {"actions": [{"actionType": "WORKING_ORDER_DELETED"}]},
                },
                {
                    "dealId": "D2",
                    "type": "POSITION",
                    "status": "REJECTED",
                    "details": {"actions": [{"actionType": "POSITION_OPENED"}]},
                },
            ]
        }
    )
    fills = _adapter(ig).executions()
    assert len(fills) == 1
    fill = fills[0]
    assert fill["exec_id"] == "D1"
    assert fill["side"] == "SELL" and fill["quantity"] == 2
    assert fill["symbol"] == "EUR.USD"
    assert fill["audit_id"] == 9


# --------------------------------------------------------------------------- #
# Streaming (Lightstreamer)
# --------------------------------------------------------------------------- #
class FakeStream:
    """Stands in for LightstreamerClient: records how it was opened and plays
    the updates (or raises the error) the test set."""

    opened = []
    updates = []
    error = None

    def __init__(self, endpoint, user, password, **kwargs):
        FakeStream.opened.append({"endpoint": endpoint, "user": user, "password": password})

    def run(self, subscriptions, on_update, should_stop):
        FakeStream.opened[-1]["subscriptions"] = subscriptions
        if FakeStream.error is not None:
            raise FakeStream.error
        for update in FakeStream.updates:
            on_update(update)


@pytest.fixture
def ig_stream(ig, monkeypatch):
    FakeStream.opened, FakeStream.updates, FakeStream.error = [], [], None
    monkeypatch.setattr(ig, "LightstreamerClient", FakeStream)

    def login(self, method, url, headers=None, params=None, json=None):
        FakeClient.calls.append((method, url, headers or {}, params or {}, json))
        return FakeResponse(
            {"currentAccountId": "ABC12", "lightstreamerEndpoint": "https://demo-apd.example.com"},
            headers={"CST": "cst-1", "X-SECURITY-TOKEN": "xst-1"},
        )

    monkeypatch.setattr(FakeClient, "request", login)
    return ig


def _update(ig, item, values, changed=None):
    return ig.Update(
        subscription=0, item=item, values=values, changed=set(changed or values.keys())
    )


def test_stream_prices_signs_in_with_the_session_and_reports_bid_and_offer(ig_stream):
    FakeStream.updates = [
        _update(ig_stream, "MARKET:CS.D.EURUSD.CFD.IP", {"BID": "1.1000", "OFFER": "1.1002"}),
        _update(ig_stream, "MARKET:IX.D.ASX.IFD.IP", {"BID": "8001.5", "OFFER": None}),
        _update(ig_stream, "MARKET:UNKNOWN", {"BID": "1", "OFFER": "2"}),
    ]
    got = []
    _adapter(ig_stream).stream_prices(
        ["EUR.USD", "IX.D.ASX.IFD.IP"], lambda s, b, a: got.append((s, b, a)), lambda: False
    )

    assert got == [("EUR.USD", 1.1, 1.1002), ("IX.D.ASX.IFD.IP", 8001.5, None)]
    opened = FakeStream.opened[0]
    assert opened["endpoint"] == "https://demo-apd.example.com"
    assert opened["user"] == "ABC12"
    assert opened["password"] == "CST-cst-1|XST-xst-1"
    (sub,) = opened["subscriptions"]
    assert sub.mode == "MERGE" and sub.snapshot is True
    assert list(sub.items) == ["MARKET:CS.D.EURUSD.CFD.IP", "MARKET:IX.D.ASX.IFD.IP"]
    assert list(sub.fields) == ["BID", "OFFER"]


def test_stream_prices_uses_the_configured_account_and_one_login(ig_stream):
    adapter = _adapter(ig_stream, account_id="ABC12")
    adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
    adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
    assert FakeStream.opened[1]["user"] == "ABC12"
    assert len(_calls("/session", "POST")) == 1


def test_a_refused_stream_is_an_error_and_does_not_log_in_again_at_once(ig_stream):
    FakeStream.error = ig_stream.LightstreamerError(1, "User/password check failed")
    adapter = _adapter(ig_stream)
    for _ in range(3):
        with pytest.raises(HTTPException) as err:
            adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
        assert err.value.status_code == 502
        assert "check failed" in err.value.detail
    # IG locks a key that logs in too often: three failures, one login.
    assert len(_calls("/session", "POST")) == 1


def test_a_refused_stream_logs_in_again_once_the_session_is_old(ig_stream, monkeypatch):
    FakeStream.error = ig_stream.LightstreamerError(1, "User/password check failed")
    adapter = _adapter(ig_stream)
    with pytest.raises(HTTPException):
        adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
    adapter._login_at -= 120  # the session is now two minutes old
    with pytest.raises(HTTPException):
        adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
    with pytest.raises(HTTPException):
        adapter.stream_prices(["EUR.USD"], lambda *a: None, lambda: False)
    assert len(_calls("/session", "POST")) == 2


def test_stream_trade_events_fires_on_accepted_deals_only(ig_stream):
    item = "TRADE:ABC12"
    FakeStream.updates = [
        _update(
            ig_stream, item, {"CONFIRMS": '{"dealStatus":"ACCEPTED","dealId":"D1"}', "OPU": None}
        ),
        _update(ig_stream, item, {"CONFIRMS": '{"dealStatus":"REJECTED"}', "OPU": None}),
        _update(
            ig_stream,
            item,
            {"CONFIRMS": '{"dealStatus":"REJECTED"}', "OPU": '{"status":"UPDATED"}'},
            changed=["OPU"],
        ),
        _update(ig_stream, item, {"CONFIRMS": None, "OPU": None}),
        _update(ig_stream, item, {"CONFIRMS": "not json", "OPU": None}, changed=["CONFIRMS"]),
    ]
    events = []
    _adapter(ig_stream).stream_trade_events(lambda: events.append(1), lambda: False)

    assert len(events) == 3
    (sub,) = FakeStream.opened[0]["subscriptions"]
    assert sub.mode == "DISTINCT" and sub.snapshot is False
    assert list(sub.items) == ["TRADE:ABC12"]
    assert list(sub.fields) == ["CONFIRMS", "OPU"]


def test_a_guaranteed_stop_is_asked_for_only_with_a_stop(ig):
    FakeClient.handler = _deal_handler(
        {"dealStatus": "ACCEPTED", "status": "OPEN", "dealId": "D1", "stopLevel": 1.09}
    )
    req = _OrderReq(stop_loss=1.09)
    req.guaranteed_stop = True
    _adapter(ig).place_order(req)
    body = _calls("/positions/otc", "POST")[-1][4]
    assert body["guaranteedStop"] is True and body["stopLevel"] == 1.09

    req = _OrderReq()
    req.guaranteed_stop = True
    _adapter(ig).place_order(req)
    assert _calls("/positions/otc", "POST")[-1][4]["guaranteedStop"] is False
