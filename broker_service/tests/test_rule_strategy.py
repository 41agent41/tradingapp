"""
Unit tests for the rule-driven strategy layer (Systematic Trading roadmap A1).

Coverage mirrors the Phase 1 Definition of Done:

  * the **compiler** — valid/invalid rule-sets, indicator resolution, and the
    example registry wiring into ``AVAILABLE_STRATEGIES``;
  * **each operand class** — constants, bar fields, indicator columns,
    multi-timeframe indicator operands and position-aware fields;
  * the **operators**, including ``crosses_above`` / ``crosses_below`` and NaN
    handling;
  * **sessions** (time-of-day / day-of-week gating, flat-at-session-end);
  * the **multi-timeframe merge** (values only visible after the higher-TF bar
    closes — no look-ahead);
  * the **SimpleMAStrategy parity** case — a JSON rule-set restating the
    built-in strategy produces an identical backtest.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backtesting import AVAILABLE_STRATEGIES, BacktestEngine, SimpleMAStrategy
from indicators import calculator as indicator_calculator
from rule_strategy import (
    MA_CROSSOVER_PARITY_RULE_SET,
    RULE_STRATEGY_EXAMPLES,
    BarFieldOperand,
    Condition,
    ConstOperand,
    EvalContext,
    IndicatorOperand,
    Position,
    RuleSetError,
    RuleStrategy,
    SessionWindow,
    compile_rule_strategy,
    parse_operand,
    session_mask,
)


def _ctx(row: dict, prev: dict | None = None, position: Position | None = None) -> EvalContext:
    return EvalContext(
        row=pd.Series(row),
        prev=pd.Series(prev) if prev is not None else None,
        position=position or Position(),
    )


# --------------------------------------------------------------------------- #
# Operand classes
# --------------------------------------------------------------------------- #


class TestOperands:
    def test_const_operand(self) -> None:
        op = parse_operand(42)
        assert isinstance(op, ConstOperand)
        ctx = _ctx({"close": 1.0})
        assert op.value(ctx) == 42.0
        assert op.prev_value(ctx) == 42.0

    def test_bar_field_operand(self) -> None:
        op = parse_operand("close")
        assert isinstance(op, BarFieldOperand)
        ctx = _ctx({"close": 10.0}, prev={"close": 9.0})
        assert op.value(ctx) == 10.0
        assert op.prev_value(ctx) == 9.0

    def test_indicator_operand_primary(self) -> None:
        op = parse_operand("sma_20")
        assert isinstance(op, IndicatorOperand)
        assert op.timeframe is None
        assert op.primary_requests() == {"sma_20"}
        assert op.higher_tf_columns() == set()
        assert op.value(_ctx({"sma_20": 5.5})) == 5.5

    def test_indicator_operand_multi_timeframe(self) -> None:
        op = parse_operand({"indicator": "rsi", "timeframe": "1hour"})
        assert isinstance(op, IndicatorOperand)
        assert op.column == "rsi@1hour"
        # A higher-TF operand needs no primary indicator, but flags the (tf, col).
        assert op.primary_requests() == set()
        assert op.higher_tf_columns() == {("1hour", "rsi")}
        assert op.value(_ctx({"rsi@1hour": 55.0})) == 55.0

    def test_position_operands(self) -> None:
        pos = Position(size=100.0, avg_price=10.0, last_price=11.0)
        ctx = _ctx({"close": 11.0}, position=pos)
        assert parse_operand("position.size").value(ctx) == 100.0
        assert parse_operand("position.avg_price").value(ctx) == 10.0
        assert parse_operand("position.unrealized_pct").value(ctx) == pytest.approx(10.0)

    def test_position_unrealized_pct_flat_is_zero(self) -> None:
        assert Position(size=0.0, avg_price=10.0, last_price=99.0).unrealized_pct == 0.0

    def test_position_unrealized_pct_short(self) -> None:
        # Short: price falling is a gain.
        pos = Position(size=-50.0, avg_price=10.0, last_price=9.0)
        assert pos.unrealized_pct == pytest.approx(10.0)

    def test_missing_column_is_nan(self) -> None:
        assert np.isnan(parse_operand("sma_20").value(_ctx({"close": 1.0})))

    @pytest.mark.parametrize("bad", [True, {"nope": 1}, [1, 2], "position.bogus", "unknown_ind"])
    def test_invalid_operands_raise(self, bad: object) -> None:
        with pytest.raises(RuleSetError):
            parse_operand(bad)


# --------------------------------------------------------------------------- #
# Operators
# --------------------------------------------------------------------------- #


class TestOperators:
    @pytest.mark.parametrize(
        "op,left,right,expected",
        [
            (">", 2.0, 1.0, True),
            (">", 1.0, 2.0, False),
            ("<", 1.0, 2.0, True),
            (">=", 2.0, 2.0, True),
            ("<=", 2.0, 2.0, True),
            ("<=", 3.0, 2.0, False),
        ],
    )
    def test_comparisons(self, op: str, left: float, right: float, expected: bool) -> None:
        cond = Condition(ConstOperand(left), op, ConstOperand(right))
        assert cond.evaluate(_ctx({"close": 1.0})) is expected

    def test_comparison_with_nan_is_false(self) -> None:
        cond = Condition(parse_operand("sma_20"), ">", ConstOperand(1.0))
        assert cond.evaluate(_ctx({"close": 1.0})) is False  # sma_20 missing -> NaN

    def test_crosses_above(self) -> None:
        cond = Condition(parse_operand("sma_20"), "crosses_above", parse_operand("sma_50"))
        # prev: fast <= slow, now: fast > slow -> cross up
        assert cond.evaluate(_ctx({"sma_20": 11, "sma_50": 10}, prev={"sma_20": 9, "sma_50": 10}))
        # already above on the previous bar -> not a fresh cross
        assert not cond.evaluate(
            _ctx({"sma_20": 11, "sma_50": 10}, prev={"sma_20": 10.5, "sma_50": 10})
        )

    def test_crosses_below(self) -> None:
        cond = Condition(parse_operand("sma_20"), "crosses_below", parse_operand("sma_50"))
        assert cond.evaluate(_ctx({"sma_20": 9, "sma_50": 10}, prev={"sma_20": 11, "sma_50": 10}))

    def test_cross_without_prev_is_false(self) -> None:
        cond = Condition(parse_operand("sma_20"), "crosses_above", parse_operand("sma_50"))
        assert cond.evaluate(_ctx({"sma_20": 11, "sma_50": 10}, prev=None)) is False


# --------------------------------------------------------------------------- #
# Groups + compiler
# --------------------------------------------------------------------------- #


class TestCompiler:
    def test_all_group(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "t",
                "entry": {
                    "all": [
                        {"left": "close", "op": ">", "right": 10},
                        {"left": "close", "op": "<", "right": 20},
                    ]
                },
                "exit": {"any": [{"left": "close", "op": ">", "right": 100}]},
            }
        )
        assert strat.entry.evaluate(_ctx({"close": 15})) is True
        assert strat.entry.evaluate(_ctx({"close": 25})) is False

    def test_nested_groups(self) -> None:
        group = compile_rule_strategy(
            {
                "name": "t",
                "entry": {
                    "any": [
                        {"left": "close", "op": ">", "right": 100},
                        {
                            "all": [
                                {"left": "close", "op": ">", "right": 5},
                                {"left": "close", "op": "<", "right": 9},
                            ]
                        },
                    ]
                },
            }
        ).entry
        assert group.evaluate(_ctx({"close": 7})) is True  # inner all matches
        assert group.evaluate(_ctx({"close": 50})) is False

    def test_indicator_requests_resolved(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "t",
                "indicators": ["rsi"],
                "entry": {"all": [{"left": "sma_20", "op": ">", "right": "sma_50"}]},
                "exit": {"all": [{"left": "macd", "op": ">", "right": 0}]},
            }
        )
        # sma_20 + sma_50 from operands, rsi declared, macd from the exit operand.
        assert set(strat.indicators) == {"sma_20", "sma_50", "rsi", "macd"}

    def test_higher_tf_requirements_collected(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "t",
                "entry": {
                    "all": [
                        {"left": {"indicator": "rsi", "timeframe": "1hour"}, "op": "<", "right": 60}
                    ]
                },
            }
        )
        assert strat._higher_tf_columns == {"1hour": {"rsi"}}
        assert strat.indicators == []  # higher-TF indicators aren't primary requests

    def test_missing_entry_raises(self) -> None:
        with pytest.raises(RuleSetError):
            compile_rule_strategy({"name": "t"})

    def test_unknown_operator_raises(self) -> None:
        with pytest.raises(RuleSetError):
            compile_rule_strategy(
                {"name": "t", "entry": {"all": [{"left": "close", "op": "~=", "right": 1}]}}
            )

    def test_unknown_declared_indicator_raises(self) -> None:
        with pytest.raises(RuleSetError):
            compile_rule_strategy({"name": "t", "indicators": ["not_real"], "entry": {"all": []}})

    def test_group_with_both_all_and_any_raises(self) -> None:
        with pytest.raises(RuleSetError):
            compile_rule_strategy({"name": "t", "entry": {"all": [], "any": []}})

    def test_invalid_sizing_and_scale_out_raise(self) -> None:
        base = {"name": "t", "entry": {"all": [{"left": "close", "op": ">", "right": 1}]}}
        with pytest.raises(RuleSetError):
            compile_rule_strategy({**base, "sizing": {"type": "bogus"}})
        with pytest.raises(RuleSetError):
            compile_rule_strategy({**base, "scale_out": [{"reduce_pct": 50}]})  # no 'when'

    def test_empty_group_is_vacuously_false(self) -> None:
        strat = compile_rule_strategy({"name": "t", "entry": {"all": []}})
        assert strat.entry.evaluate(_ctx({"close": 1})) is False


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #


class TestSessions:
    def test_no_sessions_is_always_in(self) -> None:
        idx = pd.date_range("2024-06-03", periods=5, freq="h")
        assert session_mask(idx, []).all()

    def test_time_of_day_window(self) -> None:
        # Naive index is treated as UTC; window is in UTC for a clean assertion.
        idx = pd.to_datetime(["2024-06-03 08:00", "2024-06-03 10:00", "2024-06-03 16:00"])  # Monday
        win = [
            SessionWindow(
                tz="UTC",
                days=set(),
                start=pd.Timestamp("09:00").time(),
                end=pd.Timestamp("15:30").time(),
            )
        ]
        assert list(session_mask(idx, win)) == [False, True, False]

    def test_day_of_week_gating(self) -> None:
        # 2024-06-08 is a Saturday, 2024-06-10 a Monday.
        idx = pd.to_datetime(["2024-06-08 10:00", "2024-06-10 10:00"])
        win = [
            SessionWindow(
                tz="UTC",
                days={0},
                start=pd.Timestamp("09:00").time(),
                end=pd.Timestamp("15:00").time(),
            )
        ]
        assert list(session_mask(idx, win)) == [False, True]

    def test_timezone_conversion(self) -> None:
        # 14:00 UTC == 10:00 America/New_York (EDT) — inside a 09:30-16:00 NY window.
        idx = pd.to_datetime(["2024-06-03 14:00"])
        win = [
            SessionWindow(
                tz="America/New_York",
                days=set(),
                start=pd.Timestamp("09:30").time(),
                end=pd.Timestamp("16:00").time(),
            )
        ]
        assert bool(session_mask(idx, win)[0]) is True

    def test_flat_at_session_end_forces_sell(self) -> None:
        # Two bars in-session then one out; the last in-session bar must sell.
        idx = pd.to_datetime(["2024-06-03 10:00", "2024-06-03 10:05", "2024-06-03 18:00"])
        strat = compile_rule_strategy(
            {
                "name": "t",
                "timeframe": "5min",
                "sessions": [{"tz": "UTC", "from": "09:00", "to": "15:00"}],
                "flat_at_session_end": True,
                "entry": {"all": [{"left": "close", "op": ">", "right": 1_000_000}]},  # never
            }
        )
        df = pd.DataFrame(
            {"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1},
            index=idx,
        )
        signals = strat.generate_signals(df)
        assert list(signals["sell_signal"]) == [False, True, False]


# --------------------------------------------------------------------------- #
# Multi-timeframe merge
# --------------------------------------------------------------------------- #


class TestMultiTimeframeMerge:
    def test_higher_tf_column_has_no_lookahead(self) -> None:
        # 90 one-minute bars; a rule references sma_20@1hour. The first hourly
        # bar closes at 01:00, so bars before that must have NaN for the merged
        # column (no look-ahead), and from 01:00 on it must be populated.
        idx = pd.date_range("2024-06-03 00:00", periods=90, freq="1min")
        close = np.linspace(100.0, 130.0, len(idx))
        df = pd.DataFrame(
            {"open": close, "high": close, "low": close, "close": close, "volume": 1.0},
            index=idx,
        )
        strat = compile_rule_strategy(
            {
                "name": "t",
                "timeframe": "1min",
                "entry": {
                    "all": [
                        {
                            "left": "close",
                            "op": ">",
                            "right": {"indicator": "sma_20", "timeframe": "1hour"},
                        }
                    ]
                },
            }
        )
        signals = strat.generate_signals(df)
        col = "sma_20@1hour"
        assert col in signals.columns
        before_close = signals.loc[: pd.Timestamp("2024-06-03 00:59"), col]
        after_close = signals.loc[pd.Timestamp("2024-06-03 01:00") :, col]
        assert before_close.isna().all()
        assert after_close.notna().all()


# --------------------------------------------------------------------------- #
# Registry + examples
# --------------------------------------------------------------------------- #


class TestExampleRegistry:
    def test_examples_registered(self) -> None:
        for key in RULE_STRATEGY_EXAMPLES:
            assert key in AVAILABLE_STRATEGIES

    def test_example_classes_are_zero_arg_and_expose_catalogue_fields(self) -> None:
        # The catalogue endpoint does exactly this: instantiate with no args and
        # read name / indicators / __doc__.
        for key in RULE_STRATEGY_EXAMPLES:
            strat = AVAILABLE_STRATEGIES[key]()
            assert isinstance(strat, RuleStrategy)
            assert strat.name
            assert isinstance(strat.indicators, list)
            assert strat.__doc__

    def test_showcase_has_multi_tf_session_and_position_rules(self) -> None:
        strat = AVAILABLE_STRATEGIES["rule_mtf_session"]()
        assert strat._higher_tf_columns == {"1hour": {"rsi"}}
        assert len(strat.sessions) == 1
        assert strat.flat_at_session_end is True
        assert strat.scale_out  # carried through for A3


# --------------------------------------------------------------------------- #
# SimpleMAStrategy parity
# --------------------------------------------------------------------------- #


class TestParity:
    @staticmethod
    def _rising_frame(n: int = 60) -> pd.DataFrame:
        close = np.linspace(100.0, 120.0, n)
        df = pd.DataFrame(
            {
                "open": close,
                "high": close + 0.5,
                "low": close - 0.5,
                "close": close,
                "volume": np.arange(1_000, 1_000 + n, dtype=float),
            }
        )
        df.index = pd.date_range("2024-01-01", periods=n, freq="D")
        return df

    def test_rule_set_matches_simple_ma_strategy(self) -> None:
        df = self._rising_frame()
        engine = BacktestEngine(initial_capital=100_000, commission=0.001)

        builtin = engine.run_backtest(df.copy(), SimpleMAStrategy(), symbol="TEST")
        rules = engine.run_backtest(
            df.copy(), compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET), symbol="TEST"
        )

        # Identical scalar results.
        assert rules.total_trades == builtin.total_trades
        assert rules.winning_trades == builtin.winning_trades
        assert rules.losing_trades == builtin.losing_trades
        assert rules.final_capital == pytest.approx(builtin.final_capital)
        assert rules.total_return_percent == pytest.approx(builtin.total_return_percent)

        # Identical equity curve.
        assert np.allclose(rules.equity_curve.to_numpy(), builtin.equity_curve.to_numpy())

        # Identical trades (entry/exit time, price, quantity, pnl) — only the
        # free-text reason strings differ between the two implementations.
        assert len(rules.trades) == len(builtin.trades)
        for rt, bt in zip(rules.trades, builtin.trades):
            assert rt.entry_time == bt.entry_time
            assert rt.exit_time == bt.exit_time
            assert rt.entry_price == pytest.approx(bt.entry_price)
            assert (rt.exit_price is None) == (bt.exit_price is None)
            if rt.exit_price is not None:
                assert rt.exit_price == pytest.approx(bt.exit_price)
            assert rt.quantity == bt.quantity
            assert rt.pnl == pytest.approx(bt.pnl)

    def test_compiled_result_is_json_serializable(self) -> None:
        import json

        df = self._rising_frame()
        engine = BacktestEngine(initial_capital=100_000, commission=0.001)
        results = engine.run_backtest(
            df.copy(), compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET), symbol="TEST"
        )
        json.dumps(results.to_dict(), allow_nan=False)


# --------------------------------------------------------------------------- #
# Live evaluation (A2 — RuleStrategy.evaluate)
# --------------------------------------------------------------------------- #


def _rising_ohlcv(n: int = 60) -> pd.DataFrame:
    close = np.linspace(100.0, 120.0, n)
    df = pd.DataFrame(
        {
            "open": close,
            "high": close + 0.5,
            "low": close - 0.5,
            "close": close,
            "volume": np.full(n, 1_000.0),
        }
    )
    df.index = pd.date_range("2024-01-01", periods=n, freq="D")
    return df


class TestEvaluate:
    def test_buy_when_flat_and_entry_fires(self) -> None:
        # Rising series -> sma_20 > sma_50 on the last bar; flat position -> buy.
        strat = compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET)
        result = strat.evaluate(_rising_ohlcv(), Position(size=0.0))
        assert result["signal"] == "buy"
        assert result["entry"] is True
        assert result["in_session"] is True

    def test_no_buy_when_already_long(self) -> None:
        # Entry rule includes position.size <= 0, so a long position blocks it.
        strat = compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET)
        result = strat.evaluate(_rising_ohlcv(), Position(size=100.0, avg_price=100.0))
        assert result["signal"] == "none"
        assert result["entry"] is False

    def test_sell_on_unrealized_stop_when_long(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "stop",
                "entry": {"all": [{"left": "close", "op": ">", "right": 1_000_000}]},  # never
                "exit": {"any": [{"left": "position.unrealized_pct", "op": "<=", "right": -2.0}]},
            }
        )
        # Long at avg 120, last close ~120 from the rising frame... make the loss
        # explicit: avg_price well above the last close.
        df = _rising_ohlcv()
        last_close = float(df["close"].iloc[-1])
        result = strat.evaluate(df, Position(size=100.0, avg_price=last_close * 1.05))
        assert result["exit"] is True
        assert result["signal"] == "sell"

    def test_no_sell_when_flat_even_if_exit_fires(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "always-exit",
                "entry": {"all": [{"left": "close", "op": ">", "right": 1_000_000}]},
                "exit": {"any": [{"left": "close", "op": ">", "right": 0}]},  # always
            }
        )
        result = strat.evaluate(_rising_ohlcv(), Position(size=0.0))
        assert result["exit"] is True
        assert result["signal"] == "none"  # nothing to sell

    def test_out_of_session_is_none(self) -> None:
        strat = compile_rule_strategy(
            {
                "name": "sess",
                "timeframe": "1day",
                "sessions": [
                    {"tz": "UTC", "from": "00:00", "to": "00:01"}
                ],  # never (daily 00:00 only)
                "entry": {"all": [{"left": "close", "op": ">", "right": 0}]},  # always, but gated
            }
        )
        # Daily bars stamped at 00:00 UTC actually fall in the 00:00-00:01 window,
        # so use an out-of-window intraday timestamp instead.
        df = _rising_ohlcv()
        df.index = pd.date_range("2024-01-01 12:00", periods=len(df), freq="D")
        result = strat.evaluate(df, Position(size=0.0))
        assert result["in_session"] is False
        assert result["signal"] == "none"

    def test_multi_timeframe_operand_resolved_in_evaluate(self) -> None:
        # evaluate() computes primary indicators itself and merges the 1h RSI.
        idx = pd.date_range("2024-06-03 00:00", periods=180, freq="5min")
        close = 100 + np.sin(np.linspace(0, 6, len(idx))) * 3
        df = pd.DataFrame(
            {"open": close, "high": close + 0.2, "low": close - 0.2, "close": close, "volume": 1.0},
            index=idx,
        )
        strat = compile_rule_strategy(
            {
                "name": "mtf",
                "timeframe": "5min",
                "entry": {
                    "all": [
                        {"left": {"indicator": "rsi", "timeframe": "1hour"}, "op": ">", "right": 0}
                    ]
                },
            }
        )
        result = strat.evaluate(df, Position(size=0.0))
        # The 1h RSI is defined well before the last bar, so the entry (rsi > 0)
        # resolves to a real boolean rather than being NaN-suppressed.
        assert result["entry"] is True

    def test_empty_frame_raises(self) -> None:
        strat = compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET)
        with pytest.raises(ValueError):
            strat.evaluate(pd.DataFrame())


# --------------------------------------------------------------------------- #
# Position-aware rules in the backtest (backtest == live parity)
# --------------------------------------------------------------------------- #


class TestPositionAwareBacktest:
    """The engine drives ``evaluate_bar`` with its running position.

    Before this, ``generate_signals`` ran once up front with a flat position, so
    every ``position.*`` operand read 0 on every bar and rules like a -2% stop
    could never fire in a backtest even though they fire live. These tests pin
    the position state actually reaching the rules.
    """

    @staticmethod
    def _frame(closes: list[float]) -> pd.DataFrame:
        close = np.array(closes, dtype=float)
        df = pd.DataFrame(
            {
                "open": close,
                "high": close + 0.5,
                "low": close - 0.5,
                "close": close,
                "volume": np.full(len(close), 1_000.0),
            }
        )
        df.index = pd.date_range("2024-01-01", periods=len(close), freq="D")
        return df

    # Enter whenever flat; exit only on a 2% unrealised loss.
    STOP_RULES = {
        "name": "Stop loss",
        "entry": {"all": [{"left": "position.size", "op": "<=", "right": 0}]},
        "exit": {"any": [{"left": "position.unrealized_pct", "op": "<=", "right": -2.0}]},
    }

    def test_unrealized_pct_stop_fires_during_a_backtest(self) -> None:
        # Enter at 100, then drift down: -1% at 99, -2% at 98 triggers the stop.
        df = self._frame([100.0, 100.0, 99.0, 98.0, 98.0, 97.0, 96.0, 96.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(self.STOP_RULES), symbol="TEST")

        # With a flat position the stop can never trigger, leaving a single
        # trade closed by the engine's end-of-backtest flatten.
        assert results.total_trades > 1
        stopped = [t for t in results.trades if "exit rules met" in (t.exit_reason or "")]
        assert stopped, "the -2% stop never fired"
        for trade in stopped:
            assert trade.pnl_percent <= -2.0

    def test_avg_price_is_threaded_into_the_rules(self) -> None:
        # Exit as soon as price trades below the average entry price — only
        # expressible if avg_price reaches the operand (it is 0 when flat).
        rules = {
            "name": "Below entry",
            "entry": {"all": [{"left": "position.size", "op": "<=", "right": 0}]},
            "exit": {"any": [{"left": "close", "op": "<", "right": "position.avg_price"}]},
        }
        df = self._frame([100.0, 101.0, 102.0, 99.0, 99.0, 98.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        assert any("exit rules met" in (t.exit_reason or "") for t in results.trades)

    def test_evaluate_bar_and_generate_signals_agree_when_flat(self) -> None:
        """The batch path is implemented in terms of ``evaluate_bar``, so a
        flat position must produce identical signals through either entry."""
        strat = compile_rule_strategy(MA_CROSSOVER_PARITY_RULE_SET)
        df = self._frame(list(np.linspace(100.0, 120.0, 60)))
        enriched = indicator_calculator.calculate_indicators(df, strat.indicators)

        batch = strat.generate_signals(enriched)
        signals, in_session = strat.prepare_stateful(enriched)

        for i in range(len(signals)):
            decision = strat.evaluate_bar(signals, i, in_session, 0.0, 0.0)
            assert decision["buy"] == bool(batch["buy_signal"].iloc[i])
            assert decision["sell"] == bool(batch["sell_signal"].iloc[i])


# --------------------------------------------------------------------------- #
# Sizing + scale-out simulated in the backtest (backtest == live parity)
# --------------------------------------------------------------------------- #


class TestSizingAndScaleOutBacktest:
    """A definition's ``sizing`` block and ``scale_out`` rungs affect the run.

    Before this, ``BacktestEngine`` was all-in / all-out: a strategy sized at
    100 shares backtested as though it bought the whole account, and a rung
    like "take half off at +3%" reduced nothing. A backtest could therefore
    disagree with a live run of the *same definition* even when every signal
    matched — the same silent-divergence shape as the position-aware gap above.
    """

    _frame = staticmethod(TestPositionAwareBacktest._frame)

    # Enter whenever flat; never exit on rules (the engine flattens at the end).
    _ENTRY_ONLY = {"all": [{"left": "position.size", "op": "<=", "right": 0}]}

    def test_fixed_sizing_is_honoured(self) -> None:
        rules = {"name": "Fixed 10", "entry": self._ENTRY_ONLY, "sizing": {"size": 10}}
        df = self._frame([100.0, 101.0, 102.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        assert [t.quantity for t in results.trades] == [10]

    def test_notional_sizing_converts_through_price(self) -> None:
        rules = {
            "name": "Notional 1000",
            "entry": self._ENTRY_ONLY,
            "sizing": {"type": "notional", "size": 1000},
        }
        df = self._frame([100.0, 101.0, 102.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        # 1000 / 100 = 10 whole units at the entry bar's close.
        assert [t.quantity for t in results.trades] == [10]

    def test_no_sizing_block_keeps_the_all_in_behaviour(self) -> None:
        """The built-in strategies declare no sizing; they must not change."""
        rules = {"name": "Unsized", "entry": self._ENTRY_ONLY}
        df = self._frame([100.0, 101.0, 102.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        assert [t.quantity for t in results.trades] == [1000]  # 100_000 / 100

    def test_scale_out_rung_takes_a_partial_profit(self) -> None:
        rules = {
            "name": "Half off at +3%",
            "entry": self._ENTRY_ONLY,
            "sizing": {"size": 100},
            "scale_out": [
                {
                    "when": {"left": "position.unrealized_pct", "op": ">=", "right": 3.0},
                    "reduce_pct": 50,
                }
            ],
        }
        # Enter at 100, reach +3% at 103, then run to 110.
        df = self._frame([100.0, 101.0, 103.0, 105.0, 110.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        scaled = [t for t in results.trades if "scale-out" in (t.exit_reason or "")]
        assert len(scaled) == 1, "the +3% rung did not fire"
        assert scaled[0].quantity == 50
        assert scaled[0].exit_price == 103.0
        # The remaining half rides to the end-of-backtest flatten at 110.
        remainder = [t for t in results.trades if t.exit_reason == "End of backtest"]
        assert [t.quantity for t in remainder] == [50]

    def test_a_rung_fires_at_most_once_per_trade(self) -> None:
        """Without per-trade rung tracking a threshold rung would re-fire on
        every subsequent bar that stayed past it and bleed the position out."""
        rules = {
            "name": "Half off at +3%",
            "entry": self._ENTRY_ONLY,
            "sizing": {"size": 100},
            "scale_out": [
                {
                    "when": {"left": "position.unrealized_pct", "op": ">=", "right": 3.0},
                    "reduce_pct": 50,
                }
            ],
        }
        # Six consecutive bars all sitting above +3%.
        df = self._frame([100.0, 104.0, 105.0, 106.0, 107.0, 108.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        scaled = [t for t in results.trades if "scale-out" in (t.exit_reason or "")]
        assert len(scaled) == 1

    def test_scale_out_is_inert_when_the_rung_never_triggers(self) -> None:
        rules = {
            "name": "Half off at +30%",
            "entry": self._ENTRY_ONLY,
            "sizing": {"size": 100},
            "scale_out": [
                {
                    "when": {"left": "position.unrealized_pct", "op": ">=", "right": 30.0},
                    "reduce_pct": 50,
                }
            ],
        }
        df = self._frame([100.0, 101.0, 102.0])
        engine = BacktestEngine(initial_capital=100_000, commission=0.0)

        results = engine.run_backtest(df, compile_rule_strategy(rules), symbol="TEST")

        assert [t.quantity for t in results.trades] == [100]

    def test_scale_out_operands_get_their_indicator_columns(self) -> None:
        """A rung may reference an indicator the entry/exit rules don't — it
        still has to be computed, or the rung silently evaluates against NaN."""
        strat = compile_rule_strategy(
            {
                "name": "ATR rung",
                "entry": self._ENTRY_ONLY,
                "scale_out": [
                    {"when": {"left": "atr", "op": ">", "right": 0}, "reduce_pct": 25},
                ],
            }
        )
        assert "atr" in strat.indicators

    def test_malformed_reduce_pct_is_rejected_at_compile_time(self) -> None:
        for bad in (0, -10, 150, "half"):
            with pytest.raises(RuleSetError):
                compile_rule_strategy(
                    {
                        "name": "Bad rung",
                        "entry": self._ENTRY_ONLY,
                        "scale_out": [
                            {
                                "when": {"left": "close", "op": ">", "right": 0},
                                "reduce_pct": bad,
                            }
                        ],
                    }
                )
