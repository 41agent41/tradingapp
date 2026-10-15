"""In-app broker connectivity checks (probes.py).

Deploy no longer tests brokers; the running service probes each configured
connection and reports the result. No venue is touched: adapters' probe()
methods are replaced, and the IB probe dials a local socket.
"""

from __future__ import annotations

import importlib
import socket

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

_ENV = (
    "BROKER_CONNECTIONS",
    "BROKER_CONNECTIONS_FILE",
    "MT5_BRIDGE_URL",
    "MT5_BRIDGE_SECRET",
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "OANDA_API_TOKEN",
    "OANDA_ACCOUNT_ID",
    "DEFAULT_BROKER",
    "IB_HOST",
    "BROKER_SERVICE_TOKEN",
)


@pytest.fixture
def registry(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    import connections

    importlib.reload(connections)
    import adapters

    importlib.reload(adapters)
    import probes

    probes.reset()

    def configure(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        adapters.reset_registry()
        return adapters, probes

    yield configure
    probes.reset()


def _oanda_and_ib():
    return {"OANDA_API_TOKEN": "tok", "OANDA_ACCOUNT_ID": "001", "IB_HOST": "127.0.0.1"}


def test_connected_and_unreachable_are_recorded(registry, monkeypatch):
    adapters, probes = registry(**_oanda_and_ib())
    import ib_adapter
    import oanda_adapter

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "probe", lambda self: None)

    def refused(self):
        raise HTTPException(503, "IB Gateway refused connection")

    monkeypatch.setattr(ib_adapter.IBAdapter, "probe", refused)

    results = probes.probe_all()
    assert results["oanda:default"]["status"] == "connected"
    assert results["oanda:default"]["error"] is None
    assert results["ib:default"]["status"] == "unreachable"
    assert results["ib:default"]["error"] == "IB Gateway refused connection"
    assert results["ib:default"]["checked_at"]

    health = adapters.provider_health()
    assert health["connections"]["oanda:default"]["check"]["status"] == "connected"
    assert health["connections"]["ib:default"]["check"]["status"] == "unreachable"


def test_unchecked_connection_reports_no_check(registry):
    adapters, _ = registry(OANDA_API_TOKEN="tok", OANDA_ACCOUNT_ID="001")
    assert adapters.provider_health()["connections"]["oanda:default"]["check"] is None


def test_a_removed_connection_is_forgotten(registry, monkeypatch):
    adapters, probes = registry(**_oanda_and_ib())
    import ib_adapter
    import oanda_adapter

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "probe", lambda self: None)
    monkeypatch.setattr(ib_adapter.IBAdapter, "probe", lambda self: None)
    probes.probe_all()
    monkeypatch.delenv("IB_HOST")
    adapters.reset_registry()
    assert set(probes.probe_all()) == {"oanda:default"}


def test_ib_probe_needs_ib_host(monkeypatch):
    import ib_adapter
    import ib_client

    monkeypatch.setattr(ib_client, "IB_HOST", None)
    monkeypatch.setattr(ib_client, "_ib_client", None)
    with pytest.raises(RuntimeError, match="IB_HOST"):
        ib_adapter.IBAdapter().probe()


def test_ib_probe_dials_the_gateway_port(monkeypatch):
    import ib_adapter
    import ib_client

    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    try:
        monkeypatch.setattr(ib_client, "IB_HOST", "127.0.0.1")
        monkeypatch.setattr(ib_client, "IB_PORT", server.getsockname()[1])
        monkeypatch.setattr(ib_client, "_ib_client", None)
        ib_adapter.IBAdapter().probe()
    finally:
        server.close()

    with pytest.raises(OSError):
        ib_adapter.IBAdapter().probe()  # nothing listening any more


def test_mt5_probe_calls_sidecar_health(monkeypatch):
    import mt5_adapter

    calls = []
    adapter = mt5_adapter.MT5Adapter("http://10.0.0.1:9100", shared_secret="s")
    monkeypatch.setattr(adapter, "_get", lambda path, params=None: calls.append(path) or {})
    adapter.probe()
    assert calls == ["/health"]


def test_status_and_test_routes(registry, monkeypatch):
    registry(**_oanda_and_ib())
    import ib_adapter
    import oanda_adapter

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "probe", lambda self: None)
    monkeypatch.setattr(ib_adapter.IBAdapter, "probe", lambda self: None)
    import main

    client = TestClient(main.app)

    status = client.get("/connections/status").json()
    assert status["default"] == "oanda"
    # Priority order: OANDA before IB.
    assert [c["label"] for c in status["connections"]] == ["oanda:default", "ib:default"]
    assert all(c["check"] is None for c in status["connections"])

    tested = client.post("/connections/ib:default/test").json()
    assert tested["check"]["status"] == "connected"
    after = client.get("/connections/status").json()
    assert after["connections"][1]["check"]["status"] == "connected"

    assert client.post("/connections/mt5:nope/test").status_code == 404


def test_probe_loop_skips_probing_while_the_interval_is_zero(monkeypatch):
    import asyncio

    import app_settings
    import probes

    monkeypatch.delenv("BROKER_PROBE_INTERVAL_SECONDS", raising=False)
    calls = []
    sleeps = []
    monkeypatch.setattr(probes, "probe_all", lambda: calls.append(1))

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 1:
            app_settings.apply({"BROKER_PROBE_INTERVAL_SECONDS": "7"})
        else:
            raise asyncio.CancelledError

    monkeypatch.setattr(probes.asyncio, "sleep", fake_sleep)
    app_settings.apply({"BROKER_PROBE_INTERVAL_SECONDS": "0"})
    try:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(probes.probe_loop())
    finally:
        app_settings.reset()
    assert calls == [1]
    assert sleeps == [probes._PAUSED_RECHECK_SECONDS, 7]
