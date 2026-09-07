"""The Jesse ``Strategy`` lifecycle, the simulated broker's fill model, and the
backtester's accounting — exercised with scripted strategies on hand-made
candles so every fill price and PnL is checkable by hand.
"""

from __future__ import annotations

from typing import List

import numpy as np
import pytest

import jesse.indicators as ta
from jesse import backtest
from jesse import candles as C
from jesse.adapter import to_backtest_results
from jesse.enums import order_submitted_via as via
from jesse.enums import order_types
from jesse.models import StrategyError
from jesse.strategies import Strategy
from jesse.strategy import resolve_hyperparameters

T0 = 1_699_999_200_000  # 2023-11-14 22:00:00 UTC — on a 30-minute boundary
TF_MS = 300_000  # 5 minutes


def bars(closes, highs=None, lows=None, opens=None, volume=1000.0) -> np.ndarray:
    closes = np.asarray(closes, dtype="float64")
    n = len(closes)
    highs = np.asarray(highs, dtype="float64") if highs is not None else closes + 0.5
    lows = np.asarray(lows, dtype="float64") if lows is not None else closes - 0.5
    if opens is None:
        opens = np.concatenate([[closes[0]], closes[:-1]])
    opens = np.asarray(opens, dtype="float64")
    ts = T0 + np.arange(n) * TF_MS
    return np.column_stack([ts, opens, closes, highs, lows, np.full(n, volume)]).astype("float64")


def run(strategy_cls, candles, **kwargs):
    kwargs.setdefault("warmup_candles", 0)
    kwargs.setdefault("fee_rate", 0.001)
    return backtest.run(strategy_cls, candles, symbol="MSFT", timeframe="5m", **kwargs)


class Recorder(Strategy):
    """Base for scripted strategies: records every hook call in order."""

    def __init__(self):
        super().__init__()
        self.events: List[str] = []

    def before(self):
        self.events.append(f"before:{self.index}")

    def after(self):
        self.events.append(f"after:{self.index}")

    def on_open_position(self, order):
        self.events.append(f"open:{order.filled_price}")

    def on_close_position(self, order):
        self.events.append(f"close:{order.submitted_via}:{order.filled_price}")

    def on_stop_loss(self, order):
        self.events.append("stop_loss")

    def on_take_profit(self, order):
        self.events.append("take_profit")

    def on_reduced_position(self, order):
        self.events.append(f"reduced:{order.filled_price}")

    def on_increased_position(self, order):
        self.events.append("increased")

    def on_cancel(self):
        self.events.append("cancel")

    def terminate(self):
        self.events.append("terminate")


class EnterOnceLong(Recorder):
    """Market long on the first candle, 10 units, stop -5, target +5."""

    stop = 5.0
    target = 5.0

    def should_long(self):
        return self.index == 0

    def go_long(self):
        p = self.price
        self.buy = 10, p
        self.stop_loss = 10, p - self.stop
        self.take_profit = 10, p + self.target


class TestMarketEntryAndBracket:
    def test_take_profit_fills_at_limit_price(self):
        # Entry at 100 on candle 0; TP 105 is reached on candle 3 (high 106.5).
        candles = bars([100, 101, 102, 106, 107])
        result = run(EnterOnceLong, candles)

        assert len(result.trades) == 1
        trade = result.trades[0]
        assert trade.entry_price == 100
        assert trade.exit_price == 105  # limit price, not the close
        assert trade.qty == 10
        assert trade.exit_reason.startswith("EnterOnceLong: take_profit")
        # Fees: 1000 * 0.001 on entry + 1050 * 0.001 on exit.
        assert trade.fee == pytest.approx(1.0 + 1.05)
        assert trade.pnl == pytest.approx(50 - 2.05)
        assert result.finishing_balance == pytest.approx(100_000 + 50 - 2.05)

    def test_gap_through_limit_fills_at_open(self):
        # Candle 1 opens at 108, above the 105 target: filled at the open.
        candles = bars([100, 109], opens=[100, 108])
        result = run(EnterOnceLong, candles)
        assert result.trades[0].exit_price == 108

    def test_stop_loss_fills_at_stop_price(self):
        candles = bars([100, 99, 94.9, 90])
        result = run(EnterOnceLong, candles)
        trade = result.trades[0]
        assert trade.exit_price == 95
        assert trade.pnl == pytest.approx(-50 - (1.0 + 0.95))
        assert trade.exit_reason.startswith("EnterOnceLong: stop_loss")

    def test_stop_and_target_in_same_candle_is_pessimistic(self):
        # Candle 1 spans 94 .. 106: both levels touched -> stop-loss wins.
        candles = bars([100, 100], highs=[100.5, 106], lows=[99.5, 94])
        result = run(EnterOnceLong, candles)
        assert result.trades[0].exit_price == 95
        assert result.trades[0].exit_reason.endswith("stop_loss STOP @ 95.0000")

    def test_exits_are_not_eligible_on_the_entry_candle(self):
        # Even though candle 0 ranges to 106, the bracket only arms next candle.
        candles = bars([100, 100], highs=[106, 100.5], lows=[99.5, 99.5])
        result = run(EnterOnceLong, candles)
        assert result.trades == []
        assert result.metrics["total_open_trades"] == 0  # marked flat at 100 -> pnl 0

    def test_hooks_fire_in_order(self):
        candles = bars([100, 101, 106])
        strat = EnterOnceLong()
        run(strat, candles)
        assert strat.events == [
            "before:0",
            "open:100.0",
            "after:0",
            "before:1",
            "after:1",
            "take_profit",
            "close:take_profit:105.0",
            "before:2",
            "after:2",
            "terminate",
        ]

    def test_open_position_at_end_is_marked_to_market(self):
        candles = bars([100, 101, 102])
        result = run(EnterOnceLong, candles)
        assert result.trades == []
        assert result.finishing_balance == pytest.approx(100_000 - 1.0 + 20)
        assert result.metrics["total_open_trades"] == 1
        assert result.metrics["open_pl"] == pytest.approx(20)


class LimitEntry(Recorder):
    """Buy 10 two dollars below the market; cancel if not filled next candle."""

    cancel = True

    def should_long(self):
        return self.index == 0

    def should_cancel_entry(self):
        return self.cancel

    def go_long(self):
        self.buy = 10, self.price - 2
        self.stop_loss = 10, self.price - 6


class TestRestingEntries:
    def test_limit_entry_fills_when_touched(self):
        candles = bars([100, 99, 99], lows=[99.5, 97.5, 98.5])
        strat = LimitEntry()
        result = run(strat, candles)
        assert "open:98.0" in strat.events
        assert result.orders[0]["type"] == order_types.LIMIT
        assert result.orders[0]["status"] == "EXECUTED"

    def test_limit_entry_gap_fills_at_open(self):
        candles = bars([100, 96], opens=[100, 97], lows=[99.5, 95.5])
        strat = LimitEntry()
        run(strat, candles)
        assert "open:97.0" in strat.events

    def test_unfilled_limit_is_cancelled_when_asked(self):
        candles = bars([100, 101, 102])
        strat = LimitEntry()
        result = run(strat, candles)
        assert "cancel" in strat.events
        assert result.orders[0]["status"] == "CANCELED"
        assert result.trades == []

    def test_unfilled_limit_rests_when_not_cancelled(self):
        class Patient(LimitEntry):
            cancel = False

        candles = bars([100, 101, 102, 97], lows=[99.5, 100.5, 101.5, 96.5])
        strat = Patient()
        run(strat, candles)
        assert "open:98.0" in strat.events

    def test_stop_entry_for_breakouts(self):
        class Breakout(Recorder):
            def should_long(self):
                return self.index == 0

            def go_long(self):
                self.buy = 10, self.price + 2
                self.stop_loss = 10, self.price - 2

        candles = bars([100, 101, 103], highs=[100.5, 101.5, 103.5])
        strat = Breakout()
        result = run(strat, candles)
        assert result.orders[0]["type"] == order_types.STOP
        assert "open:102.0" in strat.events


class Trailing(Recorder):
    """Long once; each candle raise the stop to close - 1."""

    def should_long(self):
        return self.index == 0

    def go_long(self):
        self.buy = 10, self.price
        self.stop_loss = 10, self.price - 3

    def update_position(self):
        self.stop_loss = 10, self.price - 1


class TestPositionManagement:
    def test_update_position_replaces_the_stop_order(self):
        candles = bars([100, 102, 104, 102.9])
        strat = Trailing()
        result = run(strat, candles)
        stop_orders = [o for o in result.orders if o["submitted_via"] == via.STOP_LOSS]
        # Initial 97, then 101 (close 102 - 1), then 103 (close 104 - 1).
        assert [o["price"] for o in stop_orders] == [97, 101, 103]
        assert [o["status"] for o in stop_orders] == ["CANCELED", "CANCELED", "EXECUTED"]
        assert result.trades[0].exit_price == 103

    def test_liquidate_closes_at_market(self):
        class LiquidateAtTwo(EnterOnceLong):
            target = 50  # unreachable

            def update_position(self):
                if self.index == 2:
                    self.liquidate()

        candles = bars([100, 101, 103, 104])
        strat = LiquidateAtTwo()
        result = run(strat, candles)
        trade = result.trades[0]
        assert trade.exit_price == 103
        assert "liquidate" in trade.exit_reason
        assert strat.events.count("close:liquidate:103.0") == 1
        # Bracket orders are cancelled with the position.
        assert all(o["status"] != "ACTIVE" for o in result.orders)

    def test_stop_moved_through_price_exits_immediately(self):
        class StopAboveMarket(EnterOnceLong):
            target = 50

            def update_position(self):
                if self.index == 1:
                    self.stop_loss = 10, self.price + 1  # already breached

        candles = bars([100, 101, 102])
        result = run(StopAboveMarket, candles)
        assert result.trades[0].exit_price == 101  # market at that close

    def test_partial_take_profits_produce_one_trade_per_rung(self):
        class Scaled(Recorder):
            def should_long(self):
                return self.index == 0

            def go_long(self):
                self.buy = 10, self.price
                self.stop_loss = 10, self.price - 5
                self.take_profit = [(4, self.price + 2), (6, self.price + 4)]

        candles = bars([100, 102.5, 104.5])
        strat = Scaled()
        result = run(strat, candles)
        assert [(t.qty, t.exit_price) for t in result.trades] == [(4, 102), (6, 104)]
        assert "reduced:102.0" in strat.events
        assert "close:take_profit:104.0" in strat.events
        # Entry fee (1.0) is split across the rungs by quantity.
        assert result.trades[0].fee == pytest.approx(0.4 + 4 * 102 * 0.001)
        assert result.trades[1].fee == pytest.approx(0.6 + 6 * 104 * 0.001)

    def test_short_trade_profits_when_price_falls(self):
        class ShortOnce(Recorder):
            def should_short(self):
                return self.index == 0

            def go_short(self):
                self.sell = 10, self.price
                self.stop_loss = 10, self.price + 5
                self.take_profit = 10, self.price - 5

        candles = bars([100, 98, 94])
        result = run(ShortOnce, candles)
        trade = result.trades[0]
        assert trade.type == "short"
        assert trade.exit_price == 95
        assert trade.pnl == pytest.approx(50 - (1.0 + 0.95))
        assert result.orders[0]["type"] == order_types.MARKET
        assert [o["type"] for o in result.orders[1:]] == [order_types.STOP, order_types.LIMIT]

    def test_position_properties_during_trade(self):
        seen = {}

        class Inspect(EnterOnceLong):
            target = 50

            def update_position(self):
                seen["is_long"] = self.is_long
                seen["qty"] = self.position.qty
                seen["entry"] = self.position.entry_price
                seen["pnl"] = self.position.pnl
                seen["pnl_pct"] = self.position.pnl_percentage
                seen["avg_stop"] = self.average_stop_loss
                seen["portfolio"] = self.portfolio_value

        candles = bars([100, 102])
        run(Inspect, candles)
        assert seen["is_long"] and seen["qty"] == 10 and seen["entry"] == 100
        assert seen["pnl"] == pytest.approx(20)
        assert seen["pnl_pct"] == pytest.approx(2.0)
        assert seen["avg_stop"] == 95
        assert seen["portfolio"] == pytest.approx(100_000 - 1 + 20)


class TestGuards:
    def test_filters_block_entry(self):
        class Filtered(EnterOnceLong):
            def filters(self):
                return [lambda: False]

        result = run(Filtered, bars([100, 101, 106]))
        assert result.orders == [] and result.trades == []

    def test_conflicting_signals_are_counted_not_traded(self):
        class Confused(EnterOnceLong):
            def should_short(self):
                return self.index == 0

        result = run(Confused, bars([100, 101, 106]))
        assert result.orders == []
        assert result.conflicts == 1
        assert result.metrics["conflicts"] == 1

    def test_missing_buy_is_an_author_error(self):
        class Forgetful(Recorder):
            def should_long(self):
                return True

            def go_long(self):
                self.stop_loss = 10, 90

        with pytest.raises(StrategyError, match="must set self.buy"):
            run(Forgetful, bars([100, 101]))

    def test_nan_quantity_is_an_author_error(self):
        class Nan(Recorder):
            def should_long(self):
                return True

            def go_long(self):
                self.buy = float("nan"), self.price

        with pytest.raises(StrategyError, match="NaN"):
            run(Nan, bars([100, 101]))

    def test_insufficient_margin_rejects_the_order(self):
        class TooBig(Recorder):
            def should_long(self):
                return self.index == 0

            def go_long(self):
                self.buy = 5_000, self.price  # 500k notional on 100k

        result = run(TooBig, bars([100, 101, 102]))
        assert result.orders == []
        assert len(result.rejected_orders) == 1
        assert "margin" in result.rejected_orders[0]["reason"]

    def test_go_long_not_implemented(self):
        class Bare(Strategy):
            def should_long(self):
                return True

        with pytest.raises(NotImplementedError):
            run(Bare, bars([100, 101]))

    def test_warmup_bounds(self):
        with pytest.raises(StrategyError):
            run(EnterOnceLong, bars([100, 101]), warmup_candles=2)


class TestWarmupAndContext:
    def test_warmup_candles_are_visible_but_not_traded(self):
        seen = {}

        class Peek(Recorder):
            def should_long(self):
                seen.setdefault("first_len", len(self.candles))
                seen.setdefault("first_index", self.index)
                seen.setdefault("first_price", self.price)
                return False

        candles = bars(np.arange(100, 110, dtype=float))
        result = run(Peek, candles, warmup_candles=4)
        assert seen == {"first_len": 5, "first_index": 0, "first_price": 104}
        assert len(result.equity_curve) == 6
        assert result.warmup_candles == 4

    def test_default_warmup_caps_at_history(self):
        result = backtest.run(EnterOnceLong, bars([100] * 10), symbol="X", timeframe="5m")
        assert result.warmup_candles == 9

    def test_get_candles_higher_timeframe_has_no_lookahead(self):
        seen = []

        class Anchor(Recorder):
            def should_long(self):
                anchor = self.get_candles(self.exchange, self.symbol, "30m")
                seen.append(
                    (self.index, len(anchor), anchor[-1][C.TIMESTAMP] if len(anchor) else None)
                )
                return False

        # 18 five-minute candles starting on a 30-minute boundary = 3 anchor candles.
        candles = bars(np.linspace(100, 117, 18))
        run(Anchor, candles)
        # The first 30m candle closes with the 6th 5m candle (index 5), the
        # second with index 11, the third with the last candle.
        counts = [n for _, n, _ in seen]
        assert counts == [0] * 5 + [1] * 6 + [2] * 6 + [3]
        for idx, n, last_ts in seen:
            if n:
                assert last_ts + 1_800_000 <= candles[idx][C.TIMESTAMP] + TF_MS

    def test_get_candles_rejects_lower_timeframe(self):
        class Lower(Strategy):
            def should_long(self):
                self.get_candles(self.exchange, self.symbol, "1m")
                return False

        with pytest.raises(StrategyError, match="larger"):
            run(Lower, bars([100, 101]))

    def test_indicators_on_self_candles_match_direct(self):
        checks = []

        class Check(Strategy):
            def should_long(self):
                checks.append((ta.sma(self.candles, 3), float(np.mean(self.candles[-3:, C.CLOSE]))))
                return False

        run(Check, bars(np.arange(100, 110, dtype=float)), warmup_candles=3)
        assert all(a == pytest.approx(b) for a, b in checks)

    def test_time_and_timeframe(self):
        seen = {}

        class Clock(Strategy):
            def should_long(self):
                seen["time"] = self.time
                seen["tf"] = self.timeframe
                seen["symbol"] = self.symbol
                return False

        run(Clock, bars([100, 101]))
        assert seen == {"time": T0 + 2 * TF_MS, "tf": "5min", "symbol": "MSFT"}

    def test_log_is_captured(self):
        class Talker(Strategy):
            def should_long(self):
                self.log("hello", "warning")
                return False

        result = run(Talker, bars([100, 101]))
        assert result.logs[0]["message"] == "hello" and result.logs[0]["type"] == "warning"


class TestHyperparameters:
    SPEC = [
        {"name": "fast", "type": int, "min": 2, "max": 50, "default": 10},
        {"name": "mult", "type": float, "min": 0.5, "max": 5, "default": 2.0},
        {"name": "flag", "type": bool, "default": False},
    ]

    def test_defaults(self):
        assert resolve_hyperparameters(self.SPEC, None) == {"fast": 10, "mult": 2.0, "flag": False}

    def test_overrides_are_coerced(self):
        hp = resolve_hyperparameters(self.SPEC, {"fast": "20", "mult": 3, "flag": "true"})
        assert hp == {"fast": 20, "mult": 3.0, "flag": True}
        assert isinstance(hp["fast"], int) and isinstance(hp["mult"], float)

    def test_unknown_name_rejected(self):
        with pytest.raises(StrategyError, match="Unknown hyperparameter"):
            resolve_hyperparameters(self.SPEC, {"fsat": 1})

    def test_range_enforced(self):
        with pytest.raises(StrategyError, match="above its max"):
            resolve_hyperparameters(self.SPEC, {"fast": 99})
        with pytest.raises(StrategyError, match="below its min"):
            resolve_hyperparameters(self.SPEC, {"mult": 0.1})

    def test_strategy_reads_hp(self):
        seen = {}

        class Param(Strategy):
            def hyperparameters(self):
                return [{"name": "n", "type": int, "default": 3}]

            def should_long(self):
                seen["n"] = self.hp["n"]
                return False

        run(Param, bars([100, 101]), hyperparameters={"n": 7})
        assert seen["n"] == 7


class TestResultsAndMetrics:
    def test_accounting_is_consistent(self):
        rng = np.random.default_rng(3)
        closes = 100 + np.cumsum(rng.normal(0, 1, 400))

        class Churn(Strategy):
            def should_long(self):
                return self.index % 7 == 0

            def should_short(self):
                return self.index % 7 == 3

            def go_long(self):
                self.buy = 10, self.price
                self.stop_loss = 10, self.price - 2
                self.take_profit = 10, self.price + 3

            def go_short(self):
                self.sell = 10, self.price
                self.stop_loss = 10, self.price + 2
                self.take_profit = 10, self.price - 3

            def update_position(self):
                if self.index % 7 == 6:
                    self.liquidate()

        result = run(Churn, bars(closes))
        assert len(result.trades) > 10
        # Wallet identity: gross realised PnL - every fee charged + open PnL.
        # (A trade's `pnl` is net of *its* fees; an open position's entry fee
        # has been charged but belongs to no closed trade yet.)
        gross = sum(t.pnl + t.fee for t in result.trades)
        open_pnl = result.metrics["open_pl"] or 0.0
        assert result.finishing_balance - result.starting_balance == pytest.approx(
            gross - result.metrics["fee"] + open_pnl, abs=1e-6
        )
        assert result.metrics["fee"] >= sum(t.fee for t in result.trades) - 1e-9
        assert result.equity_curve.iloc[-1] == pytest.approx(result.finishing_balance)
        m = result.metrics
        assert m["total"] == len(result.trades)
        assert m["longs_count"] + m["shorts_count"] == m["total"]
        assert 0 <= m["win_rate"] <= 1
        assert m["max_drawdown"] <= 0
        for key in (
            "net_profit_percentage",
            "expectancy",
            "sharpe_ratio",
            "sortino_ratio",
            "calmar_ratio",
            "profit_factor",
            "average_holding_period",
            "winning_streak",
            "losing_streak",
            "kelly_criterion",
            "fee",
        ):
            assert key in m

    def test_to_backtest_results_matches_app_shape(self):
        result = run(EnterOnceLong, bars([100, 101, 106]))
        app = to_backtest_results(result)
        assert app.total_trades == 1 and app.winning_trades == 1
        assert app.win_rate == 100.0  # percent, as the app's engine reports it
        assert app.final_capital == pytest.approx(result.finishing_balance)
        payload = app.to_dict()
        assert payload["trades_summary"][0]["order_type"] == "BUY"
        assert payload["trades_summary"][0]["exit_price"] == 105
        assert payload["metrics"]["engine"] == "jesse"
        assert len(payload["equity_curve"]) == 3
        import json

        json.dumps(payload)  # JSON-safe (no NaN / inf)

    def test_result_to_dict_serialisable(self):
        import json

        result = run(EnterOnceLong, bars([100, 101, 106]))
        json.dumps(result.to_dict())
