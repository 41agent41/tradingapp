"""Canonical → native symbol resolution, per connection (Component C — C-2).

The problem that makes many *accounts* qualitatively different from many
*platforms*: **the same instrument has a different symbol at every broker.**
EURUSD is ``EURUSD`` at one, ``EURUSD.a`` / ``EURUSD_i`` / ``EURUSD.pro`` /
``EURUSDm`` at others, and the lot step, contract size and minimum differ with
it. A strategy is written once against a *canonical* symbol; each connection
must resolve that to its own native symbol before anything trades, or the fleet
silently trades different instruments believing they are the same.

Resolution order, most explicit first:

1. **Manifest override** — ``symbol_map`` on the connection. The operator said
   so. Verified against the catalogue when it is reachable, because a typo'd
   override otherwise surfaces as a rejected order much later.
2. **Exact match** in the connection's own catalogue.
3. **Suffix match** — a single candidate whose base is the canonical symbol and
   whose remainder is a short broker suffix.
4. **Refuse.**

Two rules make this safe rather than merely convenient:

- **No fuzzy best-effort match.** Picking the wrong instrument is far worse
  than not running: the strategy would trade, report fills, and be wrong in a
  way nothing downstream can detect.
- **Ambiguity is a refusal, not a choice.** If a connection offers both
  ``EURUSD.a`` and ``EURUSD.pro``, only the operator knows which account tier
  this is. Guessing produces a plausible-looking run on the wrong contract, so
  it refuses and names both, and the fix is a one-line ``symbol_map`` entry.

There is deliberately **no static instrument catalogue** anywhere in the app.
What a broker offers differs by account tier and changes without notice, so
availability is discovered from the connection itself and cached briefly.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from observability import get_logger

logger = get_logger(__name__)

# What counts as a broker suffix, in two shapes:
#
#   separated — `.a`, `_i`, `.pro`, `.raw`, `-ECN`: a separator then up to six
#               alphanumerics. The separator is strong evidence of a tag.
#   bare      — `m`, `z`, `c` (Exness-style `EURUSDm`): at most **two**
#               characters, with no separator to lean on.
#
# The bare case is deliberately tight. A permissive bare rule makes any short
# canonical a prefix of longer instruments — `EUR` would "match" `EURUSD`,
# `EURGBP` and `EURJPY`, and with three matches that reads as ambiguity rather
# than as the mistake it is. Two characters keeps the real broker tags working
# while a currency-pair continuation (three-plus characters) never qualifies.
_SUFFIX_SEPARATED = re.compile(r"^[._\-][A-Za-z0-9]{1,6}$")
_SUFFIX_BARE = re.compile(r"^[A-Za-z0-9]{1,2}$")


def _is_suffix(remainder: str) -> bool:
    return bool(_SUFFIX_SEPARATED.match(remainder) or _SUFFIX_BARE.match(remainder))


# Catalogues are stable over a session but not forever (a broker adds symbols,
# an account tier changes). Long enough that a deploy resolving several symbols
# costs one fetch; short enough that a change is picked up the same day.
_CATALOGUE_TTL_SECONDS = 900.0

_catalogue_cache: Dict[str, tuple[float, List[str]]] = {}


class SymbolResolutionError(HTTPException):
    """A canonical symbol could not be resolved at a connection.

    422 rather than 404: the request is well-formed and the connection exists —
    the instrument simply is not available there under a name we can identify.
    A deploy turns this into a refused *leg*, leaving its siblings running.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=422, detail=detail)


@dataclass(frozen=True)
class SymbolResolution:
    """How one canonical symbol resolved at one connection."""

    canonical: str
    native: str
    method: str  # 'manifest' | 'exact' | 'suffix'
    connection: str
    candidates: tuple[str, ...] = ()

    def as_dict(self) -> Dict[str, Any]:
        return {
            "canonical": self.canonical,
            "native": self.native,
            "method": self.method,
            "connection": self.connection,
            "candidates": list(self.candidates),
        }


class _CatalogueRequest:
    """The duck-typed shape ``MarketDataAdapter.search_contracts`` expects."""

    def __init__(self, symbol: str, max_results: int = 100) -> None:
        self.symbol = symbol
        self.max_results = max_results
        self.secType = "CFD"
        self.exchange = ""
        self.currency = ""
        self.pattern = symbol


def clear_catalogue_cache() -> None:
    """Drop cached catalogues. Test-only, and useful after a manifest change."""
    _catalogue_cache.clear()


def fetch_catalogue(adapter: Any, connection_label: str, query: str) -> List[str]:
    """Symbols a connection offers matching ``query``, cached per connection.

    Fail-soft: an unreachable venue yields an empty catalogue rather than an
    error, so resolution falls through to its refusal path with a clear reason
    instead of surfacing a transport error at deploy time.
    """
    cache_key = f"{connection_label}:{query.upper()}"
    cached = _catalogue_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] <= _CATALOGUE_TTL_SECONDS:
        return cached[1]

    symbols: List[str] = []
    try:
        payload = adapter.search_contracts(_CatalogueRequest(query))
        for row in (payload or {}).get("results", []):
            symbol = str(row.get("symbol") or "").strip()
            if symbol:
                symbols.append(symbol)
    except Exception as exc:  # noqa: BLE001 - any venue failure is a soft miss
        logger.warning(
            "symbol_catalogue_unavailable",
            connection=connection_label,
            query=query,
            error=str(exc),
        )
        return []

    _catalogue_cache[cache_key] = (time.monotonic(), symbols)
    return symbols


def suffix_candidates(canonical: str, catalogue: List[str]) -> List[str]:
    """Catalogue entries that are ``canonical`` plus a short broker suffix."""
    upper = canonical.upper()
    matches: List[str] = []
    for entry in catalogue:
        candidate = entry.strip()
        if not candidate or candidate.upper() == upper:
            continue
        if not candidate.upper().startswith(upper):
            continue
        if _is_suffix(candidate[len(upper) :]):
            matches.append(candidate)
    return matches


def resolve_symbol(
    canonical: str,
    adapter: Any,
    *,
    connection_label: str,
    symbol_map: Optional[Dict[str, str]] = None,
) -> SymbolResolution:
    """Resolve ``canonical`` to this connection's native symbol, or refuse."""
    wanted = (canonical or "").strip().upper()
    if not wanted:
        raise SymbolResolutionError("A canonical symbol is required.")

    catalogue = fetch_catalogue(adapter, connection_label, wanted)

    # 1. Manifest override — explicit operator intent.
    override = (symbol_map or {}).get(wanted)
    if override:
        if catalogue and not any(c.upper() == override.upper() for c in catalogue):
            raise SymbolResolutionError(
                f"{connection_label}: symbol_map maps '{wanted}' to '{override}', which the "
                f"connection does not offer. Known matches: {sorted(catalogue) or 'none'}."
            )
        return SymbolResolution(wanted, override, "manifest", connection_label)

    if not catalogue:
        raise SymbolResolutionError(
            f"{connection_label}: no symbols matching '{wanted}' — the instrument is not "
            "offered here, or the connection is unreachable. Add a symbol_map entry to "
            "override."
        )

    # 2. Exact match.
    for entry in catalogue:
        if entry.strip().upper() == wanted:
            return SymbolResolution(wanted, entry.strip(), "exact", connection_label)

    # 3. Single suffix match. More than one is ambiguous and refuses.
    matches = suffix_candidates(wanted, catalogue)
    if len(matches) == 1:
        return SymbolResolution(wanted, matches[0], "suffix", connection_label, tuple(matches))
    if len(matches) > 1:
        raise SymbolResolutionError(
            f"{connection_label}: '{wanted}' is ambiguous — {sorted(matches)} all match. "
            "Only the operator knows which tier this account trades, so add a symbol_map "
            "entry rather than having one guessed."
        )

    raise SymbolResolutionError(
        f"{connection_label}: no symbol matching '{wanted}'. "
        f"Nearest catalogue entries: {sorted(catalogue)[:10]}."
    )
