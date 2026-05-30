"""
Order placement / cancel / modify against the IB Gateway.

This module is the **only** place in the IB service that calls
``EClient.placeOrder`` and ``EClient.cancelOrder``. Everything that
mutates a real broker account flows through these helpers, and every
helper short-circuits when ``LIVE_TRADING_ENABLED`` is false and the
caller asked for ``account_mode='live'``. The backend route layer is
expected to repeat the same check — defence in depth.

Routes (mounted from main.py):

  POST   /orders            — place a new order
  DELETE /orders/{order_id} — cancel a working order
  PUT    /orders/{order_id} — modify (resend with same orderId)

Order types supported: MKT, LMT, STP, STP_LMT.
Time-in-force values supported: DAY, GTC, IOC, FOK.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, status
from ibapi.order import Order as IBOrder
from pydantic import BaseModel, Field

from ib_client import get_ib_connection
from ib_helpers import create_contract
from observability import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Configuration — read at import time.
# ---------------------------------------------------------------------------
LIVE_TRADING_ENABLED = (os.getenv("LIVE_TRADING_ENABLED", "false").lower() == "true")
ORDER_PLACE_WAIT_SECONDS = int(os.getenv("ORDER_PLACE_WAIT_SECONDS", "3"))

VALID_ORDER_TYPES = {"MKT", "LMT", "STP", "STP_LMT"}
VALID_TIF = {"DAY", "GTC", "IOC", "FOK"}
VALID_ACTIONS = {"BUY", "SELL"}
VALID_ACCOUNT_MODES = {"paper", "live"}


# IB's wire format for STP_LMT is "STP LMT" (space-separated). Map here so
# the rest of the system can use the underscored form everywhere.
_IB_ORDER_TYPE = {
    "MKT": "MKT",
    "LMT": "LMT",
    "STP": "STP",
    "STP_LMT": "STP LMT",
}


class PlaceOrderRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=32)
    action: str = Field(..., description="BUY or SELL")
    quantity: float = Field(..., gt=0)
    order_type: str = Field("MKT", description="MKT | LMT | STP | STP_LMT")
    tif: str = Field("DAY", description="DAY | GTC | IOC | FOK")
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    account_mode: str = "paper"
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    # Optional — the backend can supply its audit-row id so error logs
    # can be correlated to the persisted attempt.
    audit_id: Optional[int] = None


class ModifyOrderRequest(BaseModel):
    quantity: Optional[float] = Field(None, gt=0)
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    tif: Optional[str] = None
    # Required so we can rebuild a valid IB Order — the original
    # contract + action don't change in a modify, but the IB API
    # requires every field on every placeOrder call.
    symbol: str
    action: str
    order_type: str
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    account_mode: str = "paper"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_order_id_lock = threading.Lock()


def _validate_common(action: str, order_type: str, tif: str, account_mode: str) -> None:
    if action not in VALID_ACTIONS:
        raise HTTPException(400, f"action must be one of {sorted(VALID_ACTIONS)}")
    if order_type not in VALID_ORDER_TYPES:
        raise HTTPException(400, f"order_type must be one of {sorted(VALID_ORDER_TYPES)}")
    if tif not in VALID_TIF:
        raise HTTPException(400, f"tif must be one of {sorted(VALID_TIF)}")
    if account_mode not in VALID_ACCOUNT_MODES:
        raise HTTPException(400, f"account_mode must be one of {sorted(VALID_ACCOUNT_MODES)}")
    if account_mode == "live" and not LIVE_TRADING_ENABLED:
        raise HTTPException(
            403,
            "Live trading is disabled. Set LIVE_TRADING_ENABLED=true on the ib_service to enable.",
        )


def _next_order_id(ib) -> int:
    """Return the next valid IB order id, waiting briefly if nextValidId
    hasn't fired yet on a freshly-connected session."""
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if ib.next_order_id is not None:
            with _order_id_lock:
                order_id = int(ib.next_order_id)
                ib.next_order_id = order_id + 1
                return order_id
        time.sleep(0.1)
    raise HTTPException(503, "IB Gateway did not return next valid order id within 5s")


def _build_ib_order(
    action: str,
    quantity: float,
    order_type: str,
    tif: str,
    limit_price: Optional[float],
    stop_price: Optional[float],
) -> IBOrder:
    o = IBOrder()
    o.action = action
    o.orderType = _IB_ORDER_TYPE[order_type]
    o.totalQuantity = quantity
    o.tif = tif
    if order_type in ("LMT", "STP_LMT"):
        if limit_price is None:
            raise HTTPException(400, f"limit_price is required for order_type={order_type}")
        o.lmtPrice = float(limit_price)
    if order_type in ("STP", "STP_LMT"):
        if stop_price is None:
            raise HTTPException(400, f"stop_price is required for order_type={order_type}")
        o.auxPrice = float(stop_price)
    # eTradeOnly / firmQuoteOnly default to True in older ibapi versions,
    # which IB Gateway now rejects with error 10268. Force them off.
    o.eTradeOnly = False
    o.firmQuoteOnly = False
    return o


# ---------------------------------------------------------------------------
# Sync workers — called from the FastAPI handlers via run_in_executor
# upstream so the event loop stays responsive.
# ---------------------------------------------------------------------------
def place_order_sync(req: PlaceOrderRequest) -> Dict[str, Any]:
    _validate_common(req.action, req.order_type, req.tif, req.account_mode)

    ib = get_ib_connection()
    if not ib.isConnected():
        raise HTTPException(503, "IB Gateway not connected")

    order_id = _next_order_id(ib)
    contract = create_contract(req.symbol, req.secType, req.exchange, req.currency)
    ib_order = _build_ib_order(
        action=req.action,
        quantity=req.quantity,
        order_type=req.order_type,
        tif=req.tif,
        limit_price=req.limit_price,
        stop_price=req.stop_price,
    )

    logger.info(
        "placing_order",
        order_id=order_id,
        symbol=req.symbol,
        action=req.action,
        quantity=req.quantity,
        order_type=req.order_type,
        account_mode=req.account_mode,
        live_enabled=LIVE_TRADING_ENABLED,
        audit_id=req.audit_id,
    )

    ib.placeOrder(order_id, contract, ib_order)
    # Brief sleep so the IB callback can update orderStatus before we read it.
    time.sleep(min(ORDER_PLACE_WAIT_SECONDS, 5))

    return {
        "order_id": order_id,
        "symbol": req.symbol,
        "action": req.action,
        "quantity": req.quantity,
        "order_type": req.order_type,
        "tif": req.tif,
        "account_mode": req.account_mode,
        "status": "submitted",
    }


def cancel_order_sync(order_id: int) -> Dict[str, Any]:
    ib = get_ib_connection()
    if not ib.isConnected():
        raise HTTPException(503, "IB Gateway not connected")
    logger.info("cancelling_order", order_id=order_id)
    # ibapi 9.81 added a manualCancelOrderTime arg; later versions take a
    # second OrderCancel object. Pass an empty string for compatibility
    # with both signatures (the gateway accepts an empty time).
    try:
        ib.cancelOrder(order_id, "")
    except TypeError:
        ib.cancelOrder(order_id)
    return {"order_id": order_id, "status": "cancel_requested"}


def modify_order_sync(order_id: int, req: ModifyOrderRequest) -> Dict[str, Any]:
    _validate_common(req.action, req.order_type, req.tif or "DAY", req.account_mode)

    ib = get_ib_connection()
    if not ib.isConnected():
        raise HTTPException(503, "IB Gateway not connected")

    contract = create_contract(req.symbol, req.secType, req.exchange, req.currency)
    ib_order = _build_ib_order(
        action=req.action,
        quantity=req.quantity if req.quantity is not None else 1,
        order_type=req.order_type,
        tif=req.tif or "DAY",
        limit_price=req.limit_price,
        stop_price=req.stop_price,
    )
    logger.info("modifying_order", order_id=order_id, symbol=req.symbol)
    # placeOrder with the same orderId modifies in-place per IB API docs.
    ib.placeOrder(order_id, contract, ib_order)
    time.sleep(min(ORDER_PLACE_WAIT_SECONDS, 5))
    return {"order_id": order_id, "status": "modify_requested"}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.post("/orders")
async def place_order(req: PlaceOrderRequest) -> Dict[str, Any]:
    # The TWS API client is synchronous; run the placement off the event loop.
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, place_order_sync, req)


@router.delete("/orders/{order_id}")
async def cancel_order(order_id: int) -> Dict[str, Any]:
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, cancel_order_sync, order_id)


@router.put("/orders/{order_id}")
async def modify_order(order_id: int, req: ModifyOrderRequest) -> Dict[str, Any]:
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: modify_order_sync(order_id, req))


@router.get("/orders/config")
async def order_routes_config() -> Dict[str, Any]:
    """Report which writes are currently enabled. Useful for the UI to
    decide whether to even render the Live-trading toggle."""
    return {
        "live_trading_enabled": LIVE_TRADING_ENABLED,
        "order_types": sorted(VALID_ORDER_TYPES),
        "tif": sorted(VALID_TIF),
        "actions": sorted(VALID_ACTIONS),
    }
