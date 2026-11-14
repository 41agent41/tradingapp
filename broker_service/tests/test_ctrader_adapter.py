"""
Tests for the cTrader Open API adapter.

The WebSocket is faked: every message the adapter sends goes to a per-test
handler, which answers with a list of messages that the fake queues for
``recv``, tagged with the request's ``clientMsgId`` unless told otherwise.
Application and account authorisation are answered by the fake itself.
"""

from __future__ import annotations

import importlib
import json

import pytest
from fastapi import HTTPException


class FakeWS:
    sent = []
    handler = None
    connects = 0

    def __init__(self):
        self.queue = []
        self.closed = False

    def send(self, raw):
        msg = json.loads(raw)
        FakeWS.sent.append(msg)
        kind, payload = msg["payloadType"], msg.get("payload", {})
        if kind == 2100:
            replies = [(2101, {})]
        elif kind == 2102:
            replies = [(2103, {"ctidTraderAccountId": payload["ctidTraderAccountId"]})]
        elif kind == 51:
            replies = []
        else:
            replies = FakeWS.handler(kind, payload)
        for reply in replies:
            reply_kind, reply_payload, *rest = reply
            tagged = rest[0] if rest else True
            out = {"payloadType": reply_kind, "payload": reply_payload}
            if tagged:
                out["clientMsgId"] = msg.get("clientMsgId")
            self.queue.append(json.dumps(out))

    def recv(self, timeout=None):
        if not self.queue:
            raise TimeoutError
        return self.queue.pop(0)

    def close(self):
        self.closed = True


SYMBOLS = {
    "symbol": [
        {
            "symbolId": 1,
            "symbolName": "EURUSD",
            "description": "Euro vs US Dollar",
            "quoteAssetId": 2,
        },
        {"symbolId": 2, "symbolName": "US500", "description": "US 500 Index", "quoteAssetId": 2},
        {"symbolId": 3, "symbolName": "GBPUSD", "enabled": False},
    ]
}
DETAIL = {
    "symbol": [
        {"symbolId": 1, "digits": 5, "minVolume": 100000, "stepVolume": 100000, "maxVolume": 10**10}
    ]
}
ASSETS = {"asset": [{"assetId": 1, "name": "AUD"}, {"assetId": 2, "name": "USD"}]}


def base_handler(extra=None):
    def handler(kind, payload):
        if extra:
            out = extra(kind, payload)
            if out is not None:
                return out
        if kind == 2114:
            return [(2115, SYMBOLS)]
        if kind == 2116:
            return [(2117, DETAIL)]
        if kind == 2112:
            return [(2113, ASSETS)]
        raise AssertionError(f"unexpected request {kind}")

    return handler


@pytest.fixture
def ct(monkeypatch):
    import ctrader_adapter

    importlib.reload(ctrader_adapter)
    FakeWS.sent = []
    FakeWS.connects = 0
    FakeWS.handler = base_handler()

    def connect(url, timeout):
        FakeWS.connects += 1
        FakeWS.url = url
        return FakeWS()

    monkeypatch.setattr(ctrader_adapter, "_connect", connect)
    monkeypatch.setattr(ctrader_adapter, "_HISTORY_PAUSE_SECONDS", 0)
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    return ctrader_adapter


def _adapter(mod, **kw):
    return mod.CTraderAdapter("app-id", "app-secret", "token-1", "424242", timeout=0.2, **kw)


def _sent(kind):
    return [m["payload"] for m in FakeWS.sent if m["payloadType"] == kind]


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
        self.stop_loss = kw.get("stop_loss")
        self.take_profit = kw.get("take_profit")


# --------------------------------------------------------------------------- #
# connection
# --------------------------------------------------------------------------- #
def test_authorises_the_application_then_the_account(ct):
    FakeWS.handler = base_handler(
        lambda k, p: [(2122, {"trader": {"balance": 1}})] if k == 2121 else None
    )
    _adapter(ct).probe()
    assert FakeWS.url == "wss://demo.ctraderapi.com:5036"
    assert _sent(2100) == [{"clientId": "app-id", "clientSecret": "app-secret"}]
    assert _sent(2102) == [{"ctidTraderAccountId": 424242, "accessToken": "token-1"}]
    assert _sent(2121) == [{"ctidTraderAccountId": 424242}]


def test_live_environment_uses_the_live_host(ct):
    assert _adapter(ct, environment="live")._url == "wss://live.ctraderapi.com:5036"


def test_an_expired_token_says_how_to_fix_it(ct):
    FakeWS.handler = base_handler(
        lambda k, p: [(2142, {"errorCode": "CH_ACCESS_TOKEN_INVALID"})] if k == 2121 else None
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).probe()
    assert exc.value.status_code == 502
    assert "access token" in exc.value.detail


def test_unreachable_is_503(ct, monkeypatch):
    def refuse(url, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(ct, "_connect", refuse)
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).probe()
    assert exc.value.status_code == 503


def test_no_answer_is_503(ct):
    FakeWS.handler = base_handler(lambda k, p: [] if k == 2121 else None)
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).probe()
    assert exc.value.status_code == 503


def test_replies_to_other_requests_are_ignored(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2122, {"trader": {"balance": 9}}, False), (2122, {"trader": {"balance": 1}})]
            if k == 2121
            else None
        )
    )
    _adapter(ct).probe()


# --------------------------------------------------------------------------- #
# market data
# --------------------------------------------------------------------------- #
def test_search_maps_names_and_skips_disabled(ct):
    out = _adapter(ct).search_contracts(type("R", (), {"symbol": "usd"})())
    assert [r["symbol"] for r in out["results"]] == ["EUR.USD"]
    assert out["results"][0]["conid"] == "1"
    assert out["results"][0]["currency"] == "USD"
    assert out["results"][0]["secType"] == "CASH"


def test_unknown_symbol_is_400(ct):
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).realtime_quote("XYZ.ABC")
    assert exc.value.status_code == 400


def test_trendbars_are_decoded_from_low_plus_deltas(ct):
    bar = {
        "utcTimestampInMinutes": 29000000,
        "low": 110000,
        "deltaOpen": 10,
        "deltaHigh": 50,
        "deltaClose": 20,
        "volume": "321",
    }
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2138, {"trendbar": [bar] if p["period"] == 9 else []})] if k == 2137 else None
        )
    )
    out = _adapter(ct).historical_bars("EUR.USD", "1hour", "1W")
    assert out.count == 1
    b = out.bars[0]
    assert b.timestamp == 29000000 * 60
    assert (b.open, b.high, b.low, b.close) == (1.1001, 1.1005, 1.1, 1.1002)
    assert b.volume == 321


def test_a_range_is_walked_in_windows(ct):
    FakeWS.handler = base_handler(lambda k, p: [(2138, {"trendbar": []})] if k == 2137 else None)
    _adapter(ct).historical_bars("EUR.USD", "1min", start_date="2025-01-01", end_date="2025-01-21")
    windows = _sent(2137)
    # 20 days of M1 at five days a window.
    assert len(windows) == 4
    assert windows[0]["toTimestamp"] > windows[-1]["fromTimestamp"]
    assert all(w["period"] == 1 and w["symbolId"] == 1 for w in windows)


def test_a_short_window_is_continued_from_its_first_bar(ct):
    calls = []

    def trendbars(kind, payload):
        if kind != 2137:
            return None
        calls.append(payload)
        if len(calls) == 1:
            # Capped: only the last bar of the window comes back.
            first = (payload["toTimestamp"] // 60000) - 10
            return [(2138, {"trendbar": [{"utcTimestampInMinutes": first, "low": 1}]})]
        return [(2138, {"trendbar": []})]

    FakeWS.handler = base_handler(trendbars)
    _adapter(ct).historical_bars("EUR.USD", "1min", start_date="2025-01-01", end_date="2025-01-03")
    assert calls[1]["toTimestamp"] == ((calls[0]["toTimestamp"] // 60000) - 10) * 60000


def test_eight_hour_is_400(ct):
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).historical_bars("EUR.USD", "8hour")
    assert exc.value.status_code == 400


def test_quote_waits_for_both_sides(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [
                (2128, {}),
                (2131, {"symbolId": 1, "bid": 110000}, False),
                (2131, {"symbolId": 2, "ask": 1}, False),
                (2131, {"symbolId": 1, "ask": 110020}, False),
            ]
            if k == 2127
            else None
        )
    )
    quote = _adapter(ct).realtime_quote("EURUSD")
    assert quote.bid == 1.1 and quote.ask == 1.1002


def test_stream_keeps_the_side_that_did_not_change(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [
                (2128, {}),
                (2131, {"symbolId": 1, "bid": 110000, "ask": 110010}, False),
                (2131, {"symbolId": 1, "bid": 110005}, False),
            ]
            if k == 2127
            else None
        )
    )
    seen = []
    _adapter(ct).stream_prices(
        ["EUR.USD"], lambda s, b, a: seen.append((s, b, a)), lambda: len(seen) >= 2
    )
    assert seen == [("EUR.USD", 1.1, 1.1001), ("EUR.USD", 1.10005, 1.1001)]


# --------------------------------------------------------------------------- #
# orders
# --------------------------------------------------------------------------- #
def _fill(order_id=77, sl=None):
    return {
        "executionType": 3,
        "order": {"orderId": order_id},
        "position": {"positionId": 5, "stopLoss": sl},
    }


def test_market_order_sends_units_as_volume_and_waits_for_the_fill(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2126, {"executionType": 2, "order": {"orderId": 77}}), (2126, _fill())]
            if k == 2106
            else None
        )
    )
    out = _adapter(ct).place_order(_OrderReq(quantity=1000, audit_id=12))
    body = _sent(2106)[0]
    assert body["symbolId"] == 1
    assert body["orderType"] == 1 and body["tradeSide"] == 1
    assert body["volume"] == 100000
    assert body["clientOrderId"] == "audit-12"
    assert "timeInForce" not in body
    assert out["status"] == "filled"
    assert out["order_id"] == "77"


def test_market_order_stop_is_a_distance_from_the_current_price(ct):
    def handler(kind, payload):
        if kind == 2127:
            return [(2128, {}), (2131, {"symbolId": 1, "bid": 110000, "ask": 110020}, False)]
        if kind == 2106:
            return [(2126, _fill(sl=1.0952))]
        return None

    FakeWS.handler = base_handler(handler)
    out = _adapter(ct).place_order(_OrderReq(stop_loss=1.0952))
    body = _sent(2106)[0]
    # Buy fills at the ask, 1.1002; the stop is 50 pips (0.0050) below it.
    assert body["relativeStopLoss"] == 500
    assert "stopLoss" not in body
    assert out["sl"] == 1.0952


def test_limit_order_carries_absolute_protection_and_day_expiry(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2126, {"executionType": 2, "order": {"orderId": 9, "stopLoss": 1.05}})]
            if k == 2106
            else None
        )
    )
    out = _adapter(ct).place_order(
        _OrderReq(order_type="LMT", limit_price=1.0812345, stop_loss=1.05, action="BUY")
    )
    body = _sent(2106)[0]
    assert body["orderType"] == 2
    assert body["limitPrice"] == 1.08123
    assert body["stopLoss"] == 1.05
    assert body["timeInForce"] == 1 and body["expirationTimestamp"] > 0
    assert out["status"] == "submitted"
    assert out["sl"] == 1.05


def test_stop_limit_sends_the_limit_as_slippage_points(ct):
    FakeWS.handler = base_handler(
        lambda k, p: [(2126, {"executionType": 2, "order": {"orderId": 9}})] if k == 2106 else None
    )
    _adapter(ct).place_order(
        _OrderReq(order_type="STP_LMT", tif="GTC", stop_price=1.1, limit_price=1.1003)
    )
    body = _sent(2106)[0]
    assert body["orderType"] == 6
    assert body["stopPrice"] == 1.1
    assert body["slippageInPoints"] == 30
    assert body["timeInForce"] == 2


def test_order_error_is_422(ct):
    FakeWS.handler = base_handler(
        lambda k, p: [(2132, {"errorCode": "NOT_ENOUGH_MONEY"})] if k == 2106 else None
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).place_order(_OrderReq())
    assert exc.value.status_code == 422
    assert "NOT_ENOUGH_MONEY" in exc.value.detail


def test_rejected_order_is_422(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2126, {"executionType": 7, "errorCode": "MARKET_CLOSED"})] if k == 2106 else None
        )
    )
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).place_order(_OrderReq())
    assert exc.value.status_code == 422


def test_live_order_blocked_without_gate(ct):
    with pytest.raises(HTTPException) as exc:
        _adapter(ct).place_order(_OrderReq(account_mode="live"))
    assert exc.value.status_code == 403
    assert FakeWS.connects == 0


# --------------------------------------------------------------------------- #
# account
# --------------------------------------------------------------------------- #
def _position(pid, side, volume, price, sl=None, symbol_id=1, margin=0):
    return {
        "positionId": pid,
        "tradeData": {"symbolId": symbol_id, "volume": volume, "tradeSide": side},
        "positionStatus": 1,
        "price": price,
        "stopLoss": sl,
        "usedMargin": margin,
    }


def _account_handler(positions, orders=()):
    def handler(kind, payload):
        if kind == 2121:
            return [
                (
                    2122,
                    {
                        "trader": {
                            "balance": 1000000,
                            "moneyDigits": 2,
                            "depositAssetId": 1,
                            "traderLogin": 5150,
                        }
                    },
                )
            ]
        if kind == 2124:
            return [(2125, {"position": list(positions), "order": list(orders)})]
        if kind == 2187:
            return [
                (
                    2188,
                    {
                        "moneyDigits": 2,
                        "positionUnrealizedPnL": [
                            {"positionId": p["positionId"], "netUnrealizedPnL": 1500}
                            for p in positions
                        ],
                    },
                )
            ]
        return None

    return base_handler(handler)


def test_positions_net_a_hedged_account(ct):
    FakeWS.handler = _account_handler(
        [
            _position(1, "BUY", 100000, 1.1, sl=1.09),
            _position(2, 1, 300000, 1.2, sl=1.08),
            _position(3, 2, 100000, 1.3),
        ]
    )
    (row,) = _adapter(ct).positions()
    assert row["symbol"] == "EUR.USD"
    assert row["position"] == 3000
    assert row["average_cost"] == pytest.approx(1.175)
    assert row["stop_loss"] == 1.08
    assert row["unrealized_pnl"] == pytest.approx(45.0)
    assert row["currency"] == "AUD"


def test_account_summary_adds_open_pnl_to_balance(ct):
    FakeWS.handler = _account_handler([_position(1, 1, 100000, 1.1, margin=20000)])
    summary = _adapter(ct).account_summary()
    assert summary["total_cash_value"] == 10000
    assert summary["net_liquidation"] == 10015
    assert summary["maintenance_margin"] == 200
    assert summary["buying_power"] == 9815
    assert summary["currency"] == "AUD"
    assert summary["account_id"] == "5150"


def test_open_orders_skip_position_protection(ct):
    FakeWS.handler = _account_handler(
        [],
        orders=[
            {
                "orderId": 8,
                "orderType": 2,
                "tradeData": {"symbolId": 1, "volume": 50000, "tradeSide": 2},
            },
            {"orderId": 9, "orderType": 4, "tradeData": {"symbolId": 1, "volume": 1}},
        ],
    )
    rows = _adapter(ct).open_orders()
    assert len(rows) == 1
    assert rows[0]["order_id"] == "8"
    assert rows[0]["action"] == "SELL" and rows[0]["quantity"] == 500
    assert rows[0]["order_type"] == "LMT"


def test_modify_position_stop_never_loosens(ct):
    def handler(kind, payload):
        if kind == 2124:
            return [
                (
                    2125,
                    {
                        "position": [
                            _position(1, 1, 100000, 1.1, sl=1.09),
                            _position(2, 1, 100000, 1.1, sl=1.095),
                        ]
                    },
                )
            ]
        if kind == 2110:
            return [(2126, {"executionType": 4, "position": {"stopLoss": payload["stopLoss"]}})]
        return None

    FakeWS.handler = base_handler(handler)
    out = _adapter(ct).modify_position_stop("EUR.USD", stop_loss=1.093)
    amends = _sent(2110)
    assert [a["positionId"] for a in amends] == [1]
    assert amends[0]["stopLoss"] == 1.093
    assert out["sl"] == 1.093


def test_instrument_spec_is_in_units(ct):
    spec = _adapter(ct).instrument_spec("EUR.USD")
    assert spec["unit"] == "units"
    assert spec["min_size"] == 1000 and spec["size_step"] == 1000
    assert spec["contract_size"] == 1.0
    assert spec["currency"] == "USD"


def test_executions_report_filled_deals(ct):
    deals = [
        {
            "dealId": 31,
            "orderId": 77,
            "symbolId": 1,
            "filledVolume": 100000,
            "tradeSide": 2,
            "executionPrice": 1.1,
            "dealStatus": 2,
            "commission": -350,
            "moneyDigits": 2,
            "executionTimestamp": 1767225600000,
            "closePositionDetail": {"grossProfit": 1200},
        },
        {"dealId": 32, "symbolId": 1, "filledVolume": 0, "dealStatus": 4},
    ]

    def handler(kind, payload):
        if kind == 2133:
            return [(2134, {"deal": deals, "hasMore": False})]
        if kind == 2121:
            return [(2122, {"trader": {"depositAssetId": 1}})]
        return None

    FakeWS.handler = base_handler(handler)
    (fill,) = _adapter(ct).executions()
    assert fill["exec_id"] == "31"
    assert fill["side"] == "SELL" and fill["quantity"] == 1000
    assert fill["commission"] == 3.5
    assert fill["realized_pnl"] == 12.0
    assert fill["currency"] == "AUD"
    assert fill["executed_at"].startswith("2026-01-01")


def test_enum_names_are_understood_too(ct):
    assert ct._enum("ORDER_FILLED", ct._EXECUTION_TYPE) == 3
    assert ct._enum("3", ct._EXECUTION_TYPE) == 3
    assert ct._enum(None, ct._EXECUTION_TYPE) is None


# --------------------------------------------------------------------------- #
# live 1-minute bars and depth of market (E-12)
# --------------------------------------------------------------------------- #
def _bar_events(*spots):
    """Answer the spot subscription, then the live-bar one with ``spots``."""

    def extra(kind, payload):
        if kind == 2127:
            return [(2128, {})]
        if kind == 2135:
            return [(2165, {})] + [(2131, spot, False) for spot in spots]
        return None

    return base_handler(extra)


def _tb(minute, low, d_open, d_high, d_close=None, volume=3):
    bar = {
        "utcTimestampInMinutes": minute,
        "period": 1,
        "low": low,
        "deltaOpen": d_open,
        "deltaHigh": d_high,
        "volume": volume,
    }
    if d_close is not None:
        bar["deltaClose"] = d_close
    return bar


def test_stream_passes_on_each_live_bar_once_when_the_next_one_starts(ct, monkeypatch):
    monkeypatch.setattr(ct, "_BAR_GRACE_SECONDS", 10**12)  # only a later bar closes one
    FakeWS.handler = _bar_events(
        {"symbolId": 1, "bid": 110010, "ask": 110020, "trendbar": [_tb(1000, 110000, 5, 20)]},
        # The same minute again: a new low, and no close of its own.
        {"symbolId": 1, "bid": 109990, "trendbar": [_tb(1000, 109990, 15, 30, volume=4)]},
        # A bar of another period is not a 1-minute bar.
        {"symbolId": 1, "bid": 110000, "trendbar": [_tb(1000, 1, 1, 1) | {"period": "M5"}]},
        {"symbolId": 1, "bid": 110030, "trendbar": [_tb(1001, 110030, 0, 0, 0, volume=1)]},
    )
    prices, bars = [], []
    _adapter(ct).stream_prices(
        ["EUR.USD"],
        lambda s, b, a: prices.append((s, b, a)),
        lambda: len(prices) >= 4,
        on_bar=lambda s, bar: bars.append((s, bar)),
    )
    assert _sent(2135) == [{"symbolId": 1, "period": 1, "ctidTraderAccountId": 424242}]
    assert bars == [
        (
            "EUR.USD",
            {
                "timestamp": 60000.0,
                "open": 1.10005,
                "high": 1.1002,
                "low": 1.0999,
                "close": 1.0999,
                "volume": 4,
            },
        )
    ]
    assert len(prices) == 4


def test_a_live_bar_is_passed_on_soon_after_its_minute_ends(ct):
    # Minute 1000 ended long ago, so the first look at the clock closes it.
    FakeWS.handler = _bar_events(
        {"symbolId": 1, "bid": 110010, "ask": 110020, "trendbar": [_tb(1000, 110000, 5, 20, 10)]}
    )
    bars = []
    _adapter(ct).stream_prices(
        ["EUR.USD"],
        lambda s, b, a: None,
        lambda: bool(bars),
        on_bar=lambda s, bar: bars.append((s, bar["timestamp"], bar["close"])),
    )
    assert bars == [("EUR.USD", 60000.0, 1.1001)]


def test_prices_still_stream_when_live_bars_are_refused(ct):
    def extra(kind, payload):
        if kind == 2127:
            return [
                (2128, {}),
                (2131, {"symbolId": 1, "bid": 110000, "ask": 110010}, False),
            ]
        if kind == 2135:
            return [(2142, {"errorCode": "UNSUPPORTED", "description": "no live bars"})]
        return None

    FakeWS.handler = base_handler(extra)
    prices, bars = [], []
    _adapter(ct).stream_prices(
        ["EUR.USD"],
        lambda s, b, a: prices.append((s, b, a)),
        lambda: bool(prices),
        on_bar=lambda s, bar: bars.append(bar),
    )
    assert prices == [("EUR.USD", 1.1, 1.1001)] and bars == []


def test_stream_without_on_bar_does_not_subscribe_to_live_bars(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2128, {}), (2131, {"symbolId": 1, "bid": 110000}, False)] if k == 2127 else None
        )
    )
    seen = []
    _adapter(ct).stream_prices(["EUR.USD"], lambda s, b, a: seen.append(b), lambda: bool(seen))
    assert _sent(2135) == []


def test_market_depth_builds_the_book_from_new_and_deleted_quotes(ct):
    def extra(kind, payload):
        if kind == 2127:
            return [(2128, {})]
        if kind == 2156:
            return [
                (2157, {}),
                (
                    2155,
                    {
                        "symbolId": 1,
                        "newQuotes": [
                            {"id": 1, "size": 100000000, "bid": 110000},
                            {"id": 2, "size": 50000000, "bid": 109990},
                            {"id": 3, "size": 20000000, "bid": 110000},
                            {"id": 4, "size": 30000000, "ask": 110020},
                            {"id": 5, "size": 70000000, "ask": 110010},
                            {"id": 6, "size": 10000000, "ask": 110030},
                        ],
                    },
                    False,
                ),
                (2155, {"symbolId": 2, "newQuotes": [{"id": 9, "size": 1, "bid": 5}]}, False),
                (
                    2155,
                    {
                        "symbolId": 1,
                        "newQuotes": [{"id": 5, "size": 80000000, "ask": 110010}],
                        "deletedQuotes": [2],
                    },
                    False,
                ),
            ]
        return None

    FakeWS.handler = base_handler(extra)
    book = _adapter(ct).market_depth("EUR.USD", levels=2)
    assert _sent(2156) == [{"ctidTraderAccountId": 424242, "symbolId": [1]}]
    assert book["symbol"] == "EUR.USD" and book["broker"] == "ctrader"
    # Quotes at one price are added up; sizes are in units; best price first.
    assert book["bids"] == [{"price": 1.1, "size": 1200000.0}]
    assert book["asks"] == [
        {"price": 1.1001, "size": 800000.0},
        {"price": 1.1002, "size": 300000.0},
    ]


def test_market_depth_with_no_book_is_a_503(ct, monkeypatch):
    monkeypatch.setattr(ct, "_DEPTH_WAIT_SECONDS", 0.05)
    FakeWS.handler = base_handler(
        lambda k, p: [(2128, {})] if k == 2127 else [(2157, {})] if k == 2156 else None
    )
    with pytest.raises(HTTPException) as err:
        _adapter(ct).market_depth("EUR.USD")
    assert err.value.status_code == 503
    assert "depth of market" in err.value.detail


def test_market_depth_reports_a_refused_subscription(ct):
    FakeWS.handler = base_handler(
        lambda k, p: (
            [(2128, {})]
            if k == 2127
            else (
                [(2142, {"errorCode": "UNSUPPORTED", "description": "no depth"})]
                if k == 2156
                else None
            )
        )
    )
    with pytest.raises(HTTPException) as err:
        _adapter(ct).market_depth("EUR.USD")
    assert "no depth" in str(err.value.detail)


def test_a_trailing_stop_sets_ctraders_flag_on_the_order(ct):
    def handler(kind, payload):
        if kind == 2127:
            return [(2128, {}), (2131, {"symbolId": 1, "bid": 110000, "ask": 110020}, False)]
        if kind == 2106:
            return [(2126, _fill(sl=1.0952))]
        return None

    FakeWS.handler = base_handler(handler)
    req = _OrderReq(stop_loss=1.0952)
    req.trailing_stop = True
    _adapter(ct).place_order(req)
    body = _sent(2106)[-1]
    assert body["trailingStopLoss"] is True and body["relativeStopLoss"] == 500

    # Nothing to trail without a stop, and no flag unless asked.
    req = _OrderReq()
    req.trailing_stop = True
    _adapter(ct).place_order(req)
    assert "trailingStopLoss" not in _sent(2106)[-1]
    _adapter(ct).place_order(_OrderReq(stop_loss=1.0952))
    assert "trailingStopLoss" not in _sent(2106)[-1]
