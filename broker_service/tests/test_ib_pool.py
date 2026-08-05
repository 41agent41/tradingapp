"""
Tests for ib_pool.IBPool.

Uses a stand-in for IBApp so the suite is hermetic (no IB Gateway, no
threads beyond what the test driver creates).
"""

from __future__ import annotations

import queue
import threading
import time

import pytest

from ib_pool import IBPool


class FakeIBApp:
    """Stand-in for IBApp. The pool only cares about identity here."""

    def __init__(self, client_id: int) -> None:
        self.client_id = client_id


def make_pool(size: int, base: int = 10):
    """Build a pool that hands out FakeIBApp(client_id=base+i)."""
    return IBPool(size=size, base_client_id=base, connect_factory=lambda cid: FakeIBApp(cid))


def test_acquire_returns_distinct_clients_until_exhausted():
    pool = make_pool(size=3)
    tokens = []
    seen_ids = set()
    for _ in range(3):
        token, client = pool.acquire(timeout=0.1)
        tokens.append(token)
        seen_ids.add(client.client_id)
    assert len(seen_ids) == 3
    # Pool is now exhausted — acquire should time out.
    with pytest.raises(queue.Empty):
        pool.acquire(timeout=0.05)
    # Release everything and confirm acquire works again.
    for t in tokens:
        pool.release(t)
    pool.acquire(timeout=0.1)


def test_release_returns_slot_to_the_pool():
    pool = make_pool(size=1)
    t1, c1 = pool.acquire(timeout=0.1)
    pool.release(t1)
    t2, c2 = pool.acquire(timeout=0.1)
    # Same slot reused => same client identity.
    assert c1 is c2
    assert t1 == t2


def test_borrow_context_manager_releases_on_exit():
    pool = make_pool(size=1)
    with pool.borrow(timeout=0.1) as ib:
        assert isinstance(ib, FakeIBApp)
    # The pool should be free again.
    pool.acquire(timeout=0.1)


def test_borrow_releases_on_exception():
    pool = make_pool(size=1)
    with pytest.raises(RuntimeError):
        with pool.borrow(timeout=0.1):
            raise RuntimeError("boom")
    # Slot must have been released despite the raise.
    pool.acquire(timeout=0.1)


def test_stats_reports_in_use_and_connected_counts():
    pool = make_pool(size=2)
    assert pool.stats() == {
        "size": 2,
        "in_use": 0,
        "connected": 0,
        "free": 2,
        "client_ids": [10, 11],
    }
    t1, _ = pool.acquire(timeout=0.1)
    stats = pool.stats()
    assert stats["in_use"] == 1
    assert stats["connected"] == 1
    assert stats["free"] == 1
    pool.release(t1)


def test_lazy_connect_runs_only_on_first_acquire():
    calls: list[int] = []

    def factory(cid: int):
        calls.append(cid)
        return FakeIBApp(cid)

    pool = IBPool(size=2, base_client_id=42, connect_factory=factory)
    # No connects yet.
    assert calls == []
    t1, _ = pool.acquire(timeout=0.1)
    # One slot connected.
    assert len(calls) == 1
    pool.release(t1)
    # Reacquire the same slot — connect should NOT fire again.
    t2, _ = pool.acquire(timeout=0.1)
    assert len(calls) == 1
    pool.release(t2)


def test_acquire_blocks_until_release():
    pool = make_pool(size=1)
    t1, _ = pool.acquire(timeout=0.1)

    waiter_started = threading.Event()
    waiter_done = threading.Event()
    waiter_result: list = []

    def waiter():
        waiter_started.set()
        t2, _ = pool.acquire(timeout=2.0)
        waiter_result.append(t2)
        pool.release(t2)
        waiter_done.set()

    th = threading.Thread(target=waiter, daemon=True)
    th.start()
    waiter_started.wait(timeout=0.5)
    # Give the waiter a beat to enter acquire().
    time.sleep(0.05)
    assert not waiter_done.is_set()
    pool.release(t1)
    waiter_done.wait(timeout=2.0)
    assert waiter_done.is_set()
    assert waiter_result == [t1]
    th.join(timeout=0.5)


def test_size_validation():
    with pytest.raises(ValueError):
        IBPool(size=0, base_client_id=1, connect_factory=FakeIBApp)
