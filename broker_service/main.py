"""
Broker Service — FastAPI application shell.

After the GAP_ANALYSIS §3.4 split this file only *builds* the app: it wires
the cross-cutting middleware (observability + CORS) and mounts the route
subpackages. Everything else lives in its own module:

  - HTTP route handlers → ``routes/`` (one module per domain) and ``orders.py``.
  - Pydantic schemas → ``models.py``.
  - The ``IBApp`` class + connection management → ``ib_client.py``.
  - Stateless converters, the symbol cache and the contract factory →
    ``ib_helpers.py``.
  - The ``process_bars*`` transformations → ``bars_processing.py``.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ib_client import IB_CLIENT_ID, IB_HOST, IB_PORT, disconnect_ib
from observability import attach_observability, get_logger
from orders import router as orders_router
from routes import register_routes

logger = get_logger(__name__)

CORS_ORIGINS = os.getenv("IB_CORS_ORIGINS", "").split(",") if os.getenv("IB_CORS_ORIGINS") else []


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    logger.info("Starting Broker Service...")
    logger.info(f"IB configuration: {IB_HOST}:{IB_PORT}, Client ID: {IB_CLIENT_ID}")
    logger.info("Broker Service ready - broker connections are established on first API call")

    yield

    logger.info("Shutting down Broker Service...")
    disconnect_ib()


app = FastAPI(
    title="TradingApp Broker Service",
    description="Multi-broker market-data and order-execution service for TradingApp (IB, MT5, Alpaca, OANDA)",
    version="4.0.0",
    lifespan=lifespan,
)

# Observability wiring (X-Request-Id middleware, /metrics, structlog).
# Attach BEFORE CORS so X-Request-Id is set even on preflight responses.
attach_observability(app)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Order management (Tier 4 item 9). Every route in orders.py double-checks the
# LIVE_TRADING_ENABLED gate.
app.include_router(orders_router)

# Domain route modules: health / market data / backtesting / streaming /
# contracts / account / symbols.
register_routes(app)


if __name__ == "__main__":
    logger.info("Starting Broker Service...")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
