"""Constants shared across the Jesse framework (mirrors ``jesse.enums``).

Kept as plain classes of string constants, exactly as Jesse exposes them, so a
strategy written against the upstream framework (``from jesse.enums import
timeframes``) reads unchanged here.
"""

from __future__ import annotations


class timeframes:  # noqa: N801 (Jesse's public name)
    MINUTE_1 = "1m"
    MINUTE_5 = "5m"
    MINUTE_15 = "15m"
    MINUTE_30 = "30m"
    HOUR_1 = "1h"
    HOUR_4 = "4h"
    HOUR_8 = "8h"
    DAY_1 = "1D"
    WEEK_1 = "1W"


class sides:  # noqa: N801
    BUY = "buy"
    SELL = "sell"


class order_types:  # noqa: N801
    MARKET = "MARKET"
    LIMIT = "LIMIT"
    STOP = "STOP"


class order_statuses:  # noqa: N801
    ACTIVE = "ACTIVE"
    CANCELED = "CANCELED"
    EXECUTED = "EXECUTED"
    PARTIALLY_FILLED = "PARTIALLY FILLED"
    QUEUED = "QUEUED"
    REJECTED = "REJECTED"


class order_submitted_via:  # noqa: N801
    """Why an order exists — what the strategy asked for when it was created."""

    ENTRY = "entry"
    STOP_LOSS = "stop_loss"
    TAKE_PROFIT = "take_profit"
    LIQUIDATE = "liquidate"


class trade_types:  # noqa: N801
    LONG = "long"
    SHORT = "short"


class position_types:  # noqa: N801
    LONG = "long"
    SHORT = "short"
    CLOSE = "close"


class exchanges:  # noqa: N801
    """Venue labels. Jesse's own list is crypto-only; this port trades through
    the broker adapters the app already has."""

    IB = "Interactive Brokers"
    MT5 = "MetaTrader 5"
    ALPACA = "Alpaca"
    OANDA = "OANDA"
