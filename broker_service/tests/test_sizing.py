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

from sizing import resolve_backtest_quantity, round_to_step


class TestFallsBackToTheEngineDefault:
    """`None` means "this block doesn't determine a size" — never an error."""

    @pytest.mark.parametrize("spec", [None, {}, {"size": 0}, {"size": None}, {"size": "abc"}])
    def test_an_absent_or_unset_size_defers(self, spec) -> None:
        quantity, _ = resolve_backtest_quantity(spec, price=100.0, equity=100_000.0)
        assert quantity is None

    @pytest.mark.parametrize("unit", ["lots", "units"])
    def test_a_unit_the_venue_does_not_trade_in_defers(self, unit: str) -> None:
        """With no spec the venue is whole shares, so a size declared in lots
        or units means something other than what it says — converting it would
        be a guess."""
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


class TestBrokerNativeUnits:
    """Sizing against a venue's own instrument spec.

    A standard FX lot: 0.01 minimum and step, 100,000 units of base currency
    per lot. That last factor is why lot sizing could never be approximated as
    shares — getting it wrong is a five-order-of-magnitude error.
    """

    LOT_SPEC = {"unit": "lots", "min_size": 0.01, "size_step": 0.01, "contract_size": 100_000}

    def test_fixed_size_is_taken_as_lots(self) -> None:
        quantity, reason = resolve_backtest_quantity(
            {"type": "fixed", "unit": "lots", "size": 0.5},
            price=1.1,
            equity=10_000.0,
            spec=self.LOT_SPEC,
        )
        assert quantity == 0.5
        assert "lots" in reason

    def test_notional_divides_by_price_and_contract_size(self) -> None:
        # 110_000 / (1.1 x 100_000) = 1.0 lots. Without the contract size this
        # would resolve to 100_000 lots — ten billion units of exposure.
        quantity, _ = resolve_backtest_quantity(
            {"type": "notional", "size": 110_000}, price=1.1, equity=10_000.0, spec=self.LOT_SPEC
        )
        assert quantity == 1.0

    def test_pct_equity_sizes_in_lots(self) -> None:
        quantity, _ = resolve_backtest_quantity(
            {"type": "pct_equity", "size": 50}, price=1.1, equity=10_000.0, spec=self.LOT_SPEC
        )
        assert quantity == 0.04

    def test_below_the_venue_minimum_is_no_trade(self) -> None:
        quantity, reason = resolve_backtest_quantity(
            {"type": "fixed", "size": 0.005}, price=1.1, equity=10_000.0, spec=self.LOT_SPEC
        )
        assert quantity == 0
        assert "minimum" in reason

    def test_floors_onto_the_step_rather_than_rounding_up(self) -> None:
        # 0.079 must become 0.07, never 0.08 — rounding up would trade more
        # than the strategy asked for.
        quantity, _ = resolve_backtest_quantity(
            {"type": "fixed", "size": 0.079}, price=1.1, equity=10_000.0, spec=self.LOT_SPEC
        )
        assert quantity == 0.07

    def test_clamps_to_the_venue_maximum(self) -> None:
        quantity, _ = resolve_backtest_quantity(
            {"type": "fixed", "size": 50},
            price=1.1,
            equity=10_000.0,
            spec={**self.LOT_SPEC, "max_size": 2},
        )
        assert quantity == 2.0

    def test_oanda_units_are_one_unit_of_base_currency(self) -> None:
        spec = {"unit": "units", "min_size": 1, "size_step": 1, "contract_size": 1}
        quantity, _ = resolve_backtest_quantity(
            {"type": "notional", "size": 1100}, price=1.1, equity=10_000.0, spec=spec
        )
        assert quantity == 1000

    def test_a_mismatched_unit_defers(self) -> None:
        quantity, reason = resolve_backtest_quantity(
            {"type": "fixed", "unit": "shares", "size": 100},
            price=1.1,
            equity=10_000.0,
            spec=self.LOT_SPEC,
        )
        assert quantity is None
        assert "lots" in reason


class TestRoundToStep:
    def test_floors_onto_the_step(self) -> None:
        assert round_to_step(10.9, 1) == 10
        assert round_to_step(0.079, 0.01) == 0.07

    def test_survives_binary_floating_point_at_the_boundary(self) -> None:
        # 0.07 / 0.01 is 6.999999999999999 in IEEE754 — a naive floor loses a
        # whole step.
        assert round_to_step(0.07, 0.01) == 0.07
        assert round_to_step(0.3, 0.1) == 0.3

    def test_passes_through_a_meaningless_step(self) -> None:
        assert round_to_step(1.234, 0) == 1.234
