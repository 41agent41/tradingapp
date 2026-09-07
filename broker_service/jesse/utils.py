"""Strategy-author utilities (``from jesse import utils``).

Sizing helpers convert between *position size* (currency) and *quantity*
(units — shares here, contracts/lots elsewhere), and turn a percentage risk of
capital plus a stop distance into a quantity. ``crossed`` is the idiomatic way
to detect an indicator crossover on the newest candle.

Function names and argument orders follow upstream Jesse so strategies port
unchanged.
"""

from __future__ import annotations

import math
from typing import Sequence, Union

import numpy as np
import pandas as pd

from . import candles as C
from . import timeframes as tf

Number = Union[int, float]


# --------------------------------------------------------------------------- #
# Float hygiene
# --------------------------------------------------------------------------- #


def floor_with_precision(num: float, precision: int = 0) -> float:
    """Floor ``num`` to ``precision`` decimals (never rounds a quantity *up*)."""

    if precision < 0:
        raise ValueError("precision must be >= 0")
    factor = 10**precision
    return math.floor(num * factor + 1e-9) / factor


def round_price_for_live_mode(price: float, precision: int = 2) -> float:
    return round(float(price), precision)


def sum_floats(float1: float, float2: float) -> float:
    return round(float1 + float2, 10)


def subtract_floats(float1: float, float2: float) -> float:
    return round(float1 - float2, 10)


# --------------------------------------------------------------------------- #
# Sizing
# --------------------------------------------------------------------------- #


def size_to_qty(
    position_size: float, price: float, precision: int = 3, fee_rate: float = 0
) -> float:
    """Currency amount -> quantity at ``price``.

    ``fee_rate`` reserves headroom for the round-trip fees (Jesse budgets three
    fee legs) so a "spend my whole balance" size does not overdraw.
    """

    if math.isnan(position_size) or math.isnan(price):
        raise TypeError("size_to_qty() received NaN input")
    if price <= 0:
        raise ValueError("price must be positive")
    if fee_rate:
        position_size *= 1 - fee_rate * 3
    return floor_with_precision(position_size / price, precision)


def qty_to_size(qty: float, price: float) -> float:
    """Quantity at ``price`` -> currency amount."""

    if math.isnan(qty) or math.isnan(price):
        raise TypeError("qty_to_size() received NaN input")
    return qty * price


def risk_to_size(
    capital_size: float, risk_percentage: float, risk_per_qty: float, entry_price: float
) -> float:
    """Position size (currency) such that a move of ``risk_per_qty`` against
    the entry loses ``risk_percentage`` percent of ``capital_size``.

    Capped at ``capital_size`` — you cannot deploy more than you have without
    leverage, which sizing does not assume."""

    if risk_per_qty <= 0:
        raise ValueError("risk_per_qty must be positive (entry and stop cannot coincide)")
    if capital_size <= 0 or entry_price <= 0:
        raise ValueError("capital_size and entry_price must be positive")
    risk_amount = capital_size * (risk_percentage / 100.0)
    qty = risk_amount / risk_per_qty
    size = qty * entry_price
    return min(size, capital_size)


def risk_to_qty(
    capital: float,
    risk_per_capital: float,
    entry_price: float,
    stop_loss_price: float,
    precision: int = 3,
    fee_rate: float = 0,
) -> float:
    """Quantity to buy/sell so a stop at ``stop_loss_price`` risks
    ``risk_per_capital`` percent of ``capital``.

    >>> risk_to_qty(10_000, 1, 100, 98)    # risk $100 over a $2 stop -> 50 units
    50.0
    """

    risk_per_qty = abs(entry_price - stop_loss_price)
    size = risk_to_size(capital, risk_per_capital, risk_per_qty, entry_price)
    return size_to_qty(size, entry_price, precision=precision, fee_rate=fee_rate)


def estimate_risk(entry_price: float, stop_price: float) -> float:
    """Absolute price distance between entry and stop."""

    return abs(entry_price - stop_price)


def limit_stop_loss(
    entry_price: float, stop_price: float, trade_type: str, max_allowed_risk_percentage: float
) -> float:
    """Clamp a stop so it never risks more than ``max_allowed_risk_percentage``
    of the entry price. ``trade_type`` is ``'long'`` or ``'short'``."""

    risk = abs(entry_price - stop_price)
    max_allowed_risk = entry_price * (max_allowed_risk_percentage / 100.0)
    risk = min(risk, max_allowed_risk)
    if trade_type == "long":
        return entry_price - risk
    if trade_type == "short":
        return entry_price + risk
    raise ValueError("trade_type must be 'long' or 'short'")


def kelly_criterion(win_rate: float, ratio_avg_win_loss: float) -> float:
    """Kelly fraction from win rate (0-1) and average-win / average-loss."""

    if ratio_avg_win_loss <= 0:
        return 0.0
    return win_rate - (1 - win_rate) / ratio_avg_win_loss


# --------------------------------------------------------------------------- #
# Series helpers
# --------------------------------------------------------------------------- #


def _as_array(values) -> np.ndarray:
    if np.isscalar(values):
        return np.asarray([float(values)])
    return np.asarray(values, dtype="float64")


def crossed(
    series1: Union[np.ndarray, Sequence[float]],
    series2: Union[np.ndarray, Sequence[float], Number],
    direction: str | None = None,
    sequential: bool = False,
):
    """Did ``series1`` cross ``series2`` on the newest value?

    ``series2`` may be a scalar (a level) or a series. ``direction`` is
    ``'above'``, ``'below'`` or ``None`` (either). With ``sequential=True`` a
    boolean array is returned, one flag per candle.

    >>> crossed([1, 2, 3], 2.5, 'above')
    True
    """

    s1 = _as_array(series1)
    if np.isscalar(series2):
        s2 = np.full(len(s1), float(series2))
    else:
        s2 = _as_array(series2)
        if len(s2) != len(s1):
            # Align on the tail (the newest values), as Jesse does.
            n = min(len(s1), len(s2))
            s1, s2 = s1[-n:], s2[-n:]

    if len(s1) < 2:
        return np.zeros(len(s1), dtype=bool) if sequential else False

    above = (s1[1:] > s2[1:]) & (s1[:-1] <= s2[:-1])
    below = (s1[1:] < s2[1:]) & (s1[:-1] >= s2[:-1])
    if direction == "above":
        flags = above
    elif direction == "below":
        flags = below
    elif direction is None:
        flags = above | below
    else:
        raise ValueError("direction must be 'above', 'below' or None")
    flags = np.concatenate([[False], flags])
    return flags if sequential else bool(flags[-1])


def strictly_increasing(series, lookback: int) -> bool:
    values = _as_array(series)[-lookback:]
    return bool(len(values) >= 2 and np.all(np.diff(values) > 0))


def strictly_decreasing(series, lookback: int) -> bool:
    values = _as_array(series)[-lookback:]
    return bool(len(values) >= 2 and np.all(np.diff(values) < 0))


def streaks(series, use_diff: bool = True) -> np.ndarray:
    """Run lengths of consecutive ups (+n) / downs (-n)."""

    values = _as_array(series)
    if use_diff:
        values = np.diff(values)
    out = np.zeros(len(values))
    run = 0
    for i, v in enumerate(values):
        if v > 0:
            run = run + 1 if run > 0 else 1
        elif v < 0:
            run = run - 1 if run < 0 else -1
        else:
            run = 0
        out[i] = run
    return out


def prices_to_returns(price_series) -> np.ndarray:
    """Percent returns, ``NaN`` for the first element."""

    values = _as_array(price_series)
    out = np.full(len(values), np.nan)
    if len(values) > 1:
        out[1:] = (values[1:] - values[:-1]) / values[:-1] * 100.0
    return out


def z_score(series) -> np.ndarray:
    values = _as_array(series)
    std = values.std()
    if std == 0:
        return np.zeros(len(values))
    return (values - values.mean()) / std


# --------------------------------------------------------------------------- #
# Candle / timeframe helpers
# --------------------------------------------------------------------------- #


def anchor_timeframe(timeframe: str) -> str:
    """The higher timeframe Jesse pairs with ``timeframe`` (``'5m'`` -> ``'30m'``)."""

    return tf.anchor(timeframe)


def numpy_candles_to_dataframe(
    candles: np.ndarray,
    name_date: str = "date",
    name_open: str = "open",
    name_high: str = "high",
    name_low: str = "low",
    name_close: str = "close",
    name_volume: str = "volume",
) -> pd.DataFrame:
    """Jesse candle array -> a DataFrame indexed by ``name_date`` (UTC)."""

    C.validate(candles)
    df = pd.DataFrame(
        {
            name_date: pd.to_datetime(candles[:, C.TIMESTAMP], unit="ms"),
            name_open: candles[:, C.OPEN],
            name_high: candles[:, C.HIGH],
            name_low: candles[:, C.LOW],
            name_close: candles[:, C.CLOSE],
            name_volume: candles[:, C.VOLUME],
        }
    )
    return df.set_index(name_date)


def dataframe_to_numpy_candles(df: pd.DataFrame) -> np.ndarray:
    return C.from_dataframe(df)
