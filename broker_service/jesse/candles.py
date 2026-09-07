"""Candle arrays in Jesse's layout, and conversion to/from the app's frames.

Jesse hands a strategy its candles as a ``numpy`` array of shape ``(n, 6)``
whose columns are — in this exact, slightly surprising order —

    [timestamp_ms, open, close, high, low, volume]

Every indicator in ``jesse.indicators`` and every ``Strategy`` property
(``self.close``, ``self.high``…) indexes that layout, so strategies ported from
upstream Jesse work unmodified. The rest of this service speaks pandas frames
with a ``DatetimeIndex`` and ``open/high/low/close/volume`` columns (seconds
timestamps on the wire); the two converters below are the only place the two
shapes meet.
"""

from __future__ import annotations

from typing import Iterable, Mapping

import numpy as np
import pandas as pd

from . import timeframes as tf

# Column indices — use these rather than magic numbers.
TIMESTAMP = 0
OPEN = 1
CLOSE = 2
HIGH = 3
LOW = 4
VOLUME = 5

COLUMNS = ("timestamp", "open", "close", "high", "low", "volume")


class CandleError(ValueError):
    """Raised when candle input is malformed."""


class CandleArray(np.ndarray):
    """A candle array that remembers the full history it was sliced from.

    ``Strategy.candles`` hands out ``store[: index + 1]`` — a *prefix* view of
    the full array. Every indicator in :mod:`jesse.indicators` is causal (the
    value at candle *k* depends only on candles ``0..k``), so an indicator
    computed once over the full array and sliced to the prefix is identical to
    computing it on the prefix — and turns the per-candle recomputation Jesse
    strategies do (``ta.sma(self.candles, 20)`` on every candle) from O(n²) into
    O(n). The cache lives on the root array, so it is dropped with the store.
    """

    _jesse_root: CandleArray | None
    _jesse_cache: dict

    def __new__(cls, input_array: np.ndarray) -> CandleArray:
        obj = np.asarray(input_array, dtype="float64").view(cls)
        obj._jesse_root = obj
        obj._jesse_cache = {}
        return obj

    def __array_finalize__(self, obj) -> None:
        if obj is None:
            return
        self._jesse_root = getattr(obj, "_jesse_root", None)
        self._jesse_cache = getattr(obj, "_jesse_cache", None)

    def __reduce__(self):
        # Pickle as a plain array; the cache is a transient optimisation.
        return (np.asarray, (np.asarray(self),))


def prefix_root(candles: np.ndarray) -> CandleArray | None:
    """The full-history root if ``candles`` is a leading slice of one, else ``None``."""

    root = getattr(candles, "_jesse_root", None)
    if root is None or candles.ndim != 2 or root.ndim != 2 or candles.shape[1] != root.shape[1]:
        return None
    if len(candles) > len(root) or candles.strides != root.strides:
        return None
    if candles.__array_interface__["data"][0] != root.__array_interface__["data"][0]:
        return None
    return root


def datetime_index_to_ms(index: pd.DatetimeIndex) -> np.ndarray:
    """``DatetimeIndex`` -> unix milliseconds as float64, whatever the index's
    resolution (pandas >= 2 may store ``ms``/``us`` rather than ``ns``, so
    ``asi8`` cannot be assumed to be nanoseconds)."""

    if index.tz is not None:
        index = index.tz_convert("UTC").tz_localize(None)
    values = index.to_numpy().astype("datetime64[ms]").astype("int64")
    return values.astype("float64")


def from_dataframe(df: pd.DataFrame) -> np.ndarray:
    """Build a Jesse candle array from an OHLCV frame.

    Timestamps come from a ``timestamp`` column (unix **seconds**, the app's wire
    format) when present, otherwise from a ``DatetimeIndex``. The result is
    sorted ascending and de-duplicated on time, as Jesse's candle store is.
    """

    if df is None or len(df) == 0:
        raise CandleError("Cannot build candles from an empty frame.")
    for col in ("open", "high", "low", "close"):
        if col not in df.columns:
            raise CandleError(f"Frame is missing the '{col}' column.")

    if "timestamp" in df.columns:
        ts = pd.to_numeric(df["timestamp"], errors="coerce").to_numpy(dtype="float64")
        ts_ms = ts * 1000.0
    elif isinstance(df.index, pd.DatetimeIndex):
        ts_ms = datetime_index_to_ms(df.index)
    else:
        raise CandleError("Frame needs a 'timestamp' column or a DatetimeIndex.")

    volume = (
        pd.to_numeric(df["volume"], errors="coerce").fillna(0.0).to_numpy(dtype="float64")
        if "volume" in df.columns
        else np.zeros(len(df))
    )
    candles = np.column_stack(
        [
            ts_ms,
            pd.to_numeric(df["open"], errors="coerce").to_numpy(dtype="float64"),
            pd.to_numeric(df["close"], errors="coerce").to_numpy(dtype="float64"),
            pd.to_numeric(df["high"], errors="coerce").to_numpy(dtype="float64"),
            pd.to_numeric(df["low"], errors="coerce").to_numpy(dtype="float64"),
            volume,
        ]
    )
    if np.isnan(candles[:, TIMESTAMP]).any():
        raise CandleError("Every candle needs a timestamp.")
    order = np.argsort(candles[:, TIMESTAMP], kind="stable")
    candles = candles[order]
    _, keep = np.unique(candles[:, TIMESTAMP], return_index=True)
    return np.ascontiguousarray(candles[np.sort(keep)])


def from_records(bars: Iterable[Mapping[str, float]]) -> np.ndarray:
    """Build candles from the ``{timestamp, open, high, low, close, volume}``
    dicts the routes exchange (timestamps in seconds)."""

    rows = list(bars)
    if not rows:
        raise CandleError("Cannot build candles from an empty bar list.")
    return from_dataframe(pd.DataFrame(rows))


def to_dataframe(candles: np.ndarray) -> pd.DataFrame:
    """Jesse array -> the app's OHLCV frame (``DatetimeIndex`` in UTC-naive,
    plus a ``timestamp`` seconds column)."""

    validate(candles)
    ts_s = candles[:, TIMESTAMP] / 1000.0
    df = pd.DataFrame(
        {
            "timestamp": ts_s.astype("int64"),
            "open": candles[:, OPEN],
            "high": candles[:, HIGH],
            "low": candles[:, LOW],
            "close": candles[:, CLOSE],
            "volume": candles[:, VOLUME],
        }
    )
    df.index = pd.to_datetime(df["timestamp"], unit="s")
    df.index.name = None
    return df


def validate(candles: np.ndarray) -> None:
    if not isinstance(candles, np.ndarray) or candles.ndim != 2 or candles.shape[1] != 6:
        raise CandleError("Candles must be a numpy array of shape (n, 6).")
    if len(candles) == 0:
        raise CandleError("Candles array is empty.")


def resample(candles: np.ndarray, source_timeframe: str, target_timeframe: str) -> np.ndarray:
    """Aggregate ``candles`` (at ``source_timeframe``) into ``target_timeframe``.

    Each higher-timeframe candle is stamped with its **open** time (Jesse's
    convention: a candle's timestamp is when it opened) and covers
    ``[open, open + target)``. Only candles whose window is fully covered by
    source candles are *complete*; the last, possibly partial, bucket is kept —
    callers that must avoid look-ahead use :func:`closed_before`.
    """

    validate(candles)
    if not tf.is_higher(target_timeframe, source_timeframe):
        raise CandleError(
            f"'{target_timeframe}' is not a larger exact multiple of '{source_timeframe}'."
        )
    df = to_dataframe(candles)
    offset = tf.to_pandas_offset(target_timeframe)
    agg = (
        df[["open", "high", "low", "close", "volume"]]
        .resample(offset, label="left", closed="left")
        .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
        .dropna(subset=["close"])
    )
    out = np.column_stack(
        [
            datetime_index_to_ms(agg.index),
            agg["open"].to_numpy(dtype="float64"),
            agg["close"].to_numpy(dtype="float64"),
            agg["high"].to_numpy(dtype="float64"),
            agg["low"].to_numpy(dtype="float64"),
            agg["volume"].to_numpy(dtype="float64"),
        ]
    )
    return np.ascontiguousarray(out)


def closed_before(candles: np.ndarray, timeframe: str, time_ms: float) -> np.ndarray:
    """The prefix of ``candles`` (at ``timeframe``) that had **closed** by
    ``time_ms`` — i.e. ``open + duration <= time_ms``.

    This is the no-look-ahead guard for multi-timeframe strategies: a 1-hour
    candle only becomes visible to a 5-minute strategy once the hour has ended.
    """

    if len(candles) == 0:
        return candles
    duration = tf.to_milliseconds(timeframe)
    close_times = candles[:, TIMESTAMP] + duration
    count = int(np.searchsorted(close_times, time_ms, side="right"))
    return candles[:count]


def infer_timeframe(candles: np.ndarray) -> str | None:
    """Best-effort: the canonical timeframe matching the modal candle spacing,
    or ``None`` when the spacing matches nothing served."""

    if len(candles) < 2:
        return None
    diffs = np.diff(candles[:, TIMESTAMP])
    diffs = diffs[diffs > 0]
    if len(diffs) == 0:
        return None
    values, counts = np.unique(diffs, return_counts=True)
    modal_ms = float(values[np.argmax(counts)])
    for name in tf.SUPPORTED:
        if abs(tf.to_milliseconds(name) - modal_ms) < 1e-6:
            return name
    return None
