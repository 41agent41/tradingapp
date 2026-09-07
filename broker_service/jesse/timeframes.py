"""Timeframe vocabulary bridging Jesse's names (``'5m'``, ``'1h'``, ``'1D'``)
and the app's (``'5min'``, ``'1hour'``, ``'1day'``).

Every public function accepts either spelling, so a strategy can be written in
Jesse's dialect while the routes keep speaking the app's. The set is exactly the
timeframes the charting stack supports (``backend/src/routes/marketData/shared.ts``)
plus ``1W`` as an anchor for daily strategies.
"""

from __future__ import annotations

from .enums import timeframes as TF

# Canonical (Jesse) name -> seconds per candle.
_SECONDS: dict[str, int] = {
    TF.MINUTE_1: 60,
    TF.MINUTE_5: 5 * 60,
    TF.MINUTE_15: 15 * 60,
    TF.MINUTE_30: 30 * 60,
    TF.HOUR_1: 60 * 60,
    TF.HOUR_4: 4 * 60 * 60,
    TF.HOUR_8: 8 * 60 * 60,
    TF.DAY_1: 24 * 60 * 60,
    TF.WEEK_1: 7 * 24 * 60 * 60,
}

# Canonical name -> the app's route/DB spelling.
_TO_APP: dict[str, str] = {
    TF.MINUTE_1: "1min",
    TF.MINUTE_5: "5min",
    TF.MINUTE_15: "15min",
    TF.MINUTE_30: "30min",
    TF.HOUR_1: "1hour",
    TF.HOUR_4: "4hour",
    TF.HOUR_8: "8hour",
    TF.DAY_1: "1day",
    TF.WEEK_1: "1week",
}
_FROM_APP: dict[str, str] = {v: k for k, v in _TO_APP.items()}

# Canonical name -> pandas resample offset alias.
_TO_PANDAS: dict[str, str] = {
    TF.MINUTE_1: "1min",
    TF.MINUTE_5: "5min",
    TF.MINUTE_15: "15min",
    TF.MINUTE_30: "30min",
    TF.HOUR_1: "1h",
    TF.HOUR_4: "4h",
    TF.HOUR_8: "8h",
    TF.DAY_1: "1D",
    TF.WEEK_1: "1W",
}

# Jesse's ``anchor_timeframe`` table, restricted to the timeframes this stack
# serves. The anchor is the higher timeframe a strategy consults for trend
# context (``self.get_candles(..., anchor_timeframe(self.timeframe))``).
_ANCHOR: dict[str, str] = {
    TF.MINUTE_1: TF.MINUTE_5,
    TF.MINUTE_5: TF.MINUTE_30,
    TF.MINUTE_15: TF.HOUR_1,
    TF.MINUTE_30: TF.HOUR_4,
    TF.HOUR_1: TF.HOUR_4,
    TF.HOUR_4: TF.DAY_1,
    TF.HOUR_8: TF.DAY_1,
    TF.DAY_1: TF.WEEK_1,
}

SUPPORTED: tuple[str, ...] = tuple(_SECONDS)


class TimeframeError(ValueError):
    """Raised for a timeframe string neither dialect recognises."""


def normalize(timeframe: str) -> str:
    """Return the canonical (Jesse) spelling of ``timeframe``.

    >>> normalize('5min'), normalize('5m'), normalize('1day')
    ('5m', '5m', '1D')
    """

    if not isinstance(timeframe, str) or not timeframe:
        raise TimeframeError(f"Timeframe must be a non-empty string, got {timeframe!r}")
    if timeframe in _SECONDS:
        return timeframe
    if timeframe in _FROM_APP:
        return _FROM_APP[timeframe]
    lowered = timeframe.lower()
    # Tolerate '1d' / '1w' (Jesse is case-sensitive about 'D' and 'W').
    if lowered == "1d":
        return TF.DAY_1
    if lowered == "1w":
        return TF.WEEK_1
    raise TimeframeError(
        f"Unknown timeframe '{timeframe}'. Supported: {list(SUPPORTED)} "
        f"or the app spellings {list(_FROM_APP)}"
    )


def to_app(timeframe: str) -> str:
    """Canonical -> app spelling (``'1h'`` -> ``'1hour'``)."""

    return _TO_APP[normalize(timeframe)]


def to_pandas_offset(timeframe: str) -> str:
    return _TO_PANDAS[normalize(timeframe)]


def to_seconds(timeframe: str) -> int:
    return _SECONDS[normalize(timeframe)]


def to_milliseconds(timeframe: str) -> int:
    return to_seconds(timeframe) * 1000


def anchor(timeframe: str) -> str:
    """The higher timeframe Jesse pairs with ``timeframe`` for trend context."""

    canonical = normalize(timeframe)
    if canonical not in _ANCHOR:
        raise TimeframeError(f"'{canonical}' has no anchor timeframe (it is the largest served).")
    return _ANCHOR[canonical]


def is_higher(candidate: str, base: str) -> bool:
    """``True`` when ``candidate`` is a strictly larger timeframe than ``base``
    and an exact multiple of it — the only case a resample from ``base`` is
    exact."""

    c, b = to_seconds(candidate), to_seconds(base)
    return c > b and c % b == 0
