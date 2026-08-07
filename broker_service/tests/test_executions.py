"""Unit tests for the execution (fill) normalisation layer.

The fills feed is what replaces the audit-log *estimate* of a position with the
venue's own record of what traded, so the normalisation has to be right about
exactly the things that used to be wrong: IB's unset-double sentinel leaking
into P&L sums, and its execution timestamps being read as UTC when they are
actually in the Gateway's timezone.

Everything here is hermetic — no IB Gateway, no network.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from executions import (
    IB_UNSET_DOUBLE,
    finite_or_none,
    normalise_ib_execution,
    parse_ib_exec_time,
)


def _execution(**overrides):
    base = {
        "execId": "0000e1a7.68f2c0a1.01.01",
        "orderId": 42,
        "side": "BOT",
        "shares": 100,
        "price": 250.5,
        "time": "20260807 12:30:45",
        "acctNumber": "DU1234567",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _contract(symbol="MSFT", currency="USD"):
    return SimpleNamespace(symbol=symbol, currency=currency)


def _commission(commission=1.25, realized=17.5):
    return SimpleNamespace(execId="x", commission=commission, realizedPNL=realized)


class TestFiniteOrNone:
    def test_passes_a_real_number_through(self) -> None:
        assert finite_or_none(1.25) == 1.25
        assert finite_or_none("2.5") == 2.5
        assert finite_or_none(0) == 0.0

    def test_ib_unset_sentinel_becomes_none(self) -> None:
        """The whole point: persisting 1.79e308 as a commission would poison
        every downstream P&L sum rather than fail loudly."""
        assert finite_or_none(IB_UNSET_DOUBLE) is None
        assert finite_or_none(-IB_UNSET_DOUBLE) is None

    def test_unusable_values_become_none(self) -> None:
        for value in (None, "", "abc", float("nan"), float("inf")):
            assert finite_or_none(value) is None


class TestParseIbExecTime:
    @pytest.mark.parametrize(
        "raw",
        ["20260807  12:30:45", "20260807 12:30:45", "20260807-12:30:45"],
    )
    def test_every_ib_wire_format_parses(self, raw: str, monkeypatch) -> None:
        """IB's format has drifted across API versions; all of them must land
        on the same instant rather than falling back to `now`."""
        monkeypatch.setenv("IB_TIMEZONE", "UTC")
        assert parse_ib_exec_time(raw).startswith("2026-08-07T12:30:45")

    def test_a_naive_timestamp_is_read_in_the_gateway_timezone(self, monkeypatch) -> None:
        """Reading a Gateway-local timestamp as UTC would shift every fill by
        the account's offset — silently, and differently in summer."""
        monkeypatch.setenv("IB_TIMEZONE", "America/New_York")
        # 12:30:45 EDT (UTC-4 in August) == 16:30:45 UTC.
        assert parse_ib_exec_time("20260807 12:30:45").startswith("2026-08-07T16:30:45+00:00")

    def test_an_explicit_timezone_on_the_wire_wins(self, monkeypatch) -> None:
        monkeypatch.setenv("IB_TIMEZONE", "UTC")
        parsed = parse_ib_exec_time("20260807-12:30:45 America/New_York")
        assert parsed.startswith("2026-08-07T16:30:45+00:00")

    def test_an_unknown_timezone_falls_back_to_utc(self, monkeypatch) -> None:
        monkeypatch.setenv("IB_TIMEZONE", "Mars/Olympus_Mons")
        assert parse_ib_exec_time("20260807 12:30:45").startswith("2026-08-07T12:30:45+00:00")

    def test_an_unparseable_value_does_not_raise(self) -> None:
        # One malformed fill must not sink the whole batch.
        assert parse_ib_exec_time("not a timestamp")
        assert parse_ib_exec_time(None)


class TestNormaliseIbExecution:
    def test_a_buy_fill_normalises(self, monkeypatch) -> None:
        monkeypatch.setenv("IB_TIMEZONE", "UTC")
        row = normalise_ib_execution(_contract(), _execution(), _commission())

        assert row == {
            "exec_id": "0000e1a7.68f2c0a1.01.01",
            "order_id": "42",
            "symbol": "MSFT",
            "side": "BUY",
            "quantity": 100.0,
            "price": 250.5,
            "commission": 1.25,
            "realized_pnl": 17.5,
            "executed_at": "2026-08-07T12:30:45+00:00",
            "account": "DU1234567",
            "currency": "USD",
            "broker": "ib",
        }

    def test_sld_maps_to_sell_with_a_positive_quantity(self) -> None:
        """Direction lives in `side`; `quantity` is always a magnitude, so the
        backend's signed running position is the single place sign is applied."""
        row = normalise_ib_execution(_contract(), _execution(side="SLD", shares=25))

        assert row["side"] == "SELL"
        assert row["quantity"] == 25.0

    def test_a_fill_without_its_commission_report_is_still_a_fill(self) -> None:
        """The two callbacks are independent and can arrive in either order —
        withholding the fill until the commission lands would lose it."""
        row = normalise_ib_execution(_contract(), _execution(), None)

        assert row["exec_id"]
        assert row["commission"] is None
        assert row["realized_pnl"] is None

    def test_unset_commission_sentinels_are_stripped(self) -> None:
        row = normalise_ib_execution(
            _contract(),
            _execution(),
            _commission(commission=IB_UNSET_DOUBLE, realized=IB_UNSET_DOUBLE),
        )

        assert row["commission"] is None
        assert row["realized_pnl"] is None
