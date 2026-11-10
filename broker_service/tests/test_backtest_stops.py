"""
The protective stop in a backtest (E-03).

Live, an entry goes out with the stop its rule-set declares, the broker holds
it, and the runner tightens it at each bar close. These tests hold the
backtester to the same: the stop fills inside the bar that reaches it, on the
1-minute bar that reached it when those are supplied, at the worse price when
price gapped through, and it only ever tightens.
"""

from __future__ import annotations

import pandas as pd
import pytest

from backtesting import BacktestEngine
from rule_strategy import compile_rule_strategy

T0 = 1_700_000_000 - 1_700_000_000 % 3600
HOUR = 3600


def _bars(rows: list[tuple[float, float, float, float]]) -> pd.DataFrame:
    """Hourly bars from (open, high, low, close) rows."""
    idx = pd.to_datetime([T0 + i * HOUR for i in range(len(rows))], unit="s")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(
        volume=1000
    )


def _minutes(bar: int, rows: list[tuple[int, float, float, float, float]]) -> pd.DataFrame:
    """1-minute bars inside hourly bar ``bar`` from (minute, o, h, l, c) rows."""
    idx = pd.to_datetime([T0 + bar * HOUR + m * 60 for m, *_ in rows], unit="s")
    return pd.DataFrame(
        [r[1:] for r in rows], columns=["open", "high", "low", "close"], index=idx
    ).assign(volume=10)


def _rules(stop: dict | None, direction: str = "long", sizing: dict | None = None) -> dict:
    """Enter once, on the bar that closes at 101; never exit by rule."""
    rule_set = {
        "name": "stop-test",
        "direction": direction,
        "entry": {
            "all": [
                {"left": "close", "op": ">=", "right": 101},
                {"left": "close", "op": "<=", "right": 101},
            ]
        },
        "exit": {"all": [{"left": "close", "op": "<", "right": 0}]},
        "sizing": sizing or {"type": "fixed", "size": 10},
    }
    if stop:
        rule_set["stop"] = stop
    return rule_set


def _run(bars: pd.DataFrame, rule_set: dict, minute_bars: pd.DataFrame | None = None):
    return BacktestEngine(initial_capital=100_000.0, commission=0.0).run_backtest(
        bars, compile_rule_strategy(rule_set), symbol="TEST", minute_bars=minute_bars
    )


FLAT = (100.0, 100.5, 99.5, 100.0)
ENTRY = (100.0, 101.0, 100.0, 101.0)
FIXED_2 = {"type": "fixed", "distance": 2}  # a long from 101 is stopped at 99


def test_a_stop_fills_inside_the_bar_that_reaches_it():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT, FLAT])
    results = _run(bars, _rules(FIXED_2))

    assert results.total_trades == 1
    trade = results.trades[0]
    assert trade.entry_price == 101.0
    assert trade.exit_price == 99.0  # the stop, not the bar's close of 100
    assert trade.exit_time == bars.index[2]
    assert trade.exit_reason == "Stop hit at 99.00000"
    assert trade.pnl == pytest.approx(-20.0)
    assert results.final_capital == pytest.approx(100_000.0 - 20.0)
    assert results.fills == {
        "stop": True,
        "model": "bar",
        "bars": 5,
        "bars_with_minutes": 0,
        "minute_bars": 0,
        "stop_exits": 1,
        "stop_exits_on_minutes": 0,
        "entries_refused": 0,
    }


def test_a_bar_that_opens_beyond_the_stop_fills_at_its_open():
    bars = _bars([FLAT, ENTRY, (97.0, 98.0, 96.0, 97.5), FLAT])
    trade = _run(bars, _rules(FIXED_2)).trades[0]
    assert trade.exit_price == 97.0
    assert "gapped through" in trade.exit_reason


def test_the_stop_is_not_checked_on_the_bar_that_entered():
    # The entry bar's own low is below the stop; the entry is at its close.
    quiet = (101.0, 102.0, 100.5, 101.5)
    bars = _bars([FLAT, (100.0, 101.0, 98.0, 101.0), quiet, quiet])
    results = _run(bars, _rules(FIXED_2))
    assert results.trades[0].exit_reason == "End of backtest"
    assert results.fills["stop_exits"] == 0


def test_with_minute_bars_the_stop_fills_on_the_minute_that_reached_it():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT])
    minutes = _minutes(
        2,
        [
            (0, 101.0, 101.5, 100.5, 101.0),
            (10, 101.0, 101.0, 99.5, 99.6),
            (20, 99.6, 99.7, 98.9, 99.2),
            (30, 99.2, 100.0, 98.0, 100.0),
        ],
    )
    results = _run(bars, _rules(FIXED_2), minutes)
    trade = results.trades[0]
    assert trade.exit_price == 99.0
    assert trade.exit_time == pd.Timestamp(T0 + 2 * HOUR + 20 * 60, unit="s")
    assert results.fills["model"] == "1min"
    assert results.fills["bars_with_minutes"] == 1
    assert results.fills["minute_bars"] == 4
    assert results.fills["stop_exits_on_minutes"] == 1


def test_a_minute_that_opens_beyond_the_stop_fills_at_that_minutes_open():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT])
    minutes = _minutes(2, [(0, 101.0, 101.2, 100.8, 101.0), (1, 98.6, 98.8, 98.0, 98.5)])
    trade = _run(bars, _rules(FIXED_2), minutes).trades[0]
    # The hourly bar opened above the stop, so without minutes this fills at 99.
    assert trade.exit_price == 98.6
    assert "gapped through" in trade.exit_reason


def test_a_bar_whose_minutes_miss_the_move_still_stops_on_its_own_range():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT])
    minutes = _minutes(2, [(0, 101.0, 101.2, 100.8, 101.0)])
    results = _run(bars, _rules(FIXED_2), minutes)
    assert results.trades[0].exit_price == 99.0
    assert results.fills["stop_exits_on_minutes"] == 0


def test_the_stop_trails_at_each_close_and_never_loosens():
    pct = {"type": "pct", "pct": 2}
    bars = _bars(
        [
            FLAT,
            ENTRY,  # in at 101, stop 98.98
            (101.0, 110.0, 100.9, 110.0),  # close 110: the stop trails to 107.8
            (110.0, 110.0, 107.9, 108.0),  # close 108 wants 105.84, which is looser
            (108.0, 108.5, 107.0, 107.5),  # reaches 107.8
            FLAT,
        ]
    )
    trade = _run(bars, _rules(pct)).trades[0]
    assert trade.exit_price == pytest.approx(107.8)
    assert trade.exit_time == bars.index[4]
    assert trade.pnl == pytest.approx((107.8 - 101.0) * 10)


def test_a_short_is_stopped_above_the_market():
    bars = _bars([FLAT, ENTRY, (101.0, 104.0, 100.5, 103.5), FLAT])
    trade = _run(bars, _rules(FIXED_2, direction="short")).trades[0]
    assert trade.exit_price == 103.0
    assert trade.pnl == pytest.approx(-20.0)
    # And a short that gaps up fills at the open above its stop.
    gapped = _bars([FLAT, ENTRY, (105.0, 106.0, 104.0, 105.0), FLAT])
    assert _run(gapped, _rules(FIXED_2, direction="short")).trades[0].exit_price == 105.0


def test_an_entry_whose_stop_cannot_be_resolved_is_refused():
    # The 1-bar low is the close itself: a long stop there would trigger at once.
    bars = _bars([FLAT, (101.0, 101.5, 101.0, 101.0), FLAT, FLAT])
    results = _run(bars, _rules({"type": "bar_extreme", "lookback": 1}))
    assert results.total_trades == 0
    assert results.fills["entries_refused"] == 1


def test_risk_pct_sizes_the_entry_from_its_stop():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT])
    results = _run(bars, _rules(FIXED_2, sizing={"type": "risk_pct", "size": 1}))
    trade = results.trades[0]
    # 1% of 100,000 at risk over a 2.00 stop is 500 shares, and the stop loses 1%.
    assert trade.quantity == 500
    assert trade.pnl == pytest.approx(-1000.0)


def test_a_strategy_without_a_stop_is_unchanged():
    bars = _bars([FLAT, ENTRY, (101.0, 101.5, 98.0, 100.0), FLAT])
    results = _run(bars, _rules(None))
    assert results.trades[0].exit_reason == "End of backtest"
    assert results.fills == {}
    assert "fills" not in results.to_dict()
