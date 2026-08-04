"""
Route subpackage for the IB service (GAP_ANALYSIS §3.4).

Each module owns one cohesive slice of the HTTP surface and exposes an
``APIRouter`` as ``router``. ``main.py`` builds the FastAPI app and calls
``register_routes(app)`` to mount them, so the app shell stays thin and each
route group is independently readable and testable.
"""

from __future__ import annotations

from fastapi import FastAPI

from . import (
    account,
    backtesting,
    contracts,
    health,
    market_data,
    strategies,
    streaming,
    symbols,
)

# Order is cosmetic (FastAPI matches by path, not registration order) but kept
# roughly domain-grouped for readable OpenAPI output.
_ROUTERS = (
    health.router,
    market_data.router,
    backtesting.router,
    strategies.router,
    streaming.router,
    contracts.router,
    account.router,
    symbols.router,
)


def register_routes(app: FastAPI) -> None:
    """Mount every route module's router onto ``app``."""
    for router in _ROUTERS:
        app.include_router(router)
