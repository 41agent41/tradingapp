"""Small time/format helpers (``import jesse.helpers as jh``)."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from . import timeframes as tf


def timestamp_to_time(timestamp_ms: float) -> str:
    """``1700000000000`` -> ``'2023-11-14T22:13:20+00:00'``."""

    return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=UTC).isoformat()


def timestamp_to_date(timestamp_ms: float) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=UTC).strftime("%Y-%m-%d")


def date_to_timestamp(date: str) -> int:
    """``'2024-01-31'`` -> unix milliseconds at UTC midnight."""

    dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


def timeframe_to_one_minutes(timeframe: str) -> int:
    return tf.to_seconds(timeframe) // 60


def now_to_timestamp() -> int:
    return int(datetime.now(tz=UTC).timestamp() * 1000)


def class_name_to_key(name: str) -> str:
    """``'SMACrossover'`` -> ``'sma_crossover'``; ``'MSFTTrendFollower'`` ->
    ``'msft_trend_follower'``."""

    step1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    step2 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", step1)
    return step2.lower()


def key_to_class_name(key: str) -> str:
    return "".join(part.capitalize() for part in key.split("_"))
