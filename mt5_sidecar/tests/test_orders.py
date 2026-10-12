"""Trading endpoints: entries with their stop, closes, stop moves, pending orders."""

from __future__ import annotations

from conftest import make

BUY = {
    "symbol": "EURUSDm",
    "action": "BUY",
    "quantity": 0.1,
    "order_type": "MKT",
    "tif": "DAY",
    "sl": 1.0750,
    "tp": None,
    "account_mode": "paper",
    "comment": "audit-42",
}


def _deals(fake):
    return [r for r in fake.requests if r["action"] == fake.TRADE_ACTION_DEAL]


def test_entry_carries_its_stop_in_the_same_request(netting):
    fake, client = netting
    r = client.post("/orders", json=BUY)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "filled"
    assert body["sl"] == 1.075
    assert body["tp"] is None
    sent = _deals(fake)
    assert len(sent) == 1  # never an entry followed by a separate modify
    assert sent[0]["sl"] == 1.075
    assert sent[0]["comment"] == "audit-42"
    assert sent[0]["magic"] == 61_000
    assert sent[0]["type_filling"] == fake.ORDER_FILLING_IOC
    assert sent[0]["price"] == 1.0801


def test_stop_the_venue_dropped_is_echoed_as_null(netting):
    fake, client = netting
    fake.drop_sl = True
    body = client.post("/orders", json=BUY).json()
    assert body["sl"] is None  # the app treats this as an unprotected entry


def test_positions_report_the_recorded_stop(netting):
    _, client = netting
    client.post("/orders", json=BUY)
    [pos] = client.get("/positions").json()["positions"]
    assert pos["symbol"] == "EURUSDm"
    assert pos["type"] == 0
    assert pos["volume"] == 0.1
    assert pos["sl"] == 1.075


def test_stop_inside_the_stops_level_is_rejected(netting):
    fake, client = netting
    r = client.post("/orders", json={**BUY, "sl": 1.07995})
    assert r.status_code == 400
    assert "10016" in r.json()["error"]
    assert fake.positions == []


def test_requotes_are_retried_with_a_fresh_price(netting):
    fake, client = netting
    fake.requotes = 2
    assert client.post("/orders", json=BUY).json()["status"] == "filled"
    assert len(_deals(fake)) == 3


def test_persistent_requotes_fail(netting):
    fake, client = netting
    fake.requotes = 10
    r = client.post("/orders", json=BUY)
    assert r.status_code == 400
    assert "10004" in r.json()["error"]


def test_volume_off_the_step_is_refused_not_rounded(netting):
    fake, client = netting
    r = client.post("/orders", json={**BUY, "quantity": 0.015})
    assert r.status_code == 400
    assert "step" in r.json()["error"]
    assert fake.requests == []


def test_terminal_without_algo_trading_refuses_orders(netting):
    fake, client = netting
    fake.trade_allowed = False
    assert client.post("/orders", json=BUY).status_code == 409


def test_order_send_returning_none_is_503(netting):
    fake, client = netting
    fake.send_returns_none = True
    assert client.post("/orders", json=BUY).status_code == 503


def test_paper_order_on_a_real_account_is_refused():
    fake, client = make({"MT5_ALLOW_REAL": "true"}, real=True)
    r = client.post("/orders", json=BUY)
    assert r.status_code == 403
    assert fake.requests == []


def test_real_account_needs_allow_real():
    fake, client = make(real=True)
    r = client.post("/orders", json={**BUY, "account_mode": "live"})
    assert r.status_code == 403
    assert "MT5_ALLOW_REAL" in r.json()["error"]


def test_live_order_on_a_real_account_with_allow_real():
    _, client = make({"MT5_ALLOW_REAL": "true"}, real=True)
    r = client.post("/orders", json={**BUY, "account_mode": "live"})
    assert r.status_code == 200


def test_live_order_on_a_demo_account_is_refused(netting):
    _, client = netting
    assert client.post("/orders", json={**BUY, "account_mode": "live"}).status_code == 403


def test_netting_close_flattens(netting):
    fake, client = netting
    client.post("/orders", json=BUY)
    r = client.post("/orders", json={**BUY, "action": "SELL", "sl": None, "comment": "audit-43"})
    assert r.json()["status"] == "filled"
    assert client.get("/positions").json()["positions"] == []


def test_hedging_close_names_the_ticket_instead_of_opening_a_short(hedging):
    fake, client = hedging
    opened = client.post("/orders", json=BUY).json()
    r = client.post("/orders", json={**BUY, "action": "SELL", "sl": None})
    assert r.status_code == 200, r.text
    assert _deals(fake)[-1]["position"] == opened["order_id"]
    assert client.get("/positions").json()["positions"] == []


def test_hedging_close_spans_tickets_oldest_first(hedging):
    fake, client = hedging
    first = client.post("/orders", json=BUY).json()["order_id"]
    second = client.post("/orders", json=BUY).json()["order_id"]
    client.post("/orders", json={**BUY, "action": "SELL", "quantity": 0.15, "sl": None})
    closes = [r for r in _deals(fake) if "position" in r]
    assert [(c["position"], c["volume"]) for c in closes] == [(first, 0.1), (second, 0.05)]
    [pos] = client.get("/positions").json()["positions"]
    assert pos["volume"] == 0.05


def test_hedging_reversal_is_refused(hedging):
    fake, client = hedging
    client.post("/orders", json=BUY)
    r = client.post("/orders", json={**BUY, "action": "SELL", "quantity": 0.2})
    assert r.status_code == 400
    assert "reverse" in r.json()["error"]
    assert len(fake.positions) == 1


def test_hedging_position_without_a_stop_reports_none(hedging):
    _, client = hedging
    client.post("/orders", json=BUY)
    client.post("/orders", json={**BUY, "sl": None})
    [pos] = client.get("/positions").json()["positions"]
    assert pos["volume"] == 0.2
    assert pos["sl"] == 0.0  # one ticket is unprotected, so the symbol is
    assert len(pos["tickets"]) == 2


def test_stop_move_keeps_the_take_profit(netting):
    fake, client = netting
    client.post("/orders", json={**BUY, "tp": 1.09})
    r = client.post("/positions/EURUSDM/stop", json={"sl": 1.076})
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "modified", "sl": 1.076, "tp": 1.09}
    sltp = fake.requests[-1]
    assert sltp["action"] == fake.TRADE_ACTION_SLTP
    assert sltp["tp"] == 1.09


def test_null_stop_never_clears_protection(netting):
    fake, client = netting
    client.post("/orders", json=BUY)
    r = client.post("/positions/EURUSDm/stop", json={"sl": None, "tp": 1.09})
    assert r.json()["sl"] == 1.075
    assert r.json()["tp"] == 1.09


def test_unchanged_stop_is_not_an_error(netting):
    fake, client = netting
    client.post("/orders", json=BUY)
    sent = len(fake.requests)
    r = client.post("/positions/EURUSDm/stop", json={"sl": 1.075})
    assert r.status_code == 200
    assert len(fake.requests) == sent


def test_stop_move_updates_every_hedged_ticket(hedging):
    fake, client = hedging
    client.post("/orders", json=BUY)
    client.post("/orders", json=BUY)
    r = client.post("/positions/EURUSDm/stop", json={"sl": 1.077})
    assert r.json()["sl"] == 1.077
    assert {p["sl"] for p in fake.positions} == {1.077}


def test_stop_move_without_a_position_is_404(netting):
    _, client = netting
    assert client.post("/positions/EURUSDm/stop", json={"sl": 1.07}).status_code == 404


def test_deals_carry_the_comment_and_utc_time():
    fake, client = make({"MT5_SERVER_TZ": "Etc/GMT-2"}, server_offset_hours=2)
    client.post("/orders", json=BUY)
    [deal] = client.get("/deals", params={"days": 1}).json()["deals"]
    assert deal["comment"] == "audit-42"
    assert deal["type"] == 0
    assert deal["volume"] == 0.1
    import time

    assert abs(deal["time"] - time.time()) < 5


def test_limit_order_lifecycle(netting):
    fake, client = netting
    body = {**BUY, "order_type": "LMT", "limit_price": 1.07, "tif": "GTC"}
    placed = client.post("/orders", json=body).json()
    assert placed["status"] == "submitted"
    assert placed["sl"] == 1.075
    assert fake.requests[-1]["type"] == fake.ORDER_TYPE_BUY_LIMIT

    [order] = client.get("/orders").json()["orders"]
    assert (order["order_type"], order["action"], order["price_open"]) == ("LMT", "BUY", 1.07)

    ticket = placed["order_id"]
    r = client.put(f"/orders/{ticket}", json={**body, "limit_price": 1.071})
    assert r.json() == {"status": "modified"}
    assert fake.orders[0]["price_open"] == 1.071

    r = client.put(f"/orders/{ticket}", json={**body, "quantity": 0.2})
    assert r.status_code == 400

    assert client.delete(f"/orders/{ticket}").json() == {"status": "cancelled"}
    assert client.delete(f"/orders/{ticket}").json() == {"status": "not_found"}


def test_pending_order_needs_its_price(netting):
    _, client = netting
    r = client.post("/orders", json={**BUY, "order_type": "STP"})
    assert r.status_code == 400


def test_pending_ioc_is_refused(netting):
    _, client = netting
    r = client.post("/orders", json={**BUY, "order_type": "LMT", "limit_price": 1.07, "tif": "IOC"})
    assert r.status_code == 400


def test_non_json_body_is_400(netting):
    _, client = netting
    r = client.post("/orders", content=b"nope", headers={"content-type": "application/json"})
    assert r.status_code == 400
