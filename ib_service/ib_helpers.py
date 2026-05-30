"""
Stateless helpers used across the IB service.

Includes account-mode flags, timeframe / period conversion to the IB-side
strings, contract factory and the symbol-discovery cache.

Extracted from main.py during the GAP_ANALYSIS §3.4 module split.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from ibapi.contract import Contract

from observability import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Account mode → market-data type
# ---------------------------------------------------------------------------
def get_data_type_for_account_mode(account_mode: str = "paper") -> str:
    """Determine data type based on account mode."""
    if account_mode.lower() == "live":
        return "real-time"
    return "delayed"  # Default to delayed for paper trading


def get_market_data_source(account_mode: str = "paper") -> str:
    """Get market data source description based on account mode."""
    if account_mode.lower() == "live":
        return "Live Market Data (Real-time)"
    return "Paper Trading Data (Delayed 15-20 min)"


# ---------------------------------------------------------------------------
# Timeframe / period conversion
# ---------------------------------------------------------------------------
_TIMEFRAME_MAP = {
    "tick": "1 secs",  # Tick data — use 1 second as closest approximation
    "1min": "1 min",
    "5min": "5 mins",
    "15min": "15 mins",
    "30min": "30 mins",
    "1hour": "1 hour",
    "4hour": "4 hours",
    "8hour": "8 hours",
    "1day": "1 day",
}

_PERIOD_MAP = {
    "1D": "1 D",
    "1W": "1 W",
    "1M": "1 M",
    "3M": "3 M",
    "6M": "6 M",
    "1Y": "1 Y",
}


def convert_timeframe(timeframe: str) -> str:
    """Convert timeframe to IB format."""
    return _TIMEFRAME_MAP.get(timeframe, "1 hour")


def convert_period(period: str) -> str:
    """Convert period to IB format (integer{SPACE}unit)."""
    return _PERIOD_MAP.get(period, "1 Y")


# ---------------------------------------------------------------------------
# Contract factory
# ---------------------------------------------------------------------------
def create_contract(
    symbol: str,
    sec_type: str = "STK",
    exchange: str = "SMART",
    currency: str = "USD",
) -> Contract:
    """Create IB contract using TWS API."""
    contract = Contract()
    contract.symbol = symbol.upper()
    contract.secType = sec_type
    contract.exchange = exchange
    contract.currency = currency
    return contract


# ---------------------------------------------------------------------------
# Symbol-discovery cache
# ---------------------------------------------------------------------------
# Module-level cache state — kept here (rather than in ib_state.py) because
# only ib_helpers manipulates it and the routes touch it solely through the
# four public helpers below.
_CACHE_TTL_SECONDS = 3600  # 1 hour
_MAX_CACHE_SIZE = 10_000
_symbol_cache: Dict[str, Dict[str, Any]] = {}


def get_cache_key(pattern: str, sec_type: str, exchange: str, currency: str) -> str:
    """Generate cache key for symbol search."""
    return f"{pattern.upper()}:{sec_type}:{exchange}:{currency}"


def is_cache_valid(cache_entry: dict) -> bool:
    """Check if cache entry is still valid."""
    if not cache_entry:
        return False
    return (time.time() - cache_entry.get("timestamp", 0)) < _CACHE_TTL_SECONDS


def get_cached_symbols(cache_key: str) -> Optional[List[Dict]]:
    """Get symbols from cache if valid, else None."""
    if cache_key in _symbol_cache:
        cache_entry = _symbol_cache[cache_key]
        if is_cache_valid(cache_entry):
            logger.info("symbol_cache hit", cache_key=cache_key)
            return cache_entry["data"]
        # Drop the expired entry so we don't keep returning to it.
        del _symbol_cache[cache_key]
        logger.info("symbol_cache expired", cache_key=cache_key)
    return None


def cache_symbols(cache_key: str, data: List[Dict]) -> None:
    """Cache symbol search results, with a simple LRU eviction."""
    if len(_symbol_cache) >= _MAX_CACHE_SIZE:
        # Remove 10% of the oldest entries.
        sorted_cache = sorted(_symbol_cache.items(), key=lambda x: x[1]["timestamp"])
        for i in range(len(sorted_cache) // 10):
            del _symbol_cache[sorted_cache[i][0]]

    _symbol_cache[cache_key] = {"data": data, "timestamp": time.time()}
    logger.info("symbol_cache store", cache_key=cache_key, count=len(data))


def get_cache_stats() -> Dict[str, Any]:
    """Return aggregate cache statistics for /symbols/cache/stats."""
    valid = sum(1 for entry in _symbol_cache.values() if is_cache_valid(entry))
    return {
        "size": len(_symbol_cache),
        "max_size": _MAX_CACHE_SIZE,
        "ttl_seconds": _CACHE_TTL_SECONDS,
        "valid_entries": valid,
        "expired_entries": len(_symbol_cache) - valid,
    }


def clear_symbol_cache() -> int:
    """Drop every entry. Returns the number of removed rows."""
    n = len(_symbol_cache)
    _symbol_cache.clear()
    return n
