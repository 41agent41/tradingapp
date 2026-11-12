"""
Guards the FastAPI app wiring after the routes were carved out of main.py
into the ``routes/`` subpackage (GAP_ANALYSIS §3.4).

Importing ``main`` builds the app and mounts every route module; if a router
is dropped or a handler fails to import, the app won't expose the path and
these assertions fail. No IB gateway is touched — only registration is
checked (conftest defaults IB_HOST so the import succeeds).
"""

from __future__ import annotations

import main
from tests.route_paths import served_paths

# Every business path the service is expected to expose, grouped by module.
EXPECTED_PATHS = {
    # health.py
    "/",
    "/health",
    "/timezone-info",
    "/connection",
    "/connect",
    "/disconnect",
    # market_data.py
    "/market-data/history",
    "/market-data/tick",
    "/market-data/realtime",
    "/market-data/depth",
    "/market-data/sentiment",
    "/market-data/ticks",
    "/indicators/available",
    # backtesting.py
    "/backtesting/strategies",
    "/backtesting/run",
    # strategies.py
    "/strategies/evaluate",
    # streaming.py
    "/market-data/stream/subscribe",
    "/market-data/stream/unsubscribe",
    "/market-data/stream/status",
    "/market-data/subscribe",
    "/market-data/unsubscribe",
    # contracts.py
    "/contract/search",
    "/contract/advanced-search",
    # account.py
    "/account/summary",
    "/account/positions",
    "/account/orders",
    "/account/all",
    # symbols.py
    "/symbols/discover",
    "/symbols/cache/stats",
    "/symbols/cache/clear",
    # orders.py
    "/orders",
    "/orders/config",
}


def _registered_paths() -> set[str]:
    return served_paths(main.app)


def test_all_expected_routes_are_registered():
    missing = EXPECTED_PATHS - _registered_paths()
    assert not missing, f"routes missing from the app: {sorted(missing)}"


def test_metrics_endpoint_is_mounted():
    # Observability wiring must survive the split.
    assert "/metrics" in _registered_paths()


def test_orders_router_is_mounted():
    # orders.py is included separately from the routes/ package.
    assert "/orders/{order_id}" in _registered_paths()


def test_depth_comes_only_from_a_broker_that_publishes_a_book(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import adapters
    from routes import market_data

    class WithBook:
        def market_depth(self, symbol, levels):
            return {"symbol": symbol, "bids": [{"price": 1.0, "size": 5.0}][:levels], "asks": []}

    class Without:
        pass

    app = FastAPI()
    app.include_router(market_data.router)
    client = TestClient(app)

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: WithBook())
    res = client.get("/market-data/depth", params={"symbol": "EURUSD", "source": "ctrader"})
    assert res.status_code == 200 and res.json()["bids"] == [{"price": 1.0, "size": 5.0}]
    assert client.get("/market-data/depth", params={"symbol": "X", "levels": 0}).status_code == 400

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: Without())
    res = client.get("/market-data/depth", params={"symbol": "EURUSD", "source": "oanda"})
    assert res.status_code == 501
    assert "not available from oanda" in res.json()["detail"]


def test_sentiment_comes_only_from_a_broker_that_publishes_it(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import adapters
    from routes import market_data

    class WithSentiment:
        def client_sentiment(self, symbol):
            return {"symbol": symbol, "long_pct": 60.0, "short_pct": 40.0}

    class Without:
        pass

    app = FastAPI()
    app.include_router(market_data.router)
    client = TestClient(app)

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: WithSentiment())
    res = client.get("/market-data/sentiment", params={"symbol": "EUR.USD", "source": "ig"})
    assert res.status_code == 200 and res.json()["long_pct"] == 60.0

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: Without())
    res = client.get("/market-data/sentiment", params={"symbol": "EUR.USD", "source": "oanda"})
    assert res.status_code == 501
    assert "not available from oanda" in res.json()["detail"]


def test_tick_history_comes_only_from_a_broker_that_keeps_ticks(monkeypatch):
    from datetime import UTC, datetime

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import adapters
    from routes import market_data

    asked = []

    class WithTicks:
        def tick_history(self, symbol, start, end, limit):
            asked.append((symbol, start, end, limit))
            return {"symbol": symbol, "ticks": [], "count": 0, "complete": True}

    class Without:
        pass

    app = FastAPI()
    app.include_router(market_data.router)
    client = TestClient(app)
    get = lambda **params: client.get("/market-data/ticks", params=params)  # noqa: E731

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: WithTicks())
    res = get(
        symbol="EURUSD",
        start="2026-01-05T00:00:00Z",
        end="2026-01-05T01:00:00",
        limit=7,
    )
    assert res.status_code == 200 and res.json()["complete"] is True
    symbol, start, end, limit = asked[0]
    assert (symbol, limit) == ("EURUSD", 7)
    assert start == datetime(2026, 1, 5, tzinfo=UTC)
    # A time with no zone is read as UTC.
    assert end == datetime(2026, 1, 5, 1, tzinfo=UTC)

    # With no end, up to now.
    assert get(symbol="EURUSD", start="2026-01-05T00:00:00Z").status_code == 200
    assert asked[1][2] > asked[1][1] and asked[1][3] == 5000

    assert get(symbol="X", start="yesterday").status_code == 400
    assert get(symbol="X", start="2026-01-05", end="2026-01-04").status_code == 400
    assert get(symbol="X", start="2026-01-05", limit=0).status_code == 400
    assert get(symbol="X", start="2026-01-05", limit=50001).status_code == 400

    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a: Without())
    res = get(symbol="EURUSD", start="2026-01-05T00:00:00Z", source="oanda")
    assert res.status_code == 501
    assert "not available from oanda" in res.json()["detail"]
