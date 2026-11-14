"""
Tests for the IBKR Web API adapter (Client Portal Gateway).

The gateway is faked (no network): a stub `httpx.Client` records every
request and answers from a per-test handler, so session set-up, symbol to
conid resolution, order prompts, brackets and the paper/live checks are
verified in isolation.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException

import adapters
import connections


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.content = b"x" if payload is not None else b""

    def json(self):
        return self._payload


class FakeClient:
    calls = []
    handler = None
    accounts = ["DU1234567"]

    def __init__(self, *args, **kwargs):
        FakeClient.kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def request(self, method, url, params=None, json=None, headers=None):
        path = url.split("/v1/api", 1)[1]
        FakeClient.calls.append((method, path, params or {}, json))
        if path == "/iserver/accounts":
            return FakeResponse({"accounts": FakeClient.accounts, "selectedAccount": "DU1234567"})
        if path == "/portfolio/accounts":
            return FakeResponse([{"id": a} for a in FakeClient.accounts])
        if path == "/trsrv/stocks":
            return FakeResponse(
                {
                    "AAPL": [{"name": "APPLE INC", "contracts": [{"conid": 265598, "isUS": True}]}],
                    "BHP": [
                        {
                            "name": "BHP GROUP",
                            "contracts": [
                                {"conid": 4036812, "exchange": "ASX", "isUS": False},
                                {"conid": 1111, "exchange": "LSE", "isUS": False},
                            ],
                        }
                    ],
                }
            )
        if path == "/iserver/currency/pairs":
            cur = params["currency"]
            return FakeResponse(
                {cur: [{"symbol": "AUD.USD", "conid": 14433401, "ccyPair": "USD"}]}
                if cur == "AUD"
                else {cur: []}
            )
        return FakeClient.handler(method, path, params or {}, json)


@pytest.fixture
def mod(monkeypatch):
    import ibweb_adapter

    importlib.reload(ibweb_adapter)
    FakeClient.calls = []
    FakeClient.accounts = ["DU1234567"]
    FakeClient.handler = lambda method, path, params, json: FakeResponse({})
    monkeypatch.setattr(ibweb_adapter.httpx, "Client", FakeClient)
    monkeypatch.setattr(ibweb_adapter, "_SNAPSHOT_WAIT_SECONDS", 0)
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    return ibweb_adapter


def _adapter(mod, account="DU1234567"):
    return mod.IBWebAdapter("https://gw:5000", account)


def _calls(path, method=None):
    return [c for c in FakeClient.calls if c[1] == path and (method is None or c[0] == method)]


class _Order:
    def __init__(self, **kw):
        self.symbol = kw.get("symbol", "AAPL")
        self.action = kw.get("action", "BUY")
        self.quantity = kw.get("quantity", 10)
        self.order_type = kw.get("order_type", "MKT")
        self.tif = kw.get("tif", "DAY")
        self.limit_price = kw.get("limit_price")
        self.stop_price = kw.get("stop_price")
        self.account_mode = kw.get("account_mode", "paper")
        self.stop_loss = kw.get("stop_loss")
        self.take_profit = kw.get("take_profit")
        self.audit_id = kw.get("audit_id")


# -- connection ------------------------------------------------------------- #
def test_url_takes_the_api_prefix_once(mod):
    assert mod.IBWebAdapter("https://gw:5000/", "DU1")._base == "https://gw:5000/v1/api"
    assert mod.IBWebAdapter("https://gw:5000/v1/api", "DU1")._base == "https://gw:5000/v1/api"


def test_the_self_signed_gateway_certificate_is_not_verified(mod):
    FakeClient.handler = lambda *a: FakeResponse({"authenticated": True, "connected": True})
    _adapter(mod).probe()
    assert FakeClient.kwargs["verify"] is False


def test_probe_tickles_and_checks_the_session(mod):
    FakeClient.handler = lambda *a: FakeResponse({"authenticated": True, "connected": True})
    _adapter(mod).probe()
    assert _calls("/tickle", "POST") and _calls("/iserver/auth/status", "POST")
    assert _calls("/iserver/accounts") and _calls("/portfolio/accounts")


def test_probe_fails_when_signed_out(mod):
    FakeClient.handler = lambda *a: FakeResponse({"authenticated": False, "connected": True})
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).probe()
    assert exc.value.status_code == 503 and "not signed in" in exc.value.detail


def test_probe_fails_on_a_competing_session(mod):
    FakeClient.handler = lambda *a: FakeResponse(
        {"authenticated": True, "competing": True, "connected": True}
    )
    with pytest.raises(HTTPException, match="Another IBKR session"):
        _adapter(mod).probe()


def test_an_account_the_gateway_does_not_hold_is_refused(mod):
    FakeClient.accounts = ["U7654321"]
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).positions()
    assert exc.value.status_code == 502 and "DU1234567" in exc.value.detail


def test_a_401_reads_as_signed_out(mod):
    FakeClient.handler = lambda *a: FakeResponse({}, status_code=401)
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).account_summary()
    assert exc.value.status_code == 503


# -- symbols ---------------------------------------------------------------- #
def test_symbols_resolve_to_conids(mod):
    ib = _adapter(mod)
    assert ib._conid("AAPL") == 265598
    assert ib._conid("BHP:ASX") == 4036812
    assert ib._conid("AUD.USD") == 14433401
    assert ib._conid("AUDUSD") == 14433401
    assert ib._conid("8314") == 8314


def test_an_ambiguous_listing_names_the_exchanges(mod):
    with pytest.raises(HTTPException) as exc:
        _adapter(mod)._conid("BHP")
    assert exc.value.status_code == 400 and "BHP:ASX" in exc.value.detail


def test_an_unknown_exchange_is_refused(mod):
    with pytest.raises(HTTPException, match="not on NYSE"):
        _adapter(mod)._conid("BHP:NYSE")


def test_a_six_letter_ticker_is_not_an_fx_pair(mod):
    assert mod._fx_pair("GOOGLE") is None
    assert mod._fx_pair("EURUSD") == ("EUR", "USD")
    assert mod._fx_pair("EUR/USD") == ("EUR", "USD")


# -- market data ------------------------------------------------------------ #
def test_search_maps_secdef_results(mod):
    FakeClient.handler = lambda m, p, params, j: FakeResponse(
        [
            {
                "conid": "265598",
                "companyHeader": "APPLE INC - NASDAQ",
                "companyName": "APPLE INC",
                "symbol": "AAPL",
                "description": "NASDAQ",
                "sections": [{"secType": "STK"}, {"secType": "OPT"}],
            }
        ]
    )

    class Req:
        symbol = "AAPL"
        max_results = 10

    out = _adapter(mod).search_contracts(Req())
    assert out["count"] == 1
    assert out["results"][0]["conid"] == "265598"
    assert out["results"][0]["secType"] == "STK"
    assert out["results"][0]["exchange"] == "NASDAQ"
    assert out["broker"] == "ibweb"


def test_history_maps_bars_and_millisecond_times(mod):
    def handler(method, path, params, json):
        assert path == "/iserver/marketdata/history"
        assert params["bar"] == "1h" and params["period"] == "1m"
        return FakeResponse(
            {
                "data": [
                    {"o": 2, "h": 3, "l": 1, "c": 2.5, "v": 100, "t": 1747233000000},
                    {"o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 50, "t": 1747229400000},
                ]
            }
        )

    FakeClient.handler = handler
    out = _adapter(mod).historical_bars("AAPL", "1hour", "1M")
    assert out.count == 2
    assert out.bars[0].timestamp == 1747229400.0
    assert out.bars[1].close == 2.5


def test_history_with_a_date_range_counts_back_from_the_end(mod):
    seen = {}

    def handler(method, path, params, json):
        seen.update(params)
        return FakeResponse({"data": []})

    FakeClient.handler = handler
    out = _adapter(mod).historical_bars(
        "AAPL", "1day", start_date="2026-01-01", end_date="2026-01-31"
    )
    assert seen["period"] == "30d" and seen["startTime"] == "20260131-00:00:00"
    assert out.period == "CUSTOM"


def test_an_unsupported_timeframe_is_a_400(mod):
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).historical_bars("AAPL", "2day")
    assert exc.value.status_code == 400


def test_quote_retries_until_the_snapshot_has_prices(mod):
    answers = iter(
        [
            [{"conid": 265598}],
            [{"conid": 265598, "31": "C190.50", "84": "190.40", "86": "190.60", "87_raw": 1200}],
        ]
    )
    FakeClient.handler = lambda *a: FakeResponse(next(answers))
    quote = _adapter(mod).realtime_quote("AAPL")
    assert (quote.last, quote.bid, quote.ask, quote.volume) == (190.5, 190.4, 190.6, 1200)
    assert len(_calls("/iserver/marketdata/snapshot")) == 2


def test_no_prices_names_market_data_subscriptions(mod):
    FakeClient.handler = lambda *a: FakeResponse([{"conid": 265598}])
    with pytest.raises(HTTPException, match="market data subscriptions"):
        _adapter(mod).realtime_quote("AAPL")


# -- orders ----------------------------------------------------------------- #
def test_a_market_order_confirms_prompts_and_returns_the_order(mod):
    def handler(method, path, params, json):
        if path == "/iserver/account/DU1234567/orders":
            assert json["orders"][0] == {
                "acctId": "DU1234567",
                "conid": 265598,
                "orderType": "MKT",
                "side": "BUY",
                "quantity": 10.0,
                "tif": "DAY",
                "cOID": "audit-7",
            }
            return FakeResponse([{"id": "q1", "message": ["Price exceeds the cap"]}])
        if path == "/iserver/reply/q1":
            assert json == {"confirmed": True}
            return FakeResponse(
                [{"order_id": "1001", "order_status": "Submitted", "local_order_id": "audit-7"}]
            )
        raise AssertionError(path)

    FakeClient.handler = handler
    out = _adapter(mod).place_order(_Order(audit_id=7))
    assert out["order_id"] == "1001" and out["status"] == "submitted"
    assert out["warnings"] == ["Price exceeds the cap"]
    assert out["broker"] == "ibweb"


def test_endless_prompts_are_refused(mod):
    FakeClient.handler = lambda *a: FakeResponse([{"id": "q", "message": ["again?"]}])
    with pytest.raises(HTTPException, match="kept asking"):
        _adapter(mod).place_order(_Order())
    assert len(_calls("/iserver/reply/q")) == mod._MAX_REPLIES


def test_a_rejection_is_a_422(mod):
    FakeClient.handler = lambda *a: FakeResponse({"error": "insufficient funds"})
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).place_order(_Order())
    assert exc.value.status_code == 422


def test_stop_and_target_become_a_bracket(mod):
    sent = {}

    def handler(method, path, params, json):
        sent["orders"] = json["orders"]
        return FakeResponse(
            [
                {"order_id": "1", "order_status": "Submitted", "local_order_id": "audit-9"},
                {"order_id": "2", "order_status": "PreSubmitted", "local_order_id": "audit-9-sl"},
                {"order_id": "3", "order_status": "PreSubmitted", "local_order_id": "audit-9-tp"},
            ]
        )

    FakeClient.handler = handler
    out = _adapter(mod).place_order(
        _Order(order_type="LMT", limit_price=190.0, stop_loss=180.0, take_profit=210.0, audit_id=9)
    )
    parent, stop, target = sent["orders"]
    assert parent["orderType"] == "LMT" and parent["price"] == 190.0
    assert stop == {
        "acctId": "DU1234567",
        "conid": 265598,
        "orderType": "STP",
        "side": "SELL",
        "quantity": 10.0,
        "price": 180.0,
        "tif": "GTC",
        "parentId": "audit-9",
        "cOID": "audit-9-sl",
    }
    assert target["orderType"] == "LMT" and target["price"] == 210.0
    assert out["order_id"] == "1" and out["sl"] == 180.0 and out["tp"] == 210.0


def test_a_dropped_stop_child_reads_as_missing(mod):
    FakeClient.handler = lambda *a: FakeResponse(
        [{"order_id": "1", "order_status": "Submitted", "local_order_id": "audit-9"}]
    )
    out = _adapter(mod).place_order(_Order(stop_loss=180.0, audit_id=9))
    assert out["sl"] is None


def test_stop_limit_carries_both_prices(mod):
    ticket = _adapter(mod)._ticket(1, "SELL", 5, "STP_LMT", "GTC", 99.0, 100.0)
    assert ticket["orderType"] == "STOP_LIMIT"
    assert ticket["price"] == 99.0 and ticket["auxPrice"] == 100.0


def test_fok_is_refused(mod):
    with pytest.raises(HTTPException) as exc:
        _adapter(mod).place_order(_Order(tif="FOK"))
    assert exc.value.status_code == 400


def test_live_orders_need_live_trading_enabled(mod):
    with pytest.raises(HTTPException) as exc:
        _adapter(mod, "U1234567").place_order(_Order(account_mode="live"))
    assert exc.value.status_code == 403


def test_cancel_deletes_the_order(mod):
    FakeClient.handler = lambda *a: FakeResponse({"msg": "Request was submitted"})
    out = _adapter(mod).cancel_order("1001")
    assert _calls("/iserver/account/DU1234567/order/1001", "DELETE")
    assert out["status"] == "cancel_requested"


def test_modify_fills_the_quantity_from_the_working_order(mod):
    sent = {}

    def handler(method, path, params, json):
        if path == "/iserver/account/orders":
            return FakeResponse(
                {"orders": [{"orderId": 1001, "acct": "DU1234567", "remainingQuantity": 4}]}
            )
        sent["ticket"] = json
        return FakeResponse([{"order_id": "1001", "order_status": "Submitted"}])

    FakeClient.handler = handler

    class Mod:
        quantity = None
        limit_price = 101.0
        stop_price = None
        tif = "GTC"
        symbol = "AAPL"
        action = "BUY"
        order_type = "LMT"
        account_mode = "paper"

    out = _adapter(mod).modify_order("1001", Mod())
    assert sent["ticket"]["quantity"] == 4.0 and sent["ticket"]["price"] == 101.0
    assert out["status"] == "modify_requested"


# -- account ---------------------------------------------------------------- #
def test_positions_read_every_page(mod):
    def handler(method, path, params, json):
        page = int(path.rsplit("/", 1)[1])
        if page == 0:
            rows = [
                {"conid": i, "ticker": f"S{i}", "position": 1, "assetClass": "STK"}
                for i in range(100)
            ]
            return FakeResponse(rows)
        return FakeResponse(
            [
                {
                    "conid": 14433401,
                    "contractDesc": "AUD.USD",
                    "ticker": "AUD",
                    "assetClass": "CASH",
                    "position": -25000,
                    "mktPrice": 0.66,
                    "avgPrice": 0.65,
                    "unrealizedPnl": -250,
                    "currency": "USD",
                },
                {"conid": 5, "ticker": "FLAT", "position": 0},
            ]
        )

    FakeClient.handler = handler
    out = _adapter(mod).positions()
    assert len(out) == 101
    fx = out[-1]
    assert fx["symbol"] == "AUD.USD" and fx["position"] == -25000
    assert fx["average_cost"] == 0.65 and fx["unrealized_pnl"] == -250


def test_account_summary_reads_amounts(mod):
    FakeClient.handler = lambda *a: FakeResponse(
        {
            "netliquidation": {"amount": 100000.5, "currency": "AUD"},
            "totalcashvalue": {"amount": 50000},
            "buyingpower": {"amount": 400000},
            "maintmarginreq": {"amount": 1200},
        }
    )
    out = _adapter(mod).account_summary()
    assert out["net_liquidation"] == 100000.5 and out["currency"] == "AUD"
    assert out["buying_power"] == 400000 and out["maintenance_margin"] == 1200


def test_open_orders_skip_finished_ones(mod):
    FakeClient.handler = lambda *a: FakeResponse(
        {
            "orders": [
                {
                    "orderId": 1,
                    "acct": "DU1234567",
                    "ticker": "AAPL",
                    "side": "SELL",
                    "totalSize": 10,
                    "remainingQuantity": 10,
                    "origOrderType": "STOP_LIMIT",
                    "price": 180.5,
                    "auxPrice": 181.0,
                    "status": "Submitted",
                },
                {"orderId": 2, "acct": "DU1234567", "status": "Filled"},
                {"orderId": 3, "acct": "DU9999999", "status": "Submitted"},
            ]
        }
    )
    out = _adapter(mod).open_orders()
    assert [o["order_id"] for o in out] == ["1"]
    assert out[0]["order_type"] == "STP_LMT" and out[0]["action"] == "SELL"
    # A stop-limit waits at its trigger.
    assert out[0]["price"] == 181.0


def test_executions_map_trades(mod):
    def handler(method, path, params, json):
        assert params["days"] == 7
        return FakeResponse(
            [
                {
                    "execution_id": "0000e0d5.1",
                    "symbol": "AAPL",
                    "side": "B",
                    "size": "10",
                    "price": "190.5",
                    "commission": "1.0",
                    "trade_time_r": 1747229400000,
                    "order_ref": "audit-7",
                    "account": "DU1234567",
                    "conid": 265598,
                },
                {"execution_id": "x", "size": 1, "price": 1, "account": "U0000001"},
            ]
        )

    FakeClient.handler = handler
    (fill,) = _adapter(mod).executions(30)
    assert fill["exec_id"] == "0000e0d5.1" and fill["side"] == "BUY"
    assert fill["quantity"] == 10 and fill["price"] == 190.5 and fill["audit_id"] == 7
    assert fill["executed_at"].startswith("2025-05-14")


def test_instrument_spec_uses_the_contract(mod):
    FakeClient.handler = lambda *a: FakeResponse(
        {"instrument_type": "FUT", "multiplier": "50", "currency": "USD"}
    )
    spec = _adapter(mod).instrument_spec("495512557")
    assert spec["unit"] == "contracts" and spec["contract_size"] == 50.0


# -- the connection manifest ------------------------------------------------ #
IBWEB = {
    "id": "ibkr-paper",
    "platform": "ibweb",
    "url": "https://gw:5000",
    "account_id": "DU1234567",
}


def test_ibweb_connection_builds_its_adapter():
    (conn,) = connections.parse_managed([IBWEB])
    adapter = adapters._build_adapters(conn)[1]
    assert adapter.name == "ibweb" and adapter._account_id == "DU1234567"


@pytest.mark.parametrize("missing", ["url", "account_id"])
def test_ibweb_requires_url_and_account(missing):
    with pytest.raises(connections.ManifestError, match="ibweb requires"):
        connections.parse_managed([{**IBWEB, missing: ""}])


def test_a_paper_connection_refuses_a_live_account():
    with pytest.raises(connections.ManifestError, match="live account"):
        connections.parse_managed([{**IBWEB, "account_id": "U1234567"}])


def test_a_live_connection_refuses_a_paper_account():
    with pytest.raises(connections.ManifestError, match="paper account"):
        connections.parse_managed([{**IBWEB, "account_mode": "live"}])


def test_a_live_connection_with_a_live_account_parses():
    (conn,) = connections.parse_managed(
        [{**IBWEB, "account_mode": "live", "account_id": "U1234567"}]
    )
    assert conn.account_mode == "live"
