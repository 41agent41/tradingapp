"""Tests for canonical → native symbol resolution (C-2).

The failure this guards against is silent: a strategy deployed to three
brokers that trades EURUSD on one, EURUSD.a on another, and — if resolution
guessed — something else entirely on the third, while reporting success
everywhere. So the cases below lean hard on the refusals.
"""

from __future__ import annotations

import pytest

from symbol_resolution import (
    SymbolResolutionError,
    clear_catalogue_cache,
    resolve_symbol,
    suffix_candidates,
)


class FakeAdapter:
    """A connection's catalogue. Records queries so caching can be asserted."""

    def __init__(self, symbols, fail=False):
        self.symbols = symbols
        self.fail = fail
        self.queries = []

    def search_contracts(self, request):
        self.queries.append(request.symbol)
        if self.fail:
            raise RuntimeError("bridge unreachable")
        return {"results": [{"symbol": s} for s in self.symbols]}


@pytest.fixture(autouse=True)
def _clear_cache():
    clear_catalogue_cache()
    yield
    clear_catalogue_cache()


# --------------------------------------------------------------------------- #
# The happy paths, in precedence order
# --------------------------------------------------------------------------- #
def test_exact_match_resolves():
    r = resolve_symbol("EURUSD", FakeAdapter(["EURUSD", "GBPUSD"]), connection_label="mt5:a")
    assert (r.native, r.method) == ("EURUSD", "exact")


def test_single_suffix_match_resolves():
    r = resolve_symbol("EURUSD", FakeAdapter(["EURUSD.a"]), connection_label="mt5:icmarkets")
    assert (r.native, r.method) == ("EURUSD.a", "suffix")


@pytest.mark.parametrize("native", ["EURUSD.a", "EURUSD_i", "EURUSD.pro", "EURUSDm", "EURUSD-ECN"])
def test_common_broker_suffix_conventions(native):
    """The real shapes: IC Markets, Exness, Pepperstone, ECN accounts."""
    r = resolve_symbol("EURUSD", FakeAdapter([native]), connection_label="mt5:x")
    assert r.native == native


def test_manifest_override_wins_over_the_catalogue():
    r = resolve_symbol(
        "EURUSD",
        FakeAdapter(["EURUSD", "EURUSD.pro"]),
        connection_label="mt5:x",
        symbol_map={"EURUSD": "EURUSD.pro"},
    )
    assert (r.native, r.method) == ("EURUSD.pro", "manifest")


def test_exact_match_beats_a_suffix_candidate():
    r = resolve_symbol("EURUSD", FakeAdapter(["EURUSD.a", "EURUSD"]), connection_label="mt5:x")
    assert (r.native, r.method) == ("EURUSD", "exact")


# --------------------------------------------------------------------------- #
# The refusals — the point of the module
# --------------------------------------------------------------------------- #
def test_ambiguity_refuses_rather_than_guessing():
    """Two tiers on one account. Only the operator knows which this is, and a
    guess produces a plausible-looking run on the wrong contract."""
    with pytest.raises(SymbolResolutionError) as exc:
        resolve_symbol("EURUSD", FakeAdapter(["EURUSD.a", "EURUSD.pro"]), connection_label="mt5:x")
    assert exc.value.status_code == 422
    assert "ambiguous" in exc.value.detail
    assert "EURUSD.a" in exc.value.detail and "EURUSD.pro" in exc.value.detail


def test_ambiguity_is_resolved_by_a_symbol_map_entry():
    """The refusal must be actionable, and this is the documented fix."""
    r = resolve_symbol(
        "EURUSD",
        FakeAdapter(["EURUSD.a", "EURUSD.pro"]),
        connection_label="mt5:x",
        symbol_map={"EURUSD": "EURUSD.a"},
    )
    assert r.native == "EURUSD.a"


def test_no_match_refuses():
    with pytest.raises(SymbolResolutionError) as exc:
        resolve_symbol("EURUSD", FakeAdapter(["GBPUSD", "USDJPY"]), connection_label="mt5:x")
    assert "no symbol matching" in exc.value.detail


def test_unreachable_connection_refuses_rather_than_inventing_a_symbol():
    with pytest.raises(SymbolResolutionError) as exc:
        resolve_symbol("EURUSD", FakeAdapter([], fail=True), connection_label="mt5:x")
    assert "not offered here, or the connection is unreachable" in exc.value.detail


def test_a_symbol_map_typo_is_caught_against_the_catalogue():
    """An unverified override surfaces as a rejected order much later, on a
    connection the operator believes is configured."""
    with pytest.raises(SymbolResolutionError) as exc:
        resolve_symbol(
            "EURUSD",
            FakeAdapter(["EURUSD.a"]),
            connection_label="mt5:x",
            symbol_map={"EURUSD": "EURUSD.aa"},
        )
    assert "does not offer" in exc.value.detail


def test_an_override_is_trusted_when_the_catalogue_is_unreachable():
    """A transient outage must not block a deploy the operator has pinned
    explicitly — the override *is* the operator's assertion."""
    r = resolve_symbol(
        "EURUSD",
        FakeAdapter([], fail=True),
        connection_label="mt5:x",
        symbol_map={"EURUSD": "EURUSD.a"},
    )
    assert (r.native, r.method) == ("EURUSD.a", "manifest")


def test_empty_symbol_is_refused():
    with pytest.raises(SymbolResolutionError):
        resolve_symbol("   ", FakeAdapter(["EURUSD"]), connection_label="mt5:x")


# --------------------------------------------------------------------------- #
# Suffix matching must not over-reach
# --------------------------------------------------------------------------- #
def test_a_longer_unrelated_symbol_is_not_a_suffix_match():
    """`EURUSDX_INDEX` shares a prefix with EURUSD but is a different
    instrument; a prefix test alone would happily trade it."""
    assert suffix_candidates("EURUSD", ["EURUSDX_SOMETHING_LONGER"]) == []


def test_a_different_pair_sharing_a_prefix_is_not_matched():
    assert suffix_candidates("EUR", ["EURUSD", "EURGBP", "EURJPY"]) == []


def test_suffix_matching_is_case_insensitive_but_preserves_the_native_casing():
    r = resolve_symbol("eurusd", FakeAdapter(["EurUsd.a"]), connection_label="mt5:x")
    assert r.native == "EurUsd.a"
    assert r.canonical == "EURUSD"


# --------------------------------------------------------------------------- #
# Per-connection behaviour
# --------------------------------------------------------------------------- #
def test_the_same_canonical_resolves_differently_per_connection():
    """The DoD: one definition, three connections, three native symbols."""
    a = resolve_symbol("EURUSD", FakeAdapter(["EURUSD.a"]), connection_label="mt5:icmarkets")
    b = resolve_symbol("EURUSD", FakeAdapter(["EURUSD_i"]), connection_label="mt5:pepperstone")
    c = resolve_symbol("EURUSD", FakeAdapter(["EURUSD"]), connection_label="oanda:native")
    assert [a.native, b.native, c.native] == ["EURUSD.a", "EURUSD_i", "EURUSD"]


def test_catalogues_are_cached_per_connection_not_globally():
    """Caching across connections would serve one broker's catalogue to
    another — the same class of bug as sharing an instrument spec."""
    a = FakeAdapter(["EURUSD.a"])
    b = FakeAdapter(["EURUSD_i"])

    assert resolve_symbol("EURUSD", a, connection_label="mt5:one").native == "EURUSD.a"
    assert resolve_symbol("EURUSD", b, connection_label="mt5:two").native == "EURUSD_i"
    # Second lookup on the first connection is served from cache.
    assert resolve_symbol("EURUSD", a, connection_label="mt5:one").native == "EURUSD.a"
    assert len(a.queries) == 1
    assert len(b.queries) == 1
