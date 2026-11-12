"""What each broker connection supports (E-19).

The brokers differ: one serves 8-hour bars and another does not, one streams
prices and another is polled, one takes a stop-limit order and another has
none. Before this the app offered the same choices on every connection and
the broker refused the ones it could not do. Here each connection reports what
it supports, read from its adapter, so the app can offer only that.

An adapter declares what cannot be seen from its methods as class attributes:

- ``timeframes``: the bar timeframes its history serves;
- ``order_tifs``: each order type it takes, with the times in force that
  order type accepts;
- ``spread_bars``: its bars carry the bid-to-ask spread (E-15);
- ``streams_bars``: its price stream also carries its own 1-minute bars (E-12);
- ``live_prices``: only where prices do not come through ``stream_prices``
  or ``tick`` (IB streams through its own socket).

The rest is read from the methods the adapter has, the same way the streaming
supervisors decide what to run: ``stream_prices``, ``stream_fills`` and
``stream_trade_events``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Bars every broker's history serves; an adapter with more or fewer says so.
STANDARD_TIMEFRAMES = ("1min", "5min", "15min", "30min", "1hour", "4hour", "1day")
ALL_TIFS = ("DAY", "GTC", "IOC", "FOK")
# Every order type with every time in force: what the app offered everywhere
# before connections reported their own.
STANDARD_ORDER_TIFS: Dict[str, tuple[str, ...]] = {
    "MKT": ALL_TIFS,
    "LMT": ALL_TIFS,
    "STP": ALL_TIFS,
    "STP_LMT": ALL_TIFS,
}

# The order the app lists them in.
_TIMEFRAME_ORDER = ("tick", "1min", "5min", "15min", "30min", "1hour", "4hour", "8hour", "1day")
_ORDER_TYPE_ORDER = ("MKT", "LMT", "STP", "STP_LMT")


def _ordered(values: Any, order: tuple[str, ...]) -> List[str]:
    found = [str(v) for v in values]
    return [v for v in order if v in found] + sorted(v for v in found if v not in order)


def _live_prices(adapter: Any) -> Optional[str]:
    declared = getattr(adapter, "live_prices", None)
    if isinstance(declared, str):
        return declared
    if hasattr(adapter, "stream_prices"):
        return "stream"
    return "poll" if hasattr(adapter, "tick") else None


def _fills(adapter: Any) -> str:
    """How the app learns of a fill: the fill itself is pushed (``stream``),
    a push says something traded and the app then reads the fills
    (``signal``), or the app reads them on a timer (``poll``)."""
    if hasattr(adapter, "stream_fills"):
        return "stream"
    return "signal" if hasattr(adapter, "stream_trade_events") else "poll"


def capabilities(market_data: Any = None, broker: Any = None) -> Dict[str, Any]:
    """What one connection supports, from its two adapters (either may be
    missing: a connection can be data only or trading only)."""
    order_tifs = getattr(broker, "order_tifs", STANDARD_ORDER_TIFS) if broker is not None else {}
    return {
        "market_data": market_data is not None,
        "trading": broker is not None,
        # Bar timeframes the connection's history serves.
        "timeframes": (
            _ordered(getattr(market_data, "timeframes", STANDARD_TIMEFRAMES), _TIMEFRAME_ORDER)
            if market_data is not None
            else []
        ),
        # "stream", "poll", or None when the connection has no prices.
        "live_prices": _live_prices(market_data) if market_data is not None else None,
        # Its bars carry the broker's spread, so backtests can use it.
        "spread_bars": bool(getattr(market_data, "spread_bars", False)),
        # It publishes its own live 1-minute bars, which the recorder stores
        # in place of the ones it builds from quotes.
        "live_bars": bool(getattr(market_data, "streams_bars", False)),
        # It publishes an order book (GET /market-data/depth).
        "depth": market_data is not None and hasattr(market_data, "market_depth"),
        # Each order type it takes, with the times in force that type accepts.
        "order_types": {
            kind: [t for t in ALL_TIFS if t in order_tifs[kind]]
            for kind in _ordered(order_tifs, _ORDER_TYPE_ORDER)
        },
        # A stop and target can be attached to the entry order.
        "attaches_stops": bool(getattr(broker, "attaches_stops", False)),
        # "stream", "signal" or "poll"; None when the connection cannot trade.
        "fills": _fills(broker) if broker is not None else None,
    }
