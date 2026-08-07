"""Position sizing for the backtest engine.

The live path resolves a strategy's abstract ``sizing`` block into a concrete
order quantity in ``backend/src/services/orderSizing.ts``. The backtester had
no equivalent — it was all-in / all-out, sinking every available currency unit
into each entry — so a definition's ``sizing`` block did nothing in backtest
and a backtest's returns could not match a live run's even when the signals
agreed exactly. That is the gap this module closes; the two implementations
are deliberately kept semantically identical:

    fixed      -> ``size`` units outright
    notional   -> floor(size / price) units
    pct_equity -> floor((size% x equity) / price) units

with a floor of one whole unit — a size that rounds below 1 is *no trade*
rather than a fractional one, matching the live path's refusal to place a
sub-minimum order.

The one deliberate difference is what happens when sizing can't be resolved.
Live, that is an abort with an auditable reason: refusing to trade is always
safe. In backtest, refusing would silently produce a zero-trade result that
looks like "the rules never fired" — the exact failure shape this whole line of
work exists to eliminate. So the caller falls back to the historical all-in
behaviour and the reason is returned for logging, rather than swallowed.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

# Broker-native units (MT5 lots, OANDA units) are rejected by the live sizer
# until their unit conversion lands. The backtester follows suit rather than
# quietly pricing a lot as if it were a share.
_UNSUPPORTED_UNITS = {"lots", "units"}


def resolve_backtest_quantity(
    sizing: Optional[Dict[str, Any]],
    price: float,
    equity: float,
) -> Tuple[Optional[int], str]:
    """Resolve a ``sizing`` block to a whole-unit quantity for one entry.

    Returns ``(quantity, reason)``. A ``None`` quantity means "this block does
    not determine a size — use the engine's default", with ``reason`` saying
    why; it is never an error the caller has to handle.
    """

    if not isinstance(sizing, dict) or not sizing:
        return None, "no sizing block"

    size = sizing.get("size")
    try:
        size = float(size)
    except (TypeError, ValueError):
        return None, f"sizing.size is not a number ({size!r})"
    if not math.isfinite(size) or size <= 0:
        # A zero size is how a definition says "unset" (it is the default the
        # rule compiler fills in), so this is the common path, not a fault.
        return None, "sizing.size is unset"

    unit = str(sizing.get("unit") or "broker_default")
    if unit in _UNSUPPORTED_UNITS:
        return None, f"sizing unit '{unit}' is not simulated (broker-native units)"

    sizing_type = str(sizing.get("type") or "fixed")

    if sizing_type == "fixed":
        quantity = size
    elif sizing_type == "notional":
        if not math.isfinite(price) or price <= 0:
            return None, "notional sizing needs a positive price"
        quantity = size / price
    elif sizing_type == "pct_equity":
        if not math.isfinite(price) or price <= 0:
            return None, "pct_equity sizing needs a positive price"
        if not math.isfinite(equity) or equity <= 0:
            return None, "pct_equity sizing needs positive equity"
        quantity = (size / 100.0) * equity / price
    else:
        return None, f"unknown sizing type '{sizing_type}'"

    whole = int(math.floor(quantity))
    if whole < 1:
        return 0, f"{sizing_type} sizing resolved to {quantity:.4f}, below the 1-unit minimum"
    return whole, f"{sizing_type} sizing"
