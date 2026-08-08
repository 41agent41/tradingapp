"""Tests for the connection manifest and the connection-keyed registry (C-1).

The behaviour under test is *routing*: which credentials a request reaches.
Getting that wrong sends an order to the wrong account, so the cases here lean
on the failure modes rather than the happy path — a malformed manifest must
fail loudly at startup, an unknown account must 400 rather than silently
falling through to the platform default, and a mode mismatch must refuse.

No venue is touched: adapters are constructed against fake URLs/credentials
and never called.
"""

from __future__ import annotations

import importlib
import json

import pytest
from fastapi import HTTPException


@pytest.fixture
def adapters_mod(monkeypatch):
    """A freshly-reloaded registry with every connection env var cleared, so
    each test declares its own topology and nothing leaks between them."""
    for name in (
        "BROKER_CONNECTIONS",
        "BROKER_CONNECTIONS_FILE",
        "MT5_BRIDGE_URL",
        "MT5_BRIDGE_SECRET",
        "ALPACA_API_KEY",
        "ALPACA_API_SECRET",
        "OANDA_API_TOKEN",
        "OANDA_ACCOUNT_ID",
        "LIVE_TRADING_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    import connections

    importlib.reload(connections)
    import adapters

    importlib.reload(adapters)
    return adapters


def _manifest(monkeypatch, adapters_mod, entries):
    monkeypatch.setenv("BROKER_CONNECTIONS", json.dumps(entries))
    adapters_mod.reset_registry()


MT5_A = {
    "id": "icmarkets-live",
    "platform": "mt5",
    "url": "http://10.0.0.1:9100",
    "secret_env": "SECRET_A",
    "account_mode": "live",
    "currency": "USD",
    "default": True,
}
MT5_B = {
    "id": "pepperstone-demo",
    "platform": "mt5",
    "url": "http://10.0.0.2:9100",
    "secret_env": "SECRET_B",
    "account_mode": "paper",
    "currency": "USD",
}


# --------------------------------------------------------------------------- #
# Backwards compatibility — the legacy single-account topology
# --------------------------------------------------------------------------- #
def test_no_manifest_yields_ib_default_only(adapters_mod):
    """A deployment that has never heard of the manifest keeps working."""
    adapter = adapters_mod.get_broker_adapter("ib")
    assert adapter.name == "ib"
    conn = adapters_mod.resolve_connection("ib")
    assert conn.account == "default"


def test_legacy_mt5_env_synthesises_one_connection(adapters_mod, monkeypatch):
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://legacy:9100")
    monkeypatch.setenv("MT5_BRIDGE_SECRET", "s3cret")
    adapters_mod.reset_registry()

    conn = adapters_mod.resolve_connection("mt5")
    assert conn.label == "mt5:default"
    assert conn.url == "http://legacy:9100"
    assert conn.secret == "s3cret"


def test_manifest_alongside_legacy_env_is_rejected(adapters_mod, monkeypatch):
    """Supporting both would need a precedence rule, and guessing wrong routes
    orders to the wrong account — so it is a startup failure instead."""
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://legacy:9100")
    _manifest(monkeypatch, adapters_mod, [MT5_A])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert exc.value.status_code == 500
    assert "legacy variable" in exc.value.detail


# --------------------------------------------------------------------------- #
# Multiple accounts on one platform — the point of the component
# --------------------------------------------------------------------------- #
def test_two_mt5_accounts_resolve_to_different_adapters(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    a = adapters_mod.get_broker_adapter("mt5", "icmarkets-live")
    b = adapters_mod.get_broker_adapter("mt5", "pepperstone-demo")

    assert a is not b
    # Each adapter must be pointed at its own sidecar with its own secret;
    # sharing either is how one account's orders reach the other.
    assert a._base == "http://10.0.0.1:9100"
    assert b._base == "http://10.0.0.2:9100"
    assert a._shared_secret == "aaa"
    assert b._shared_secret == "bbb"


def test_omitted_account_resolves_to_the_platform_default(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    assert adapters_mod.resolve_connection("mt5").account == "icmarkets-live"


def test_first_declared_becomes_default_when_none_marked(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [{**MT5_A, "default": False}, MT5_B])

    assert adapters_mod.resolve_connection("mt5").account == "icmarkets-live"


def test_two_defaults_on_one_platform_is_rejected(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, {**MT5_B, "default": True}])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert "default" in exc.value.detail


def test_unknown_account_is_400_naming_the_configured_ones(adapters_mod, monkeypatch):
    """Critically *not* a silent fall-through to the platform default."""
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("mt5", "ftmo-challenge")
    assert exc.value.status_code == 400
    assert "icmarkets-live" in exc.value.detail
    assert "pepperstone-demo" in exc.value.detail


def test_platform_with_no_connections_is_501(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    _manifest(monkeypatch, adapters_mod, [MT5_A])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("alpaca")
    assert exc.value.status_code == 501


def test_unknown_platform_is_still_400(adapters_mod):
    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("robinhood")
    assert exc.value.status_code == 400


# --------------------------------------------------------------------------- #
# account_mode as a binding constraint
# --------------------------------------------------------------------------- #
def test_live_order_to_a_paper_connection_is_refused(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("mt5", "pepperstone-demo", account_mode="live")
    assert exc.value.status_code == 409
    assert "paper" in exc.value.detail


def test_paper_order_to_a_live_connection_is_refused(adapters_mod, monkeypatch):
    """The inverse matters just as much: a paper order silently executing on a
    live account is the worse direction of the same mistake."""
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("mt5", "icmarkets-live", account_mode="paper")
    assert exc.value.status_code == 409


def test_matching_mode_is_allowed(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    _manifest(monkeypatch, adapters_mod, [MT5_A])

    assert adapters_mod.get_broker_adapter("mt5", "icmarkets-live", account_mode="live")


def test_omitted_mode_does_not_constrain(adapters_mod, monkeypatch):
    """Read paths (positions, quotes) pass no mode and must not be blocked."""
    monkeypatch.setenv("SECRET_A", "aaa")
    _manifest(monkeypatch, adapters_mod, [MT5_A])

    assert adapters_mod.get_broker_adapter("mt5", "icmarkets-live")


# --------------------------------------------------------------------------- #
# Manifest validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "entry,fragment",
    [
        ({"id": "x", "platform": "nasdaq"}, "unknown platform"),
        ({"id": "Bad Id", "platform": "mt5", "url": "http://x"}, "invalid id"),
        ({"id": "x", "platform": "mt5"}, "requires a 'url'"),
        ({"id": "x", "platform": "alpaca"}, "requires 'key_env'"),
        ({"id": "x", "platform": "oanda"}, "requires 'token_env'"),
        (
            {"id": "x", "platform": "mt5", "url": "http://x", "account_mode": "demo"},
            "invalid account_mode",
        ),
    ],
)
def test_malformed_entries_fail_loudly(adapters_mod, monkeypatch, entry, fragment):
    _manifest(monkeypatch, adapters_mod, [entry])
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert fragment in exc.value.detail


def test_duplicate_connection_is_rejected(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_A])
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert "duplicate" in exc.value.detail


def test_invalid_json_is_rejected(adapters_mod, monkeypatch):
    monkeypatch.setenv("BROKER_CONNECTIONS", "{not json")
    adapters_mod.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("ib")
    assert "not valid JSON" in exc.value.detail


def test_secrets_come_from_env_not_the_manifest(adapters_mod, monkeypatch):
    """The manifest names the variable; it never contains the value."""
    monkeypatch.setenv("SECRET_A", "from-the-environment")
    _manifest(monkeypatch, adapters_mod, [MT5_A])

    conn = adapters_mod.resolve_connection("mt5", "icmarkets-live")
    assert conn.secret == "from-the-environment"
    assert "from-the-environment" not in json.dumps(MT5_A)


# --------------------------------------------------------------------------- #
# same_funds_as — two routes to one pot of money
# --------------------------------------------------------------------------- #
def test_same_funds_groups_are_reported(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("TOKEN", "t")
    monkeypatch.setenv("ACCT", "a")
    _manifest(
        monkeypatch,
        adapters_mod,
        [
            {**MT5_A, "id": "oanda-mt5", "same_funds_as": "oanda-native"},
            {
                "id": "oanda-native",
                "platform": "oanda",
                "token_env": "TOKEN",
                "account_env": "ACCT",
            },
        ],
    )

    groups = adapters_mod.same_funds_groups()
    assert groups == [["mt5:oanda-mt5", "oanda:oanda-native"]]


def test_same_funds_as_must_reference_a_real_connection(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    _manifest(monkeypatch, adapters_mod, [{**MT5_A, "same_funds_as": "does-not-exist"}])
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert "unknown connection id" in exc.value.detail


# --------------------------------------------------------------------------- #
# Health surface
# --------------------------------------------------------------------------- #
def test_provider_health_reports_each_connection(adapters_mod, monkeypatch):
    monkeypatch.setenv("SECRET_A", "aaa")
    monkeypatch.setenv("SECRET_B", "bbb")
    _manifest(monkeypatch, adapters_mod, [MT5_A, MT5_B])

    health = adapters_mod.provider_health()

    assert health["providers"]["mt5"]["available"] is True
    assert health["providers"]["mt5"]["accounts"] == ["icmarkets-live", "pepperstone-demo"]
    assert health["providers"]["mt5"]["default_account"] == "icmarkets-live"
    assert health["connections"]["mt5:icmarkets-live"]["account_mode"] == "live"
    assert health["connections"]["mt5:pepperstone-demo"]["account_mode"] == "paper"
    # IB is absent from this manifest, so the platform is unavailable.
    assert health["providers"]["ib"]["available"] is False


def test_provider_health_reports_a_broken_manifest_without_500ing(adapters_mod, monkeypatch):
    """A health check that dies on a bad manifest tells the operator nothing."""
    monkeypatch.setenv("BROKER_CONNECTIONS", "[]")
    adapters_mod.reset_registry()

    health = adapters_mod.provider_health()
    assert "error" in health
    assert all(p["available"] is False for p in health["providers"].values())
