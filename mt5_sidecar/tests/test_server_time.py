"""Server-clock conversion: MT5 times are the server's wall clock, not UTC."""

from __future__ import annotations

from datetime import UTC, datetime

from server_time import ServerClock


def test_utc_is_identity():
    assert ServerClock("UTC").to_utc(1_700_000_000) == 1_700_000_000


def test_fixed_offset_is_removed():
    clock = ServerClock("Etc/GMT-2")  # POSIX sign: this is UTC+2
    assert clock.to_utc(1_700_000_000 + 7200) == 1_700_000_000
    assert clock.to_server(1_700_000_000) == 1_700_000_000 + 7200


def test_daylight_saving_changes_the_offset():
    clock = ServerClock("Europe/Athens")
    winter = datetime(2026, 1, 15, 12, tzinfo=UTC).timestamp()
    summer = datetime(2026, 7, 15, 12, tzinfo=UTC).timestamp()
    assert clock.to_server(winter) - winter == 2 * 3600
    assert clock.to_server(summer) - summer == 3 * 3600
    assert clock.to_utc(clock.to_server(summer)) == summer
