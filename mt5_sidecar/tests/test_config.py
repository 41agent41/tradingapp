"""Startup settings: the sidecar refuses configurations that would expose the account."""

from __future__ import annotations

import pytest

from config import ConfigError, load_config, read_env_file


def test_loopback_without_secret_is_allowed():
    cfg = load_config({})
    assert cfg.host == "127.0.0.1"
    assert cfg.secret == ""


def test_network_listener_requires_a_secret():
    with pytest.raises(ConfigError, match="MT5_BRIDGE_SECRET is required"):
        load_config({"MT5_SIDECAR_HOST": "0.0.0.0"})


def test_short_secret_is_refused():
    with pytest.raises(ConfigError, match="at least 24"):
        load_config({"MT5_BRIDGE_SECRET": "short"})


def test_unknown_time_zone_is_refused():
    with pytest.raises(ConfigError, match="MT5_SERVER_TZ"):
        load_config({"MT5_SERVER_TZ": "Mars/Olympus"})


def test_settings_are_read():
    cfg = load_config(
        {
            "MT5_BRIDGE_SECRET": "x" * 24,
            "MT5_SIDECAR_HOST": "0.0.0.0",
            "MT5_SIDECAR_PORT": "9101",
            "MT5_LOGIN": "123",
            "MT5_SERVER": "Broker-Demo",
            "MT5_MAGIC": "77",
            "MT5_SERVER_TZ": "Europe/Athens",
            "MT5_ALLOW_REAL": "true",
        }
    )
    assert (cfg.port, cfg.login, cfg.server, cfg.magic) == (9101, 123, "Broker-Demo", 77)
    assert cfg.server_tz == "Europe/Athens"
    assert cfg.allow_real is True


def test_real_money_is_off_by_default():
    assert load_config({}).allow_real is False


def test_env_file(tmp_path):
    path = tmp_path / "sidecar.env"
    path.write_text('# comment\n\nMT5_LOGIN=123\nMT5_PASSWORD="p=w"\nnot a setting\n')
    assert read_env_file(str(path)) == {"MT5_LOGIN": "123", "MT5_PASSWORD": "p=w"}
    assert read_env_file(str(tmp_path / "missing.env")) == {}
