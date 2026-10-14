"""
Real-time streaming endpoints (Phase 4).

These wrap the StreamingManager in ``streaming.py``. The manager owns
refcounted ``reqMktData`` subscriptions and publishes every tick to Redis so
the backend can fan them out to Socket.IO clients.

A subscription goes to the broker named in ``source`` or, with none, the
default broker, falling back to the next broker with market data when that
one cannot stream. IB streams through ``streaming.py``; every other broker
through ``venue_streaming.py`` (OANDA's pricing stream, or polling), on the
same Redis channel.

The endpoints are deliberately small — almost all the logic lives in the
manager module (which has dedicated unit tests). The IBApp tick observer is
attached lazily on the first subscribe so importing this module never touches
an IB connection.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ib_client import get_ib_connection
from ib_helpers import create_contract
from observability import get_logger
from streaming import streaming_manager
from venue_streaming import venue_streamer

from ._shared import run_tws_operation

logger = get_logger(__name__)
router = APIRouter()


class StreamSubscribeRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)
    secType: str = Field(default="STK")
    exchange: str = Field(default="SMART")
    currency: str = Field(default="USD")
    source: str = Field(default="")
    account: Optional[str] = None


class StreamSymbolRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)


def _attach_streaming_if_needed() -> None:
    """Lazy-wire the StreamingManager to the live IBApp instance."""
    if getattr(streaming_manager, "_ib_app", None) is not None:
        return
    ib = get_ib_connection()

    def _resolve(symbol: str, sec_type: str, exchange: str, currency: str):
        # Re-use the existing contract helper so symbol semantics stay
        # consistent with the rest of the IB service. No `reqContractDetails`
        # round-trip here — `reqMktData` accepts the lightweight contract.
        return create_contract(symbol.upper(), sec_type, exchange, currency)

    streaming_manager.attach(ib, _resolve)


def _subscribe_ib(req: StreamSubscribeRequest):
    _attach_streaming_if_needed()
    return streaming_manager.subscribe(
        req.symbol, sec_type=req.secType, exchange=req.exchange, currency=req.currency
    )


@router.post("/market-data/stream/subscribe")
async def stream_subscribe(req: StreamSubscribeRequest):
    """Start (or refcount-bump) a streaming market-data subscription."""
    from adapters import falls_back, market_data_candidates, resolve_connection

    symbol = req.symbol.upper()
    try:
        # Already streaming (from whichever broker): just take a reference.
        held = venue_streamer.retain(symbol)
        if held is not None:
            return _venue_answer(held)

        candidates = market_data_candidates(req.source, req.account)
        if symbol in streaming_manager.list_symbols():
            # Already streaming from IB: take a reference there, not a second feed.
            candidates = [("ib", None)]
        first_error: Exception | None = None
        for platform, account in candidates:
            try:
                if platform == "ib":
                    sub = await run_tws_operation(lambda: _subscribe_ib(req))
                    return {
                        "status": "subscribed",
                        "symbol": sub.symbol,
                        "source": "ib",
                        "req_id": sub.req_id,
                        "ref_count": sub.ref_count,
                        "channel": f"marketdata:tick:{sub.symbol}",
                    }
                conn = resolve_connection(platform, account)
                venue_streamer.adapter_for(conn.key)  # fails now if it has no market data
                return _venue_answer(venue_streamer.subscribe(symbol, *conn.key))
            except Exception as exc:  # noqa: BLE001 — try the next broker
                if not falls_back(exc):
                    raise
                first_error = first_error or exc
                logger.warning(f"stream subscribe for {symbol} on {platform} failed: {exc}")
        raise first_error or HTTPException(503, "No broker can stream market data")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"stream subscribe failed for {req.symbol}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to subscribe to {req.symbol}: {exc}",
        )


def _venue_answer(sub) -> dict:
    return {
        "status": "subscribed",
        "symbol": sub.symbol,
        "source": sub.platform,
        "ref_count": sub.ref_count,
        "channel": f"marketdata:tick:{sub.symbol}",
    }


@router.post("/market-data/stream/unsubscribe")
async def stream_unsubscribe(req: StreamSymbolRequest):
    """Drop one reference on a streaming subscription."""
    try:
        if venue_streamer.holds(req.symbol):
            sub = venue_streamer.unsubscribe(req.symbol)
        else:
            sub = streaming_manager.unsubscribe(req.symbol)
        if sub is None:
            return {"status": "not-subscribed", "symbol": req.symbol.upper()}
        return {
            "status": "unsubscribed" if sub.ref_count == 0 else "decremented",
            "symbol": sub.symbol,
            "ref_count": sub.ref_count,
        }
    except Exception as exc:
        logger.error(f"stream unsubscribe failed for {req.symbol}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to unsubscribe from {req.symbol}: {exc}",
        )


@router.get("/market-data/stream/status")
async def stream_status():
    """Diagnostics for the streaming pipeline (subs, refcounts, totals)."""
    return {**streaming_manager.status(), "venues": venue_streamer.status()}


# Backwards-compatible aliases. The backend Socket.IO bridge has been calling
# these paths since before the streaming pipeline existed; the endpoints used
# to be missing entirely. Keeping the older names live lets older backend
# builds keep working during a rolling deploy.
@router.post("/market-data/subscribe")
async def stream_subscribe_legacy(req: StreamSubscribeRequest):
    return await stream_subscribe(req)


@router.post("/market-data/unsubscribe")
async def stream_unsubscribe_legacy(req: StreamSymbolRequest):
    return await stream_unsubscribe(req)
