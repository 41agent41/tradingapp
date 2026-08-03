"""
IB connection pool (GAP_ANALYSIS §3.3).

The default IB-service deployment uses a single ``IBApp`` instance with a
single ``clientId``. That caps concurrent IB requests at one — a slow
historical fetch starves contract lookups, the streaming worker and the
account endpoints — and means a second replica can't share an IB Gateway
because both would claim the same ``clientId``.

This module introduces an opt-in pool of IB clients, parameterised by a
``clientId`` range so each pooled slot connects with a distinct id.
Concurrent route handlers can reserve a slot via ``acquire(timeout)`` and
return it via ``release(token)``; idle slots stay connected so subsequent
requests don't pay the connection cost again.

Enable by setting ``IB_CLIENT_POOL_SIZE>=2`` in the environment. Size 1
(the default) keeps the existing single-client path intact — see
``ib_client.get_ib_connection``.
"""

from __future__ import annotations

import os
import queue
import threading
from dataclasses import dataclass
from typing import Callable, Optional

from observability import get_logger

logger = get_logger(__name__)


POOL_SIZE = int(os.getenv("IB_CLIENT_POOL_SIZE", "1"))


@dataclass
class PoolSlot:
    """One entry in the pool. ``client`` is connected lazily on first use."""

    client_id: int
    client: Optional[object] = None  # An IBApp instance, set on first connect.
    in_use: bool = False


class IBPool:
    """A bounded pool of IBApp instances keyed by ``clientId``.

    The pool is fully thread-safe. ``acquire`` blocks until a slot is
    available (or ``timeout`` elapses). ``release`` returns it. Slots are
    *not* recycled on release — the underlying IBApp connection stays open
    so subsequent acquires are cheap.
    """

    def __init__(
        self,
        size: int,
        base_client_id: int,
        connect_factory: Callable[[int], object],
    ) -> None:
        if size < 1:
            raise ValueError("pool size must be >= 1")
        self._size = size
        self._base_client_id = base_client_id
        self._connect = connect_factory
        self._lock = threading.Lock()
        # LIFO so a released slot is the next one handed out — reusing an
        # already-connected (warm) slot instead of connecting a cold one and
        # churning IB Gateway sessions. Only matters for size >= 2.
        self._free: queue.LifoQueue[int] = queue.LifoQueue()  # of slot indices
        self._slots = [PoolSlot(client_id=base_client_id + i) for i in range(size)]
        for i in range(size):
            self._free.put(i)

    @property
    def size(self) -> int:
        return self._size

    def stats(self) -> dict:
        with self._lock:
            in_use = sum(1 for s in self._slots if s.in_use)
            connected = sum(1 for s in self._slots if s.client is not None)
            return {
                "size": self._size,
                "in_use": in_use,
                "connected": connected,
                "free": self._size - in_use,
                "client_ids": [s.client_id for s in self._slots],
            }

    def acquire(self, timeout: Optional[float] = None) -> tuple[int, object]:
        """Reserve a slot. Returns ``(token, client)``.

        ``token`` is opaque — pass it to ``release()`` to free the slot.
        ``client`` is the underlying IBApp instance.

        Raises ``queue.Empty`` when no slot becomes available before
        ``timeout`` elapses.
        """
        idx = self._free.get(timeout=timeout)
        try:
            with self._lock:
                slot = self._slots[idx]
                slot.in_use = True
                if slot.client is None:
                    # Lazy connect — keeps the pool import cheap and lets
                    # uvicorn boot even when IB Gateway is unreachable.
                    slot.client = self._connect(slot.client_id)
                    logger.info(
                        "ib_pool_slot_connected",
                        slot=idx,
                        client_id=slot.client_id,
                    )
                return idx, slot.client
        except Exception:
            # Re-queue on failure so the slot doesn't leak.
            self._free.put(idx)
            raise

    def release(self, token: int) -> None:
        """Return a slot to the pool."""
        with self._lock:
            slot = self._slots[token]
            if not slot.in_use:
                logger.warning("ib_pool_double_release", slot=token)
                return
            slot.in_use = False
        self._free.put(token)

    def borrow(self, timeout: Optional[float] = None):
        """Context-manager wrapper around ``acquire`` / ``release``.

        Usage::

            with pool.borrow(timeout=5) as ib:
                ib.reqHistoricalData(...)
        """
        return _PoolBorrow(self, timeout)


class _PoolBorrow:
    def __init__(self, pool: IBPool, timeout: Optional[float]) -> None:
        self._pool = pool
        self._timeout = timeout
        self._token: Optional[int] = None
        self._client: Optional[object] = None

    def __enter__(self):
        self._token, self._client = self._pool.acquire(timeout=self._timeout)
        return self._client

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._token is not None:
            self._pool.release(self._token)
            self._token = None
            self._client = None


# ---------------------------------------------------------------------------
# Module-level pool instance — None when POOL_SIZE <= 1 (single-client path).
# ---------------------------------------------------------------------------
_pool: Optional[IBPool] = None


def get_pool() -> Optional[IBPool]:
    """Return the configured pool, or None when the pool is disabled."""
    return _pool


def configure_pool(
    connect_factory: Callable[[int], object], base_client_id: int
) -> Optional[IBPool]:
    """Initialise the module-level pool. Returns it (or None when size<=1).

    Callers (typically the FastAPI lifespan handler) should call this once
    at startup. Subsequent calls are no-ops.
    """
    global _pool
    if _pool is not None:
        return _pool
    if POOL_SIZE <= 1:
        logger.info("ib_pool_disabled", reason="IB_CLIENT_POOL_SIZE<=1")
        return None
    _pool = IBPool(size=POOL_SIZE, base_client_id=base_client_id, connect_factory=connect_factory)
    logger.info(
        "ib_pool_configured",
        size=POOL_SIZE,
        base_client_id=base_client_id,
        client_ids=[base_client_id + i for i in range(POOL_SIZE)],
    )
    return _pool
