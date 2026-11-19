"""The symbol catalogue: each listable broker's whole list, grouped by market,
and the catalogue route for listable and search-only brokers. No venue is
contacted: each adapter's transport is the fake its own tests use."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import symbol_catalogue as sc
from tests import test_alpaca_adapter as alpaca_tests
from tests import test_ctrader_adapter as ctrader_tests
from tests import test_mt5_adapter as mt5_tests
from tests import test_oanda_adapter as oanda_tests

# The adapters' fixtures, under the names these tests use.
oanda = oanda_tests.oanda
ct = ctrader_tests.ct
mt5 = mt5_tests.mt5
alpaca = alpaca_tests.alpaca


# --------------------------------------------------------------------------- #
# classification
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "name, words, sec_type, market",
    [
        ("AU200_AUD", (), "CFD", "INDEX"),
        ("US30_USD", (), "CFD", "INDEX"),
        ("BCO_USD", (), "CFD", "COMMODITY"),
        ("XAU_USD", (), "CFD", "METAL"),
        ("USB10Y_USD", (), "CFD", "BOND"),
        ("EURUSD", (), "CFD", "FX"),
        ("AAPL", (), "STK", "STOCK"),
        ("SOMETHING", (), "CFD", "OTHER"),
        ("AUS200", ("Indices",), "CFD", "INDEX"),
        ("EURUSDm", ("Forex", "Majors"), "CFD", "FX"),
        ("BTCUSD", ("Crypto",), "CFD", "CRYPTO"),
        ("XAUUSD", ("Metals",), "CFD", "METAL"),
        ("BHP.AX", ("Stocks", "ASX"), "CFD", "STOCK"),
        ("SPOTCRUDE", ("Energies",), "CFD", "COMMODITY"),
    ],
)
def test_classify(name, words, sec_type, market):
    assert sc.classify(name, words=words, sec_type=sec_type) == market


def test_search_results_become_catalogue_rows():
    rows = sc.from_search_results(
        [
            {"conid": "265598", "symbol": "AAPL", "companyName": "Apple", "secType": "STK"},
            {"conid": "", "symbol": "", "secType": "STK"},
            {"conid": "12087792", "symbol": "EUR", "secType": "CASH", "currency": "USD"},
        ]
    )
    assert [(r["symbol"], r["market"], r["venue_id"]) for r in rows] == [
        ("AAPL", "STOCK", "265598"),
        ("EUR", "FX", "12087792"),
    ]


# --------------------------------------------------------------------------- #
# listable brokers
# --------------------------------------------------------------------------- #
def test_oanda_lists_every_instrument_with_its_market(oanda):
    oanda_tests.FakeClient.handler = lambda method, url, params, json: oanda_tests.FakeResponse(
        {
            "instruments": [
                {"name": "EUR_USD", "displayName": "EUR/USD", "type": "CURRENCY"},
                {"name": "AU200_AUD", "displayName": "Australia 200", "type": "CFD"},
                {
                    "name": "CORN_USD",
                    "displayName": "Corn",
                    "type": "CFD",
                    "tags": [{"type": "ASSET_CLASS", "name": "COMMODITY"}],
                },
                {"name": "XAU_USD", "displayName": "Gold", "type": "METAL"},
            ]
        }
    )
    rows = oanda_tests._adapter(oanda).list_instruments()
    assert oanda_tests.FakeClient.calls[0][1].endswith("/instruments")
    assert [(r["symbol"], r["market"], r["secType"], r["currency"]) for r in rows] == [
        ("EUR.USD", "FX", "CASH", "USD"),
        ("AU200.AUD", "INDEX", "CFD", "AUD"),
        ("CORN.USD", "COMMODITY", "CFD", "USD"),
        ("XAU.USD", "METAL", "CFD", "USD"),
    ]
    assert rows[1]["venue_id"] == "AU200_AUD"


def test_ctrader_groups_by_category_and_asset_class(ct):
    def extra(kind, payload):
        if kind == 2153:
            return [
                (2154, {"assetClass": [{"id": 1, "name": "Forex"}, {"id": 2, "name": "Indices"}]})
            ]
        if kind == 2160:
            return [
                (
                    2161,
                    {
                        "symbolCategory": [
                            {"id": 10, "assetClassId": 1, "name": "Majors"},
                            {"id": 20, "assetClassId": 2, "name": "US"},
                        ]
                    },
                )
            ]
        if kind == 2114:
            symbols = [dict(s) for s in ctrader_tests.SYMBOLS["symbol"]]
            symbols[0]["symbolCategoryId"] = 10
            symbols[1]["symbolCategoryId"] = 20
            return [(2115, {"symbol": symbols})]
        return None

    ctrader_tests.FakeWS.handler = ctrader_tests.base_handler(extra)
    rows = ctrader_tests._adapter(ct).list_instruments()
    assert [(r["symbol"], r["market"], r["secType"], r["venue_id"]) for r in rows] == [
        ("EUR.USD", "FX", "CASH", "1"),
        ("US500", "INDEX", "CFD", "2"),
    ]


def test_ctrader_without_categories_still_lists_by_name(ct):
    # The base fake answers neither category call: names decide.
    rows = ctrader_tests._adapter(ct).list_instruments()
    assert [(r["symbol"], r["market"]) for r in rows] == [("EUR.USD", "FX"), ("US500", "INDEX")]


def test_mt5_groups_by_the_symbols_folder(mt5):
    mt5_tests.FakeClient.handler = lambda method, url, params, json: mt5_tests.FakeResponse(
        {
            "results": [
                {"symbol": "EURUSDm", "description": "Euro", "path": "Forex\\Majors\\EURUSDm"},
                {"symbol": "AUS200", "description": "ASX 200", "path": "Indices\\AUS200"},
                {"symbol": "XAUUSD", "description": "Gold", "path": "Metals\\XAUUSD"},
                {"symbol": "ODD", "path": ""},
            ]
        }
    )
    rows = mt5_tests._adapter(mt5).list_instruments()
    _, url, params, _, _ = mt5_tests.FakeClient.calls[0]
    assert url.endswith("/symbols") and params["query"] == "" and params["limit"] >= 10000
    assert [(r["symbol"], r["market"]) for r in rows] == [
        ("EURUSDm", "FX"),
        ("AUS200", "INDEX"),
        ("XAUUSD", "METAL"),
        ("ODD", "OTHER"),
    ]


def test_alpaca_lists_tradable_stocks_and_crypto(alpaca):
    def handler(method, url, params, json):
        if params.get("asset_class") == "crypto":
            return alpaca_tests.FakeResponse([{"symbol": "BTC/USD", "name": "Bitcoin"}])
        return alpaca_tests.FakeResponse(
            [
                {"symbol": "AAPL", "name": "Apple", "exchange": "NASDAQ"},
                {"symbol": "XYZ", "tradable": False},
            ]
        )

    alpaca_tests.FakeClient.handler = handler
    rows = alpaca_tests._adapter(alpaca).list_instruments()
    assert [(r["symbol"], r["market"], r["secType"], r["currency"]) for r in rows] == [
        ("AAPL", "STOCK", "STK", "USD"),
        ("BTC/USD", "CRYPTO", "CRYPTO", "USD"),
    ]


# --------------------------------------------------------------------------- #
# the route
# --------------------------------------------------------------------------- #
class _Lister:
    def list_instruments(self):
        return [sc.entry(symbol="EUR.USD", name="EUR/USD", market="FX", sec_type="CASH")]


class _Searcher:
    def __init__(self):
        self.searched = []

    def search_contracts(self, request):
        self.searched.append(request)
        return {"results": [{"conid": "1", "symbol": "AAPL", "secType": "STK"}]}


@pytest.fixture
def route(monkeypatch):
    import adapters
    from routes import symbols

    chosen = {}
    monkeypatch.setattr(adapters, "resolve_provider", lambda name: name or "oanda")
    monkeypatch.setattr(adapters, "get_market_data_adapter", lambda s, a=None: chosen["adapter"])
    monkeypatch.setattr(
        symbols,
        "venue_search",
        lambda source, pattern, **kw: chosen["adapter"].search_contracts(
            type("R", (), {"symbol": pattern, **kw})()
        ),
    )
    app = FastAPI()
    app.include_router(symbols.router)
    return TestClient(app), chosen


def test_a_listable_broker_gives_its_whole_list(route):
    client, chosen = route
    chosen["adapter"] = _Lister()
    body = client.get("/symbols/catalogue", params={"source": "oanda", "q": "ignored"}).json()
    assert body["complete"] is True
    assert body["platform"] == "oanda"
    assert [r["symbol"] for r in body["instruments"]] == ["EUR.USD"]


def test_a_search_only_broker_searches_in_the_market_asked_for(route):
    client, chosen = route
    chosen["adapter"] = searcher = _Searcher()
    body = client.get(
        "/symbols/catalogue", params={"source": "ig", "q": "aapl", "market": "STOCK"}
    ).json()
    assert body["complete"] is False
    assert [(r["symbol"], r["market"]) for r in body["instruments"]] == [("AAPL", "STOCK")]
    assert searcher.searched[0].symbol == "aapl"
    assert searcher.searched[0].secType == "STK"


def test_a_search_only_broker_with_nothing_to_search_gives_nothing(route):
    client, chosen = route
    chosen["adapter"] = searcher = _Searcher()
    body = client.get("/symbols/catalogue", params={"source": "ig"}).json()
    assert body == {"platform": "ig", "complete": False, "instruments": [], "count": 0}
    assert searcher.searched == []
