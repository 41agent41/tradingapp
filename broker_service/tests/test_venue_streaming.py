"""Live prices from brokers other than IB (venue_streaming.py), OANDA's
pricing stream, and market-data fallback to the next broker.

No venue is contacted: adapters are fakes, and OANDA's stream is served by an
httpx MockTransport.
"""

from __future__ import annotations

import importlib
import json
import threading
import time

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from venue_streaming import VenueStreamer


def _wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class PollingAdapter:
    def __init__(self, prices):
        self.prices = prices
        self.calls = []

    def tick(self, symbol, account_mode="paper"):
        self.calls.append(symbol)
        if symbol not in self.prices:
            raise HTTPException(404, f"unknown {symbol}")
        bid, ask = self.prices[symbol]
        return {"bid": bid, "ask": ask, "last": (bid + ask) / 2}


class StreamingAdapter:
    def __init__(self):
        self.started = []

    def stream_prices(self, symbols, on_price, should_stop):
        self.started.append(list(symbols))
        while not should_stop():
            for s in symbols:
                on_price(s, 1.0, 1.2)
            time.sleep(0.01)


def _streamer(adapter, published):
    lock = threading.Lock()

    def publish(symbol, tick_name, price=None, source=None):
        with lock:
            published.append((symbol, tick_name, price, source))

    return VenueStreamer(
        publish_tick=publish, resolve_adapter=lambda p, a: adapter, poll_seconds=0.01
    )


def test_polled_broker_publishes_bid_ask_last():
    published = []
    streamer = _streamer(PollingAdapter({"AAPL": (100.0, 102.0)}), published)
    try:
        streamer.subscribe("aapl", "alpaca", "default")
        assert _wait_for(lambda: len(published) >= 3)
        assert published[:3] == [
            ("AAPL", "BID", 100.0, "alpaca"),
            ("AAPL", "ASK", 102.0, "alpaca"),
            ("AAPL", "LAST", 101.0, "alpaca"),
        ]
        assert streamer.status()["subscriptions"][0]["tick_count"] >= 1
    finally:
        streamer.stop_all()


def test_refcount_and_worker_retires_when_empty():
    published = []
    adapter = PollingAdapter({"AAPL": (1.0, 2.0)})
    streamer = _streamer(adapter, published)
    try:
        streamer.subscribe("AAPL", "alpaca", "default")
        assert streamer.retain("AAPL").ref_count == 2
        assert streamer.unsubscribe("AAPL").ref_count == 1
        assert streamer.holds("AAPL")
        assert streamer.unsubscribe("AAPL").ref_count == 0
        assert not streamer.holds("AAPL")
        assert _wait_for(lambda: not streamer._workers)
        assert streamer.unsubscribe("AAPL") is None
    finally:
        streamer.stop_all()


def test_a_failing_symbol_records_its_error_and_keeps_the_rest():
    published = []
    streamer = _streamer(PollingAdapter({"AAPL": (1.0, 2.0)}), published)
    try:
        streamer.subscribe("AAPL", "alpaca", "default")
        streamer.subscribe("NOPE", "alpaca", "default")
        assert _wait_for(lambda: any(s["last_error"] for s in streamer.status()["subscriptions"]))
        errors = {s["symbol"]: s["last_error"] for s in streamer.status()["subscriptions"]}
        assert errors["NOPE"] == "unknown NOPE"
        assert _wait_for(lambda: any(p[0] == "AAPL" for p in published))
    finally:
        streamer.stop_all()


def test_streaming_broker_restarts_its_stream_when_symbols_change():
    published = []
    adapter = StreamingAdapter()
    streamer = _streamer(adapter, published)
    try:
        streamer.subscribe("EUR.USD", "oanda", "default")
        assert _wait_for(lambda: adapter.started == [["EUR.USD"]])
        streamer.subscribe("GBP.USD", "oanda", "default")
        assert _wait_for(lambda: ["EUR.USD", "GBP.USD"] in adapter.started)
        assert _wait_for(lambda: any(p[0] == "GBP.USD" for p in published))
        assert ("EUR.USD", "LAST", pytest.approx(1.1), "oanda") in published
    finally:
        streamer.stop_all()


def test_oanda_stream_prices_parses_prices_and_skips_heartbeats(monkeypatch):
    import oanda_adapter

    lines = [
        {"type": "HEARTBEAT", "time": "t"},
        {
            "type": "PRICE",
            "instrument": "EUR_USD",
            "bids": [{"price": "1.1000"}],
            "asks": [{"price": "1.1002"}],
        },
        {"type": "PRICE", "instrument": "XAU_USD", "bids": [], "asks": []},
    ]
    seen_requests = []

    def handler(request):
        seen_requests.append(request)
        body = "\n".join(json.dumps(line) for line in lines) + "\n"
        return httpx.Response(200, content=body.encode())

    real_client = httpx.Client
    monkeypatch.setattr(
        oanda_adapter.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    adapter = oanda_adapter.OANDAAdapter("tok", "001", environment="practice")
    got = []
    adapter.stream_prices(["EUR.USD"], lambda s, b, a: got.append((s, b, a)), lambda: False)

    assert got == [("EUR.USD", 1.1, 1.1002)]
    req = seen_requests[0]
    assert req.url.host == "stream-fxpractice.oanda.com"
    assert req.url.path == "/v3/accounts/001/pricing/stream"
    assert req.url.params["instruments"] == "EUR_USD"
    assert req.headers["authorization"] == "Bearer tok"


# --------------------------------------------------------------------------- #
# Fallback to the next broker
# --------------------------------------------------------------------------- #
_ENV = (
    "BROKER_CONNECTIONS",
    "BROKER_CONNECTIONS_FILE",
    "MT5_BRIDGE_URL",
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "OANDA_API_TOKEN",
    "OANDA_ACCOUNT_ID",
    "DEFAULT_BROKER",
    "BROKER_PRIORITY",
    "IB_HOST",
)


@pytest.fixture
def two_brokers(monkeypatch):
    """OANDA (default) and Alpaca configured; their quotes are fakes."""
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OANDA_API_TOKEN", "tok")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "001")
    monkeypatch.setenv("ALPACA_API_KEY", "k")
    monkeypatch.setenv("ALPACA_API_SECRET", "s")
    import ib_client

    monkeypatch.setattr(ib_client, "IB_HOST", None)
    import connections

    importlib.reload(connections)
    import managed

    importlib.reload(managed)
    import adapters

    importlib.reload(adapters)
    import alpaca_adapter
    import oanda_adapter

    def quote(source):
        def fn(self, symbol, account_mode="paper"):
            from models import RealTimeQuote

            return RealTimeQuote(
                symbol=symbol, bid=1.0, ask=2.0, last=1.5, volume=None, timestamp="t"
            )

        return fn

    monkeypatch.setattr(alpaca_adapter.AlpacaAdapter, "realtime_quote", quote("alpaca"))
    from routes import market_data

    app = FastAPI()
    app.include_router(market_data.router)
    yield TestClient(app), oanda_adapter, adapters
    adapters.reset_registry()


def test_realtime_falls_back_when_the_default_broker_is_down(two_brokers, monkeypatch):
    client, oanda_adapter, adapters = two_brokers

    def down(self, symbol, account_mode="paper"):
        raise HTTPException(503, "OANDA unreachable")

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "realtime_quote", down)
    assert adapters.default_provider() == "oanda"

    res = client.get("/market-data/realtime", params={"symbol": "AAPL"})
    assert res.status_code == 200
    assert res.headers["x-market-data-source"] == "alpaca"
    assert res.json()["last"] == 1.5


def test_a_named_source_never_falls_back(two_brokers, monkeypatch):
    client, oanda_adapter, _ = two_brokers

    def down(self, symbol, account_mode="paper"):
        raise HTTPException(503, "OANDA unreachable")

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "realtime_quote", down)
    res = client.get("/market-data/realtime", params={"symbol": "AAPL", "source": "oanda"})
    assert res.status_code == 503


def test_a_bad_request_does_not_fall_back(two_brokers, monkeypatch):
    client, oanda_adapter, _ = two_brokers

    def bad(self, symbol, account_mode="paper"):
        raise HTTPException(400, "bad symbol")

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "realtime_quote", bad)
    res = client.get("/market-data/realtime", params={"symbol": "???"})
    assert res.status_code == 400


def test_stream_subscribe_uses_the_default_non_ib_broker(two_brokers, monkeypatch):
    _, oanda_adapter, _ = two_brokers
    import venue_streaming
    from routes import streaming as streaming_routes

    subscribed = []

    class FakeStreamer:
        def retain(self, symbol):
            return None

        def adapter_for(self, key):
            return object()

        def subscribe(self, symbol, platform, account):
            subscribed.append((symbol, platform, account))
            return venue_streaming.VenueSubscription(
                symbol=symbol, platform=platform, account=account, ref_count=1
            )

    monkeypatch.setattr(streaming_routes, "venue_streamer", FakeStreamer())
    app = FastAPI()
    app.include_router(streaming_routes.router)
    res = TestClient(app).post("/market-data/stream/subscribe", json={"symbol": "eur.usd"})
    assert res.status_code == 200
    assert res.json()["source"] == "oanda"
    assert subscribed == [("EUR.USD", "oanda", "default")]
