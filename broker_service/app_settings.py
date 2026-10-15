"""Settings the backend manages on its Settings page and sends here.

The broker service has no database, so the backend includes these in the same
``PUT /connections/managed`` push that carries the app's connections (see
managed.py). ``.env`` still wins, setting by setting, exactly as it does on the
backend.

Until the first push arrives the service knows only ``.env``, so a live order
is refused until the backend has said live trading is on: a stale or missing
copy fails closed.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

# The settings the backend sends. Anything else in the payload is ignored.
KEYS = (
    "LIVE_TRADING_ENABLED",
    "DEFAULT_BROKER",
    "PORTFOLIO_BASE_CURRENCY",
    "ORDER_PLACE_WAIT_SECONDS",
    "BROKER_PROBE_INTERVAL_SECONDS",
    "STREAM_POLL_SECONDS",
)

_values: Dict[str, str] = {}


def apply(values: Optional[Dict[str, Any]]) -> None:
    """Replace the backend's values. A key it leaves out is unset."""
    global _values
    _values = {
        k: str(v).strip()
        for k, v in (values or {}).items()
        if k in KEYS and v is not None and str(v).strip()
    }


def reset() -> None:
    """Forget the backend's values. Test-only."""
    apply(None)


def get(name: str) -> Optional[str]:
    """``.env`` when set there, else the value the backend sent, else None."""
    env = (os.getenv(name) or "").strip()
    if env:
        return env
    return _values.get(name)


def live_trading_enabled() -> bool:
    return (get("LIVE_TRADING_ENABLED") or "false").lower() == "true"


def order_place_wait_seconds() -> int:
    try:
        return max(0, int(get("ORDER_PLACE_WAIT_SECONDS") or "3"))
    except ValueError:
        return 3


def probe_interval_seconds() -> int:
    """How often every connection is probed; 0 turns probing off."""
    try:
        return max(0, int(get("BROKER_PROBE_INTERVAL_SECONDS") or "60"))
    except ValueError:
        return 60


def stream_poll_seconds() -> float:
    """How often a venue without a price stream is polled for prices."""
    try:
        value = float(get("STREAM_POLL_SECONDS") or "2")
    except ValueError:
        return 2.0
    return value if value > 0 else 2.0
