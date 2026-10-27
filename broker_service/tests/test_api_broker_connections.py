"""IG and cTrader connections: what each needs, and which server it reaches."""

from __future__ import annotations

import pytest

import adapters
import connections

IG = {
    "id": "ig-demo",
    "platform": "ig",
    "api_key": "key",
    "username": "trader",
    "api_secret": "password",
}
CTRADER = {
    "id": "icmarkets",
    "platform": "ctrader",
    "api_key": "client-id",
    "api_secret": "client-secret",
    "token": "access",
    "account_id": "424242",
}


def test_ig_connection_parses_with_its_username():
    (conn,) = connections.parse_managed([IG])
    assert conn.username == "trader"
    assert conn.api_secret == "password"


@pytest.mark.parametrize("missing", ["api_key", "username", "api_secret"])
def test_ig_requires_each_credential(missing):
    with pytest.raises(connections.ManifestError, match="ig requires"):
        connections.parse_managed([{**IG, missing: ""}])


@pytest.mark.parametrize("missing", ["api_key", "api_secret", "token", "account_id"])
def test_ctrader_requires_each_credential(missing):
    with pytest.raises(connections.ManifestError, match="ctrader requires"):
        connections.parse_managed([{**CTRADER, missing: ""}])


def test_ctrader_refuses_a_login_for_the_account_id():
    with pytest.raises(connections.ManifestError, match="ctidTraderAccountId"):
        connections.parse_managed([{**CTRADER, "account_id": "icm-5150"}])


@pytest.mark.parametrize("entry", [IG, CTRADER])
def test_mode_picks_the_server(entry):
    (paper,) = connections.parse_managed([entry])
    (live,) = connections.parse_managed([{**entry, "account_mode": "live"}])
    assert adapters._server(paper) == "demo"
    assert adapters._server(live) == "live"


def test_a_manifest_entry_without_an_environment_follows_its_mode():
    conn = connections.Connection(account="x", platform="ig", account_mode="live")
    assert adapters._server(conn) == "live"


def test_adapters_are_built_for_both():
    ig = adapters._build_adapters(connections.parse_managed([IG])[0])[1]
    ctrader = adapters._build_adapters(connections.parse_managed([CTRADER])[0])[1]
    assert ig.name == "ig" and ig._base.startswith("https://demo-api.ig.com")
    assert ctrader.name == "ctrader" and ctrader._url.startswith("wss://demo.")
