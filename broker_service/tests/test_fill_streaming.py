"""Fills streamed from the broker (fill_streaming.py) and OANDA's transaction
stream. No venue is contacted: adapters are fakes, and OANDA's stream is
served by an httpx MockTransport."""

from __future__ import annotations

import json
import time
from types import SimpleNamespace

import httpx

from fill_streaming import FillStreamer


def _wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class FillAdapter:
    """Sends its fills once, then idles until told to stop."""

    def __init__(self, fills=(), fail=None):
        self.fills = list(fills)
        self.fail = fail
        self.opened = 0

    def stream_fills(self, on_fill, should_stop):
        self.opened += 1
        if self.fail:
            raise RuntimeError(self.fail)
        for fill in self.fills:
            on_fill(fill)
        self.fills = []
        while not should_stop():
            time.sleep(0.01)


class NoStreamAdapter:
    def executions(self, days=1):
        return []


def _streamer(adapters, published, enabled):
    return FillStreamer(
        list_connections=lambda: [SimpleNamespace(platform=p, account=a) for p, a in adapters],
        resolve_adapter=lambda p, a: adapters[(p, a)],
        publish_fill=lambda p, a, fill: published.append((p, a, fill)),
        enabled=lambda: enabled["on"],
    )


def test_streams_only_connections_that_can_and_publishes_their_fills():
    published = []
    adapters = {
        ("oanda", "001"): FillAdapter([{"exec_id": "7"}]),
        ("alpaca", "paper"): NoStreamAdapter(),
    }
    streamer = _streamer(adapters, published, {"on": True})
    try:
        streamer.reconcile()
        assert _wait_for(lambda: published)
        assert published == [("oanda", "001", {"exec_id": "7"})]
        status = streamer.status()
        assert [s["connection"] for s in status["streams"]] == ["oanda:001"]
        assert status["streams"][0]["fills"] == 1
        assert status["streams"][0]["listening"] is True
    finally:
        streamer.stop_all()


def test_nothing_streams_while_executions_sync_is_off_and_turning_it_off_stops_streams():
    published = []
    enabled = {"on": False}
    adapter = FillAdapter()
    streamer = _streamer({("oanda", "001"): adapter}, published, enabled)
    try:
        streamer.reconcile()
        assert streamer.status() == {"enabled": False, "streams": []}
        assert adapter.opened == 0

        enabled["on"] = True
        streamer.reconcile()
        assert _wait_for(lambda: adapter.opened == 1)
        streamer.reconcile()  # already running: not opened a second time
        assert adapter.opened == 1

        enabled["on"] = False
        streamer.reconcile()
        assert streamer.status()["streams"] == []
    finally:
        streamer.stop_all()


def test_a_removed_connection_stops_streaming():
    adapters = {("oanda", "001"): FillAdapter(), ("oanda", "002"): FillAdapter()}
    streamer = _streamer(adapters, [], {"on": True})
    try:
        streamer.reconcile()
        assert len(streamer.status()["streams"]) == 2
        del adapters[("oanda", "002")]
        streamer.reconcile()
        assert [s["connection"] for s in streamer.status()["streams"]] == ["oanda:001"]
    finally:
        streamer.stop_all()


def test_a_failing_stream_records_its_error_and_keeps_its_worker(monkeypatch):
    import fill_streaming

    monkeypatch.setattr(fill_streaming, "RETRY_SECONDS", 0.01)
    adapter = FillAdapter(fail="stream refused")
    streamer = _streamer({("oanda", "001"): adapter}, [], {"on": True})
    try:
        streamer.reconcile()
        assert _wait_for(lambda: adapter.opened >= 2)  # it retried
        assert streamer.status()["streams"][0]["last_error"] == "stream refused"
    finally:
        streamer.stop_all()


def test_the_setting_comes_from_the_backend_and_defaults_to_off(monkeypatch):
    import app_settings

    monkeypatch.delenv("FILL_STREAM_ENABLED", raising=False)
    app_settings.reset()
    assert app_settings.fill_stream_enabled() is False
    app_settings.apply({"FILL_STREAM_ENABLED": "true"})
    try:
        assert app_settings.fill_stream_enabled() is True
    finally:
        app_settings.reset()


def test_oanda_stream_fills_parses_fills_and_skips_everything_else(monkeypatch):
    import oanda_adapter

    lines = [
        {"type": "HEARTBEAT", "lastTransactionID": "10", "time": "2026-01-05T08:00:00Z"},
        {"type": "MARKET_ORDER", "id": "11", "instrument": "EUR_USD", "units": "1000"},
        {
            "type": "ORDER_FILL",
            "id": "12",
            "orderID": "11",
            "accountID": "001",
            "instrument": "EUR_USD",
            "units": "-1000",
            "price": "1.10250",
            "pl": "-1.5",
            "commission": "0.05",
            "accountBalanceCurrency": "AUD",
            "time": "2026-01-05T08:00:01.000000000Z",
        },
        {"type": "ORDER_FILL", "id": "13", "units": "0", "price": "1.1"},
    ]
    body = "\n".join(json.dumps(line) for line in lines) + "\nnot json\n"
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=body.encode())

    real_client = httpx.Client
    monkeypatch.setattr(
        oanda_adapter.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    adapter = oanda_adapter.OANDAAdapter("tok", "001", environment="practice")
    got = []
    adapter.stream_fills(got.append, lambda: False)

    assert len(got) == 1
    fill = got[0]
    assert fill["exec_id"] == "12"
    assert fill["order_id"] == "11"
    assert fill["symbol"] == "EUR.USD"
    assert (fill["side"], fill["quantity"], fill["price"]) == ("SELL", 1000.0, 1.1025)
    assert (fill["commission"], fill["realized_pnl"]) == (0.05, -1.5)
    assert (fill["currency"], fill["broker"], fill["account"]) == ("AUD", "oanda", "001")
    req = seen[0]
    assert req.url.host == "stream-fxpractice.oanda.com"
    assert req.url.path == "/v3/accounts/001/transactions/stream"
    assert req.headers["authorization"] == "Bearer tok"


def test_oanda_stream_fills_raises_on_an_http_error(monkeypatch):
    import pytest
    from fastapi import HTTPException

    import oanda_adapter

    real_client = httpx.Client
    monkeypatch.setattr(
        oanda_adapter.httpx,
        "Client",
        lambda **kw: real_client(
            transport=httpx.MockTransport(lambda r: httpx.Response(401, text="bad token")), **kw
        ),
    )
    adapter = oanda_adapter.OANDAAdapter("tok", "001", environment="live")
    with pytest.raises(HTTPException) as err:
        adapter.stream_fills(lambda f: None, lambda: False)
    assert err.value.status_code == 502
    assert "401" in err.value.detail


class TradeEventAdapter:
    """A broker that says only that something traded."""

    def __init__(self, events=1):
        self.events = events

    def stream_trade_events(self, on_event, should_stop):
        for _ in range(self.events):
            on_event()
        self.events = 0
        while not should_stop():
            time.sleep(0.01)


def test_a_broker_that_only_signals_a_trade_publishes_a_change_notice():
    published, changed = [], []
    adapters = {("ig", "demo"): TradeEventAdapter(events=2)}
    streamer = FillStreamer(
        list_connections=lambda: [SimpleNamespace(platform="ig", account="demo")],
        resolve_adapter=lambda p, a: adapters[(p, a)],
        publish_fill=lambda p, a, fill: published.append(fill),
        publish_changed=lambda p, a: changed.append((p, a)),
        enabled=lambda: True,
    )
    try:
        streamer.reconcile()
        assert _wait_for(lambda: len(changed) == 2)
        assert changed == [("ig", "demo"), ("ig", "demo")]
        assert published == []
        assert streamer.status()["streams"][0]["fills"] == 2
    finally:
        streamer.stop_all()
