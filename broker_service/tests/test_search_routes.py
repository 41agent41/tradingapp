"""Contract search, advanced search and symbol discovery, end to end.

The backend once called broker-service paths that did not exist, so search
failed whatever the broker. These tests check every path the backend calls
is served here, and that advanced search and discovery answer from the
selected venue's adapter when it isn't IB. No venue is contacted.
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[2] / "backend" / "src"


def _backend_paths() -> set[str]:
    if not BACKEND.exists():
        pytest.skip(f"{BACKEND} is not in this checkout")
    paths = set()
    for path in BACKEND.rglob("*.ts"):
        for m in re.finditer(r"\$\{BROKER_SERVICE_URL\}(/[^`'\"?\s]*)", path.read_text("utf-8")):
            paths.add(m.group(1))
    return paths


def _pattern(route_path: str) -> re.Pattern[str]:
    return re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", route_path) + "$")


def test_every_path_the_backend_calls_is_served():
    import main

    served = [_pattern(r.path) for r in main.app.routes if hasattr(r, "path")]
    called = _backend_paths()
    assert "/contract/search" in called
    missing = sorted(
        p for p in called if not any(s.match(re.sub(r"\$\{[^}]+\}", "x", p)) for s in served)
    )
    assert not missing, f"backend calls paths the broker service does not serve: {missing}"


_ENV = (
    "BROKER_CONNECTIONS",
    "BROKER_CONNECTIONS_FILE",
    "MT5_BRIDGE_URL",
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "OANDA_API_TOKEN",
    "OANDA_ACCOUNT_ID",
    "DEFAULT_BROKER",
    "BROKER_PRIORITY",
)


@pytest.fixture
def oanda_only(monkeypatch):
    """OANDA is the only broker; its contract search is a fake."""
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OANDA_API_TOKEN", "tok")
    monkeypatch.setenv("OANDA_ACCOUNT_ID", "001")
    import ib_client

    monkeypatch.setattr(ib_client, "IB_HOST", None)
    import connections

    importlib.reload(connections)
    import managed

    importlib.reload(managed)
    import adapters

    importlib.reload(adapters)
    import oanda_adapter

    searched = []

    def search(self, request):
        searched.append(request)
        results = [
            {"conid": f"EUR_{c}", "symbol": f"EUR.{c}", "secType": "CASH"}
            for c in ("USD", "GBP", "JPY")
        ]
        return {"results": results, "count": len(results), "broker": "oanda"}

    monkeypatch.setattr(oanda_adapter.OANDAAdapter, "search_contracts", search)
    from routes import contracts, symbols

    app = FastAPI()
    app.include_router(contracts.router)
    app.include_router(symbols.router)
    yield TestClient(app), searched
    adapters.reset_registry()


def test_advanced_search_on_a_venue_uses_its_contract_search(oanda_only):
    client, searched = oanda_only
    res = client.post(
        "/contract/advanced-search",
        json={"symbol": "eur", "secType": "CASH", "currency": "USD", "source": "oanda"},
    )
    assert res.status_code == 200
    assert res.json()["count"] == 3
    assert searched[0].symbol == "eur"
    assert searched[0].secType == "CASH"
    assert searched[0].source == "oanda"


def test_advanced_search_on_a_venue_needs_a_symbol(oanda_only):
    client, _ = oanda_only
    res = client.post("/contract/advanced-search", json={"secType": "CASH"})
    assert res.status_code == 400


def test_discovery_uses_the_default_venue_and_caps_results(oanda_only):
    client, searched = oanda_only
    res = client.post("/symbols/discover", json={"pattern": "eur", "max_results": 2})
    assert res.status_code == 200
    body = res.json()
    assert body["method"] == "venue_search"
    assert [r["symbol"] for r in body["results"]] == ["EUR.USD", "EUR.GBP"]
    assert body["count"] == 3
    assert searched[0].symbol == "EUR"


def test_discovery_passes_venue_errors_through(oanda_only):
    client, _ = oanda_only
    res = client.post("/symbols/discover", json={"pattern": "eur", "source": "nope"})
    assert res.status_code == 400
