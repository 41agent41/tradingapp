"""Client order ids carry the app's audit id to the venue and back (B9)."""

from __future__ import annotations

from client_ids import audit_id_from, client_order_id


def test_round_trip():
    assert client_order_id(42) == "audit-42"
    assert audit_id_from("audit-42") == 42


def test_no_id_without_a_positive_audit_id():
    assert client_order_id(None) is None
    assert client_order_id(0) is None
    assert client_order_id("x") is None


def test_parses_an_mt5_comment_and_ignores_others():
    assert audit_id_from("audit-7") == 7
    assert audit_id_from("  audit-7 ") == 7
    assert audit_id_from("sl hit audit-9") == 9
    assert audit_id_from("manual trade") is None
    assert audit_id_from("audit-") is None
    assert audit_id_from(None) is None
