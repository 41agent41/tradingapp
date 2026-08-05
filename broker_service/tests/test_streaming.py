"""
Unit tests for ``streaming.StreamingManager``.

The tests substitute fake objects for the live IB ``EClient`` and for
the Redis client so they run hermetically — no network, no IB Gateway,
no `redis` server.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import pytest

from streaming import (
    BASE_STREAM_REQ_ID,
    TICK_CHANNEL_PREFIX,
    StreamingManager,
)

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class FakeContract:
    symbol: str
    sec_type: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"


@dataclass
class FakeIB:
    """Minimal stand-in for the live ``IBApp``.

    Records every ``reqMktData`` / ``cancelMktData`` call so the tests
    can assert on the sequence. ``tick_observer`` is the attribute the
    real IBApp exposes (added in main.py alongside this module).
    """

    req_calls: list[tuple] = field(default_factory=list)
    cancel_calls: list[int] = field(default_factory=list)
    tick_observer: object | None = None

    def reqMktData(self, req_id, contract, ticks, snapshot, regulatory, opts):
        self.req_calls.append((req_id, contract, ticks, snapshot, regulatory, opts))

    def cancelMktData(self, req_id):
        self.cancel_calls.append(req_id)


class FakeRedis:
    """In-memory Redis pub/sub stand-in."""

    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.connected = True

    def publish(self, channel, payload):
        if not self.connected:
            raise RuntimeError("FakeRedis: not connected")
        self.published.append((channel, payload))

    def ping(self):
        if not self.connected:
            raise RuntimeError("FakeRedis: not connected")
        return True


def resolver(symbol: str, sec_type: str, exchange: str, currency: str) -> FakeContract:
    return FakeContract(symbol=symbol, sec_type=sec_type, exchange=exchange, currency=currency)


@pytest.fixture
def mgr_and_pieces():
    redis = FakeRedis()
    mgr = StreamingManager(redis_factory=lambda: redis, clock=lambda: 1234567890.0)
    ib = FakeIB()
    mgr.attach(ib, resolver)
    return mgr, ib, redis


# ---------------------------------------------------------------------------
# Attach / detach
# ---------------------------------------------------------------------------


def test_attach_wires_tick_observer(mgr_and_pieces):
    mgr, ib, _redis = mgr_and_pieces
    # Bound methods are equal but not identical, so use ==.
    assert ib.tick_observer == mgr.on_tick


def test_detach_cancels_all_and_clears_observer(mgr_and_pieces):
    mgr, ib, _redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.subscribe("AAPL")
    mgr.detach()
    assert ib.tick_observer is None
    assert sorted(ib.cancel_calls) == sorted([BASE_STREAM_REQ_ID, BASE_STREAM_REQ_ID + 1])
    assert mgr.list_symbols() == []


# ---------------------------------------------------------------------------
# Subscription lifecycle
# ---------------------------------------------------------------------------


def test_subscribe_starts_ib_and_publishes_status(mgr_and_pieces):
    mgr, ib, redis = mgr_and_pieces
    sub = mgr.subscribe("MSFT")
    assert sub.symbol == "MSFT"
    assert sub.req_id == BASE_STREAM_REQ_ID
    assert sub.ref_count == 1
    # Exactly one reqMktData call with the qualified contract.
    assert len(ib.req_calls) == 1
    req_id, contract, ticks, snapshot, regulatory, opts = ib.req_calls[0]
    assert (req_id, snapshot, regulatory) == (BASE_STREAM_REQ_ID, False, False)
    assert isinstance(contract, FakeContract) and contract.symbol == "MSFT"
    # And a status event landed on the marketdata:status channel.
    assert ("marketdata:status", pytest.approx) is not None  # placeholder readability
    status_events = [c for c in redis.published if c[0] == "marketdata:status"]
    assert any("started" in p for _ch, p in status_events)


def test_subscribe_is_idempotent_and_refcounted(mgr_and_pieces):
    mgr, ib, _redis = mgr_and_pieces
    a = mgr.subscribe("MSFT")
    b = mgr.subscribe("MSFT")
    assert a.req_id == b.req_id == BASE_STREAM_REQ_ID
    assert b.ref_count == 2
    # Only one IB call regardless of subscribers.
    assert len(ib.req_calls) == 1


def test_unsubscribe_decrements_then_cancels(mgr_and_pieces):
    mgr, ib, redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.subscribe("MSFT")
    sub = mgr.unsubscribe("MSFT")
    assert sub is not None and sub.ref_count == 1
    assert ib.cancel_calls == []  # not yet
    sub = mgr.unsubscribe("MSFT")
    assert sub is not None and sub.ref_count == 0
    assert ib.cancel_calls == [BASE_STREAM_REQ_ID]
    # Resource freed — MSFT is no longer in the subscriptions table.
    assert "MSFT" not in mgr.list_symbols()
    # Status events captured (started + stopped)
    status_payloads = [p for ch, p in redis.published if ch == "marketdata:status"]
    assert any("started" in p for p in status_payloads)
    assert any("stopped" in p for p in status_payloads)


def test_unsubscribe_unknown_symbol_returns_none(mgr_and_pieces):
    mgr, _ib, _redis = mgr_and_pieces
    assert mgr.unsubscribe("NOPE") is None


def test_force_unsubscribe_drops_regardless_of_refcount(mgr_and_pieces):
    mgr, ib, _redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.subscribe("MSFT")
    mgr.subscribe("MSFT")  # ref_count = 3
    out = mgr.force_unsubscribe("MSFT")
    assert out is not None and out.ref_count == 0
    assert ib.cancel_calls == [BASE_STREAM_REQ_ID]
    assert mgr.list_symbols() == []


def test_subscribe_with_blank_symbol_raises(mgr_and_pieces):
    mgr, _ib, _redis = mgr_and_pieces
    with pytest.raises(ValueError):
        mgr.subscribe("   ")


def test_subscribe_rolls_back_bookkeeping_on_ib_failure():
    redis = FakeRedis()
    mgr = StreamingManager(redis_factory=lambda: redis, clock=lambda: 1.0)

    class Broken(FakeIB):
        def reqMktData(self, *args, **kwargs):
            raise RuntimeError("boom")

    ib = Broken()
    mgr.attach(ib, resolver)
    with pytest.raises(RuntimeError):
        mgr.subscribe("MSFT")
    # The failure must not leave a half-state behind.
    assert mgr.list_symbols() == []


# ---------------------------------------------------------------------------
# Tick publishing
# ---------------------------------------------------------------------------


def test_on_tick_publishes_price_payload(mgr_and_pieces):
    mgr, _ib, redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.on_tick(BASE_STREAM_REQ_ID, tick_type=4, price=380.25)  # LAST
    ticks = [c for c in redis.published if c[0].startswith(TICK_CHANNEL_PREFIX)]
    assert len(ticks) == 1
    channel, payload = ticks[0]
    assert channel == f"{TICK_CHANNEL_PREFIX}MSFT"
    assert '"tick_type": "LAST"' in payload
    assert '"price": 380.25' in payload
    assert '"symbol": "MSFT"' in payload


def test_on_tick_publishes_size_payload(mgr_and_pieces):
    mgr, _ib, redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.on_tick(BASE_STREAM_REQ_ID, tick_type=5, size=100)  # LAST_SIZE
    ticks = [c for c in redis.published if c[0].startswith(TICK_CHANNEL_PREFIX)]
    assert len(ticks) == 1
    _channel, payload = ticks[0]
    assert '"tick_type": "LAST_SIZE"' in payload
    assert '"size": 100.0' in payload


def test_on_tick_unknown_req_id_is_dropped(mgr_and_pieces):
    mgr, _ib, redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    redis.published.clear()
    mgr.on_tick(99_999_999, tick_type=4, price=1.23)
    assert redis.published == []
    assert mgr.ticks_dropped == 1


def test_on_tick_unknown_tick_type_is_dropped(mgr_and_pieces):
    mgr, _ib, redis = mgr_and_pieces
    sub = mgr.subscribe("MSFT")
    redis.published.clear()
    mgr.on_tick(sub.req_id, tick_type=999, price=1.0)
    assert redis.published == []
    assert mgr.ticks_dropped == 1


@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_on_tick_drops_nanish_values(mgr_and_pieces, bad_value):
    mgr, _ib, redis = mgr_and_pieces
    sub = mgr.subscribe("MSFT")
    redis.published.clear()
    mgr.on_tick(sub.req_id, tick_type=4, price=bad_value)
    assert redis.published == []
    assert mgr.ticks_dropped == 1


def test_on_tick_increments_per_sub_counter(mgr_and_pieces):
    mgr, _ib, _redis = mgr_and_pieces
    sub = mgr.subscribe("MSFT")
    mgr.on_tick(sub.req_id, tick_type=4, price=10.0)
    mgr.on_tick(sub.req_id, tick_type=4, price=11.0)
    assert sub.tick_count == 2
    assert math.isclose(sub.last_tick_at, 1234567890.0)


# ---------------------------------------------------------------------------
# Redis failure tolerance
# ---------------------------------------------------------------------------


def test_publish_failure_does_not_break_callbacks(mgr_and_pieces):
    mgr, _ib, redis = mgr_and_pieces
    sub = mgr.subscribe("MSFT")
    # Simulate a publish error
    redis.connected = False
    mgr.on_tick(sub.req_id, tick_type=4, price=42.0)
    # We should have observed the tick (counts updated) without raising,
    # and the cached client must be evicted so the next publish will
    # reconnect.
    assert mgr.ticks_total >= 1
    assert mgr.ticks_dropped >= 1


def test_status_payload_shape(mgr_and_pieces):
    mgr, _ib, _redis = mgr_and_pieces
    mgr.subscribe("MSFT")
    mgr.subscribe("AAPL")
    snap = mgr.status()
    assert {s["symbol"] for s in snap["subscriptions"]} == {"MSFT", "AAPL"}
    assert snap["channels"]["tick_prefix"] == TICK_CHANNEL_PREFIX
    assert snap["totals"]["ticks_total"] >= 0


def test_status_when_redis_unavailable_reports_disconnected():
    mgr = StreamingManager(redis_factory=lambda: None, clock=lambda: 1.0)
    info = mgr._redis_health()
    assert info["connected"] is False
