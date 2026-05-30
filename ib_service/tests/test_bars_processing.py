"""
Tests for bars_processing.py.

Uses a tiny ``FakeBar`` stand-in for ibapi.common.BarData so we can
exercise the timestamp-format heuristics (string with seconds, string
without seconds, int, datetime) without dragging in the real EClient.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pytest

from bars_processing import (
    process_bars,
    process_bars_with_date_range,
    process_bars_with_indicators,
)


@dataclass
class FakeBar:
    date: Any
    open: float = 1.0
    high: float = 2.0
    low: float = 0.5
    close: float = 1.5
    volume: int = 100


def test_process_bars_handles_yyyymmdd_string():
    bars = [FakeBar(date="20250101")]
    out = process_bars(bars, symbol="MSFT", timeframe="1day", period="1Y")
    assert out.count == 1
    assert out.bars[0].timestamp == 1735689600  # 2025-01-01 00:00:00 UTC


def test_process_bars_handles_intraday_string_with_seconds():
    bars = [FakeBar(date="20250101 12:30:00")]
    out = process_bars(bars, symbol="MSFT", timeframe="1hour", period="1D")
    assert out.count == 1
    # 2025-01-01 12:30:00 UTC = 1735734600
    assert out.bars[0].timestamp == 1735734600


def test_process_bars_handles_double_spaces():
    """IB sometimes returns double-space separators between date and time."""
    bars = [FakeBar(date="20250101  12:30:00")]
    out = process_bars(bars, symbol="MSFT", timeframe="1hour", period="1D")
    assert out.count == 1


def test_process_bars_handles_int_timestamp():
    bars = [FakeBar(date=1735689600)]
    out = process_bars(bars, symbol="MSFT", timeframe="1day", period="1Y")
    assert out.count == 1
    assert out.bars[0].timestamp == 1735689600


def test_process_bars_returns_descending_order():
    bars = [
        FakeBar(date="20250101"),
        FakeBar(date="20250105"),
        FakeBar(date="20250103"),
    ]
    out = process_bars(bars, symbol="MSFT", timeframe="1day", period="1Y")
    assert out.count == 3
    assert out.bars[0].timestamp > out.bars[1].timestamp > out.bars[2].timestamp


def test_process_bars_skips_unparseable_bars_but_keeps_going():
    bars = [
        FakeBar(date="20250101"),
        FakeBar(date="not a date"),
        FakeBar(date="20250102"),
    ]
    out = process_bars(bars, symbol="MSFT", timeframe="1day", period="1Y")
    # Bad bar is dropped; good ones survive.
    assert out.count == 2


def test_process_bars_with_date_range_filters():
    bars = [
        FakeBar(date="20250101"),
        FakeBar(date="20250105"),
        FakeBar(date="20250110"),
        FakeBar(date="20250115"),
    ]
    out = process_bars_with_date_range(
        bars,
        symbol="MSFT",
        timeframe="1day",
        start_date_str="2025-01-03",
        end_date_str="2025-01-12",
    )
    # Only Jan 5 and Jan 10 fall in range.
    assert out.count == 2
    assert out.period == "CUSTOM"


def test_process_bars_with_date_range_handles_empty_set():
    bars = [FakeBar(date="20240101")]  # before range
    out = process_bars_with_date_range(
        bars,
        symbol="MSFT",
        timeframe="1day",
        start_date_str="2025-01-01",
        end_date_str="2025-12-31",
    )
    assert out.count == 0
    assert out.bars == []


def test_process_bars_with_indicators_no_indicators_passthrough():
    bars = [FakeBar(date="20250101"), FakeBar(date="20250102")]
    out = process_bars_with_indicators(
        bars, symbol="MSFT", timeframe="1day", period="1Y", indicators=None
    )
    assert out.count == 2
    # No indicator fields set when none requested.
    assert out.bars[0].sma_20 is None


def test_process_bars_with_indicators_empty_input_returns_empty_response():
    out = process_bars_with_indicators(
        [], symbol="MSFT", timeframe="1day", period="1Y", indicators=["sma_20"]
    )
    assert out.count == 0
    assert out.symbol == "MSFT"


@pytest.mark.parametrize(
    "bad_date",
    [
        "completely invalid",
        "2025/01/01",  # wrong separator
        None,
    ],
)
def test_process_bars_individual_failures_are_logged_not_raised(bad_date):
    bars = [FakeBar(date=bad_date)]
    out = process_bars(bars, symbol="MSFT", timeframe="1day", period="1Y")
    assert out.count == 0  # the bad bar was skipped
