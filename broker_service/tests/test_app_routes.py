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
