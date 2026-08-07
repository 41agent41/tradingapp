"""Position sizing for the backtest engine.

The live path resolves a strategy's abstract ``sizing`` block into a concrete
order quantity in ``backend/src/services/orderSizing.ts``. The backtester had
no equivalent — it was all-in / all-out, sinking every available currency unit
into each entry — so a definition's ``sizing`` block did nothing in backtest
and a backtest's returns could not match a live run's even when the signals
agreed exactly. That is the gap this module closes; the two implementations
are deliberately kept semantically identical:

    fixed      -> ``size`` venue units outright
    notional   -> size / (price x contract_size) venue units
    pct_equity -> (size% x equity) / (price x contract_size) venue units

**Venue units, not shares.** A quantity of 1 means one share on IB or Alpaca,
one unit of the base currency on OANDA, and one *lot* on MT5 — which at a
standard contract size controls 100,000 units. That factor is why lot sizing
was previously refused outright rather than approximated. An
:class:`models.InstrumentSpec` supplies the three numbers that make the
conversion exact: ``contract_size`` (what one quantity unit controls),
``size_step`` (the venue's increment) and ``min_size`` (its floor). Without a
spec the shares default applies — step 1, minimum 1, contract size 1 — which
is exactly the whole-share behaviour the equity path has always had.

A resolved size is **floored** onto the step and refused below the minimum:
rounding up would place an order larger than the strategy asked for, which is
never the safe direction to err.

The one deliberate difference from the live sizer is what happens when sizing
can't be resolved. Live, that is an abort with an auditable reason: refusing to
trade is always safe. In backtest, refusing would silently produce a zero-trade
result that looks like "the rules never fired" — the exact failure shape this
whole line of work exists to eliminate. So the caller falls back to the
historical all-in behaviour and the reason is returned for logging, rather than
swallowed.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

# Applied when no instrument spec is supplied: whole shares, the unit every
# equity venue in the stack uses and the behaviour this module shipped with.
DEFAULT_SPEC: Dict[str, Any] = {
    "unit": "shares",
    "min_size": 1.0,
    "size_step": 1.0,
    "max_size": None,
    "contract_size": 1.0,
}


def _positive(spec: Dict[str, Any], key: str, fallback: float) -> float:
    try:
        value = float(spec.get(key))
    except (TypeError, ValueError):
        return fallback
    return value if math.isfinite(value) and value > 0 else fallback


def round_to_step(quantity: float, step: float) -> float:
    """Floor ``quantity`` onto a multiple of ``step``.

    Floors rather than rounds so a resolved size never grows past what the
    strategy asked for. The result is re-rounded to the step's own decimal
    precision because binary floating point turns e.g. ``0.07 / 0.01`` into
    6.999999999999999, which would floor to 0.06 — a whole step lost to
    representation error.
    """

    if step <= 0:
        return quantity
    steps = math.floor(quantity / step + 1e-9)
    decimals = max(0, -math.floor(math.log10(step))) + 2 if step < 1 else 0
    return round(steps * step, decimals)


def resolve_backtest_quantity(
    sizing: Optional[Dict[str, Any]],
    price: float,
    equity: float,
    spec: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[float], str]:
    """Resolve a ``sizing`` block to a venue-native quantity for one entry.

    Returns ``(quantity, reason)``. A ``None`` quantity means "this block does
    not determine a size — use the engine's default", with ``reason`` saying
    why; it is never an error the caller has to handle. A ``0`` means the block
    *did* resolve but to something the venue would not accept.
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

    resolved_spec = {**DEFAULT_SPEC, **(spec or {})}
    unit = str(sizing.get("unit") or "broker_default")
    venue_unit = str(resolved_spec.get("unit") or "shares")
    # A rule-set may pin a unit; if it names one the venue doesn't trade in,
    # the size means something other than what it says and is not convertible.
    if unit not in ("broker_default", venue_unit):
        return None, f"sizing unit '{unit}' does not match the venue's '{venue_unit}'"

    contract_size = _positive(resolved_spec, "contract_size", 1.0)
    step = _positive(resolved_spec, "size_step", 1.0)
    minimum = _positive(resolved_spec, "min_size", step)
    sizing_type = str(sizing.get("type") or "fixed")

    if sizing_type == "fixed":
        # Already expressed in venue units — no conversion, just conformance.
        quantity = size
    elif sizing_type == "notional":
        if not math.isfinite(price) or price <= 0:
            return None, "notional sizing needs a positive price"
        quantity = size / (price * contract_size)
    elif sizing_type == "pct_equity":
        if not math.isfinite(price) or price <= 0:
            return None, "pct_equity sizing needs a positive price"
        if not math.isfinite(equity) or equity <= 0:
            return None, "pct_equity sizing needs positive equity"
        quantity = (size / 100.0) * equity / (price * contract_size)
    else:
        return None, f"unknown sizing type '{sizing_type}'"

    maximum = resolved_spec.get("max_size")
    try:
        maximum = float(maximum) if maximum is not None else None
    except (TypeError, ValueError):
        maximum = None
    if maximum is not None and maximum > 0:
        quantity = min(quantity, maximum)

    rounded = round_to_step(quantity, step)
    if rounded < minimum:
        return (
            0,
            f"{sizing_type} sizing resolved to {quantity:.6f} {venue_unit}, "
            f"below the venue minimum of {minimum:g}",
        )
    return rounded, f"{sizing_type} sizing ({venue_unit})"
