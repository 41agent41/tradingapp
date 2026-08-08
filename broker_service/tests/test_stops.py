"""Tests for protective-stop resolution (Component E — E-2/E-3).

Direction is the theme. A long's stop sits below the market and a short's
above, and getting that backwards produces a stop that triggers the instant it
is placed — so the cases below check the sign on every spec type, and check
that a stop landing on the wrong side is refused rather than sent.
"""

from __future__ import annotations

import pandas as pd
import pytest

from stops import StopSpecError, is_more_protective, resolve_stop, validate_stop


def bars(closes, lows=None, highs=None, atr=None):
    n = len(closes)
    frame = {
        "open": closes,
        "high": highs or [c + 1 for c in closes],
        "low": lows or [c - 1 for c in closes],
        "close": closes,
        "volume": [100] * n,
    }
    if atr is not None:
        frame["atr"] = atr
    return pd.DataFrame(frame)


# --------------------------------------------------------------------------- #
# Direction
# --------------------------------------------------------------------------- #
def test_pct_stop_sits_below_a_long_and_above_a_short():
    spec = validate_stop({"type": "pct", "pct": 1})
    frame = bars([100.0, 100.0])

    long_stop = resolve_stop(spec, frame, direction="long", reference_price=100.0)
    short_stop = resolve_stop(spec, frame, direction="short", reference_price=100.0)

    assert long_stop == pytest.approx(99.0)
    assert short_stop == pytest.approx(101.0)


def test_atr_stop_scales_with_volatility_and_respects_direction():
    spec = validate_stop({"type": "atr", "multiple": 2})
    frame = bars([100.0, 100.0], atr=[1.5, 1.5])

    assert resolve_stop(spec, frame, direction="long", reference_price=100.0) == pytest.approx(97.0)
    assert resolve_stop(spec, frame, direction="short", reference_price=100.0) == pytest.approx(
        103.0
    )


def test_bar_extreme_uses_the_low_for_a_long_and_the_high_for_a_short():
    # The structure trail: "stop at the 2-bar low".
    spec = validate_stop({"type": "bar_extreme", "lookback": 2})
    frame = bars([100.0, 101.0, 102.0], lows=[95.0, 96.0, 97.0], highs=[105.0, 106.0, 107.0])

    # Only the last two bars count, so the 95 low is out of the window.
    assert resolve_stop(spec, frame, direction="long", reference_price=102.0) == pytest.approx(96.0)
    assert resolve_stop(spec, frame, direction="short", reference_price=94.0) == pytest.approx(
        107.0
    )


def test_fixed_distance_respects_direction():
    spec = validate_stop({"type": "fixed", "distance": 0.005})
    frame = bars([1.1, 1.1])
    assert resolve_stop(spec, frame, direction="long", reference_price=1.1) == pytest.approx(1.095)
    assert resolve_stop(spec, frame, direction="short", reference_price=1.1) == pytest.approx(1.105)


def test_buffer_widens_away_from_the_market_not_towards_it():
    # A stop sitting exactly on a level is taken out by the spread alone.
    spec = validate_stop({"type": "bar_extreme", "lookback": 1, "buffer_pct": 1})
    frame = bars([100.0], lows=[99.0], highs=[101.0])

    long_stop = resolve_stop(spec, frame, direction="long", reference_price=100.0)
    assert long_stop < 99.0


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #
def test_a_stop_on_the_wrong_side_is_refused():
    # A 2-bar low *above* the current price means the rule and the market
    # disagree; placing it would trigger instantly.
    spec = validate_stop({"type": "bar_extreme", "lookback": 1})
    frame = bars([100.0], lows=[105.0], highs=[110.0])

    with pytest.raises(StopSpecError, match="at or above"):
        resolve_stop(spec, frame, direction="long", reference_price=100.0)


def test_an_atr_stop_without_a_usable_atr_raises_rather_than_returning_none():
    # None means "no stop declared". Returning it here would place the
    # position unprotected while the caller believed a stop was set.
    spec = validate_stop({"type": "atr", "multiple": 2})
    frame = bars([100.0, 100.0])  # no atr column

    with pytest.raises(StopSpecError, match="ATR"):
        resolve_stop(spec, frame, direction="long", reference_price=100.0)


def test_no_stop_declared_returns_none():
    assert resolve_stop(None, bars([100.0]), direction="long", reference_price=100.0) is None
    assert validate_stop(None) is None


@pytest.mark.parametrize(
    "spec",
    [
        {"type": "trailing_magic"},
        {"type": "pct", "pct": 0},
        {"type": "pct", "pct": -1},
        {"type": "atr", "multiple": "wide"},
        {"type": "bar_extreme", "lookback": 0},
        {"type": "fixed"},
    ],
)
def test_malformed_specs_fail_to_compile(spec):
    with pytest.raises(StopSpecError):
        validate_stop(spec)


# --------------------------------------------------------------------------- #
# The ratchet (E-3)
# --------------------------------------------------------------------------- #
def test_a_long_stop_only_ratchets_upward():
    assert is_more_protective(99.0, 98.0, "long") is True
    assert is_more_protective(97.0, 98.0, "long") is False
    assert is_more_protective(98.0, 98.0, "long") is False


def test_a_short_stop_only_ratchets_downward():
    assert is_more_protective(101.0, 102.0, "short") is True
    assert is_more_protective(103.0, 102.0, "short") is False


def test_any_stop_is_more_protective_than_none():
    assert is_more_protective(99.0, None, "long") is True
    assert is_more_protective(101.0, None, "short") is True
