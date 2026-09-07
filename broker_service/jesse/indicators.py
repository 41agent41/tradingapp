"""Technical indicators with Jesse's calling convention (``import jesse.indicators as ta``).

Every function takes a Jesse candle array (``[timestamp, open, close, high, low,
volume]``), a ``period``, an optional ``source_type`` and a ``sequential`` flag:

    ta.sma(self.candles, 20)                    # -> float, the newest value
    ta.sma(self.candles, 20, sequential=True)   # -> np.ndarray, one value per candle
    ta.ema(self.candles, 9, source_type="hlc3")

Multi-output indicators return a ``namedtuple`` (``ta.macd(...).signal``,
``ta.bollinger_bands(...).upperband``) exactly as upstream Jesse does.

Numerics follow TA-Lib, which is what Jesse wraps: warm-up values are ``NaN``,
Wilder smoothing for RSI/ATR/ADX, EMA seeded with the first value. A strategy
should therefore expect ``NaN`` until ``period`` candles exist — the backtester
gives strategies warm-up candles for exactly this reason.

Pure ``numpy``/``pandas`` — no TA-Lib or numba build dependency, so the module
runs anywhere the broker service already runs.
"""

from __future__ import annotations

import functools
import inspect
from collections import namedtuple
from typing import Union

import numpy as np
import pandas as pd

from . import candles as C

Source = Union[np.ndarray, str]


def _memoize(fn):
    """Compute once over the full candle history, serve prefixes by slicing.

    Only kicks in when ``candles`` is a leading slice of a :class:`CandleArray`
    (what ``Strategy.candles`` / ``get_candles`` return). Any other input —
    a plain array, a tail slice, a derived series — is computed directly.
    """

    signature = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(candles, *args, **kwargs):
        root = C.prefix_root(candles) if isinstance(candles, np.ndarray) else None
        if root is None:
            return fn(candles, *args, **kwargs)
        bound = signature.bind(candles, *args, **kwargs)
        bound.apply_defaults()
        params = dict(bound.arguments)
        params.pop("candles", None)
        sequential = bool(params.pop("sequential", False))
        try:
            key = (fn.__name__, tuple(sorted(params.items())))
            hash(key)
        except TypeError:
            return fn(candles, *args, **kwargs)
        cache = root._jesse_cache
        full = cache.get(key)
        if full is None:
            full = fn(np.asarray(root), **params, sequential=True)
            cache[key] = full
        n = len(candles)
        if isinstance(full, tuple):
            return type(full)(*[_out(part[:n], sequential) for part in full])
        return _out(full[:n], sequential)

    return wrapper


MACD = namedtuple("MACD", ["macd", "signal", "hist"])
BollingerBands = namedtuple("BollingerBands", ["upperband", "middleband", "lowerband"])
KeltnerChannel = namedtuple("KeltnerChannel", ["upperband", "middleband", "lowerband"])
DonchianChannel = namedtuple("DonchianChannel", ["upperband", "middleband", "lowerband"])
Stochastic = namedtuple("Stochastic", ["k", "d"])
DI = namedtuple("DI", ["plus", "minus"])
SuperTrend = namedtuple("SuperTrend", ["trend", "changed"])
AroonResult = namedtuple("Aroon", ["down", "up"])


# --------------------------------------------------------------------------- #
# Source selection
# --------------------------------------------------------------------------- #


def get_candle_source(candles: np.ndarray, source_type: str = "close") -> np.ndarray:
    """Select a price series from a candle array (Jesse's ``source_type`` names).

    A 1-D array is treated as an already-extracted series and returned as-is,
    so indicators compose (``ta.ema(ta.rsi(candles, sequential=True), 9)``).
    """

    if candles.ndim == 1:
        return candles.astype("float64", copy=False)
    if candles.ndim != 2 or candles.shape[1] < 6:
        raise ValueError("Expected a candle array of shape (n, 6) or a 1-D series.")

    if source_type == "close":
        return candles[:, C.CLOSE]
    if source_type == "open":
        return candles[:, C.OPEN]
    if source_type == "high":
        return candles[:, C.HIGH]
    if source_type == "low":
        return candles[:, C.LOW]
    if source_type == "volume":
        return candles[:, C.VOLUME]
    if source_type == "hl2":
        return (candles[:, C.HIGH] + candles[:, C.LOW]) / 2
    if source_type == "hlc3":
        return (candles[:, C.HIGH] + candles[:, C.LOW] + candles[:, C.CLOSE]) / 3
    if source_type == "ohlc4":
        return (
            candles[:, C.OPEN] + candles[:, C.HIGH] + candles[:, C.LOW] + candles[:, C.CLOSE]
        ) / 4
    raise ValueError(
        f"Unknown source_type '{source_type}'. "
        "Use one of: close, open, high, low, volume, hl2, hlc3, ohlc4."
    )


def _out(values: np.ndarray, sequential: bool):
    values = np.asarray(values, dtype="float64")
    if sequential:
        return values
    return float(values[-1]) if len(values) else float("nan")


def _tuple_out(tuple_type, parts, sequential: bool):
    return tuple_type(*[_out(p, sequential) for p in parts])


def _series(values: np.ndarray) -> pd.Series:
    return pd.Series(np.asarray(values, dtype="float64"))


def _require_period(period: int) -> int:
    period = int(period)
    if period < 1:
        raise ValueError("period must be >= 1")
    return period


# --------------------------------------------------------------------------- #
# Moving averages
# --------------------------------------------------------------------------- #


def sma(candles: np.ndarray, period: int = 5, source_type: str = "close", sequential: bool = False):
    """Simple Moving Average."""

    period = _require_period(period)
    src = get_candle_source(candles, source_type)
    res = _series(src).rolling(period, min_periods=period).mean().to_numpy()
    return _out(res, sequential)


def _ema_array(src: np.ndarray, period: int) -> np.ndarray:
    """TA-Lib-style EMA: seeded with the SMA of the first ``period`` values."""

    n = len(src)
    out = np.full(n, np.nan)
    if n < period:
        return out
    alpha = 2.0 / (period + 1.0)
    # First non-NaN window seeds the average.
    start = 0
    while start + period <= n and np.isnan(src[start : start + period]).any():
        start += 1
    if start + period > n:
        return out
    out[start + period - 1] = np.mean(src[start : start + period])
    for i in range(start + period, n):
        prev = out[i - 1]
        x = src[i]
        out[i] = prev if np.isnan(x) else (x - prev) * alpha + prev
    return out


def ema(candles: np.ndarray, period: int = 5, source_type: str = "close", sequential: bool = False):
    """Exponential Moving Average."""

    period = _require_period(period)
    src = get_candle_source(candles, source_type)
    return _out(_ema_array(np.asarray(src, dtype="float64"), period), sequential)


def dema(
    candles: np.ndarray, period: int = 30, source_type: str = "close", sequential: bool = False
):
    """Double Exponential Moving Average."""

    period = _require_period(period)
    src = np.asarray(get_candle_source(candles, source_type), dtype="float64")
    e1 = _ema_array(src, period)
    e2 = _ema_array(e1, period)
    return _out(2 * e1 - e2, sequential)


def tema(
    candles: np.ndarray, period: int = 9, source_type: str = "close", sequential: bool = False
):
    """Triple Exponential Moving Average."""

    period = _require_period(period)
    src = np.asarray(get_candle_source(candles, source_type), dtype="float64")
    e1 = _ema_array(src, period)
    e2 = _ema_array(e1, period)
    e3 = _ema_array(e2, period)
    return _out(3 * e1 - 3 * e2 + e3, sequential)


def wma(
    candles: np.ndarray, period: int = 30, source_type: str = "close", sequential: bool = False
):
    """Weighted Moving Average (linearly weighted, newest heaviest)."""

    period = _require_period(period)
    src = get_candle_source(candles, source_type)
    weights = np.arange(1, period + 1, dtype="float64")
    res = (
        _series(src)
        .rolling(period, min_periods=period)
        .apply(lambda w: float(np.dot(w, weights) / weights.sum()), raw=True)
        .to_numpy()
    )
    return _out(res, sequential)


def hma(candles: np.ndarray, period: int = 5, source_type: str = "close", sequential: bool = False):
    """Hull Moving Average."""

    period = _require_period(period)
    src = get_candle_source(candles, source_type)
    half = max(1, period // 2)
    root = max(1, int(round(np.sqrt(period))))
    diff = 2 * wma(src, half, sequential=True) - wma(src, period, sequential=True)
    return _out(wma(diff, root, sequential=True), sequential)


def vwma(
    candles: np.ndarray, period: int = 20, source_type: str = "close", sequential: bool = False
):
    """Volume Weighted Moving Average."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    vol = _series(candles[:, C.VOLUME])
    res = (src * vol).rolling(period, min_periods=period).sum() / vol.rolling(
        period, min_periods=period
    ).sum()
    return _out(res.to_numpy(), sequential)


def vwap(candles: np.ndarray, source_type: str = "hlc3", sequential: bool = False):
    """Volume Weighted Average Price, anchored at the first candle supplied.

    Anchor it to a session by passing only that session's candles."""

    src = np.asarray(get_candle_source(candles, source_type), dtype="float64")
    vol = candles[:, C.VOLUME]
    cum_vol = np.cumsum(vol)
    with np.errstate(divide="ignore", invalid="ignore"):
        res = np.cumsum(src * vol) / cum_vol
    res[cum_vol == 0] = np.nan
    return _out(res, sequential)


# --------------------------------------------------------------------------- #
# Momentum
# --------------------------------------------------------------------------- #


def _wilder(values: np.ndarray, period: int) -> np.ndarray:
    """Wilder's smoothing (RMA): seeded with the SMA of the first ``period``
    values, then ``prev + (x - prev) / period``."""

    n = len(values)
    out = np.full(n, np.nan)
    if n < period:
        return out
    start = 0
    while start + period <= n and np.isnan(values[start : start + period]).any():
        start += 1
    if start + period > n:
        return out
    out[start + period - 1] = np.mean(values[start : start + period])
    for i in range(start + period, n):
        out[i] = out[i - 1] + (values[i] - out[i - 1]) / period
    return out


def rsi(
    candles: np.ndarray, period: int = 14, source_type: str = "close", sequential: bool = False
):
    """Relative Strength Index (Wilder smoothing, as TA-Lib)."""

    period = _require_period(period)
    src = np.asarray(get_candle_source(candles, source_type), dtype="float64")
    n = len(src)
    out = np.full(n, np.nan)
    if n <= period:
        return _out(out, sequential)
    delta = np.diff(src)
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    avg_gain = _wilder(gains, period)
    avg_loss = _wilder(losses, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = avg_gain / avg_loss
        value = 100.0 - 100.0 / (1.0 + rs)
    # Flat losses -> RSI 100, flat gains -> 0 (TA-Lib convention).
    value = np.where((avg_loss == 0) & (avg_gain > 0), 100.0, value)
    value = np.where((avg_loss == 0) & (avg_gain == 0), 0.0, value)
    out[1:] = value
    return _out(out, sequential)


def macd(
    candles: np.ndarray,
    fast_period: int = 12,
    slow_period: int = 26,
    signal_period: int = 9,
    source_type: str = "close",
    sequential: bool = False,
) -> MACD:
    """Moving Average Convergence Divergence -> ``MACD(macd, signal, hist)``."""

    src = np.asarray(get_candle_source(candles, source_type), dtype="float64")
    fast = _ema_array(src, _require_period(fast_period))
    slow = _ema_array(src, _require_period(slow_period))
    line = fast - slow
    signal = _ema_array(line, _require_period(signal_period))
    return _tuple_out(MACD, (line, signal, line - signal), sequential)


def stoch(
    candles: np.ndarray,
    fastk_period: int = 14,
    slowk_period: int = 3,
    slowd_period: int = 3,
    sequential: bool = False,
) -> Stochastic:
    """Slow Stochastic oscillator -> ``Stochastic(k, d)``."""

    high = _series(candles[:, C.HIGH])
    low = _series(candles[:, C.LOW])
    close = _series(candles[:, C.CLOSE])
    fastk_period = _require_period(fastk_period)
    hh = high.rolling(fastk_period, min_periods=fastk_period).max()
    ll = low.rolling(fastk_period, min_periods=fastk_period).min()
    fast_k = 100 * (close - ll) / (hh - ll).replace(0, np.nan)
    slow_k = fast_k.rolling(_require_period(slowk_period), min_periods=slowk_period).mean()
    slow_d = slow_k.rolling(_require_period(slowd_period), min_periods=slowd_period).mean()
    return _tuple_out(Stochastic, (slow_k.to_numpy(), slow_d.to_numpy()), sequential)


def willr(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Williams %R."""

    period = _require_period(period)
    high = _series(candles[:, C.HIGH]).rolling(period, min_periods=period).max()
    low = _series(candles[:, C.LOW]).rolling(period, min_periods=period).min()
    close = _series(candles[:, C.CLOSE])
    res = -100 * (high - close) / (high - low).replace(0, np.nan)
    return _out(res.to_numpy(), sequential)


def cci(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Commodity Channel Index."""

    period = _require_period(period)
    tp = _series(get_candle_source(candles, "hlc3"))
    ma = tp.rolling(period, min_periods=period).mean()
    mad = tp.rolling(period, min_periods=period).apply(
        lambda w: float(np.mean(np.abs(w - w.mean()))), raw=True
    )
    res = (tp - ma) / (0.015 * mad.replace(0, np.nan))
    return _out(res.to_numpy(), sequential)


def roc(
    candles: np.ndarray, period: int = 10, source_type: str = "close", sequential: bool = False
):
    """Rate of Change (percent)."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    res = (src / src.shift(period) - 1.0) * 100.0
    return _out(res.to_numpy(), sequential)


def mom(
    candles: np.ndarray, period: int = 10, source_type: str = "close", sequential: bool = False
):
    """Momentum (price difference over ``period``)."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    return _out((src - src.shift(period)).to_numpy(), sequential)


def aroon(candles: np.ndarray, period: int = 14, sequential: bool = False) -> AroonResult:
    """Aroon indicator -> ``Aroon(down, up)``."""

    period = _require_period(period)
    high = _series(candles[:, C.HIGH])
    low = _series(candles[:, C.LOW])
    window = period + 1
    up = high.rolling(window, min_periods=window).apply(
        lambda w: 100.0 * (period - (len(w) - 1 - int(np.argmax(w)))) / period, raw=True
    )
    down = low.rolling(window, min_periods=window).apply(
        lambda w: 100.0 * (period - (len(w) - 1 - int(np.argmin(w)))) / period, raw=True
    )
    return _tuple_out(AroonResult, (down.to_numpy(), up.to_numpy()), sequential)


# --------------------------------------------------------------------------- #
# Volatility / trend strength
# --------------------------------------------------------------------------- #


def trange(candles: np.ndarray, sequential: bool = False):
    """True Range."""

    high = candles[:, C.HIGH]
    low = candles[:, C.LOW]
    close = candles[:, C.CLOSE]
    prev_close = np.concatenate([[np.nan], close[:-1]])
    tr = np.maximum.reduce(
        [high - low, np.abs(high - prev_close), np.abs(low - prev_close)]
    ).astype("float64")
    tr[0] = high[0] - low[0]
    return _out(tr, sequential)


def atr(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Average True Range (Wilder smoothing)."""

    period = _require_period(period)
    tr = trange(candles, sequential=True)
    return _out(_wilder(tr, period), sequential)


def natr(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Normalised ATR (percent of close)."""

    res = atr(candles, period, sequential=True) / candles[:, C.CLOSE] * 100.0
    return _out(res, sequential)


def bollinger_bands(
    candles: np.ndarray,
    period: int = 20,
    devup: float = 2.0,
    devdn: float = 2.0,
    source_type: str = "close",
    sequential: bool = False,
) -> BollingerBands:
    """Bollinger Bands -> ``BollingerBands(upperband, middleband, lowerband)``."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    middle = src.rolling(period, min_periods=period).mean()
    # Population std (ddof=0), as TA-Lib.
    std = src.rolling(period, min_periods=period).std(ddof=0)
    upper = middle + devup * std
    lower = middle - devdn * std
    return _tuple_out(
        BollingerBands, (upper.to_numpy(), middle.to_numpy(), lower.to_numpy()), sequential
    )


def bollinger_bands_width(
    candles: np.ndarray,
    period: int = 20,
    devup: float = 2.0,
    devdn: float = 2.0,
    source_type: str = "close",
    sequential: bool = False,
):
    """Bollinger Band width, ``(upper - lower) / middle``."""

    bands = bollinger_bands(candles, period, devup, devdn, source_type, sequential=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        res = (bands.upperband - bands.lowerband) / bands.middleband
    return _out(res, sequential)


def keltner(
    candles: np.ndarray,
    period: int = 20,
    multiplier: float = 2.0,
    source_type: str = "close",
    sequential: bool = False,
) -> KeltnerChannel:
    """Keltner Channel (EMA ± multiplier × ATR)."""

    period = _require_period(period)
    middle = ema(candles, period, source_type=source_type, sequential=True)
    band = multiplier * atr(candles, period, sequential=True)
    return _tuple_out(KeltnerChannel, (middle + band, middle, middle - band), sequential)


def donchian(candles: np.ndarray, period: int = 20, sequential: bool = False) -> DonchianChannel:
    """Donchian Channel (highest high / lowest low over ``period``)."""

    period = _require_period(period)
    upper = _series(candles[:, C.HIGH]).rolling(period, min_periods=period).max().to_numpy()
    lower = _series(candles[:, C.LOW]).rolling(period, min_periods=period).min().to_numpy()
    return _tuple_out(DonchianChannel, (upper, (upper + lower) / 2, lower), sequential)


def _directional(candles: np.ndarray, period: int):
    high = candles[:, C.HIGH]
    low = candles[:, C.LOW]
    up_move = np.concatenate([[np.nan], np.diff(high)])
    down_move = np.concatenate([[np.nan], -np.diff(low)])
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    plus_dm[0] = np.nan
    minus_dm[0] = np.nan
    tr = trange(candles, sequential=True)
    tr[0] = np.nan
    atr_w = _wilder(tr[1:], period)
    plus_s = _wilder(plus_dm[1:], period)
    minus_s = _wilder(minus_dm[1:], period)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100.0 * plus_s / atr_w
        minus_di = 100.0 * minus_s / atr_w
    pad = np.full(1, np.nan)
    return np.concatenate([pad, plus_di]), np.concatenate([pad, minus_di])


def di(candles: np.ndarray, period: int = 14, sequential: bool = False) -> DI:
    """Directional Indicators -> ``DI(plus, minus)``."""

    period = _require_period(period)
    plus, minus = _directional(candles, period)
    return _tuple_out(DI, (plus, minus), sequential)


def adx(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Average Directional Index."""

    period = _require_period(period)
    plus, minus = _directional(candles, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        dx = 100.0 * np.abs(plus - minus) / (plus + minus)
    dx = np.where(np.isfinite(dx), dx, np.nan)
    res = _wilder(dx, period)
    # _wilder skips leading NaN windows; align to the full length.
    return _out(res, sequential)


def supertrend(
    candles: np.ndarray, period: int = 10, factor: float = 3.0, sequential: bool = False
) -> SuperTrend:
    """SuperTrend -> ``SuperTrend(trend, changed)``.

    ``trend`` is the stop line (below price in an uptrend, above in a
    downtrend); ``changed`` is ``1.0`` on the candle the direction flipped."""

    period = _require_period(period)
    hl2 = get_candle_source(candles, "hl2")
    close = candles[:, C.CLOSE]
    a = atr(candles, period, sequential=True)
    n = len(close)
    upper = hl2 + factor * a
    lower = hl2 - factor * a
    final_upper = np.full(n, np.nan)
    final_lower = np.full(n, np.nan)
    trend = np.full(n, np.nan)
    changed = np.zeros(n)
    direction = 1  # 1 = up (use lower band), -1 = down (use upper band)
    started = False
    for i in range(n):
        if np.isnan(a[i]):
            continue
        if not started:
            final_upper[i] = upper[i]
            final_lower[i] = lower[i]
            direction = 1 if close[i] > upper[i] else -1
            trend[i] = final_lower[i] if direction == 1 else final_upper[i]
            started = True
            continue
        final_upper[i] = (
            upper[i]
            if upper[i] < final_upper[i - 1] or close[i - 1] > final_upper[i - 1]
            else final_upper[i - 1]
        )
        final_lower[i] = (
            lower[i]
            if lower[i] > final_lower[i - 1] or close[i - 1] < final_lower[i - 1]
            else final_lower[i - 1]
        )
        new_direction = direction
        if direction == 1 and close[i] < final_lower[i]:
            new_direction = -1
        elif direction == -1 and close[i] > final_upper[i]:
            new_direction = 1
        changed[i] = 1.0 if new_direction != direction else 0.0
        direction = new_direction
        trend[i] = final_lower[i] if direction == 1 else final_upper[i]
    return _tuple_out(SuperTrend, (trend, changed), sequential)


# --------------------------------------------------------------------------- #
# Volume
# --------------------------------------------------------------------------- #


def obv(candles: np.ndarray, sequential: bool = False):
    """On-Balance Volume."""

    close = candles[:, C.CLOSE]
    volume = candles[:, C.VOLUME]
    direction = np.sign(np.concatenate([[0.0], np.diff(close)]))
    return _out(np.cumsum(direction * volume), sequential)


def mfi(candles: np.ndarray, period: int = 14, sequential: bool = False):
    """Money Flow Index."""

    period = _require_period(period)
    tp = _series(get_candle_source(candles, "hlc3"))
    raw = tp * _series(candles[:, C.VOLUME])
    change = tp.diff()
    pos = raw.where(change > 0, 0.0).rolling(period, min_periods=period).sum()
    neg = raw.where(change < 0, 0.0).rolling(period, min_periods=period).sum()
    res = 100.0 - 100.0 / (1.0 + pos / neg.replace(0, np.nan))
    return _out(res.to_numpy(), sequential)


# --------------------------------------------------------------------------- #
# Statistics
# --------------------------------------------------------------------------- #


def stddev(
    candles: np.ndarray,
    period: int = 5,
    nbdev: float = 1.0,
    source_type: str = "close",
    sequential: bool = False,
):
    """Rolling standard deviation (population, as TA-Lib)."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    res = src.rolling(period, min_periods=period).std(ddof=0) * nbdev
    return _out(res.to_numpy(), sequential)


def zscore(
    candles: np.ndarray,
    period: int = 14,
    source_type: str = "close",
    sequential: bool = False,
):
    """Rolling z-score of the source against its own moving mean/std."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    mean = src.rolling(period, min_periods=period).mean()
    std = src.rolling(period, min_periods=period).std(ddof=0)
    res = (src - mean) / std.replace(0, np.nan)
    return _out(res.to_numpy(), sequential)


def highest(
    candles: np.ndarray, period: int = 20, source_type: str = "high", sequential: bool = False
):
    """Highest value of the source over ``period``."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    return _out(src.rolling(period, min_periods=period).max().to_numpy(), sequential)


def lowest(
    candles: np.ndarray, period: int = 20, source_type: str = "low", sequential: bool = False
):
    """Lowest value of the source over ``period``."""

    period = _require_period(period)
    src = _series(get_candle_source(candles, source_type))
    return _out(src.rolling(period, min_periods=period).min().to_numpy(), sequential)


AVAILABLE = (
    "sma",
    "ema",
    "dema",
    "tema",
    "wma",
    "hma",
    "vwma",
    "vwap",
    "rsi",
    "macd",
    "stoch",
    "willr",
    "cci",
    "roc",
    "mom",
    "aroon",
    "trange",
    "atr",
    "natr",
    "bollinger_bands",
    "bollinger_bands_width",
    "keltner",
    "donchian",
    "di",
    "adx",
    "supertrend",
    "obv",
    "mfi",
    "stddev",
    "zscore",
    "highest",
    "lowest",
)

# Every public indicator is causal, so all of them can be served from the
# full-history cache (see ``_memoize``). Applied here rather than per-def so the
# plain implementations above stay readable and directly testable.
for _name in AVAILABLE:
    globals()[_name] = _memoize(globals()[_name])
del _name
