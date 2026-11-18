"""What a broker connection can trade, grouped by market.

A data or order request for a symbol the broker does not list, or with the
wrong security type for it, fails at the venue (or worse, half-works). The
catalogue is the broker's own list, fetched once and kept by the backend, so
the symbol pickers only offer what the connection actually has.

Two kinds of broker:

  - **Listable** brokers hand over their whole list in one or a few calls:
    OANDA (``/v3/accounts/{id}/instruments``), cTrader (``SymbolsList`` with
    its categories and asset classes), MetaTrader 5 (``symbols_get`` through
    the sidecar) and Alpaca (``/v2/assets``). Their adapters have
    ``list_instruments()``, and the catalogue they give is *complete*.
  - **Search-only** brokers have no "everything" call: Interactive Brokers
    (Gateway and Web API) holds every listed security in the world, and IG's
    market navigation is a tree thousands of nodes deep. For these the
    catalogue is built from what searches find, and is never complete.

Every entry carries a ``market``, one of :data:`MARKETS`, so a picker can
group the list the same way whatever the broker calls its classes.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional

# The market groups, in the order a picker shows them.
MARKETS = (
    "FX",
    "INDEX",
    "COMMODITY",
    "METAL",
    "BOND",
    "STOCK",
    "ETF",
    "CRYPTO",
    "FUTURE",
    "OPTION",
    "OTHER",
)

# The security type a search for a market asks a search-only broker for.
MARKET_SEC_TYPE = {
    "FX": "CASH",
    "INDEX": "IND",
    "COMMODITY": "CMDTY",
    "METAL": "CMDTY",
    "BOND": "BOND",
    "STOCK": "STK",
    "ETF": "STK",
    "CRYPTO": "CRYPTO",
    "FUTURE": "FUT",
    "OPTION": "OPT",
}

_SEC_TYPE_MARKET = {
    "CASH": "FX",
    "STK": "STOCK",
    "IND": "INDEX",
    "CMDTY": "COMMODITY",
    "BOND": "BOND",
    "CRYPTO": "CRYPTO",
    "FUT": "FUTURE",
    "OPT": "OPTION",
    "FOP": "OPTION",
    "WAR": "OPTION",
    "FUND": "ETF",
}

# Words a broker uses for a class or a folder, to a market. Checked in order,
# so the more specific ("crypto") is tried before the general ("currency").
_WORDS = (
    ("CRYPTO", ("CRYPTO", "BITCOIN", "DIGITAL")),
    ("METAL", ("METAL", "GOLD", "SILVER", "BULLION")),
    ("ETF", ("ETF", "FUND")),
    ("INDEX", ("INDEX", "INDICES", "INDEXES", "INDICE")),
    ("BOND", ("BOND", "TREASUR", "RATES", "GILT", "BUND")),
    ("COMMODITY", ("COMMODIT", "ENERGY", "ENERGIES", "OIL", "AGRI", "SOFT", "GRAIN")),
    ("STOCK", ("STOCK", "SHARE", "EQUIT", "CFD ON")),
    ("FUTURE", ("FUTURE",)),
    ("FX", ("FOREX", "FX", "CURRENC", "MAJOR", "MINOR", "EXOTIC", "CROSS")),
)

# CFD names with no class attached (OANDA's untagged CFDs, an MT5 symbol
# outside any folder): the well-known index, commodity and bond names.
_INDEX_RE = re.compile(
    r"^(AU200|AUS200|US30|US500|SPX500|US2000|NAS100|USTEC|DE30|DE40|GER30|GER40|UK100|"
    r"FR40|EU50|STOXX50|JP225|JPN225|HK33|HK50|CN50|CHINA50|IN50|SG30|TWIX|NL25|CH20|"
    r"ES35|IT40|SPI200|DJ30|DJI|SPX|NDX|VIX)"
)
_COMMODITY_RE = re.compile(
    r"^(BCO|WTICO|USOIL|UKOIL|XBR|XTI|BRENT|WTI|NATGAS|XNG|NGAS|CORN|WHEAT|SOYBN|SUGAR|"
    r"COFFEE|COCOA|COTTON|XCU|COPPER)"
)
_METAL_RE = re.compile(r"^(XAU|XAG|XPT|XPD|GOLD|SILVER)")
_BOND_RE = re.compile(r"^(USB\d|US\d+Y|DE\d+YB|UK\d+YB|BUND|GILT|TNOTE)")
_FX_RE = re.compile(r"^[A-Z]{3}[._/]?[A-Z]{3}$")


def market_from_words(*words: Optional[str]) -> Optional[str]:
    """The market a broker's own class or folder names point to, if any."""
    text = " ".join(w for w in words if w).upper()
    if not text:
        return None
    for market, needles in _WORDS:
        if any(n in text for n in needles):
            return market
    return None


def market_from_name(name: str) -> Optional[str]:
    """The market a bare symbol name points to, if it is a well-known one."""
    key = (name or "").upper()
    for market, pattern in (
        ("METAL", _METAL_RE),
        ("INDEX", _INDEX_RE),
        ("COMMODITY", _COMMODITY_RE),
        ("BOND", _BOND_RE),
    ):
        if pattern.match(key):
            return market
    if _FX_RE.match(key):
        return "FX"
    return None


def market_from_sec_type(sec_type: Optional[str]) -> Optional[str]:
    return _SEC_TYPE_MARKET.get((sec_type or "").upper())


def classify(
    name: str,
    *,
    words: Iterable[Optional[str]] = (),
    sec_type: Optional[str] = None,
) -> str:
    """The market for an instrument: its broker's class words first, then
    its security type (unless that is the catch-all CFD), then its name."""
    return (
        market_from_words(*words)
        or (market_from_sec_type(sec_type) if (sec_type or "").upper() != "CFD" else None)
        or market_from_name(name)
        or "OTHER"
    )


def entry(
    *,
    symbol: str,
    name: str,
    market: str,
    sec_type: str,
    currency: str = "",
    exchange: str = "",
    venue_id: str = "",
) -> Dict[str, Any]:
    """One catalogue row, in the shape the backend stores."""
    return {
        "symbol": symbol,
        "name": name or symbol,
        "market": market if market in MARKETS else "OTHER",
        "secType": sec_type,
        "currency": currency or "",
        "exchange": exchange or "",
        "venue_id": venue_id or symbol,
    }


def from_search_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Catalogue rows from a contract search's results (search-only brokers)."""
    rows = []
    for r in results:
        symbol = str(r.get("symbol") or "")
        if not symbol:
            continue
        sec_type = str(r.get("secType") or "")
        rows.append(
            entry(
                symbol=symbol,
                name=str(r.get("companyName") or r.get("description") or symbol),
                market=classify(symbol, sec_type=sec_type),
                sec_type=sec_type,
                currency=str(r.get("currency") or ""),
                exchange=str(r.get("exchange") or ""),
                venue_id=str(r.get("conid") or symbol),
            )
        )
    return rows
