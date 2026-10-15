"""Broker connectivity checks, run inside the app.

Deploy no longer tests any broker: a broker that is down must not fail a
deploy, and only the running service knows which connections exist. Instead
every configured connection is probed here, on a timer and on demand, with
its adapter's ``probe()`` (the cheapest authenticated call that venue offers).
The last result per connection is kept in memory and reported on ``/health``
and ``/connections/status``, which the backend turns into the header badge,
the Settings page Test buttons and the heartbeat.

A probe never raises: an exception is the result, recorded as ``unreachable``
with its message.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any, Dict, Optional

import app_settings
from observability import get_logger

logger = get_logger(__name__)

# While probing is paused (interval 0), how often to look whether it was
# turned back on. On-demand tests work either way.
_PAUSED_RECHECK_SECONDS = 60

CONNECTED = "connected"
UNREACHABLE = "unreachable"

_results: Dict[str, Dict[str, Any]] = {}


def _error_text(exc: BaseException) -> str:
    detail = getattr(exc, "detail", None)
    return str(detail if detail is not None else exc)[:300] or type(exc).__name__


def probe_connection(conn: Any) -> Dict[str, Any]:
    """Probe one connection and record the result under its label."""
    from adapters import get_market_data_adapter

    started = time.monotonic()
    try:
        # The market-data side is always the platform's own adapter; the broker
        # side may be a split-account wrapper reading another connection.
        get_market_data_adapter(conn.platform, conn.account).probe()
        status, error = CONNECTED, None
    except Exception as exc:  # noqa: BLE001 — every failure is a result
        status, error = UNREACHABLE, _error_text(exc)
    result = {
        "status": status,
        "error": error,
        "latency_ms": round((time.monotonic() - started) * 1000),
        "checked_at": datetime.now(UTC).isoformat(),
    }
    previous = _results.get(conn.label, {}).get("status")
    _results[conn.label] = result
    if previous != status:
        log = logger.info if status == CONNECTED else logger.warning
        log("broker_connection_status", connection=conn.label, status=status, error=error)
    return result


def probe_all() -> Dict[str, Dict[str, Any]]:
    """Probe every registered connection concurrently. Returns all results."""
    from adapters import list_connections

    try:
        connections = list_connections()
    except Exception as exc:  # noqa: BLE001 — a broken manifest shows on /health
        logger.error("broker_probe_list_failed", error=_error_text(exc))
        return dict(_results)
    labels = {c.label for c in connections}
    for stale in [label for label in _results if label not in labels]:
        _results.pop(stale, None)
    if connections:
        with ThreadPoolExecutor(max_workers=min(8, len(connections))) as pool:
            list(pool.map(probe_connection, connections))
    return dict(_results)


def result_for(label: str) -> Optional[Dict[str, Any]]:
    return _results.get(label)


def reset() -> None:
    """Forget every result. Test-only."""
    _results.clear()


async def probe_loop() -> None:
    """Probe every connection now and then every BROKER_PROBE_INTERVAL_SECONDS.

    The interval is read on every pass, so a change on the Settings page takes
    effect after the current wait. 0 pauses probing (checked once a minute).
    """
    while True:
        interval = app_settings.probe_interval_seconds()
        if interval > 0:
            try:
                await asyncio.to_thread(probe_all)
            except Exception as exc:  # noqa: BLE001 — the loop must survive
                logger.error("broker_probe_loop_error", error=_error_text(exc))
        await asyncio.sleep(interval or _PAUSED_RECHECK_SECONDS)
