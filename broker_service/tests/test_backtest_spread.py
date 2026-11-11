"""
Spread-aware fills in a backtest (E-15).

Bars from a broker that quotes two prices are mid prices, which nothing trades
at. When the bars carry the broker's spread, a buy fills half of it above the
bar's price (the ask) and a sell half below (the bid), a long's stop is hit
when the bid reaches it and a short's when the ask does.
"""

from __future__ import annotations

import pandas as pd
import pytest

from backtesting import BacktestEngine
from rule_strategy import compile_rule_strategy

T0 = 1_700_000_000 - 1_700_000_000 % 3600
HOUR = 3600

FLAT = (100.0, 100.5, 99.5, 100.0)
ENTRY = (100.0, 101.0, 100.0, 101.0)
EXIT = (101.0, 103.0, 101.0, 103.0)


def _bars(rows, spread=None) -> pd.DataFrame:
    """Hourly bars from (open, high, low, close) rows; ``spread`` is one value
    for every bar, a list with one per bar (None for unknown), or absent."""
    idx = pd.to_datetime([T0 + i * HOUR for i in range(len(rows))], unit="s")
    frame = pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(
        volume=1000
    )
    if spread is not None:
        values = spread if isinstance(spread, list) else [spread] * len(rows)
        frame["spread"] = pd.Series(values, index=idx, dtype="float64")
    return frame


def _rules(direction: str = "long", stop: dict | None = None) -> dict:
    """Enter on the bar that closes at 101; exit on the one that closes at 103."""
    rule_set = {
        "name": "spread-test",
        "direction": direction,
        "entry": {
            "all": [
                {"left": "close", "op": ">=", "right": 101},
                {"left": "close", "op": "<=", "right": 101},
            ]
        },
        "exit": {"all": [{"left": "close", "op": ">=", "right": 103}]},
        "sizing": {"type": "fixed", "size": 10},
    }
    if stop:
        rule_set["stop"] = stop
    return rule_set


def _run(bars: pd.DataFrame, rule_set: dict):
    return BacktestEngine(initial_capital=100_000.0, commission=0.0).run_backtest(
        bars, compile_rule_strategy(rule_set), symbol="TEST"
    )


def test_a_long_buys_at_the_ask_and_sells_at_the_bid():
    results = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT], spread=0.2), _rules())

    (trade,) = results.trades
    assert trade.entry_price == pytest.approx(101.1)
    assert trade.exit_price == pytest.approx(102.9)
    assert trade.pnl == pytest.approx(18.0)  # 20 at the mid, less two half spreads on 10
    assert results.final_capital == pytest.approx(100_018.0)
    assert results.spread == {
        "applied": True,
        "bars": 5,
        "bars_with_spread": 5,
        "fills": 2,
        "cost": pytest.approx(2.0),
        "average": pytest.approx(0.2),
    }
    assert results.to_dict()["spread"]["cost"] == pytest.approx(2.0)


def test_a_short_sells_at_the_bid_and_buys_back_at_the_ask():
    results = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT], spread=0.2), _rules("short"))

    (trade,) = results.trades
    assert trade.entry_price == pytest.approx(100.9)
    assert trade.exit_price == pytest.approx(103.1)
    assert trade.pnl == pytest.approx(-22.0)


def test_bars_without_a_spread_fill_at_their_own_price_as_before():
    results = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT]), _rules())

    (trade,) = results.trades
    assert (trade.entry_price, trade.exit_price) == (101.0, 103.0)
    assert results.spread == {}
    assert "spread" not in results.to_dict()


def test_a_bar_with_no_spread_fills_at_its_own_price_and_the_rest_use_theirs():
    spreads = [0.2, None, 0.2, 0.4, 0.2]
    results = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT], spread=spreads), _rules())

    (trade,) = results.trades
    assert trade.entry_price == 101.0  # the entry bar's spread is not known
    assert trade.exit_price == pytest.approx(102.8)  # half of that bar's own 0.4
    assert results.spread["bars_with_spread"] == 4
    assert results.spread["fills"] == 1
    assert results.spread["cost"] == pytest.approx(2.0)


def test_a_spread_column_with_no_values_changes_nothing():
    results = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT], spread=[None] * 5), _rules())
    assert results.trades[0].entry_price == 101.0
    assert results.spread == {}


def test_a_position_left_open_is_closed_at_the_bid():
    results = _run(_bars([FLAT, ENTRY, FLAT, FLAT], spread=0.2), _rules())

    (trade,) = results.trades
    assert trade.exit_reason == "End of backtest"
    assert trade.exit_price == pytest.approx(99.9)


def test_the_spread_does_not_reach_the_rules_or_the_indicators():
    """The entry rule reads `close`; a spread on the frame must not shift it."""
    with_spread = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT], spread=0.2), _rules())
    without = _run(_bars([FLAT, ENTRY, FLAT, EXIT, FLAT]), _rules())
    assert with_spread.trades[0].entry_time == without.trades[0].entry_time
    assert with_spread.trades[0].exit_time == without.trades[0].exit_time


# --------------------------------------------------------------------------- #
# Stops
# --------------------------------------------------------------------------- #
FIXED_2 = {"type": "fixed", "distance": 2}  # a long from a 101 close is stopped at 99


def test_a_longs_stop_is_hit_when_the_bid_reaches_it():
    # The low is 99.05: above the stop at the mid, but the bid was 98.95.
    dip = (100.5, 100.6, 99.05, 100.0)
    hit = _run(_bars([FLAT, ENTRY, dip, FLAT], spread=0.2), _rules(stop=FIXED_2))
    missed = _run(_bars([FLAT, ENTRY, dip, FLAT]), _rules(stop=FIXED_2))

    assert hit.trades[0].exit_reason == "Stop hit at 99.00000"
    assert hit.trades[0].exit_price == 99.0
    assert missed.trades[0].exit_reason == "End of backtest"


def test_a_shorts_stop_is_hit_when_the_ask_reaches_it():
    # A short from 101 is stopped at 103. The high is 102.95; the ask was 103.05.
    spike = (101.0, 102.95, 100.8, 101.0)
    hit = _run(_bars([FLAT, ENTRY, spike, FLAT], spread=0.2), _rules("short", FIXED_2))
    missed = _run(_bars([FLAT, ENTRY, spike, FLAT]), _rules("short", FIXED_2))

    assert hit.trades[0].exit_reason == "Stop hit at 103.00000"
    assert hit.trades[0].exit_price == 103.0
    assert missed.trades[0].exit_reason == "End of backtest"


def test_a_gap_through_the_stop_fills_at_the_opens_bid():
    gap = (98.0, 98.5, 97.5, 98.2)
    results = _run(_bars([FLAT, ENTRY, gap, FLAT], spread=0.2), _rules(stop=FIXED_2))

    trade = results.trades[0]
    assert trade.exit_price == pytest.approx(97.9)
    assert "gapped through" in trade.exit_reason
