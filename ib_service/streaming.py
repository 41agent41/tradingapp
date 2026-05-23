"""
Real-time market-data streaming for the IB service (Phase 4).

This module turns the IB service from a request/response API into a true
streaming publisher. The high-level picture::

    IB Gateway ──reqMktData──▶ IBApp (tickPrice / tickSize)
                                    │
                                    ▼
                       StreamingManager.on_tick
                                    │  redis.publish
                                    ▼
                    redis://...                              ──▶  backend ──▶ Socket.IO ──▶ frontend
                       channel = "marketdata:tick:<SYMBOL>"

Design notes:

- One IB subscription per symbol. The manager refcounts callers (the
  backend may have many Socket.IO clients on the same symbol) and only
  cancels ``reqMktData`` once the refcount drops to zero.
- The IBApp class in ``main.py`` exposes a ``tick_observer`` hook (added
  alongside this module). Every ``tickPrice`` / ``tickSize`` callback
  calls the observer when set, so we don't need to subclass the wrapper.
- The Redis client is lazy: a connection failure degrades into a "no
  fan-out" mode rather than crashing the IB service. Ticks still hit
  the in-memory ``self.data[reqId]`` so the legacy REST realtime
  endpoint keeps working.
- Reserve a dedicated request-ID band (``BASE_STREAM_REQ_ID`` onward)
  so streaming IDs never collide with the ad-hoc request IDs scattered
  through ``main.py`` (the legacy code uses 1, 2, 3, 4, ...).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Channel prefix for tick payloads. The backend subscribes to
# ``marketdata:tick:*`` so adding new symbols requires no backend
# changes.
TICK_CHANNEL_PREFIX = "marketdata:tick:"

# Status channel for diagnostics (subscription started / stopped /
# errored). The frontend doesn't need this, but the backend health
# probe and ops dashboards can subscribe.
STATUS_CHANNEL = "marketdata:status"

# Streaming request-IDs start well above anything ``main.py`` uses for
# one-shot calls (history, contract details, etc.). 10000 leaves plenty
# of headroom for the legacy code.
BASE_STREAM_REQ_ID = 10_000


# Subset of IB ``TickTypeEnum`` values we surface. Anything not in this
# map is dropped — we don't want to flood Socket.IO clients with the
# 70+ exotic tick types IB emits.
TICK_TYPE_NAMES: dict[int, str] = {
    0: "BID_SIZE",
    1: "BID",
    2: "ASK",
    3: "ASK_SIZE",
    4: "LAST",
    5: "LAST_SIZE",
    6: "HIGH",
    7: "LOW",
    8: "VOLUME",
    9: "CLOSE",
    14: "OPEN",
}


@dataclass
class Subscription:
    """Per-symbol bookkeeping for an active IB subscription."""

    symbol: str
    req_id: int
    ref_count: int = 0
    started_at: float = field(default_factory=time.time)
    tick_count: int = 0
    last_tick_at: float | None = None
    last_error: str | None = None


class StreamingManager:
    """Manages the IB ``reqMktData`` subscriptions and fans ticks out to Redis.

    The manager is intentionally small — it owns subscription state,
    delegates IB calls back to whatever the caller passes in (the
    ``IBApp`` instance is supplied via ``attach``) and publishes JSON
    payloads to Redis. Tests inject a fake IB client and a fake Redis
    client to keep the unit tests hermetic.
    """

    def __init__(
        self,
        redis_factory: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        # Redis client factory (overridable in tests). The default lazily
        # imports ``redis`` so this module is importable in environments
        # that don't have the package (the unit tests use the
        # ``fakeredis`` stand-in).
        self._redis_factory = redis_factory or self._default_redis_factory
        self._redis: Any | None = None
        self._redis_lock = threading.Lock()

        self._subs: dict[str, Subscription] = {}
        self._req_to_symbol: dict[int, str] = {}
        self._lock = threading.Lock()
        self._next_req_id = BASE_STREAM_REQ_ID

        self._clock = clock

        # The IBApp instance and the contract resolver are wired up via
        # ``attach()`` so this module can be imported (and tested)
        # without requiring the IB API to be installed.
        self._ib_app: Any | None = None
        self._resolve_contract: Callable[[str, str, str, str], Any] | None = None

        # Total ticks observed since process start. Useful for the
        # ``/market-data/stream/status`` diagnostics endpoint.
        self.ticks_total = 0
        self.ticks_published = 0
        self.ticks_dropped = 0

    # ------------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------------
    def attach(self, ib_app: Any, resolve_contract: Callable[..., Any]) -> None:
        """Wire the manager to a live IB connection.

        ``ib_app`` must expose ``reqMktData``, ``cancelMktData`` and the
        ``tick_observer`` attribute (added by ``main.py`` alongside this
        module). ``resolve_contract`` takes ``(symbol, sec_type,
        exchange, currency)`` and returns a qualified IB ``Contract``.
        """
        self._ib_app = ib_app
        self._resolve_contract = resolve_contract
        # The IBApp tickPrice / tickSize callbacks invoke us; see main.py.
        try:
            ib_app.tick_observer = self.on_tick  # type: ignore[attr-defined]
            logger.info("StreamingManager attached to IBApp")
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning("StreamingManager could not attach tick_observer: %s", exc)

    def detach(self) -> None:
        """Drop all subscriptions and disconnect from the IB client."""
        with self._lock:
            subs = list(self._subs.values())
            self._subs.clear()
            self._req_to_symbol.clear()
        for sub in subs:
            try:
                if self._ib_app is not None:
                    self._ib_app.cancelMktData(sub.req_id)
            except Exception as exc:  # pragma: no cover — best effort on shutdown
                logger.warning("Failed to cancel %s on detach: %s", sub.symbol, exc)
        if self._ib_app is not None:
            try:
                self._ib_app.tick_observer = None  # type: ignore[attr-defined]
            except Exception:
                pass
        self._ib_app = None
        self._resolve_contract = None

    # ------------------------------------------------------------------
    # Public API — driven by the FastAPI endpoints
    # ------------------------------------------------------------------
    def subscribe(
        self,
        symbol: str,
        sec_type: str = "STK",
        exchange: str = "SMART",
        currency: str = "USD",
    ) -> Subscription:
        """Start (or refcount-bump) a streaming subscription for ``symbol``.

        Returns the resulting :class:`Subscription`. Idempotent —
        repeated calls for the same symbol increment ``ref_count`` and
        do not start a new IB subscription.
        """
        symbol = symbol.upper().strip()
        if not symbol:
            raise ValueError("symbol is required")

        with self._lock:
            sub = self._subs.get(symbol)
            if sub is not None:
                sub.ref_count += 1
                logger.info(
                    "Stream refcount %s for %s (req_id=%s)", sub.ref_count, symbol, sub.req_id
                )
                return sub

            req_id = self._next_req_id
            self._next_req_id += 1
            sub = Subscription(symbol=symbol, req_id=req_id, ref_count=1)
            self._subs[symbol] = sub
            self._req_to_symbol[req_id] = symbol

        try:
            self._start_ib(sub, sec_type=sec_type, exchange=exchange, currency=currency)
        except Exception:
            # Roll back the bookkeeping if the IB call fails so the
            # caller can retry.
            with self._lock:
                self._subs.pop(symbol, None)
                self._req_to_symbol.pop(sub.req_id, None)
            raise

        self._publish_status({"event": "started", "symbol": symbol, "req_id": sub.req_id})
        return sub

    def unsubscribe(self, symbol: str) -> Subscription | None:
        """Decrement the refcount and cancel the IB subscription at zero.

        Returns the (now-removed) subscription on the call that brings
        the refcount to zero, otherwise the still-live subscription, or
        ``None`` if the symbol wasn't subscribed.
        """
        symbol = symbol.upper().strip()
        with self._lock:
            sub = self._subs.get(symbol)
            if sub is None:
                return None
            sub.ref_count = max(0, sub.ref_count - 1)
            if sub.ref_count > 0:
                logger.info("Stream refcount %s for %s after unsubscribe", sub.ref_count, symbol)
                return sub
            # refcount hit zero — pop it out before we make the IB call
            # so a concurrent subscribe re-creates cleanly.
            self._subs.pop(symbol, None)
            self._req_to_symbol.pop(sub.req_id, None)

        try:
            self._cancel(symbol, sub=sub)
        except Exception as exc:
            sub.last_error = str(exc)
            logger.warning("cancelMktData(%s) failed: %s", sub.req_id, exc)

        self._publish_status({"event": "stopped", "symbol": symbol, "req_id": sub.req_id})
        return sub

    def force_unsubscribe(self, symbol: str) -> Subscription | None:
        """Tear a subscription down regardless of refcount.

        Used by ops endpoints and during shutdown; normal flow should
        always go through :meth:`unsubscribe`.
        """
        symbol = symbol.upper().strip()
        with self._lock:
            sub = self._subs.pop(symbol, None)
            if sub is None:
                return None
            self._req_to_symbol.pop(sub.req_id, None)
            sub.ref_count = 0
        try:
            self._cancel(symbol, sub=sub)
        except Exception as exc:  # pragma: no cover
            logger.warning("Force unsubscribe of %s failed: %s", symbol, exc)
        self._publish_status({"event": "force_stopped", "symbol": symbol})
        return sub

    def status(self) -> dict[str, Any]:
        """Diagnostics payload for ``GET /market-data/stream/status``."""
        with self._lock:
            subs = [
                {
                    "symbol": s.symbol,
                    "req_id": s.req_id,
                    "ref_count": s.ref_count,
                    "started_at": s.started_at,
                    "tick_count": s.tick_count,
                    "last_tick_at": s.last_tick_at,
                    "last_error": s.last_error,
                }
                for s in self._subs.values()
            ]
        redis_info = self._redis_health()
        return {
            "redis": redis_info,
            "subscriptions": subs,
            "totals": {
                "ticks_total": self.ticks_total,
                "ticks_published": self.ticks_published,
                "ticks_dropped": self.ticks_dropped,
            },
            "channels": {
                "tick_prefix": TICK_CHANNEL_PREFIX,
                "status": STATUS_CHANNEL,
            },
        }

    def list_symbols(self) -> list[str]:
        with self._lock:
            return sorted(self._subs.keys())

    # ------------------------------------------------------------------
    # Tick callback — wired in by ``IBApp.tick_observer``
    # ------------------------------------------------------------------
    def on_tick(
        self,
        req_id: int,
        tick_type: int,
        price: float | None = None,
        size: float | None = None,
    ) -> None:
        """Tick callback hooked into ``IBApp.tickPrice`` / ``tickSize``.

        Builds a normalised JSON payload and publishes it to the
        corresponding ``marketdata:tick:<symbol>`` channel. Drops the
        tick (and bumps ``ticks_dropped``) when the tick type isn't in
        :data:`TICK_TYPE_NAMES` or when the value is NaN / None.
        """
        self.ticks_total += 1

        with self._lock:
            symbol = self._req_to_symbol.get(req_id)
            sub = self._subs.get(symbol) if symbol else None

        if symbol is None or sub is None:
            # Tick for a req_id we don't track — most likely the legacy
            # one-shot snapshot flow. Let the existing IBApp.data path
            # handle it.
            self.ticks_dropped += 1
            return

        tick_name = TICK_TYPE_NAMES.get(tick_type)
        if tick_name is None:
            self.ticks_dropped += 1
            return

        try:
            numeric: float | None
            if price is not None and not _is_nanish(price):
                numeric = float(price)
            elif size is not None and not _is_nanish(size):
                numeric = float(size)
            else:
                self.ticks_dropped += 1
                return
        except (TypeError, ValueError):
            self.ticks_dropped += 1
            return

        now = self._clock()
        sub.tick_count += 1
        sub.last_tick_at = now

        payload = {
            "symbol": symbol,
            "type": "tick",
            "tick_type": tick_name,
            "tick_type_code": tick_type,
            "price": float(price) if price is not None else None,
            "size": float(size) if size is not None else None,
            "value": numeric,
            "timestamp": now,
        }

        self._publish(self._tick_channel(symbol), payload)

    # ------------------------------------------------------------------
    # Internal — Redis
    # ------------------------------------------------------------------
    @staticmethod
    def _default_redis_factory() -> Any:
        """Build a Redis client from env vars. Returns ``None`` on failure."""
        try:
            import redis  # type: ignore[import-not-found]
        except Exception as exc:
            logger.warning("redis-py not installed: %s — streaming will be no-op", exc)
            return None

        host = os.getenv("REDIS_HOST", "redis")
        port = int(os.getenv("REDIS_PORT", "6379"))
        password = os.getenv("REDIS_PASSWORD") or None
        try:
            client = redis.Redis(
                host=host,
                port=port,
                password=password,
                socket_connect_timeout=2,
                socket_timeout=2,
                health_check_interval=30,
            )
            client.ping()
            logger.info("Redis publisher connected to %s:%s", host, port)
            return client
        except Exception as exc:
            logger.warning(
                "Could not connect to Redis at %s:%s: %s — streaming will be degraded",
                host,
                port,
                exc,
            )
            return None

    def _ensure_redis(self) -> Any | None:
        if self._redis is not None:
            return self._redis
        with self._redis_lock:
            if self._redis is None:
                self._redis = self._redis_factory()
        return self._redis

    def _publish(self, channel: str, payload: dict[str, Any]) -> None:
        client = self._ensure_redis()
        if client is None:
            self.ticks_dropped += 1
            return
        try:
            client.publish(channel, json.dumps(payload, default=str))
            self.ticks_published += 1
        except Exception as exc:
            # Don't let a Redis hiccup take down the IB callback thread.
            self.ticks_dropped += 1
            logger.warning("Redis publish to %s failed: %s", channel, exc)
            # Drop the cached client; the next publish will reconnect.
            with self._redis_lock:
                self._redis = None

    def _publish_status(self, payload: dict[str, Any]) -> None:
        payload.setdefault("timestamp", self._clock())
        self._publish(STATUS_CHANNEL, payload)

    def _redis_health(self) -> dict[str, Any]:
        client = self._ensure_redis()
        if client is None:
            return {"connected": False, "host": os.getenv("REDIS_HOST", "redis")}
        try:
            ok = bool(client.ping())
        except Exception:
            ok = False
        return {
            "connected": ok,
            "host": os.getenv("REDIS_HOST", "redis"),
            "port": int(os.getenv("REDIS_PORT", "6379")),
        }

    @staticmethod
    def _tick_channel(symbol: str) -> str:
        return f"{TICK_CHANNEL_PREFIX}{symbol.upper()}"

    # ------------------------------------------------------------------
    # Internal — IB calls
    # ------------------------------------------------------------------
    def _start_ib(self, sub: Subscription, sec_type: str, exchange: str, currency: str) -> None:
        if self._ib_app is None or self._resolve_contract is None:
            raise RuntimeError("StreamingManager.attach() has not been called")

        contract = self._resolve_contract(sub.symbol, sec_type, exchange, currency)
        # IB ``reqMktData`` signature:
        #   reqMktData(reqId, contract, genericTickList, snapshot,
        #              regulatorySnapshot, mktDataOptions)
        self._ib_app.reqMktData(sub.req_id, contract, "", False, False, [])
        logger.info(
            "IB streaming subscription started: symbol=%s req_id=%s exchange=%s",
            sub.symbol,
            sub.req_id,
            exchange,
        )

    def _cancel(self, symbol: str, sub: Subscription | None = None) -> None:
        if sub is None:
            sub = self._subs.get(symbol)
        if sub is None or self._ib_app is None:
            return
        try:
            self._ib_app.cancelMktData(sub.req_id)
            logger.info(
                "IB streaming subscription cancelled: symbol=%s req_id=%s", symbol, sub.req_id
            )
        except Exception as exc:
            sub.last_error = str(exc)
            raise


def _is_nanish(value: float) -> bool:
    """IB sometimes returns +/-inf or NaN sentinel values; treat them as missing."""
    try:
        import math

        return math.isnan(value) or math.isinf(value) or value == float("-inf")
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Module-level singleton.
# ---------------------------------------------------------------------------
# Importers should use this instance rather than constructing their own so
# the FastAPI endpoints and the IBApp tick callbacks see the same state.
streaming_manager = StreamingManager()
