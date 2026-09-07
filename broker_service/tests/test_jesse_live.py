"""``jesse.live.evaluate`` — a Jesse strategy's decision for the newest closed
candle, given the venue's real position, in the live runner's signal shape."""

from __future__ import annotations

import numpy as np
import pytest

from jesse import live
from jesse.strategies import Strategy

T0 = 1_699_999_200_000
TF_MS = 300_000


def bars(closes, highs=None, lows=None) -> np.ndarray:
    closes = np.asarray(closes, dtype="float64")
    n = len(closes)
    highs = np.asarray(highs, dtype="float64") if highs is not None else closes + 0.5
    lows = np.asarray(lows, dtype="float64") if lows is not None else closes - 0.5
    opens = np.concatenate([[closes[0]], closes[:-1]])
    ts = T0 + np.arange(n) * TF_MS
    return np.column_stack([ts, opens, closes, highs, lows, np.full(n, 1000.0)])


class LongOnLastCandle(Strategy):
    """Enter long when price closes above 104 (only the last candle does)."""

    def should_long(self):
        return self.price > 104

    def go_long(self):
        self.buy = 10, self.price
        self.stop_loss = 10, self.price - 3
        self.take_profit = 10, self.price + 6

    def update_position(self):
        if self.vars.get("liquidate_now"):
            self.liquidate()
        elif self.vars.get("trail_to") is not None:
            self.stop_loss = abs(self.position.qty), self.vars["trail_to"]

    def watch_list(self):
        return [("price", self.price), ("nan", float("nan"))]


def evaluate(cls, candles, **kwargs):
    kwargs.setdefault("warmup_candles", 0)
    return live.evaluate(cls, candles, symbol="MSFT", timeframe="5min", **kwargs)


class TestFlatPosition:
    def test_entry_becomes_long_signal_with_bracket(self):
        res = evaluate(LongOnLastCandle, bars([100, 101, 102, 105]))
        assert res["signal"] == "long"
        assert res["entry"] is True and res["exit"] is False
        assert res["stop_price"] == 102
        assert res["take_profit"] == 111
        assert res["entry_price"] == 105
        assert res["has_stop_rule"] is True
        assert res["entry_orders"][0]["type"] == "MARKET"
        assert res["entry_reason"] == "LongOnLastCandle: go_long()"
        assert res["engine"] == "jesse"
        assert res["position"] == {"size": 0.0, "avg_price": 0.0}
        assert res["trail"] == {"stop_price": None, "direction": None, "error": None}
        assert res["bar_time"].startswith("2023-11-14T22:15:00")

    def test_no_entry_is_none(self):
        res = evaluate(LongOnLastCandle, bars([100, 101, 102, 103]))
        assert res["signal"] == "none"
        assert res["stop_price"] is None and res["entry"] is False

    def test_watch_list_is_json_safe(self):
        res = evaluate(LongOnLastCandle, bars([100, 101, 102, 103]))
        assert res["watch_list"] == [["price", 103.0], ["nan", None]]

    def test_short_signal(self):
        class ShortLast(Strategy):
            def should_short(self):
                return self.price < 96

            def go_short(self):
                self.sell = 10, self.price
                self.stop_loss = 10, self.price + 2

        res = evaluate(ShortLast, bars([100, 99, 98, 95]))
        assert res["signal"] == "short" and res["stop_price"] == 97

    def test_conflict_reported_not_traded(self):
        class Both(LongOnLastCandle):
            def should_short(self):
                return self.price > 104

        res = evaluate(Both, bars([100, 101, 102, 105]))
        assert res["signal"] == "none" and res["conflict"] is True

    def test_shadow_position_does_not_leak_into_a_flat_venue(self):
        # The strategy would have been long since candle 3 in the replay, but
        # the venue says flat, so the last candle is evaluated as flat and it
        # re-enters (price still > 104).
        res = evaluate(LongOnLastCandle, bars([100, 101, 102, 105, 106, 107]))
        assert res["signal"] == "long" and res["entry_price"] == 107


class TestOpenPosition:
    def test_liquidate_becomes_flat(self):
        class Liq(LongOnLastCandle):
            def update_position(self):
                self.liquidate()

        res = evaluate(Liq, bars([100, 101, 102, 105]), position_size=10, position_avg_price=101)
        assert res["signal"] == "flat" and res["exit"] is True
        assert "liquidate" in res["exit_reason"]
        assert res["position"] == {"size": 10, "avg_price": 101}

    def test_holding_returns_none_with_trail(self):
        class Trail(LongOnLastCandle):
            def update_position(self):
                self.stop_loss = abs(self.position.qty), 103.5

        res = evaluate(Trail, bars([100, 101, 102, 105]), position_size=10, position_avg_price=101)
        assert res["signal"] == "none"
        assert res["trail"] == {"stop_price": 103.5, "direction": "long", "error": None}
        assert res["stop_price"] == 103.5

    def test_stop_already_breached_is_flat(self):
        class Trail(LongOnLastCandle):
            def update_position(self):
                self.stop_loss = abs(self.position.qty), 106  # above the close

        res = evaluate(Trail, bars([100, 101, 102, 105]), position_size=10, position_avg_price=101)
        assert res["signal"] == "flat"
        assert "stop_loss" in res["exit_reason"]

    def test_take_profit_touched_within_candle_is_flat(self):
        class TP(LongOnLastCandle):
            def update_position(self):
                self.take_profit = abs(self.position.qty), 105.3  # inside the last high

        res = evaluate(TP, bars([100, 101, 102, 105]), position_size=10, position_avg_price=101)
        assert res["signal"] == "flat"
        assert "take_profit" in res["exit_reason"]

    def test_short_position_trail_direction(self):
        class Trail(Strategy):
            def update_position(self):
                self.stop_loss = abs(self.position.qty), 110

        res = evaluate(Trail, bars([100, 101, 102, 103]), position_size=-5, position_avg_price=104)
        assert res["signal"] == "none"
        assert res["trail"]["direction"] == "short" and res["trail"]["stop_price"] == 110

    def test_no_entry_signal_while_open(self):
        # Even though should_long is true on the last candle, an open position
        # means update_position() runs, not go_long().
        res = evaluate(
            LongOnLastCandle, bars([100, 101, 102, 105]), position_size=10, position_avg_price=101
        )
        assert res["signal"] == "none" and res["entry"] is False


class TestStatefulReplay:
    def test_vars_survive_the_replay(self):
        class Counter(Strategy):
            def before(self):
                self.vars["seen"] = self.vars.get("seen", 0) + 1

            def should_long(self):
                return self.vars["seen"] == 4

            def go_long(self):
                self.buy = 1, self.price

        res = evaluate(Counter, bars([100, 101, 102, 103]))
        assert res["signal"] == "long"

    def test_hyperparameters_applied(self):
        class Level(Strategy):
            def hyperparameters(self):
                return [{"name": "level", "type": float, "default": 104}]

            def should_long(self):
                return self.price > self.hp["level"]

            def go_long(self):
                self.buy = 1, self.price

        assert evaluate(Level, bars([100, 101, 102, 103]))["signal"] == "none"
        res = evaluate(Level, bars([100, 101, 102, 103]), hyperparameters={"level": 102.5})
        assert res["signal"] == "long" and res["hyperparameters"] == {"level": 102.5}

    def test_single_bar_works(self):
        res = evaluate(LongOnLastCandle, bars([105]))
        assert res["signal"] == "long"


@pytest.mark.parametrize("size", [0, 10, -10])
def test_result_is_json_serialisable(size):
    import json

    res = evaluate(
        LongOnLastCandle, bars([100, 101, 102, 105]), position_size=size, position_avg_price=100
    )
    json.dumps(res)
