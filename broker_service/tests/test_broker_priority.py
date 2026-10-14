"""Broker priority and optional IB.

Brokers rank OANDA (and later API brokers), then MT5, IB and Alpaca. A request
that names no platform goes to the highest-ranked one that is configured, and
IB is only a connection when IB_HOST names a gateway. No venue is touched.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException

_ENV = (
    "BROKER_CONNECTIONS",
    "BROKER_CONNECTIONS_FILE",
    "MT5_BRIDGE_URL",
    "MT5_BRIDGE_SECRET",
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "OANDA_API_TOKEN",
    "OANDA_ACCOUNT_ID",
    "LIVE_TRADING_ENABLED",
    "DEFAULT_BROKER",
    "IB_HOST",
)


@pytest.fixture
def registry(monkeypatch):
    """A freshly-reloaded registry with no broker configured at all."""
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    import connections

    importlib.reload(connections)
    import adapters

    importlib.reload(adapters)

    def configure(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        adapters.reset_registry()
        return adapters

    return configure


def _oanda():
    return {"OANDA_API_TOKEN": "tok", "OANDA_ACCOUNT_ID": "001-001-1-001"}


def test_priority_order():
    import connections

    assert connections.BROKER_PRIORITY == ("oanda", "mt5", "ib", "alpaca")
    assert set(connections.BROKER_PRIORITY) == set(connections.SUPPORTED_PLATFORMS)


def test_ib_is_not_registered_without_ib_host(registry):
    adapters = registry()
    assert adapters.provider_health()["providers"]["ib"]["available"] is False
    with pytest.raises(HTTPException) as exc:
        adapters.get_broker_adapter("ib")
    assert exc.value.status_code == 501


@pytest.mark.parametrize("host", ["", "   ", "YOUR_IB_GATEWAY_IP"])
def test_placeholder_ib_host_is_not_configured(registry, host):
    adapters = registry(IB_HOST=host)
    assert adapters.provider_health()["providers"]["ib"]["available"] is False


def test_ib_is_registered_with_a_gateway_address(registry):
    adapters = registry(IB_HOST="10.7.3.21")
    assert adapters.get_broker_adapter("ib").name == "ib"
    assert adapters.default_provider() == "ib"


def test_oanda_outranks_ib(registry):
    adapters = registry(IB_HOST="10.7.3.21", **_oanda())
    assert adapters.default_provider() == "oanda"
    assert adapters.resolve_provider(None) == "oanda"
    assert adapters.resolve_provider("") == "oanda"
    # Naming a platform still reaches it.
    assert adapters.resolve_provider("ib") == "ib"


def test_mt5_outranks_ib_and_alpaca(registry):
    adapters = registry(
        IB_HOST="10.7.3.21",
        MT5_BRIDGE_URL="http://10.0.0.1:9100",
        MT5_BRIDGE_SECRET="s",
        ALPACA_API_KEY="k",
        ALPACA_API_SECRET="s",
    )
    assert adapters.default_provider() == "mt5"


def test_ib_outranks_alpaca(registry):
    adapters = registry(IB_HOST="10.7.3.21", ALPACA_API_KEY="k", ALPACA_API_SECRET="s")
    assert adapters.default_provider() == "ib"


def test_default_broker_overrides_priority(registry):
    adapters = registry(IB_HOST="10.7.3.21", DEFAULT_BROKER="ib", **_oanda())
    assert adapters.default_provider() == "ib"


def test_unknown_default_broker_is_ignored(registry):
    adapters = registry(DEFAULT_BROKER="nope", **_oanda())
    assert adapters.default_provider() == "oanda"


def test_nothing_configured_defaults_to_top_of_list_and_501s(registry):
    adapters = registry()
    assert adapters.default_provider() == "oanda"
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter(None)
    assert exc.value.status_code == 501
    assert "OANDA_API_TOKEN" in exc.value.detail


def test_health_reports_default_and_priority(registry):
    health = registry(**_oanda()).provider_health()
    assert health["default"] == "oanda"
    assert health["priority"] == ["oanda", "mt5", "ib", "alpaca"]


def test_ib_connection_without_ib_host_is_a_clear_503(monkeypatch):
    import ib_client

    monkeypatch.setattr(ib_client, "IB_HOST", None)
    with pytest.raises(HTTPException) as exc:
        ib_client.get_ib_connection()
    assert exc.value.status_code == 503
    assert "IB_HOST" in exc.value.detail
