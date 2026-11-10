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
    # The connection the subscribe answer named. Omitted (an older backend),
    # the reference is dropped from whichever connection streams the symbol.
    source: str = Field(default="")
    account: Optional[str] = None


class RecordedInstrument(BaseModel):
    platform: str = Field(..., min_length=1, max_length=16)
    account: Optional[str] = None
    symbol: str = Field(..., min_length=1, max_length=20)
    secType: str = Field(default="STK")
    exchange: str = Field(default="SMART")
    currency: str = Field(default="USD")


class RecordedSetRequest(BaseModel):
    instruments: list[RecordedInstrument] = Field(default_factory=list, max_length=500)


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


def _ib_account(account: Optional[str] = None) -> str:
    """The IB connection's account name, for channels and recorded quotes."""
    from adapters import resolve_connection

    try:
        return resolve_connection("ib", account).key[1]
    except Exception:  # noqa: BLE001 — IB configured the old way, with no named account
        return account or "default"


def _subscribe_ib(req: StreamSubscribeRequest):
    _attach_streaming_if_needed()
    streaming_manager.ib_account = _ib_account(req.account)
    return streaming_manager.subscribe(
        req.symbol, sec_type=req.secType, exchange=req.exchange, currency=req.currency
    )


@router.post("/market-data/stream/subscribe")
async def stream_subscribe(req: StreamSubscribeRequest):
    """Start (or refcount-bump) a streaming market-data subscription."""
    from adapters import falls_back, market_data_candidates, resolve_connection

    symbol = req.symbol.upper()
    try:
        candidates = market_data_candidates(req.source, req.account)
        if not req.source.strip():
            # No connection named: if the symbol already streams somewhere,
            # take a reference there instead of starting a second feed.
            held = venue_streamer.retain(symbol)
            if held is not None:
                return _venue_answer(held)
            if symbol in streaming_manager.list_symbols():
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
                        "account": streaming_manager.ib_account,
                        "req_id": sub.req_id,
                        "ref_count": sub.ref_count,
                        "channel": f"marketdata:tick:ib:{streaming_manager.ib_account}:{sub.symbol}",
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
        "account": sub.account,
        "ref_count": sub.ref_count,
        "channel": f"marketdata:tick:{sub.platform}:{sub.account}:{sub.symbol}",
    }


@router.post("/market-data/stream/unsubscribe")
async def stream_unsubscribe(req: StreamSymbolRequest):
    """Drop one reference on a streaming subscription."""
    try:
        platform = req.source.strip().lower() or None
        if platform == "ib":
            sub = streaming_manager.unsubscribe(req.symbol)
        elif platform is not None:
            sub = venue_streamer.unsubscribe(req.symbol, platform, req.account or None)
        elif venue_streamer.holds(req.symbol):
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


@router.put("/market-data/stream/recorded")
async def stream_recorded(req: RecordedSetRequest):
    """Replace the set of instruments streamed for the backend's live recorder.

    The backend sends the whole set it wants and re-sends it every minute, so
    a call is safe to repeat and a restart here is repaired by the next one.
    Recorded instruments stream whether or not a chart is open, and their
    quotes go to the ``marketdata:quotes`` Redis Stream. An instrument that
    cannot be started is reported in ``errors`` and tried again next call.
    """
    from adapters import resolve_connection

    errors: list[dict] = []
    resolved: list[dict] = []
    venue_wanted: set[tuple[str, str, str]] = set()
    ib_wanted: dict[str, RecordedInstrument] = {}
    for item in req.instruments:
        symbol = item.symbol.upper().strip()
        platform = item.platform.strip().lower()
        try:
            if platform == "ib":
                ib_wanted[symbol] = item
                stream_account, mode = _ib_account(item.account), "streamed"
            else:
                key = resolve_connection(platform, item.account).key
                venue_wanted.add((key[0], key[1], symbol))
                stream_account, mode = key[1], _feed_mode(key)
            # The account as asked for (often "default") and the one the
            # quotes carry, so the backend can match a quote to its contract.
            resolved.append(
                {
                    "platform": platform,
                    "account": item.account,
                    "symbol": symbol,
                    "stream_account": stream_account,
                    "mode": mode,
                }
            )
        except Exception as exc:  # noqa: BLE001 — report it, keep the rest
            errors.append(_record_error(platform, item.account, symbol, exc))

    for (platform, account, symbol), message in venue_streamer.set_recorded(venue_wanted).items():
        errors.append(
            {"platform": platform, "account": account, "symbol": symbol, "error": message}
        )

    for symbol in streaming_manager.recorded_symbols() - set(ib_wanted):
        streaming_manager.unrecord(symbol)
    held = streaming_manager.recorded_symbols()
    for symbol, item in ib_wanted.items():
        if symbol in held:
            continue
        try:
            await run_tws_operation(lambda item=item: _record_ib(item))
        except Exception as exc:  # noqa: BLE001 — report it, keep the rest
            errors.append(_record_error("ib", item.account, symbol, exc))

    recorded = [
        {"platform": p, "account": a, "symbol": s}
        for (p, a, s) in sorted(venue_streamer.recorded())
    ] + [
        {"platform": "ib", "account": streaming_manager.ib_account, "symbol": s}
        for s in sorted(streaming_manager.recorded_symbols())
    ]
    return {
        "recorded": recorded,
        "resolved": resolved,
        "errors": errors,
        "poll_seconds": venue_streamer.poll_seconds,
    }


def _feed_mode(key: tuple[str, str]) -> str:
    """``streamed`` when the broker pushes prices, ``polled`` when they are fetched."""
    try:
        return "streamed" if hasattr(venue_streamer.adapter_for(key), "stream_prices") else "polled"
    except Exception:  # noqa: BLE001 — the start error is reported by set_recorded
        return "polled"


def _record_ib(item: RecordedInstrument):
    _attach_streaming_if_needed()
    streaming_manager.ib_account = _ib_account(item.account)
    return streaming_manager.record(
        item.symbol, sec_type=item.secType, exchange=item.exchange, currency=item.currency
    )


def _record_error(platform: str, account: Optional[str], symbol: str, exc: BaseException) -> dict:
    detail = getattr(exc, "detail", None)
    return {
        "platform": platform,
        "account": account,
        "symbol": symbol,
        "error": str(detail if detail is not None else exc)[:300],
    }


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
