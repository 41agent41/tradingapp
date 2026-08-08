"""Protective-stop resolution (Component E — E-2/E-3).

A strategy declares *how* its stop is derived; this turns that declaration into
a **price**, given the bars, the direction and the entry. It lives beside the
rule engine rather than in the execution layer for the reason §1 of the plan
insists on: the backtester and the live runner must compute a stop the same
way, and the only way to guarantee that is one implementation both call.

Direction is not a detail here. A long's stop sits **below** the market and a
short's **above**, and every spec below is expressed as a distance so the sign
comes from the direction rather than from whoever wrote the rule.

### Spec vocabulary

    {"type": "pct",         "pct": 1.5}          — 1.5% from the reference price
    {"type": "atr",         "multiple": 2}       — 2 × ATR from the reference price
    {"type": "bar_extreme", "lookback": 2}       — the low of the last 2 bars
                                                   (a long) / their high (a short)
    {"type": "fixed",       "distance": 0.0050}  — an absolute price distance

`bar_extreme` is the structure trail — "stop at the 2-bar low". It is the one
spec whose value is a *level* rather than a distance, and it is deliberately
computed from **closed bars only**, so it never depends on where price happens
to be mid-bar.

An optional `buffer_pct` widens any of them slightly, so a stop sits just
beyond the level rather than exactly on it, where it would be taken out by the
spread alone.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import pandas as pd

STOP_TYPES = {"pct", "atr", "bar_extreme", "fixed"}


class StopSpecError(ValueError):
    """Raised when a stop block is malformed. A strategy that declares a stop
    it cannot compute must fail to compile rather than silently trade
    unprotected."""


def validate_stop(spec: Any) -> Optional[Dict[str, Any]]:
    """Shape-check a `stop` block. Returns the normalised spec, or None when no
    stop is declared."""
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise StopSpecError("stop must be an object")

    stop_type = str(spec.get("type") or "").strip().lower()
    if stop_type not in STOP_TYPES:
        raise StopSpecError(f"Unknown stop type '{spec.get('type')}'. Valid: {sorted(STOP_TYPES)}.")

    out: Dict[str, Any] = {"type": stop_type}

    if stop_type == "pct":
        pct = _positive(spec.get("pct"), "stop.pct")
        out["pct"] = pct
    elif stop_type == "atr":
        out["multiple"] = _positive(spec.get("multiple"), "stop.multiple")
    elif stop_type == "bar_extreme":
        lookback = spec.get("lookback", 2)
        try:
            lookback_int = int(lookback)
        except (TypeError, ValueError):
            raise StopSpecError("stop.lookback must be an integer")
        if lookback_int < 1:
            raise StopSpecError("stop.lookback must be at least 1")
        out["lookback"] = lookback_int
    elif stop_type == "fixed":
        out["distance"] = _positive(spec.get("distance"), "stop.distance")

    buffer_pct = spec.get("buffer_pct")
    if buffer_pct is not None:
        out["buffer_pct"] = _positive(buffer_pct, "stop.buffer_pct")

    return out


def _positive(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise StopSpecError(f"{field} must be a number")
    if not number > 0:
        raise StopSpecError(f"{field} must be greater than 0")
    return number


def stop_indicator_requests(spec: Optional[Dict[str, Any]]) -> set[str]:
    """Indicators a stop spec needs precomputed. An ATR stop that evaluated
    against a missing column would resolve to NaN and be dropped — silently
    leaving the position unprotected — so the requirement is declared like any
    operand's."""
    if spec and spec.get("type") == "atr":
        return {"atr"}
    return set()


def resolve_stop(
    spec: Optional[Dict[str, Any]],
    bars: pd.DataFrame,
    *,
    direction: str,
    reference_price: float,
) -> Optional[float]:
    """The stop price for a position, or None when no stop is declared.

    ``direction`` is ``long`` or ``short``; ``reference_price`` is the entry
    price at placement and the current close when trailing.

    Returns None only when *no stop is declared*. A declared stop that cannot
    be computed raises, because the caller must be able to tell "no stop
    wanted" apart from "stop wanted but unavailable" — treating the second as
    the first is how a position ends up unprotected.
    """
    if spec is None:
        return None
    if bars is None or len(bars) == 0:
        raise StopSpecError("cannot resolve a stop without bars")

    long_side = direction == "long"
    last = bars.iloc[-1]
    stop_type = spec["type"]

    if stop_type == "pct":
        distance = reference_price * spec["pct"] / 100.0
        price = reference_price - distance if long_side else reference_price + distance
    elif stop_type == "atr":
        atr = float(last.get("atr", float("nan")))
        if not pd.notna(atr) or atr <= 0:
            raise StopSpecError(
                "stop.type='atr' but no usable ATR on the latest bar — the indicator is "
                "missing or still in its warmup window"
            )
        distance = atr * spec["multiple"]
        price = reference_price - distance if long_side else reference_price + distance
    elif stop_type == "bar_extreme":
        lookback = spec["lookback"]
        window = bars.iloc[-lookback:] if len(bars) >= lookback else bars
        column = "low" if long_side else "high"
        if column not in window:
            raise StopSpecError(f"stop.type='bar_extreme' needs a '{column}' column")
        level = float(window[column].min() if long_side else window[column].max())
        if not pd.notna(level):
            raise StopSpecError("stop.type='bar_extreme' resolved to a non-finite level")
        price = level
    else:  # fixed
        distance = spec["distance"]
        price = reference_price - distance if long_side else reference_price + distance

    buffer_pct = spec.get("buffer_pct")
    if buffer_pct:
        buffer = price * buffer_pct / 100.0
        # Widen away from the market: a stop sitting exactly on a level gets
        # taken out by the spread alone.
        price = price - buffer if long_side else price + buffer

    if not pd.notna(price) or price <= 0:
        raise StopSpecError("stop resolved to a non-positive price")

    # A stop on the wrong side of the market would trigger instantly. That is
    # a strategy bug — a 2-bar low above the current price means the rule and
    # the market disagree — and triggering instantly is worse than refusing.
    if long_side and price >= reference_price:
        raise StopSpecError(
            f"long stop {price:.5f} is at or above the reference price {reference_price:.5f}"
        )
    if not long_side and price <= reference_price:
        raise StopSpecError(
            f"short stop {price:.5f} is at or below the reference price {reference_price:.5f}"
        )

    return float(price)


def is_more_protective(new_stop: float, current_stop: Optional[float], direction: str) -> bool:
    """Whether ``new_stop`` tightens the position's protection (E-3's ratchet).

    With the stop held at the broker, "never move the stop backwards" is this
    comparison rather than carried state: the app issues a modify only when the
    answer is True, so the broker holds the high-water mark on our behalf.
    """
    if current_stop is None:
        return True
    return new_stop > current_stop if direction == "long" else new_stop < current_stop
