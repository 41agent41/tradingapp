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


def _streamer(adapter, published, quotes=None):
    lock = threading.Lock()

    def publish(symbol, tick_name, price=None, source=None, account=None):
        with lock:
            published.append((symbol, tick_name, price, source))

    def quote(platform, account, symbol, **fields):
        if quotes is not None:
            with lock:
                quotes.append((platform, account, symbol, fields))

    return VenueStreamer(
        publish_tick=publish,
        resolve_adapter=lambda p, a: adapter,
        poll_seconds=0.01,
        publish_quote=quote,
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


def test_the_same_symbol_streams_from_two_connections():
    published = []
    streamer = _streamer(PollingAdapter({"EURUSD": (1.0, 1.2)}), published)
    try:
        streamer.subscribe("EURUSD", "oanda", "practice")
        streamer.subscribe("EURUSD", "ctrader", "icmarkets")
        assert _wait_for(lambda: {p[3] for p in published} == {"oanda", "ctrader"})
        assert len(streamer.status()["subscriptions"]) == 2
        # Dropping one connection's reference leaves the other streaming.
        assert streamer.unsubscribe("EURUSD", "oanda", "practice").ref_count == 0
        assert not streamer.holds("EURUSD", "oanda")
        assert streamer.holds("EURUSD", "ctrader", "icmarkets")
    finally:
        streamer.stop_all()


def test_recorded_set_holds_without_references_and_sends_quotes():
    published, quotes = [], []
    adapter = PollingAdapter({"EURUSD": (1.0, 1.2), "GBPUSD": (2.0, 2.2)})
    adapter.bar_basis = "bid"
    streamer = _streamer(adapter, published, quotes)
    try:
        wanted = {("mt5", "axi", "EURUSD"), ("mt5", "axi", "GBPUSD")}
        assert streamer.set_recorded(wanted) == {}
        assert streamer.set_recorded(wanted) == {}  # repeating changes nothing
        assert streamer.recorded() == wanted
        assert _wait_for(lambda: {q[2] for q in quotes} == {"EURUSD", "GBPUSD"})
        platform, account, _symbol, fields = quotes[0]
        assert (platform, account, fields["basis"]) == ("mt5", "axi", "bid")
        assert set(fields) == {"bid", "ask", "last", "basis"}

        # A chart's reference comes and goes without stopping the recording.
        streamer.subscribe("EURUSD", "mt5", "axi")
        assert streamer.unsubscribe("EURUSD", "mt5", "axi").recorded
        assert streamer.holds("EURUSD", "mt5", "axi")

        # Leaving it out of the set releases it; the other keeps recording.
        streamer.set_recorded({("mt5", "axi", "GBPUSD")})
        assert not streamer.holds("EURUSD")
        assert streamer.recorded() == {("mt5", "axi", "GBPUSD")}
        streamer.set_recorded(set())
        assert _wait_for(lambda: not streamer._workers)
    finally:
        streamer.stop_all()


def test_quotes_are_sent_only_for_recorded_subscriptions():
    published, quotes = [], []
    streamer = _streamer(PollingAdapter({"AAPL": (1.0, 2.0)}), published, quotes)
    try:
        streamer.subscribe("AAPL", "alpaca", "default")
        assert _wait_for(lambda: len(published) >= 6)
        assert quotes == []
    finally:
        streamer.stop_all()


def test_recorded_set_reports_what_it_cannot_start():
    def resolve(platform, account):
        raise HTTPException(501, "nope is not configured")

    streamer = VenueStreamer(publish_tick=lambda *a, **k: None, resolve_adapter=resolve)
    errors = streamer.set_recorded({("nope", "default", "X")})
    assert errors == {("nope", "default", "X"): "nope is not configured"}
    assert streamer.recorded() == set()


def test_recorded_set_reports_a_symbol_whose_fetch_keeps_failing():
    streamer = _streamer(PollingAdapter({"AAPL": (1.0, 2.0)}), [], [])
    try:
        wanted = {("alpaca", "default", "AAPL"), ("alpaca", "default", "NOPE")}
        streamer.set_recorded(wanted)
        # It starts, then the broker says it has no such symbol.
        assert _wait_for(
            lambda: streamer.set_recorded(wanted) == {("alpaca", "default", "NOPE"): "unknown NOPE"}
        )
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

    subscribed, unsubscribed = [], []

    class FakeStreamer:
        def retain(self, symbol):
            return None

        def unsubscribe(self, symbol, platform=None, account=None):
            unsubscribed.append((symbol, platform, account))
            return venue_streaming.VenueSubscription(
                symbol=symbol.upper(), platform=platform, account=account, ref_count=0
            )

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
    assert res.json()["account"] == "default"
    assert res.json()["channel"] == "marketdata:tick:oanda:default:EUR.USD"
    assert subscribed == [("EUR.USD", "oanda", "default")]

    # The backend hands the connection back when it drops the reference.
    res = TestClient(app).post(
        "/market-data/stream/unsubscribe",
        json={"symbol": "EUR.USD", "source": "oanda", "account": "default"},
    )
    assert res.json()["status"] == "unsubscribed"
    assert unsubscribed == [("EUR.USD", "oanda", "default")]


def test_recorded_set_route_resolves_connections_and_reports_errors(two_brokers, monkeypatch):
    import venue_streaming
    from routes import streaming as streaming_routes

    quiet = PollingAdapter({"AAPL": (1.0, 2.0), "EUR.USD": (1.0, 1.2)})
    streamer = venue_streaming.VenueStreamer(
        publish_tick=lambda *a, **k: None,
        resolve_adapter=lambda p, a: quiet,
        poll_seconds=60,
        publish_quote=lambda *a, **k: None,
    )
    monkeypatch.setattr(streaming_routes, "venue_streamer", streamer)
    app = FastAPI()
    app.include_router(streaming_routes.router)
    client = TestClient(app)
    try:
        body = {
            "instruments": [
                {"platform": "oanda", "symbol": "eur.usd"},
                {"platform": "alpaca", "account": "default", "symbol": "AAPL"},
                {"platform": "mt5", "symbol": "EURUSD"},
            ]
        }
        res = client.put("/market-data/stream/recorded", json=body)
        assert res.status_code == 200
        assert res.json()["recorded"] == [
            {"platform": "alpaca", "account": "default", "symbol": "AAPL"},
            {"platform": "oanda", "account": "default", "symbol": "EUR.USD"},
        ]
        assert [e["platform"] for e in res.json()["errors"]] == ["mt5"]
        # Each instrument that resolved, with the account its quotes carry.
        assert res.json()["resolved"] == [
            {
                "platform": "oanda",
                "account": None,
                "symbol": "EUR.USD",
                "stream_account": "default",
                "mode": "polled",
            },
            {
                "platform": "alpaca",
                "account": "default",
                "symbol": "AAPL",
                "stream_account": "default",
                "mode": "polled",
            },
        ]
        # An empty set releases everything.
        res = client.put("/market-data/stream/recorded", json={"instruments": []})
        assert res.json() == {"recorded": [], "resolved": [], "errors": [], "poll_seconds": 60}
    finally:
        streamer.stop_all()


class BrokenStreamAdapter(PollingAdapter):
    """Has a price stream that always fails, and a working ``tick``."""

    def stream_prices(self, symbols, on_price, should_stop):
        raise HTTPException(502, "stream refused")


def test_a_failing_price_stream_falls_back_to_polling_and_still_reports_its_error(monkeypatch):
    import venue_streaming

    monkeypatch.setattr(venue_streaming, "RETRY_SECONDS", 0.01)
    published = []
    adapter = BrokenStreamAdapter({"EURUSD": (1.1, 1.2)})
    streamer = _streamer(adapter, published)
    try:
        streamer.subscribe("EURUSD", "ig", "demo")
        assert _wait_for(lambda: len(adapter.calls) >= 2)  # polled on each failed attempt
        assert _wait_for(lambda: published)
        assert _wait_for(
            lambda: streamer.status()["subscriptions"][0]["last_error"] == "stream refused"
        )
    finally:
        streamer.stop_all()


class TradeStreamAdapter:
    """A stream that reports a quote (no last price) and then a trade."""

    bar_basis = "last"

    def stream_prices(self, symbols, on_price, should_stop):
        on_price(symbols[0], 189.5, 189.52, last=None)
        on_price(symbols[0], None, None, last=189.51)
        while not should_stop():
            time.sleep(0.01)


def test_a_stream_that_gives_its_own_last_price_is_not_given_a_midpoint():
    published, quotes = [], []
    streamer = _streamer(TradeStreamAdapter(), published, quotes)
    try:
        streamer.set_recorded({("alpaca", "paper", "AAPL")})
        assert _wait_for(lambda: len(quotes) >= 2)
        assert [(name, price) for _, name, price, _ in published] == [
            ("BID", 189.5),
            ("ASK", 189.52),
            ("LAST", 189.51),
        ]
        assert [q[3] for q in quotes] == [
            {"bid": 189.5, "ask": 189.52, "last": None, "basis": "last"},
            {"bid": None, "ask": None, "last": 189.51, "basis": "last"},
        ]
    finally:
        streamer.stop_all()


class BarStreamAdapter:
    """A stream that also passes on the broker's own 1-minute bars (E-12)."""

    bar_basis = "bid"
    streams_bars = True
    BAR = {"timestamp": 60000.0, "open": 1.1, "high": 1.2, "low": 1.0, "close": 1.15, "volume": 7}

    def stream_prices(self, symbols, on_price, should_stop, on_bar=None):
        on_price(symbols[0], 1.15, 1.16)
        on_bar(symbols[0], dict(self.BAR))
        while not should_stop():
            time.sleep(0.01)


def _bar_streamer(bars):
    return VenueStreamer(
        publish_tick=lambda *a, **k: None,
        resolve_adapter=lambda p, a: BarStreamAdapter(),
        publish_quote=lambda *a, **k: None,
        publish_bar=lambda platform, account, symbol, **bar: bars.append(
            (platform, account, symbol, bar)
        ),
    )


def test_a_broker_built_bar_of_a_recorded_subscription_goes_onto_the_stream():
    bars = []
    streamer = _bar_streamer(bars)
    try:
        streamer.set_recorded({("ctrader", "demo", "EURUSD")})
        assert _wait_for(lambda: bars)
        assert bars == [
            (
                "ctrader",
                "demo",
                "EURUSD",
                {
                    "minute": 60000.0,
                    "open": 1.1,
                    "high": 1.2,
                    "low": 1.0,
                    "close": 1.15,
                    "volume": 7,
                },
            )
        ]
    finally:
        streamer.stop_all()


def test_a_broker_built_bar_of_a_chart_only_subscription_is_dropped():
    bars = []
    streamer = _bar_streamer(bars)
    try:
        streamer.subscribe("EURUSD", "ctrader", "demo")
        assert _wait_for(lambda: streamer.status()["subscriptions"][0]["tick_count"] >= 1)
        time.sleep(0.05)
        assert bars == []
    finally:
        streamer.stop_all()


def test_an_adapter_without_bars_is_not_given_on_bar():
    # StreamingAdapter.stream_prices takes no on_bar: it would raise if given.
    published = []
    streamer = _streamer(StreamingAdapter(), published)
    try:
        streamer.subscribe("EURUSD", "oanda", "practice")
        assert _wait_for(lambda: len(published) >= 3)
        assert streamer.status()["subscriptions"][0]["last_error"] is None
    finally:
        streamer.stop_all()
