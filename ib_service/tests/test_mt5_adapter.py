"""
Tests for the MT5 market-data adapter (B2a).

The sidecar HTTP layer is faked (no network): a stub `httpx.Client` records the
request and returns canned JSON, so the adapter's mapping (timeframe, timestamp
normalisation, response shaping, error translation) is verified in isolation.
Registry availability is exercised by toggling MT5_BRIDGE_URL.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException


# --------------------------------------------------------------------------- #
# Fake httpx client
# --------------------------------------------------------------------------- #
class FakeResponse:
    def __init__(self, payload, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text or str(payload)

    def json(self):
        if self._payload is _NON_JSON:
            raise ValueError("not json")
        return self._payload


_NON_JSON = object()


class FakeClient:
    """Context-manager stand-in for httpx.Client. `calls` records (url, params);
    `handler(path, params)` returns a FakeResponse (or raises httpx.HTTPError)."""

    calls = []
    handler = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url, params=None):
        FakeClient.calls.append((url, params or {}))
        return FakeClient.handler(url, params or {})


@pytest.fixture
def mt5(monkeypatch):
    import mt5_adapter

    importlib.reload(mt5_adapter)
    FakeClient.calls = []
    FakeClient.handler = None
    monkeypatch.setattr(mt5_adapter.httpx, "Client", FakeClient)
    return mt5_adapter


def _adapter(mt5_mod):
    return mt5_mod.MT5Adapter("http://mt5-host:9100/")


# --------------------------------------------------------------------------- #
# Timestamp coercion
# --------------------------------------------------------------------------- #
def test_to_unix_seconds_variants(mt5):
    f = mt5._to_unix_seconds
    assert f(1_700_000_000) == 1_700_000_000
    assert f(1_700_000_000_000) == 1_700_000_000  # millis -> seconds
    assert f("1700000000") == 1_700_000_000
    assert f("2023-11-14T22:13:20Z") == pytest.approx(1_700_000_000, abs=1)


# --------------------------------------------------------------------------- #
# historical_bars
# --------------------------------------------------------------------------- #
def test_historical_bars_maps_timeframe_and_normalises(mt5):
    FakeClient.handler = lambda url, params: FakeResponse(
        {
            "bars": [
                # deliberately out of order + mixed time units
                {"time": 1_700_000_300, "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 5},
                {
                    "time": 1_700_000_000_000,
                    "open": 1,
                    "high": 2,
                    "low": 0.5,
                    "close": 1.5,
                    "tick_volume": 9,
                },
            ]
        }
    )
    resp = _adapter(mt5).historical_bars("eurusd", "5min", "1M")

    # Sent MT5-native timeframe + a bounded count.
    _, params = FakeClient.calls[0]
    assert params["timeframe"] == "M5"
    assert params["symbol"] == "EURUSD"
    assert "count" in params

    assert resp.symbol == "EURUSD"
    assert resp.timeframe == "5min"
    assert resp.count == 2
    # Sorted ascending, millis coerced to seconds.
    assert resp.bars[0].timestamp == 1_700_000_000
    assert resp.bars[1].timestamp == 1_700_000_300
    assert resp.bars[0].volume == 9  # tick_volume fallback


def test_historical_bars_date_range_sets_custom_period(mt5):
    FakeClient.handler = lambda url, params: FakeResponse({"bars": []})
    resp = _adapter(mt5).historical_bars(
        "EURUSD", "1hour", "1Y", start_date="2024-01-01", end_date="2024-02-01"
    )
    _, params = FakeClient.calls[0]
    assert params["timeframe"] == "H1"
    assert params["start"] == "2024-01-01" and params["end"] == "2024-02-01"
    assert "count" not in params
    assert resp.period == "CUSTOM"


def test_historical_bars_computes_requested_indicators(mt5):
    bars = [
        {
            "time": 1_700_000_000 + i * 60,
            "open": 10 + i,
            "high": 11 + i,
            "low": 9 + i,
            "close": 10 + i,
            "volume": 100,
        }
        for i in range(30)
    ]
    FakeClient.handler = lambda url, params: FakeResponse({"bars": bars})
    resp = _adapter(mt5).historical_bars("EURUSD", "1min", "1D", indicators=["sma_20"])
    assert resp.count == 30
    # The same calculator the IB path uses populates sma_20 on the bars.
    assert resp.bars[-1].sma_20 is not None
    # A 20-period average of a linear ramp trails the latest close.
    assert resp.bars[-1].sma_20 < resp.bars[-1].close


def test_unsupported_timeframe_is_400(mt5):
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).historical_bars("EURUSD", "tick", "1D")
    assert exc.value.status_code == 400


# --------------------------------------------------------------------------- #
# quotes / ticks / search
# --------------------------------------------------------------------------- #
def test_realtime_quote_maps_fields(mt5):
    FakeClient.handler = lambda url, params: FakeResponse(
        {"bid": 1.2345, "ask": 1.2347, "last": 1.2346, "volume": 1000, "time": 1_700_000_000}
    )
    q = _adapter(mt5).realtime_quote("eurusd")
    assert q.symbol == "EURUSD"
    assert q.bid == 1.2345 and q.ask == 1.2347 and q.last == 1.2346
    assert q.volume == 1000


def test_search_contracts_tags_broker_mt5(mt5):
    FakeClient.handler = lambda url, params: FakeResponse(
        {"results": [{"symbol": "EURUSD", "description": "Euro vs USD"}]}
    )

    class Req:
        symbol = "eur"
        max_results = 10

    out = _adapter(mt5).search_contracts(Req())
    assert out["count"] == 1
    assert out["results"][0]["symbol"] == "EURUSD"
    assert out["results"][0]["broker"] == "mt5"
    assert out["broker"] == "mt5"


# --------------------------------------------------------------------------- #
# error translation
# --------------------------------------------------------------------------- #
def test_bridge_unreachable_is_503(mt5):
    def boom(url, params):
        raise mt5.httpx.ConnectError("refused")

    FakeClient.handler = boom
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).realtime_quote("EURUSD")
    assert exc.value.status_code == 503


def test_bridge_5xx_is_502(mt5):
    FakeClient.handler = lambda url, params: FakeResponse({}, status_code=500, text="boom")
    with pytest.raises(HTTPException) as exc:
        _adapter(mt5).realtime_quote("EURUSD")
    assert exc.value.status_code == 502


# --------------------------------------------------------------------------- #
# registry availability
# --------------------------------------------------------------------------- #
def test_registry_registers_mt5_when_bridge_url_set(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.setenv("MT5_BRIDGE_URL", "http://mt5-host:9100")
    adapters.reset_registry()

    md = adapters.get_market_data_adapter("mt5")
    assert md.name == "mt5"
    health = adapters.provider_health()
    assert health["providers"]["mt5"]["market_data"] is True
    # Execution (broker) side is still B2b.
    with pytest.raises(HTTPException) as exc:
        adapters.get_broker_adapter("mt5")
    assert exc.value.status_code == 501


def test_registry_mt5_unavailable_without_bridge_url(monkeypatch):
    import adapters

    importlib.reload(adapters)
    monkeypatch.delenv("MT5_BRIDGE_URL", raising=False)
    adapters.reset_registry()
    with pytest.raises(HTTPException) as exc:
        adapters.get_market_data_adapter("mt5")
    assert exc.value.status_code == 501
