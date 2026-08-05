"""
Shared pytest fixtures for the broker_service tests.

The tests target pure-math modules so the IB gateway / FastAPI / network
layers are never exercised — they only need pandas and numpy.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

# ib_client.py reads IB_HOST at import time and raises without it. The tests
# never touch a real gateway, so default it here — before any test module
# imports the IB layer — while `setdefault` preserves a real value if set.
os.environ.setdefault("IB_HOST", "127.0.0.1")

# Make sure the broker_service package is importable when pytest is invoked
# from the repo root or from broker_service/.
_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))


@pytest.fixture
def linear_series() -> pd.Series:
    """A deterministic, monotonically-increasing price series.

    1.0, 2.0, 3.0, ..., 100.0 — useful for sanity-checking averages.
    """
    return pd.Series(np.arange(1.0, 101.0))


@pytest.fixture
def constant_series() -> pd.Series:
    """A constant 50.0 series — any moving average should equal 50.0
    once warmed up and any change-based indicator should be 0."""
    return pd.Series(np.full(100, 50.0))


@pytest.fixture
def synthetic_ohlcv() -> pd.DataFrame:
    """A small but realistic OHLCV frame.

    The price walks up and down so volatility/momentum indicators have
    something to chew on without being random (deterministic seed).
    """
    rng = np.random.default_rng(seed=42)
    n = 60
    base = np.linspace(100.0, 120.0, n)
    noise = rng.normal(0.0, 0.5, size=n)
    close = base + noise

    high = close + np.abs(rng.normal(0.5, 0.2, size=n))
    low = close - np.abs(rng.normal(0.5, 0.2, size=n))
    open_ = close + rng.normal(0.0, 0.2, size=n)
    volume = rng.integers(1_000, 10_000, size=n)

    return pd.DataFrame(
        {
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )
