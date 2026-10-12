"""
Tests for the OANDA account-info switch on an MT5 connection.

An mt5 connection declaring ``account_info_from: <oanda connection>`` reads its
balance, margin and positions from the OANDA REST API while orders keep going
through the MT5 sidecar. The cases cover the three layers that make that true:

  - the manifest refuses a link that can't be honoured (wrong platform,
    conflicting ``same_funds_as``, mismatched currency) rather than quietly
    reading the sidecar's own account;
  - `SplitAccountAdapter` sends each call to the right side, and translates
    OANDA positions into the MT5 run's vocabulary (symbol, lots, stops);
  - the account routes pick the switch up end to end.

No venue is touched: the adapters' HTTP helpers are replaced with canned
payloads keyed by path.
"""

from __future__ import annotations

import importlib
import json
from typing import Any, Dict, List

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from split_account_adapter import SplitAccountAdapter, _canonical

# --------------------------------------------------------------------------- #
# Manifest + registry
# --------------------------------------------------------------------------- #


@pytest.fixture
def adapters_mod(monkeypatch):
    for name in (
        "BROKER_CONNECTIONS",
        "BROKER_CONNECTIONS_FILE",
        "MT5_BRIDGE_URL",
        "MT5_BRIDGE_SECRET",
        "MT5_ACCOUNT_INFO_SOURCE",
        "ALPACA_API_KEY",
        "ALPACA_API_SECRET",
        "OANDA_API_TOKEN",
        "OANDA_ACCOUNT_ID",
        "OANDA_ENVIRONMENT",
        "LIVE_TRADING_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MT5_SECRET", "s")
    monkeypatch.setenv("OANDA_TOKEN", "t")
    monkeypatch.setenv("OANDA_ACCT", "101-001-1-001")
    import connections

    importlib.reload(connections)
    import adapters

    importlib.reload(adapters)
    yield adapters
    adapters.reset_registry()


OANDA_MT5 = {
    "id": "oanda-mt5",
    "platform": "mt5",
    "url": "http://10.0.0.9:9100",
    "secret_env": "MT5_SECRET",
    "account_mode": "paper",
    "currency": "USD",
    "account_info_from": "oanda-native",
}
OANDA_NATIVE = {
    "id": "oanda-native",
    "platform": "oanda",
    "token_env": "OANDA_TOKEN",
    "account_env": "OANDA_ACCT",
    "account_mode": "paper",
    "currency": "USD",
}


def _manifest(monkeypatch, adapters_mod, entries):
    monkeypatch.setenv("BROKER_CONNECTIONS", json.dumps(entries))
    adapters_mod.reset_registry()


def test_account_info_from_wraps_the_mt5_broker_adapter(adapters_mod, monkeypatch):
    from mt5_adapter import MT5Adapter
    from oanda_adapter import OANDAAdapter

    _manifest(monkeypatch, adapters_mod, [OANDA_MT5, OANDA_NATIVE])

    adapter = adapters_mod.get_broker_adapter("mt5", "oanda-mt5")
    assert isinstance(adapter, SplitAccountAdapter)
    assert isinstance(adapter._execution, MT5Adapter)
    assert isinstance(adapter._account_info, OANDAAdapter)
    # Same OANDA instance the oanda connection itself uses.
    assert adapter._account_info is adapters_mod.get_broker_adapter("oanda", "oanda-native")
    # Market data is untouched: charts on this connection still come from MT5.
    assert isinstance(adapters_mod.get_market_data_adapter("mt5", "oanda-mt5"), MT5Adapter)


def test_account_info_from_implies_same_funds(adapters_mod, monkeypatch):
    _manifest(monkeypatch, adapters_mod, [OANDA_MT5, OANDA_NATIVE])

    assert adapters_mod.resolve_connection("mt5", "oanda-mt5").same_funds_as == "oanda-native"
    assert adapters_mod.same_funds_groups() == [["mt5:oanda-mt5", "oanda:oanda-native"]]
    health = adapters_mod.provider_health()
    assert health["connections"]["mt5:oanda-mt5"]["account_info_from"] == "oanda:oanda-native"
    assert health["connections"]["oanda:oanda-native"]["account_info_from"] is None


def test_mt5_without_the_switch_is_unwrapped(adapters_mod, monkeypatch):
    from mt5_adapter import MT5Adapter

    plain = {k: v for k, v in OANDA_MT5.items() if k != "account_info_from"}
    _manifest(monkeypatch, adapters_mod, [plain, OANDA_NATIVE])

    assert isinstance(adapters_mod.get_broker_adapter("mt5", "oanda-mt5"), MT5Adapter)


@pytest.mark.parametrize(
    "entries, fragment",
    [
        ([{**OANDA_MT5, "account_info_from": "nope"}, OANDA_NATIVE], "must name an oanda"),
        (
            [
                {**OANDA_MT5, "same_funds_as": "other"},
                OANDA_NATIVE,
                {**OANDA_NATIVE, "id": "other"},
            ],
            "conflicts with same_funds_as",
        ),
        ([OANDA_MT5, {**OANDA_NATIVE, "currency": "AUD"}], "wrong currency"),
        (
            [OANDA_NATIVE, {**OANDA_NATIVE, "id": "b", "account_info_from": "oanda-native"}],
            "only supported on mt5",
        ),
    ],
)
def test_a_link_that_cannot_be_honoured_fails_loudly(adapters_mod, monkeypatch, entries, fragment):
    _manifest(monkeypatch, adapters_mod, entries)
    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert exc.value.status_code == 500
    assert fragment in exc.value.detail


def test_legacy_env_switch(adapters_mod, monkeypatch):
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://legacy:9100")
    monkeypatch.setenv("OANDA_API_TOKEN", "t")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "101-001-1-001")
    monkeypatch.setenv("MT5_ACCOUNT_INFO_SOURCE", "oanda")
    adapters_mod.reset_registry()

    adapter = adapters_mod.get_broker_adapter("mt5")
    assert isinstance(adapter, SplitAccountAdapter)
    assert adapter._account_info is adapters_mod.get_broker_adapter("oanda")


@pytest.mark.parametrize(
    "env, fragment",
    [
        ({"MT5_ACCOUNT_INFO_SOURCE": "oanda", "MT5_BRIDGE_URL": "http://x"}, "all set"),
        ({"MT5_ACCOUNT_INFO_SOURCE": "alpaca", "MT5_BRIDGE_URL": "http://x"}, "not supported"),
    ],
)
def test_legacy_env_switch_fails_closed(adapters_mod, monkeypatch, env, fragment):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    adapters_mod.reset_registry()

    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert fragment in exc.value.detail


def test_legacy_switch_alongside_the_manifest_is_rejected(adapters_mod, monkeypatch):
    monkeypatch.setenv("MT5_ACCOUNT_INFO_SOURCE", "oanda")
    _manifest(monkeypatch, adapters_mod, [OANDA_MT5, OANDA_NATIVE])

    with pytest.raises(HTTPException) as exc:
        adapters_mod.resolve_connection("mt5")
    assert "MT5_ACCOUNT_INFO_SOURCE" in exc.value.detail


# --------------------------------------------------------------------------- #
# SplitAccountAdapter dispatch and position translation
# --------------------------------------------------------------------------- #
class FakeOanda:
    name = "oanda"

    def __init__(self, positions: List[Dict[str, Any]]) -> None:
        self._positions = positions

    def account_summary(self) -> Dict[str, Any]:
        return {"account_id": "101-001-1-001", "net_liquidation": 10_250.0, "currency": "USD"}

    def positions(self) -> List[Dict[str, Any]]:
        return self._positions

    def place_order(self, request: Any) -> Dict[str, Any]:  # pragma: no cover
        raise AssertionError("orders must never reach OANDA REST through the switch")


class FakeMt5:
    name = "mt5"

    def __init__(self, positions=None, contract_size: Any = 100_000.0) -> None:
        self._positions = positions or []
        self._contract_size = contract_size
        self.calls: List[str] = []

    def positions(self) -> List[Dict[str, Any]]:
        self.calls.append("positions")
        return self._positions

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        self.calls.append(f"spec:{symbol}")
        return {"symbol": symbol, "contract_size": self._contract_size}

    def account_summary(self) -> Dict[str, Any]:  # pragma: no cover
        raise AssertionError("account information must come from OANDA")

    def place_order(self, request: Any) -> Dict[str, Any]:
        self.calls.append("place_order")
        return {"order_id": "77", "broker": "mt5"}

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        self.calls.append(f"cancel:{order_id}")
        return {"order_id": order_id}

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        self.calls.append(f"modify:{order_id}")
        return {"order_id": order_id}

    def open_orders(self) -> List[Dict[str, Any]]:
        self.calls.append("open_orders")
        return []

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        self.calls.append(f"executions:{days}")
        return []

    def modify_position_stop(self, symbol: str, sl: Any = None, tp: Any = None) -> Dict[str, Any]:
        self.calls.append(f"stop:{symbol}")
        return {"status": "ok"}


def _oanda_row(symbol: str, units: float, **extra: Any) -> Dict[str, Any]:
    return {
        "symbol": symbol,
        "position": units,
        "market_price": None,
        "market_value": None,
        "average_cost": 1.0850,
        "unrealized_pnl": 12.5,
        "currency": "USD",
        **extra,
    }


@pytest.mark.parametrize(
    "symbol, canonical",
    [
        ("EUR.USD", "EURUSD"),
        ("EUR_USD", "EURUSD"),
        ("EURUSD", "EURUSD"),
        ("EURUSD.a", "EURUSD"),
        ("eurusd_i", "EURUSD"),
        ("US30_USD", "US30"),
        ("US30.cash", "US30"),
        ("XAU_USD", "XAUUSD"),
    ],
)
def test_canonical_symbol(symbol, canonical):
    assert _canonical(symbol) == canonical


def test_account_summary_comes_from_oanda():
    split = SplitAccountAdapter(execution=FakeMt5(), account_info=FakeOanda([]))
    assert split.account_summary()["net_liquidation"] == 10_250.0


def test_execution_stays_on_mt5():
    mt5 = FakeMt5()
    split = SplitAccountAdapter(execution=mt5, account_info=FakeOanda([]))

    assert split.place_order(object())["broker"] == "mt5"
    split.cancel_order(5)
    split.modify_order(6, object())
    split.open_orders()
    split.executions(3)
    split.instrument_spec("EURUSD")
    split.modify_position_stop("EURUSD", sl=1.08)

    assert mt5.calls == [
        "place_order",
        "cancel:5",
        "modify:6",
        "open_orders",
        "executions:3",
        "spec:EURUSD",
        "stop:EURUSD",
    ]
    assert split.name == "mt5"


def test_positions_are_translated_to_mt5_symbols_lots_and_stops():
    mt5 = FakeMt5(
        positions=[
            {"symbol": "EURUSD.A", "position": 0.5, "stop_loss": 1.0800, "take_profit": 1.0950}
        ]
    )
    split = SplitAccountAdapter(
        execution=mt5, account_info=FakeOanda([_oanda_row("EUR.USD", -50_000.0)])
    )

    [row] = split.positions()

    assert row["symbol"] == "EURUSD.A"
    assert row["position"] == -0.5
    assert row["stop_loss"] == 1.0800
    assert row["take_profit"] == 1.0950
    # Price and P&L are OANDA's own figures.
    assert row["average_cost"] == 1.0850
    assert row["unrealized_pnl"] == 12.5
    assert "spec:EURUSD.A" in mt5.calls


def test_position_only_oanda_sees_uses_the_symbol_map():
    mt5 = FakeMt5(contract_size=100.0)
    split = SplitAccountAdapter(
        execution=mt5,
        account_info=FakeOanda([_oanda_row("XAU.USD", 200.0)]),
        symbol_map={"XAUUSD": "GOLD"},
    )

    [row] = split.positions()

    assert row["symbol"] == "GOLD"
    assert row["position"] == 2.0
    assert row["stop_loss"] is None


def test_symbol_map_also_matches_mt5_positions():
    mt5 = FakeMt5(positions=[{"symbol": "GOLD", "position": 2.0, "stop_loss": 2300.0}])
    split = SplitAccountAdapter(
        execution=mt5,
        account_info=FakeOanda([_oanda_row("XAU.USD", 200.0)]),
        symbol_map={"XAUUSD": "GOLD"},
    )
    mt5._contract_size = 100.0

    [row] = split.positions()

    assert row["symbol"] == "GOLD"
    assert row["stop_loss"] == 2300.0


def test_oanda_is_the_authority_for_which_positions_exist():
    mt5 = FakeMt5(positions=[{"symbol": "GBPUSD", "position": 1.0}])
    split = SplitAccountAdapter(execution=mt5, account_info=FakeOanda([]))

    assert split.positions() == []


@pytest.mark.parametrize("contract_size", [None, 0, "junk"])
def test_missing_contract_size_fails_closed(contract_size):
    """Units handed back as lots would read 100,000x too large."""
    mt5 = FakeMt5(contract_size=contract_size)
    split = SplitAccountAdapter(
        execution=mt5, account_info=FakeOanda([_oanda_row("EUR.USD", 1000.0)])
    )

    with pytest.raises(HTTPException) as exc:
        split.positions()
    assert exc.value.status_code == 502


def test_unreachable_sidecar_fails_positions_rather_than_dropping_stops():
    class DownMt5(FakeMt5):
        def positions(self):
            raise HTTPException(503, "MT5 bridge unreachable")

    split = SplitAccountAdapter(
        execution=DownMt5(), account_info=FakeOanda([_oanda_row("EUR.USD", 1000.0)])
    )

    with pytest.raises(HTTPException) as exc:
        split.positions()
    assert exc.value.status_code == 503


# --------------------------------------------------------------------------- #
# End to end through the account routes
# --------------------------------------------------------------------------- #
def test_account_routes_read_oanda_for_the_switched_connection(adapters_mod, monkeypatch):
    from routes import account

    _manifest(monkeypatch, adapters_mod, [OANDA_MT5, OANDA_NATIVE])
    split = adapters_mod.get_broker_adapter("mt5", "oanda-mt5")

    oanda_payloads = {
        "/v3/accounts/101-001-1-001/summary": {
            "account": {
                "id": "101-001-1-001",
                "NAV": "10250.00",
                "balance": "10000.00",
                "marginAvailable": "9000.00",
                "marginUsed": "1250.00",
                "currency": "USD",
            }
        },
        "/v3/accounts/101-001-1-001/openPositions": {
            "positions": [
                {
                    "instrument": "EUR_USD",
                    "long": {"units": "100000", "averagePrice": "1.0850"},
                    "short": {"units": "0"},
                    "unrealizedPL": "25.00",
                    "currency": "USD",
                }
            ]
        },
    }
    mt5_payloads = {
        "/positions": {"positions": [{"symbol": "EURUSD", "volume": 1.0, "type": 0}]},
        "/symbol": {"trade_contract_size": 100000},
    }
    monkeypatch.setattr(split._account_info, "_get", lambda path, params=None: oanda_payloads[path])
    monkeypatch.setattr(split._execution, "_get", lambda path, params=None: mt5_payloads[path])

    app = FastAPI()
    app.include_router(account.router)
    client = TestClient(app)
    params = {"broker": "mt5", "account": "oanda-mt5"}

    summary = client.get("/account/summary", params=params)
    assert summary.status_code == 200
    assert summary.json()["account_id"] == "101-001-1-001"
    assert summary.json()["net_liquidation"] == 10_250.0
    assert summary.json()["maintenance_margin"] == 1_250.0

    positions = client.get("/account/positions", params=params)
    assert positions.status_code == 200
    assert positions.json() == [
        {
            "symbol": "EURUSD",
            "position": 1.0,
            "market_price": None,
            "market_value": None,
            "average_cost": 1.085,
            "unrealized_pnl": 25.0,
            "stop_loss": None,
            "take_profit": None,
            "currency": "USD",
        }
    ]
