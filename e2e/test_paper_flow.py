"""End-to-end paper run: the runbook's steps 11-22 against the real services.

Runs against a stack started by `e2e/stack.sh start`: two simulated MT5
terminals behind the real sidecar app, the broker service, and the backend with
the strategy runner placing paper orders. Bars are one minute, so the whole run
takes several minutes.

The strategy goes long whenever a bar closes above its open, with a 2-bar-low
stop. The simulated market rises steadily, so it enters on the first bar, the
stop trails up every bar, and a price drop forced through the control route
stops it out.

    e2e/stack.sh start && python -m pytest e2e -q; e2e/stack.sh stop
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent
BACKEND = "http://127.0.0.1:4000/api"
BROKER = "http://127.0.0.1:8000"
SIDECARS = {
    "sim-a": ("http://127.0.0.1:9101", os.environ.get("E2E_SECRET_A", "a" * 32)),
    "sim-b": ("http://127.0.0.1:9102", os.environ.get("E2E_SECRET_B", "b" * 32)),
}
API = {
    "Authorization": f"Bearer {os.environ.get('E2E_API_TOKEN', 'e2e-api-token-0123456789abcdef0123')}"
}
BROKER_AUTH = {
    "X-Broker-Service-Token": os.environ.get(
        "E2E_BROKER_TOKEN", "e2e-broker-token-0123456789abcdef"
    )
}
SIZE = 0.1

RULE_SET = {
    "direction": "long",
    "entry": {"all": [{"left": "close", "op": ">", "right": "open"}]},
    "exit": {"all": [{"left": "close", "op": "<", "right": "open"}]},
    "stop": {"type": "bar_extreme", "lookback": 2},
    "sizing": {"type": "fixed", "size": SIZE},
}


def wait_until(
    what: str, check: Callable[[], Any], timeout: float = 180, every: float = 3
) -> Any:
    deadline = time.time() + timeout
    last: Any = None
    while time.time() < deadline:
        try:
            last = check()
        except httpx.HTTPError as exc:
            last = exc
        if last and not isinstance(last, Exception):
            return last
        time.sleep(every)
    pytest.fail(f"timed out after {timeout}s waiting for {what}; last: {last!r}")


def sim(account: str) -> Dict[str, Any]:
    url, secret = SIDECARS[account]
    r = httpx.get(f"{url}/_sim", headers={"X-MT5-Bridge-Secret": secret}, timeout=10)
    r.raise_for_status()
    return r.json()


def sim_set(account: str, **changes: Any) -> None:
    url, secret = SIDECARS[account]
    httpx.post(
        f"{url}/_sim", json=changes, headers={"X-MT5-Bridge-Secret": secret}, timeout=10
    ).raise_for_status()


def api(method: str, path: str, **kw: Any) -> httpx.Response:
    return httpx.request(method, f"{BACKEND}{path}", headers=API, timeout=30, **kw)


def entries(account: str) -> List[Dict[str, Any]]:
    """Market orders the terminal received that carried a stop (the entries)."""
    return [r for r in sim(account)["requests"] if r["action"] == 1 and r.get("sl")]


def stop_moves(account: str) -> List[float]:
    return [r["sl"] for r in sim(account)["requests"] if r["action"] == 6]


def assert_never_doubled(account: str) -> None:
    """The runner must never add to an open position: one entry, one size."""
    for pos in sim(account)["positions"]:
        assert pos["volume"] == pytest.approx(
            SIZE
        ), f"{account} holds {pos['volume']}: {pos}"


def fleet_connection(account: str) -> Dict[str, Any]:
    connections = api("GET", "/strategies/fleet").json()["connections"]
    return next(c for c in connections if c["connection"] == f"mt5:{account}")


def fleet_halt(account: str) -> Any:
    return fleet_connection(account)["halt"]


def signals(run_id: int) -> List[Dict[str, Any]]:
    return api("GET", f"/strategies/runs/{run_id}/signals").json()["signals"]


E2E_DIR = Path(os.environ.get("E2E_DIR", "/tmp/tradingapp-e2e"))


def backend_log() -> str:
    return (E2E_DIR / "backend.log").read_text()


def set_calendar(events: List[Dict[str, Any]]) -> None:
    """Rewrite the economic calendar the backend reads (see stack.sh)."""
    (E2E_DIR / "calendar" / "calendar.json").write_text(json.dumps(events))


def restart(component: str) -> None:
    subprocess.run([str(ROOT / "e2e" / "stack.sh"), "restart", component], check=True)


def test_paper_flow():
    # Step 11-12: both connections are registered and routed separately.
    providers = httpx.get(f"{BROKER}/providers", headers=BROKER_AUTH, timeout=30).json()
    assert {"mt5:sim-a", "mt5:sim-b"} <= set(
        providers.get("connections", {})
    ), providers
    logins = {
        account: httpx.get(
            f"{BROKER}/account/summary",
            params={"broker": "mt5", "account": account},
            headers=BROKER_AUTH,
            timeout=30,
        ).json()["account_id"]
        for account in SIDECARS
    }
    assert len(set(logins.values())) == 2, logins

    # Step 16: one definition, deployed to both with A as the canary.
    created = api(
        "POST",
        "/strategies/definitions",
        json={
            "name": "e2e trend",
            "symbol": "EURUSD",
            "timeframe": "1min",
            "broker": "mt5",
            "sec_type": "CASH",
            "currency": "USD",
            "holdout_start": "2026-01-01",
            "rule_set": RULE_SET,
        },
    )
    assert created.status_code == 201, created.text
    definition = created.json()["id"]
    deployed = api(
        "POST",
        f"/strategies/definitions/{definition}/deploy",
        json={
            "targets": [
                {
                    "broker": "mt5",
                    "account": "sim-a",
                    "canary": True,
                    "account_mode": "paper",
                },
                {"broker": "mt5", "account": "sim-b", "account_mode": "paper"},
            ],
            "settle_seconds": 30,
        },
    )
    assert deployed.status_code == 201, deployed.text
    runs = {r["broker_account"]: r for r in deployed.json()["runs"]}
    assert runs["sim-a"]["status"] == "running" and runs["sim-b"]["status"] == "pending"
    assert runs["sim-a"]["native_symbol"] == "EURUSD.a"
    assert runs["sim-b"]["native_symbol"] == "EURUSDm"

    # Step 20: the canary enters with its stop on the entry order itself.
    wait_until("the canary's entry", lambda: entries("sim-a"))
    position = sim("sim-a")["positions"][0]
    assert position["sl"] > 0 and position["sl"] < position["price_open"], position

    # Step 17: the canary settles and admits its sibling, which then enters.
    wait_until(
        "the sibling to be admitted",
        lambda: api("GET", f"/strategies/runs/{runs['sim-b']['id']}").json()["status"]
        == "running",
    )
    wait_until("the sibling's entry", lambda: entries("sim-b"))

    # Step 15: fills reach the database, linked to their runs.
    for account in SIDECARS:
        wait_until(
            f"{account}'s entry fill to be ingested",
            lambda account=account: api(
                "GET",
                "/account/executions",
                params={"broker": "mt5", "account": account},
            ).json()["count"],
            timeout=90,
        )

    # Prop rules (R-P1) on sim-b, read through the real broker service: the
    # balance reaches the marks, and the firm's floors are where its rules say.
    prop = wait_until(
        "sim-b's prop rules to be measured",
        lambda: (fleet_connection("sim-b")["equity"] or {}).get("prop"),
        timeout=90,
    )
    assert fleet_connection("sim-b")["equity"]["balance"] == pytest.approx(25_000)
    rules = {r["kind"]: r for r in prop["rules"]}
    # 5% daily and 10% trailing of a 25,000 initial balance.
    assert rules["prop_daily_loss"]["floor"] == pytest.approx(23_750, abs=50), rules
    assert rules["prop_max_loss"]["floor"] == pytest.approx(22_500, abs=50), rules
    assert not any(r["stopped"] for r in rules.values()), rules

    # Step 21: the stop trails up, one move per bar, never down.
    wait_until("two trail moves", lambda: len(stop_moves("sim-a")) >= 2, timeout=200)
    moves = stop_moves("sim-a")
    assert moves == sorted(moves) and len(set(moves)) == len(moves), moves
    assert_never_doubled("sim-a")
    assert_never_doubled("sim-b")

    # Restart drill: the backend and the broker service go down with positions
    # open. Nothing is re-entered, and the trail carries on from the venue's stop.
    before = {account: len(entries(account)) for account in SIDECARS}
    restart("backend")
    restart("broker")
    moved = len(stop_moves("sim-a"))
    wait_until(
        "the trail to resume", lambda: len(stop_moves("sim-a")) > moved, timeout=150
    )
    assert {account: len(entries(account)) for account in SIDECARS} == before
    assert_never_doubled("sim-a")
    assert_never_doubled("sim-b")

    # A drop through the stop closes the position at the stop, at the venue.
    stop = sim("sim-a")["positions"][0]["sl"]
    sim_set("sim-a", price_offset=-0.003)
    deals = wait_until(
        "the stop to fire",
        lambda: [d for d in sim("sim-a")["deals"] if d["comment"] == "[sl]"],
        timeout=30,
    )
    assert deals[0]["price"] == pytest.approx(stop)
    # The stop fill is ingested, and the strategy re-enters on a later bar.
    wait_until(
        "the stop fill to be ingested",
        lambda: any(
            e["side"] == "SELL"
            for e in api(
                "GET",
                "/account/executions",
                params={"broker": "mt5", "account": "sim-a"},
            ).json()["executions"]
        ),
        timeout=90,
    )
    wait_until(
        "the re-entry",
        lambda: len(entries("sim-a")) == before["sim-a"] + 1,
        timeout=150,
    )
    assert_never_doubled("sim-a")

    # Kill-switch halt (E-6): sim-b's stop disappears at the venue. The runner
    # halts new entries on sim-b alone and puts the stop back. After a stop-out
    # the strategy wants back in, and is refused until the connection resumes.
    sim_set("sim-b", strip_sl=True)
    halt = wait_until("sim-b to be halted", lambda: fleet_halt("sim-b"), timeout=90)
    assert halt["trigger_kind"] == "unprotected_position", halt
    assert fleet_halt("sim-a") is None
    wait_until(
        "sim-b's stop to be re-attached",
        lambda: sim("sim-b")["positions"] and sim("sim-b")["positions"][0]["sl"] > 0,
        timeout=90,
    )

    halted_entries = len(entries("sim-b"))
    sim_set("sim-b", price_offset=-0.003)
    stopped = wait_until(
        "sim-b's stop to fire",
        lambda: [d for d in sim("sim-b")["deals"] if d["comment"] == "[sl]"],
        timeout=30,
    )
    assert stopped
    run_b = runs["sim-b"]["id"]
    seen = {s["id"] for s in signals(run_b)}
    # Entry signals the runner saw while flat, after the stop-out, that placed
    # nothing: the halt refusing them.
    wait_until(
        "two refused entry signals on the halted connection",
        lambda: len(
            [
                s
                for s in signals(run_b)
                if s["id"] not in seen
                and s["entry"]
                and not s["acted"]
                and float(s["position_size"]) == 0
            ]
        )
        >= 2,
        timeout=240,
    )
    assert len(entries("sim-b")) == halted_entries
    assert not sim("sim-b")["positions"]

    resumed = api("POST", "/strategies/connections/mt5/sim-b/resume")
    assert resumed.status_code == 200, resumed.text
    assert fleet_halt("sim-b") is None
    wait_until(
        "sim-b's entry after resuming",
        lambda: len(entries("sim-b")) == halted_entries + 1,
        timeout=150,
    )
    assert_never_doubled("sim-b")

    # Equity limits with floating P&L: sim-a loses 100 of equity (a balance
    # drop stands in for a loss), past both its daily loss (50) and drawdown
    # (80) limits. Nothing has closed at a loss in the fills, so only an
    # equity-based limit can see it. Entries stop; the open position's stop
    # still works.
    sim_set("sim-a", balance=9_900)
    equity = wait_until(
        "sim-a's equity limits to trip",
        lambda: (fleet_connection("sim-a")["equity"] or {}).get("breaches") or None,
        timeout=120,
    )
    assert set(equity) == {"daily_equity_loss", "drawdown"}, equity
    assert not (fleet_connection("sim-b")["equity"] or {}).get("breaches")

    limited_entries = len(entries("sim-a"))
    stops_before = len([d for d in sim("sim-a")["deals"] if d["comment"] == "[sl]"])
    sim_set("sim-a", price_offset=-0.006)
    wait_until(
        "sim-a's stop to fire again",
        lambda: len([d for d in sim("sim-a")["deals"] if d["comment"] == "[sl]"])
        > stops_before,
        timeout=30,
    )
    run_a = runs["sim-a"]["id"]
    seen = {s["id"] for s in signals(run_a)}
    wait_until(
        "two entry signals refused by the equity limits",
        lambda: len(
            [
                s
                for s in signals(run_a)
                if s["id"] not in seen
                and s["entry"]
                and not s["acted"]
                and float(s["position_size"]) == 0
            ]
        )
        >= 2,
        timeout=240,
    )
    assert len(entries("sim-a")) == limited_entries
    assert not sim("sim-a")["positions"]

    # News blackout (R-P2): a high-impact USD release is due now, and sim-b's
    # firm forbids entries within an hour of one. Stopped out, sim-b is refused
    # re-entry with the release named; once the calendar clears, it re-enters.
    set_calendar(
        [
            {
                "title": "Non-Farm Employment Change",
                "country": "USD",
                "date": datetime.now(timezone.utc).isoformat(),
                "impact": "High",
            }
        ]
    )
    blackout_entries = len(entries("sim-b"))
    stops_before = len([d for d in sim("sim-b")["deals"] if d["comment"] == "[sl]"])
    sim_set("sim-b", price_offset=-0.006)
    wait_until(
        "sim-b's stop to fire again",
        lambda: len([d for d in sim("sim-b")["deals"] if d["comment"] == "[sl]"])
        > stops_before,
        timeout=30,
    )
    wait_until(
        "an entry refused by the news blackout",
        lambda: "news blackout: USD Non-Farm Employment Change" in backend_log(),
        timeout=240,
    )
    assert len(entries("sim-b")) == blackout_entries
    assert not sim("sim-b")["positions"]

    set_calendar([])
    wait_until(
        "sim-b's entry once the blackout clears",
        lambda: len(entries("sim-b")) == blackout_entries + 1,
        timeout=240,
    )
    assert_never_doubled("sim-b")

    # Flatten (E-6): the operator closes everything on sim-b. The position is
    # closed at the venue through the audited order path, and the connection is
    # halted so the strategy does not walk straight back in.
    assert sim("sim-b")["positions"], "sim-b should hold its re-entry"
    flattened = api("POST", "/strategies/connections/mt5/sim-b/flatten")
    assert flattened.status_code == 200, flattened.text
    body = flattened.json()
    assert body["complete"] is True, body
    assert len(body["closed"]) == 1 and not body["failed"], body
    wait_until("sim-b to be flat", lambda: not sim("sim-b")["positions"], timeout=30)
    assert fleet_halt("sim-b")["trigger_kind"] == "operator_flatten"
    assert fleet_halt("sim-a") is None
