"""
Tests for ib_service/orders.py.

Hits the validation gate (action / order_type / tif / account_mode /
LIVE_TRADING_ENABLED) and the IB-Order builder. Doesn't touch a live
IB Gateway — the place / cancel / modify sync workers go through
get_ib_connection which is mocked here.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def fresh_orders(monkeypatch):
    """Re-import the module so module-level constants like
    LIVE_TRADING_ENABLED reflect whatever the test set in env."""
    import orders as orders_mod

    importlib.reload(orders_mod)
    yield orders_mod


def test_validate_common_rejects_unknown_action(fresh_orders):
    with pytest.raises(HTTPException) as exc:
        fresh_orders._validate_common("HOLD", "MKT", "DAY", "paper")
    assert exc.value.status_code == 400
    assert "action" in exc.value.detail


def test_validate_common_rejects_unknown_order_type(fresh_orders):
    with pytest.raises(HTTPException) as exc:
        fresh_orders._validate_common("BUY", "ICEBERG", "DAY", "paper")
    assert exc.value.status_code == 400
    assert "order_type" in exc.value.detail


def test_validate_common_rejects_unknown_tif(fresh_orders):
    with pytest.raises(HTTPException) as exc:
        fresh_orders._validate_common("BUY", "MKT", "OPG", "paper")
    assert exc.value.status_code == 400


def test_validate_common_rejects_live_when_gate_off(monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    import orders as orders_mod

    importlib.reload(orders_mod)
    with pytest.raises(HTTPException) as exc:
        orders_mod._validate_common("BUY", "MKT", "DAY", "live")
    assert exc.value.status_code == 403
    assert "Live trading" in exc.value.detail


def test_validate_common_allows_live_when_gate_on(monkeypatch):
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "true")
    import orders as orders_mod

    importlib.reload(orders_mod)
    # Should not raise.
    orders_mod._validate_common("BUY", "MKT", "DAY", "live")


def test_validate_common_allows_paper_regardless_of_gate(monkeypatch):
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    import orders as orders_mod

    importlib.reload(orders_mod)
    orders_mod._validate_common("BUY", "MKT", "DAY", "paper")


def test_build_ib_order_for_market(fresh_orders):
    o = fresh_orders._build_ib_order(
        action="BUY", quantity=10, order_type="MKT", tif="DAY",
        limit_price=None, stop_price=None,
    )
    assert o.action == "BUY"
    assert o.orderType == "MKT"
    assert o.totalQuantity == 10
    assert o.tif == "DAY"


def test_build_ib_order_for_limit_requires_limit_price(fresh_orders):
    with pytest.raises(HTTPException) as exc:
        fresh_orders._build_ib_order(
            action="BUY", quantity=10, order_type="LMT", tif="DAY",
            limit_price=None, stop_price=None,
        )
    assert exc.value.status_code == 400
    assert "limit_price" in exc.value.detail


def test_build_ib_order_for_stop_requires_stop_price(fresh_orders):
    with pytest.raises(HTTPException) as exc:
        fresh_orders._build_ib_order(
            action="BUY", quantity=10, order_type="STP", tif="DAY",
            limit_price=None, stop_price=None,
        )
    assert exc.value.status_code == 400
    assert "stop_price" in exc.value.detail


def test_build_ib_order_for_stp_lmt_requires_both_prices(fresh_orders):
    # No prices at all → first failure is on limit (validated first).
    with pytest.raises(HTTPException):
        fresh_orders._build_ib_order(
            action="SELL", quantity=10, order_type="STP_LMT", tif="GTC",
            limit_price=None, stop_price=10,
        )
    # Both prices → translates orderType to IB's space-separated form.
    o = fresh_orders._build_ib_order(
        action="SELL", quantity=10, order_type="STP_LMT", tif="GTC",
        limit_price=100, stop_price=99,
    )
    assert o.orderType == "STP LMT"
    assert o.lmtPrice == 100
    assert o.auxPrice == 99
    assert o.tif == "GTC"


def test_build_ib_order_disables_etradeonly_firmquoteonly(fresh_orders):
    """IB Gateway error 10268 rejects orders with eTradeOnly=True.
    Force them off."""
    o = fresh_orders._build_ib_order(
        action="BUY", quantity=1, order_type="MKT", tif="DAY",
        limit_price=None, stop_price=None,
    )
    assert o.eTradeOnly is False
    assert o.firmQuoteOnly is False


def test_order_routes_config_reports_gate_and_enums(fresh_orders):
    import asyncio

    result = asyncio.run(fresh_orders.order_routes_config())
    assert result["live_trading_enabled"] in (True, False)
    assert "MKT" in result["order_types"]
    assert "LMT" in result["order_types"]
    assert "STP" in result["order_types"]
    assert "STP_LMT" in result["order_types"]
    assert set(result["tif"]) == {"DAY", "GTC", "IOC", "FOK"}
    assert set(result["actions"]) == {"BUY", "SELL"}
