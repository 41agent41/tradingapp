"""Route tests for canonical → native symbol resolution (C-2).

The deploy-time contract: resolving one canonical symbol across N connections
returns a *per-target* outcome. A single failing connection must not hide the
ones that resolved — "these four legs are fine, this one is not, here is why"
is the answer an operator can act on.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import symbol_resolution
from routes import account


class FakeConnection:
    def __init__(self, platform, acct, symbol_map=None, mode="paper"):
        self.platform = platform
        self.account = acct
        self.label = f"{platform}:{acct}"
        self.symbol_map = symbol_map or {}
        self.account_mode = mode


class FakeDataAdapter:
    def __init__(self, symbols):
        self.symbols = symbols

    def search_contracts(self, request):
        return {"results": [{"symbol": s} for s in self.symbols]}


class FakeBrokerAdapter:
    def __init__(self, step):
        self.step = step
        self.asked = []

    def instrument_spec(self, symbol):
        self.asked.append(symbol)
        return {
            "symbol": symbol,
            "broker": "mt5",
            "unit": "lots",
            "min_size": self.step,
            "size_step": self.step,
            "contract_size": 100000.0,
            "currency": "USD",
        }


def _client():
    app = FastAPI()
    app.include_router(account.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear():
    symbol_resolution.clear_catalogue_cache()
    yield
    symbol_resolution.clear_catalogue_cache()


@pytest.fixture
def fleet(monkeypatch):
    """Three connections offering the same instrument under three names, with
    three different lot steps — the DoD case."""
    import adapters

    conns = {
        ("mt5", "icmarkets"): FakeConnection("mt5", "icmarkets"),
        ("mt5", "pepperstone"): FakeConnection("mt5", "pepperstone"),
        ("mt5", "ftmo"): FakeConnection("mt5", "ftmo"),
    }
    data = {
        ("mt5", "icmarkets"): FakeDataAdapter(["EURUSD.a"]),
        ("mt5", "pepperstone"): FakeDataAdapter(["EURUSD_i"]),
        ("mt5", "ftmo"): FakeDataAdapter(["GBPUSD"]),  # no EURUSD here
    }
    brokers = {
        ("mt5", "icmarkets"): FakeBrokerAdapter(0.01),
        ("mt5", "pepperstone"): FakeBrokerAdapter(0.1),
        ("mt5", "ftmo"): FakeBrokerAdapter(1.0),
    }

    def _conn(broker, account=None, **kw):
        key = (broker, account)
        if key not in conns:
            raise HTTPException(400, f"Unknown account '{account}'")
        return conns[key]

    monkeypatch.setattr(adapters, "resolve_connection", _conn)
    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda b, a=None: data[(b, a)])
    monkeypatch.setattr(adapters, "get_broker_adapter", lambda b, a=None, **kw: brokers[(b, a)])
    return brokers


def test_resolves_to_the_connections_own_symbol(fleet):
    res = _client().get(
        "/instrument/resolve", params={"symbol": "EURUSD", "broker": "mt5", "account": "icmarkets"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["native"] == "EURUSD.a"
    assert body["method"] == "suffix"
    assert body["spec"]["size_step"] == 0.01


def test_the_spec_is_fetched_for_the_native_symbol_not_the_canonical(fleet):
    """Asking the venue about 'EURUSD' when it trades 'EURUSD.a' either errors
    or describes a different contract."""
    _client().get(
        "/instrument/resolve", params={"symbol": "EURUSD", "broker": "mt5", "account": "icmarkets"}
    )
    assert fleet[("mt5", "icmarkets")].asked == ["EURUSD.a"]


def test_an_unresolvable_symbol_is_422(fleet):
    res = _client().get(
        "/instrument/resolve", params={"symbol": "EURUSD", "broker": "mt5", "account": "ftmo"}
    )
    assert res.status_code == 422


def test_preview_reports_each_leg_independently(fleet):
    """The DoD: one definition, three connections, three native symbols and
    three lot steps — with the failing leg named rather than fatal."""
    res = _client().post(
        "/instrument/resolve/preview",
        json={
            "symbol": "EURUSD",
            "targets": [
                {"broker": "mt5", "account": "icmarkets"},
                {"broker": "mt5", "account": "pepperstone"},
                {"broker": "mt5", "account": "ftmo"},
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["resolved"] == 2
    assert body["refused"] == 1

    ok = {r["account"]: r for r in body["results"] if r["ok"]}
    assert ok["icmarkets"]["native"] == "EURUSD.a"
    assert ok["pepperstone"]["native"] == "EURUSD_i"
    # Different lot steps per connection: serving one account's step to another
    # produces orders the second broker rejects, or silently rounds.
    assert ok["icmarkets"]["spec"]["size_step"] == 0.01
    assert ok["pepperstone"]["spec"]["size_step"] == 0.1

    failed = [r for r in body["results"] if not r["ok"]]
    assert failed[0]["account"] == "ftmo"
    assert failed[0]["status"] == 422


def test_preview_never_fails_as_a_whole_on_an_unknown_account(fleet):
    res = _client().post(
        "/instrument/resolve/preview",
        json={
            "symbol": "EURUSD",
            "targets": [
                {"broker": "mt5", "account": "icmarkets"},
                {"broker": "mt5", "account": "not-configured"},
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["resolved"] == 1
    assert body["refused"] == 1
