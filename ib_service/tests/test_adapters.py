"""
Tests for the broker / market-data adapter registry (B1).

Exercise provider resolution, availability (IB registered, MT5 recognised but
unavailable) and the IBAdapter's delegation to the existing sync workers — all
without a live IB Gateway (the workers are monkeypatched).
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


@pytest.fixture
def adapters_mod():
    import adapters

    importlib.reload(adapters)
    return adapters


# --------------------------------------------------------------------------- #
# Provider resolution
# --------------------------------------------------------------------------- #
def test_resolve_provider_defaults_to_ib(adapters_mod):
    assert adapters_mod.resolve_provider(None) == "ib"
    assert adapters_mod.resolve_provider("") == "ib"
    assert adapters_mod.resolve_provider("  ") == "ib"


def test_resolve_provider_normalises_case(adapters_mod):
    assert adapters_mod.resolve_provider("IB") == "ib"
    assert adapters_mod.resolve_provider("Mt5") == "mt5"


def test_resolve_provider_rejects_unknown(adapters_mod):
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_provider("robinhood")
    assert exc.value.status_code == 400
    assert "Unknown provider" in exc.value.detail


# --------------------------------------------------------------------------- #
# Availability
# --------------------------------------------------------------------------- #
def test_ib_broker_adapter_is_available(adapters_mod):
    adapter = adapters_mod.get_broker_adapter("ib")
    assert adapter.name == "ib"


def test_ib_market_data_adapter_is_available_by_default(adapters_mod):
    adapter = adapters_mod.get_market_data_adapter()  # defaults to ib
    assert adapter.name == "ib"


def test_mt5_broker_is_recognised_but_unavailable(adapters_mod):
    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("mt5")
    assert exc.value.status_code == 501
    assert "mt5" in exc.value.detail


def test_mt5_market_data_is_recognised_but_unavailable(adapters_mod):
    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_market_data_adapter("mt5")
    assert exc.value.status_code == 501


def test_unknown_broker_is_400(adapters_mod):
    with pytest.raises(HTTPException) as exc:
        adapters_mod.get_broker_adapter("wells_fargo")
    assert exc.value.status_code == 400


def test_provider_health_reports_ib_available_mt5_not(adapters_mod):
    health = adapters_mod.provider_health()
    assert health["default"] == "ib"
    assert health["providers"]["ib"]["available"] is True
    assert health["providers"]["ib"]["broker"] is True
    assert health["providers"]["ib"]["market_data"] is True
    assert health["providers"]["mt5"]["available"] is False


# --------------------------------------------------------------------------- #
# IBAdapter delegation (workers monkeypatched — no gateway touched)
# --------------------------------------------------------------------------- #
def test_ib_adapter_place_order_delegates(monkeypatch):
    import orders

    sentinel = {"order_id": 1, "status": "submitted"}
    monkeypatch.setattr(orders, "place_order_sync", lambda req: sentinel)

    from ib_adapter import IBAdapter

    assert IBAdapter().place_order({"symbol": "MSFT"}) is sentinel


def test_ib_adapter_cancel_and_modify_delegate(monkeypatch):
    import orders

    monkeypatch.setattr(orders, "cancel_order_sync", lambda oid: {"order_id": oid, "cancel": True})
    monkeypatch.setattr(
        orders, "modify_order_sync", lambda oid, req: {"order_id": oid, "modify": True}
    )

    from ib_adapter import IBAdapter

    adapter = IBAdapter()
    assert adapter.cancel_order(42) == {"order_id": 42, "cancel": True}
    assert adapter.modify_order(42, {"symbol": "MSFT"}) == {"order_id": 42, "modify": True}
