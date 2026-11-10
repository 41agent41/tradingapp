"""End to end: the live recorder against real Redis and TimescaleDB.

Runs after the paper run, on the same stack. An instrument is marked Record
live with Store ticks, known quotes are added to the quote stream in the
format the broker service writes (broker_service/streaming.py ``add_quote``),
and the 1-minute bar and the quote rows are read back from the database. The
backend is then restarted to show the recorder resumes from its stored cursor:
quotes added while it was down are stored once, and nothing is stored twice.

The quotes are added here, not by a broker, so the result is exact. The
simulated MT5 terminal has no such symbol; the recorder reports that as the
reason the instrument is not streaming, which is checked too.
"""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any, Dict, List

import httpx
import redis

from test_paper_flow import API, BACKEND, ROOT, wait_until

STREAM = "marketdata:quotes"
SYMBOL = "RECUSD"
ACCOUNT = "sim-b"


def sql(query: str) -> List[List[str]]:
    env = {
        **os.environ,
        "PGHOST": os.environ.get("POSTGRES_HOST", "localhost"),
        "PGPORT": os.environ.get("POSTGRES_PORT", "5432"),
        "PGUSER": os.environ.get("POSTGRES_USER", "tradingapp"),
        "PGPASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
        "PGDATABASE": os.environ.get("POSTGRES_DB", "tradingapp"),
    }
    out = subprocess.run(
        ["psql", "-At", "-F", ",", "-c", query], env=env, check=True, capture_output=True, text=True
    ).stdout
    return [line.split(",") for line in out.splitlines() if line]


def status() -> Dict[str, Any]:
    r = httpx.get(f"{BACKEND}/market-data/recorder/status", headers=API, timeout=10)
    r.raise_for_status()
    return r.json()


def recorded(contract_id: int) -> Dict[str, Any] | None:
    return next((c for c in status()["contracts"] if c["contract_id"] == contract_id), None)


def add_quotes(client: redis.Redis, minute_ms: int, quotes: List[tuple]) -> None:
    for offset_s, bid, ask in quotes:
        ts = minute_ms + offset_s * 1000
        client.xadd(
            STREAM,
            {
                "v": "1",
                "platform": "mt5",
                "account": ACCOUNT,
                "symbol": SYMBOL,
                "bid": repr(bid),
                "ask": repr(ask),
                "last": "",
                "last_size": "",
                "basis": "bid",
                "ts": str(ts),
                "recv_ts": str(ts + 3),
            },
        )


def test_recorder_stores_bars_and_quotes_and_resumes_after_a_restart():
    client = redis.Redis(
        host=os.environ.get("REDIS_HOST", "127.0.0.1"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
    )
    r = httpx.post(
        f"{BACKEND}/market-data/collection",
        headers=API,
        json={
            "broker": "mt5",
            "account": ACCOUNT,
            "symbol": SYMBOL,
            "timeframe": "1min",
            "auto_collect": False,
            "record_ticks": True,
        },
        timeout=10,
    )
    assert r.status_code == 201, r.text
    entry = r.json()["entry"]
    # Storing ticks turns Record live on.
    assert entry["record_live"] and entry["record_ticks"]
    contract = entry["contract_id"]

    try:
        # The recorder has told the broker service, which has resolved the
        # account, and the recorder has stored where it starts reading.
        wait_until(
            "the recorder to take the instrument",
            lambda: (recorded(contract) or {}).get("mode") and status()["cursor"],
            timeout=90,
        )

        # A finished minute, inside the recorder's ten-minute window.
        minute = (int(time.time()) // 60 - 2) * 60_000
        add_quotes(client, minute, [(1, 1.1000, 1.1002), (20, 1.1050, 1.1052), (40, 1.0950, 1.0952)])
        wait_until(
            "the first quotes to be stored",
            lambda: sql(f"SELECT count(*) FROM quote_ticks WHERE contract_id = {contract}")[0][0]
            == "3",
            timeout=60,
        )

        # Down: these wait in the stream. Up: stored once, the bar carries on.
        subprocess.run([str(ROOT / "e2e" / "stack.sh"), "stop-one", "backend"], check=True)
        add_quotes(client, minute, [(50, 1.1020, 1.1022), (55, 1.1010, 1.1012)])
        subprocess.run([str(ROOT / "e2e" / "stack.sh"), "restart", "backend"], check=True)
        wait_until(
            "the quotes added while the backend was down",
            lambda: sql(f"SELECT count(*) FROM quote_ticks WHERE contract_id = {contract}")[0][0]
            == "5",
            timeout=90,
        )

        bars = sql(
            "SELECT open::float8, high::float8, low::float8, close::float8, count, source, "
            "(extract(epoch FROM timestamp) * 1000)::bigint FROM candlestick_data "
            f"WHERE contract_id = {contract} AND timeframe = '1min'"
        )
        # MT5 bars are built from the bid.
        assert bars == [["1.1", "1.105", "1.095", "1.101", "5", "stream", str(minute)]]
        ticks = sql(
            "SELECT bid, ask, (extract(epoch FROM ts) * 1000)::bigint FROM quote_ticks "
            f"WHERE contract_id = {contract} ORDER BY ts"
        )
        assert [t[0] for t in ticks] == ["1.1", "1.105", "1.095", "1.102", "1.101"]
        assert ticks[0][2] == str(minute + 1000)

        # The simulated terminal has no such symbol, and the page is told so.
        row = wait_until(
            "the reason it is not streaming",
            lambda: (recorded(contract) or {}).get("error") and recorded(contract),
            timeout=150,
        )
        assert "not found" in row["error"]
        assert row["mode"] == "polled"
        assert status()["lag_seconds"] == 0
    finally:
        httpx.delete(f"{BACKEND}/market-data/collection/{entry['id']}", headers=API, timeout=10)

    # Removed from the list: the recorder lets go of it.
    wait_until("the recorder to release it", lambda: recorded(contract) is None, timeout=90)
