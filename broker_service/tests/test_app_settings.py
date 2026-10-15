"""Settings the backend sends from its Settings page (app_settings.py).

.env wins setting by setting; until the backend has sent anything, live
trading is off; the values arrive with the managed connections push.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import app_settings

_ENV = app_settings.KEYS + ("BROKER_CONNECTIONS", "BROKER_CONNECTIONS_FILE", "BROKER_PRIORITY")


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    app_settings.reset()
    yield
    app_settings.reset()


def test_live_trading_is_off_until_the_backend_says_otherwise():
    assert app_settings.live_trading_enabled() is False
    app_settings.apply({"LIVE_TRADING_ENABLED": "true"})
    assert app_settings.live_trading_enabled() is True
    app_settings.apply({})
    assert app_settings.live_trading_enabled() is False


def test_env_wins_over_the_backend(monkeypatch):
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "false")
    app_settings.apply({"LIVE_TRADING_ENABLED": "true"})
    assert app_settings.live_trading_enabled() is False


def test_unknown_and_empty_keys_are_ignored():
    app_settings.apply(
        {"APP_PASSWORD": "x", "DEFAULT_BROKER": "  ", "PORTFOLIO_BASE_CURRENCY": "usd"}
    )
    assert app_settings.get("APP_PASSWORD") is None
    assert app_settings.get("DEFAULT_BROKER") is None
    assert app_settings.get("PORTFOLIO_BASE_CURRENCY") == "usd"


def test_order_wait_falls_back_on_a_bad_value():
    assert app_settings.order_place_wait_seconds() == 3
    app_settings.apply({"ORDER_PLACE_WAIT_SECONDS": "1"})
    assert app_settings.order_place_wait_seconds() == 1
    app_settings.apply({"ORDER_PLACE_WAIT_SECONDS": "soon"})
    assert app_settings.order_place_wait_seconds() == 3


def test_the_order_gate_follows_the_backend():
    import orders

    with pytest.raises(HTTPException) as exc:
        orders._validate_common("BUY", "MKT", "DAY", "live")
    assert exc.value.status_code == 403
    app_settings.apply({"LIVE_TRADING_ENABLED": "true"})
    orders._validate_common("BUY", "MKT", "DAY", "live")


def test_managed_push_carries_the_settings():
    import managed

    managed.reset()
    managed.apply(
        {
            "revision": "r1",
            "connections": [],
            "settings": {"LIVE_TRADING_ENABLED": "true", "DEFAULT_BROKER": "oanda"},
        }
    )
    assert app_settings.live_trading_enabled() is True
    import connections

    assert connections.default_platform([]) == "oanda"
    managed.reset()
    assert app_settings.live_trading_enabled() is False


def test_broker_check_and_poll_intervals_come_from_the_backend():
    assert app_settings.probe_interval_seconds() == 60
    assert app_settings.stream_poll_seconds() == 2.0
    app_settings.apply({"BROKER_PROBE_INTERVAL_SECONDS": "0", "STREAM_POLL_SECONDS": "0.5"})
    assert app_settings.probe_interval_seconds() == 0
    assert app_settings.stream_poll_seconds() == 0.5
    app_settings.apply({"BROKER_PROBE_INTERVAL_SECONDS": "x", "STREAM_POLL_SECONDS": "-1"})
    assert app_settings.probe_interval_seconds() == 60
    assert app_settings.stream_poll_seconds() == 2.0


def test_the_poll_interval_is_read_on_every_wait():
    from venue_streaming import VenueStreamer

    streamer = VenueStreamer()
    app_settings.apply({"STREAM_POLL_SECONDS": "5"})
    assert streamer.poll_seconds == 5.0
    app_settings.apply({"STREAM_POLL_SECONDS": "1"})
    assert streamer.poll_seconds == 1.0
    assert VenueStreamer(poll_seconds=0.01).poll_seconds == 0.01
