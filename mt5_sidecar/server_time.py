"""Conversion between MT5 server time and real UTC.

The MetaTrader5 package returns bar, tick and deal times as unix seconds, but
the clock behind them is the trade server's wall clock, not UTC: a broker on
GMT+2 reports 12:00 UTC as 14:00 "UTC". Most retail brokers also switch
between GMT+2 and GMT+3 with daylight saving, so a fixed offset is wrong for
half the year. Converting through a named zone handles both.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo


class ServerClock:
    def __init__(self, zone: str) -> None:
        self._zone = ZoneInfo(zone)
        self._identity = zone.upper() in {"UTC", "ETC/UTC", "GMT", "ETC/GMT"}

    def to_utc(self, server_seconds: float) -> float:
        """A time the terminal reported → real unix seconds (UTC)."""
        if self._identity:
            return float(server_seconds)
        wall = datetime.fromtimestamp(float(server_seconds), tz=UTC).replace(tzinfo=None)
        return wall.replace(tzinfo=self._zone).timestamp()

    def to_server(self, utc_seconds: float) -> float:
        """Real unix seconds (UTC) → the value the terminal expects."""
        if self._identity:
            return float(utc_seconds)
        wall = datetime.fromtimestamp(float(utc_seconds), tz=self._zone).replace(tzinfo=None)
        return wall.replace(tzinfo=UTC).timestamp()

    def server_datetime(self, utc_seconds: float) -> datetime:
        """The aware datetime to pass to ``copy_rates_range`` and friends."""
        return datetime.fromtimestamp(self.to_server(utc_seconds), tz=UTC)
