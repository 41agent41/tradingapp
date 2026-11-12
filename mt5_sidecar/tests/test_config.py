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


# --- TLS (S-07) ----------------------------------------------------------- #
@pytest.fixture()
def tls_pair(tmp_path):
    import shutil
    import subprocess

    if shutil.which("openssl") is None:
        pytest.skip("needs openssl")
    cert, key = tmp_path / "sidecar.crt", tmp_path / "sidecar.key"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"]
        + ["-subj", "/CN=mt5-sidecar", "-keyout", str(key), "-out", str(cert)],
        check=True,
        capture_output=True,
    )
    return cert, key


def test_tls_is_off_unless_both_files_are_named():
    assert load_config({}).tls is False


def test_tls_needs_the_certificate_and_the_key_together(tls_pair):
    cert, key = tls_pair
    with pytest.raises(ConfigError, match="set together"):
        load_config({"MT5_TLS_CERT": str(cert)})
    with pytest.raises(ConfigError, match="set together"):
        load_config({"MT5_TLS_KEY": str(key)})


def test_a_missing_tls_file_is_refused(tls_pair, tmp_path):
    cert, _ = tls_pair
    with pytest.raises(ConfigError, match="MT5_TLS_KEY=.* is not a file"):
        load_config({"MT5_TLS_CERT": str(cert), "MT5_TLS_KEY": str(tmp_path / "nope.key")})


def test_the_fingerprint_matches_what_openssl_reports(tls_pair):
    import subprocess

    from config import tls_fingerprint

    cert, key = tls_pair
    cfg = load_config({"MT5_TLS_CERT": str(cert), "MT5_TLS_KEY": str(key)})
    assert cfg.tls is True
    reported = subprocess.run(
        ["openssl", "x509", "-in", str(cert), "-noout", "-fingerprint", "-sha256"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert reported.split("=", 1)[1] == tls_fingerprint(str(cert))


def test_a_file_that_is_not_a_certificate_has_no_fingerprint(tmp_path):
    from config import tls_fingerprint

    bad = tmp_path / "bad.crt"
    bad.write_text("not a certificate")
    with pytest.raises(ConfigError, match="no PEM certificate"):
        tls_fingerprint(str(bad))


def test_the_server_is_started_with_tls_and_logs_the_fingerprint(tls_pair, caplog):
    import logging

    from config import tls_fingerprint
    from server import tls_options

    cert, key = tls_pair
    cfg = load_config(
        {
            "MT5_BRIDGE_SECRET": "x" * 24,
            "MT5_SIDECAR_HOST": "0.0.0.0",
            "MT5_TLS_CERT": str(cert),
            "MT5_TLS_KEY": str(key),
        }
    )
    with caplog.at_level(logging.INFO, logger="mt5_sidecar"):
        assert tls_options(cfg) == {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    assert tls_fingerprint(str(cert)) in caplog.text


def test_a_network_listener_without_tls_is_warned_about(caplog):
    import logging

    from server import tls_options

    cfg = load_config({"MT5_BRIDGE_SECRET": "x" * 24, "MT5_SIDECAR_HOST": "0.0.0.0"})
    with caplog.at_level(logging.WARNING, logger="mt5_sidecar"):
        assert tls_options(cfg) == {}
    assert "TLS is off" in caplog.text
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="mt5_sidecar"):
        assert tls_options(load_config({})) == {}
    assert caplog.text == ""
