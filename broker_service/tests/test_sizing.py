"""Unit tests for backtest position sizing.

These pin the semantics the backtester shares with the live sizer
(`backend/src/services/orderSizing.ts`) — same three types, same whole-unit
floor — plus the one deliberate difference: an unresolvable size falls back to
the engine's default here rather than aborting, because a silent zero-trade
backtest reads as "the rules never fired" and hides the very divergence this
work exists to eliminate.
"""

from __future__ import annotations

import pytest

from sizing import resolve_backtest_quantity


class TestFallsBackToTheEngineDefault:
    """`None` means "this block doesn't determine a size" — never an error."""

    @pytest.mark.parametrize("spec", [None, {}, {"size": 0}, {"size": None}, {"size": "abc"}])
    def test_an_absent_or_unset_size_defers(self, spec) -> None:
        quantity, _ = resolve_backtest_quantity(spec, price=100.0, equity=100_000.0)
        assert quantity is None

    @pytest.mark.parametrize("unit", ["lots", "units"])
    def test_broker_native_units_are_not_simulated(self, unit: str) -> None:
        """MT5 lots and OANDA units have no share-equivalent conversion yet;
        pricing a lot as if it were a share would be worse than deferring."""
        quantity, reason = resolve_backtest_quantity(
            {"size": 2, "unit": unit}, price=100.0, equity=100_000.0
        )
        assert quantity is None
        assert unit in reason

    def test_an_unknown_type_defers(self) -> None:
        quantity, reason = resolve_backtest_quantity(
            {"type": "kelly", "size": 5}, price=100.0, equity=100_000.0
        )
        assert quantity is None
        assert "kelly" in reason


class TestFixed:
    def test_size_is_taken_outright(self) -> None:
        quantity, _ = resolve_backtest_quantity({"size": 100}, price=250.0, equity=100_000.0)
        assert quantity == 100

    def test_a_fractional_size_floors_to_whole_units(self) -> None:
        quantity, _ = resolve_backtest_quantity({"size": 10.9}, price=250.0, equity=100_000.0)
        assert quantity == 10


class TestNotional:
    def test_converts_through_price(self) -> None:
        quantity, _ = resolve_backtest_quantity(
            {"type": "notional", "size": 1000}, price=100.0, equity=100_000.0
        )
        assert quantity == 10

    def test_below_one_unit_is_no_trade_not_a_fraction(self) -> None:
        """Matches the live sizer's refusal to place a sub-minimum order."""
        quantity, reason = resolve_backtest_quantity(
            {"type": "notional", "size": 50}, price=100.0, equity=100_000.0
        )
        assert quantity == 0
        assert "minimum" in reason

    def test_a_non_positive_price_defers(self) -> None:
        quantity, _ = resolve_backtest_quantity(
            {"type": "notional", "size": 1000}, price=0.0, equity=100_000.0
        )
        assert quantity is None


class TestPctEquity:
    def test_scales_with_equity(self) -> None:
        # 10% of 100_000 = 10_000 at 250 -> 40 units.
        quantity, _ = resolve_backtest_quantity(
            {"type": "pct_equity", "size": 10}, price=250.0, equity=100_000.0
        )
        assert quantity == 40

    def test_shrinks_as_the_account_draws_down(self) -> None:
        """The point of pct_equity: the size must track the running equity the
        engine passes in, not the initial capital."""
        quantity, _ = resolve_backtest_quantity(
            {"type": "pct_equity", "size": 10}, price=250.0, equity=50_000.0
        )
        assert quantity == 20

    def test_non_positive_equity_defers(self) -> None:
        quantity, _ = resolve_backtest_quantity(
            {"type": "pct_equity", "size": 10}, price=250.0, equity=0.0
        )
        assert quantity is None
