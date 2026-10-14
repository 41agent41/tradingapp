"""Broker connections added on the Settings page (managed.py).

The backend sends them with their secrets; .env wins per platform; a bad
entry rejects the whole set; the broker priority chosen there reorders the
default unless BROKER_PRIORITY is in .env.
"""

from __future__ import annotations

import importlib
import time

import pytest
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
    "BROKER_PRIORITY",
    "IB_HOST",
    "BROKER_SERVICE_TOKEN",
)

OANDA = {
    "id": "practice",
    "platform": "oanda",
    "token": "tok",
    "account_id": "101-001",
    "environment": "practice",
}
ALPACA = {"id": "paper", "platform": "alpaca", "api_key": "k", "api_secret": "s"}


@pytest.fixture
def mods(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    import ib_client

    monkeypatch.setattr(ib_client, "IB_HOST", None)
    import connections

    importlib.reload(connections)
    import managed

    importlib.reload(managed)
    import adapters

    importlib.reload(adapters)
    import probes

    probes.reset()
    yield connections, managed, adapters
    managed.reset()
    adapters.reset_registry()
    probes.reset()


def test_app_connections_register_with_their_secrets(mods):
    _, managed, adapters = mods
    out = managed.apply({"revision": "r1", "connections": [OANDA, ALPACA]})
    assert out["connections"] == ["oanda:practice", "alpaca:paper"]

    labels = {c.label: c for c in adapters.list_connections()}
    assert set(labels) == {"oanda:practice", "alpaca:paper"}
    assert labels["oanda:practice"].token == "tok"
    assert labels["oanda:practice"].source == "app"
    assert labels["oanda:practice"].is_default  # the only one for its platform

    health = adapters.provider_health()
    assert health["default"] == "oanda"
    assert health["managed"] == {"revision": "r1", "overridden": []}
    assert health["connections"]["alpaca:paper"]["source"] == "app"
    assert "tok" not in str(health)  # secrets never reach /health


def test_env_wins_per_platform(mods, monkeypatch):
    _, managed, adapters = mods
    monkeypatch.setenv("OANDA_API_TOKEN", "envtok")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "env-acct")
    out = managed.apply({"revision": "r2", "connections": [OANDA, ALPACA]})
    assert out["overridden"] == ["oanda:practice"]

    labels = {c.label: c for c in adapters.list_connections()}
    assert set(labels) == {"oanda:default", "alpaca:paper"}
    assert labels["oanda:default"].source == "env"


def test_a_bad_entry_changes_nothing(mods):
    connections, managed, adapters = mods
    managed.apply({"revision": "good", "connections": [ALPACA]})
    with pytest.raises(connections.ManifestError, match="token and account id"):
        managed.apply({"revision": "bad", "connections": [ALPACA, {**OANDA, "token": ""}]})
    assert managed.revision() == "good"
    assert [c.label for c in adapters.list_connections()] == ["alpaca:paper"]


def test_priority_from_the_app_and_env(mods, monkeypatch):
    _, managed, adapters = mods
    managed.apply({"revision": "r", "priority": ["alpaca"], "connections": [OANDA, ALPACA]})
    health = adapters.provider_health()
    assert health["priority"] == ["alpaca", "oanda", "mt5", "ib"]
    assert health["default"] == "alpaca"
    assert health["priority_from_env"] is False

    monkeypatch.setenv("BROKER_PRIORITY", "oanda,alpaca")
    health = adapters.provider_health()
    assert health["priority"][:2] == ["oanda", "alpaca"]
    assert health["default"] == "oanda"
    assert health["priority_from_env"] is True


def test_app_ib_connection_points_the_gateway_client(mods):
    _, managed, adapters = mods
    import ib_client

    managed.apply(
        {
            "revision": "ib",
            "connections": [{"id": "gw", "platform": "ib", "host": "10.0.0.5", "port": "4001"}],
        }
    )
    assert (ib_client.IB_HOST, ib_client.IB_PORT) == ("10.0.0.5", 4001)
    assert [c.label for c in adapters.list_connections()] == ["ib:gw"]

    managed.apply({"revision": "none", "connections": []})
    assert ib_client.IB_HOST is None


def test_only_one_ib_connection(mods):
    connections, managed, _ = mods
    ib = {"platform": "ib", "host": "h"}
    with pytest.raises(connections.ManifestError, match="only one IB"):
        managed.apply({"connections": [{**ib, "id": "a"}, {**ib, "id": "b"}]})


def test_put_route(mods, monkeypatch):
    _, managed, _ = mods
    from fastapi import FastAPI

    import probes
    from routes.health import router

    # The router alone: importing main registers its metrics globally, which
    # the observability tests expect to do themselves.
    app = FastAPI()
    app.include_router(router)

    checked = []
    monkeypatch.setattr(probes, "probe_all", lambda: checked.append(True))

    client = TestClient(app)
    r = client.put("/connections/managed", json={"revision": "x", "connections": [ALPACA]})
    assert r.status_code == 200
    assert r.json()["connections"] == ["alpaca:paper"]
    # The new set is checked straight away, on a worker thread.
    deadline = time.monotonic() + 2
    while not checked and time.monotonic() < deadline:
        time.sleep(0.01)
    assert checked

    r = client.put(
        "/connections/managed", json={"connections": [{"id": "Bad!", "platform": "oanda"}]}
    )
    assert r.status_code == 422
    assert managed.revision() == "x"

    status = client.get("/connections/status").json()
    assert status["connections"][0]["source"] == "app"
