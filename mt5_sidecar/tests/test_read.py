"""Auth, health and the read-side endpoints."""

from __future__ import annotations

import time

from conftest import SECRET, make
from server import SECRET_HEADER


def test_requests_without_the_secret_are_refused(netting):
    _, client = netting
    del client.headers[SECRET_HEADER]
    assert client.get("/health").status_code == 401
    assert client.post("/orders", json={}).status_code == 401
    r = client.get("/health", headers={SECRET_HEADER: "w" * len(SECRET)})
    assert r.status_code == 401


def test_health_reports_the_account(netting):
    _, client = netting
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["login"] == 5001
    assert body["account_type"] == "demo"
    assert body["margin_mode"] == "netting"


def test_health_is_503_when_the_terminal_is_offline(netting):
    fake, client = netting
    fake.connected = False
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["terminal_connected"] is False


def test_reattaches_after_the_terminal_restarts(netting):
    fake, client = netting
    fake.initialized = False  # terminal closed and reopened: IPC lost
    assert client.get("/health").json()["status"] == "ok"
    assert len(fake.init_calls) == 2


def test_wrong_account_is_reported():
    _, client = make({"MT5_LOGIN": "999"})
    r = client.get("/health")
    assert r.status_code == 503
    assert "not MT5_LOGIN=999" in r.json()["error"]


def test_health_flags_algo_trading_off(netting):
    fake, client = netting
    fake.trade_allowed = False
    assert client.get("/health").json()["status"] == "trading_disabled"


def test_symbol_search(netting):
    _, client = netting
    body = client.get("/symbols", params={"query": "usd", "limit": 2}).json()
    assert body["count"] == 2
    assert body["results"][0]["symbol"] == "EURUSDm"


def test_symbols_resolve_case_insensitively(netting):
    fake, client = netting
    body = client.get("/symbol", params={"symbol": "EURUSDM"}).json()
    assert body["name"] == "EURUSDm"
    assert "symbol" not in body  # the adapter would read it as a nested spec
    assert body["trade_stops_level"] == 10
    assert body["trade_tick_value"] == 1.0
    assert fake.selected[-1] == "EURUSDm"


def test_unknown_symbol_is_404(netting):
    _, client = netting
    assert client.get("/quote", params={"symbol": "NOPE"}).status_code == 404


def test_history_converts_server_time_to_utc():
    fake, client = make({"MT5_SERVER_TZ": "Etc/GMT-2"}, server_offset_hours=2)
    bars = client.get(
        "/history", params={"symbol": "EURUSDm", "timeframe": "M5", "count": 3}
    ).json()["bars"]
    assert len(bars) == 3
    now = time.time()
    # Without the conversion the last bar would sit two hours in the future.
    assert now - 300 <= bars[-1]["time"] <= now
    assert bars[-1]["volume"] == 100
    assert isinstance(bars[-1]["time"], int)


def test_history_range_is_sent_in_server_time():
    fake, client = make({"MT5_SERVER_TZ": "Etc/GMT-2"}, server_offset_hours=2)
    client.get(
        "/history",
        params={
            "symbol": "EURUSDm",
            "timeframe": "H1",
            "start": "2026-01-05T00:00:00Z",
            "end": "2026-01-05T03:00:00Z",
        },
    )
    _, _, tf, date_from, _ = fake.rate_calls[-1]
    assert tf == fake.TIMEFRAME_H1
    assert date_from.isoformat() == "2026-01-05T02:00:00+00:00"


def test_unsupported_timeframe_is_400(netting):
    _, client = netting
    r = client.get("/history", params={"symbol": "EURUSDm", "timeframe": "M2"})
    assert r.status_code == 400


def test_quote_time_is_utc():
    _, client = make({"MT5_SERVER_TZ": "Etc/GMT-3"}, server_offset_hours=3)
    q = client.get("/quote", params={"symbol": "eurusdm"}).json()
    assert (q["bid"], q["ask"]) == (1.08, 1.0801)
    assert abs(q["time"] - time.time()) < 5


def test_account(netting):
    _, client = netting
    body = client.get("/account").json()
    assert body["equity"] == 10_000.0
    assert body["margin_free"] == 10_000.0
    assert body["account_type"] == "demo"


def test_initialize_gets_the_path_and_login():
    fake, _ = make(
        {
            "MT5_TERMINAL_PATH": r"C:\MT5-A\terminal64.exe",
            "MT5_PORTABLE": "1",
            "MT5_LOGIN": "5001",
            "MT5_PASSWORD": "pw",
            "MT5_SERVER": "Fake-Demo",
        }
    )
    args, kwargs = fake.init_calls[-1]
    assert args == (r"C:\MT5-A\terminal64.exe",)
    assert kwargs == {"login": 5001, "password": "pw", "server": "Fake-Demo", "portable": True}


def test_failed_position_read_is_an_error_not_flat(netting):
    fake, client = netting
    fake.fail_reads = True
    r = client.get("/positions")
    assert r.status_code == 503
    assert "positions unavailable" in r.json()["error"]


def test_reads_while_offline_are_503(netting):
    fake, client = netting
    fake.connected = False
    for path in ("/positions", "/orders", "/account", "/deals", "/symbols"):
        assert client.get(path).status_code == 503, path
    assert client.get("/quote", params={"symbol": "EURUSDm"}).status_code == 503
