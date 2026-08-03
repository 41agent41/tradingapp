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
    "/indicators/available",
    # backtesting.py
    "/backtesting/strategies",
    "/backtesting/run",
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
    return {route.path for route in main.app.routes}


def test_all_expected_routes_are_registered():
    missing = EXPECTED_PATHS - _registered_paths()
    assert not missing, f"routes missing from the app: {sorted(missing)}"


def test_metrics_endpoint_is_mounted():
    # Observability wiring must survive the split.
    assert "/metrics" in _registered_paths()


def test_orders_router_is_mounted():
    # orders.py is included separately from the routes/ package.
    assert "/orders/{order_id}" in _registered_paths()
