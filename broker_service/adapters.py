"""Broker / market-data adapter registry (Systematic Trading roadmap — B1).

The enabling refactor for multi-broker support. Historically the IB Gateway
was hard-wired into every route and ``get_market_data_source()`` was a cosmetic
string, so a second venue (MetaTrader) had *nowhere to plug in*. This module
introduces the seam:

  - two ``Protocol`` shapes, ``MarketDataAdapter`` and ``BrokerAdapter``,
    describing the venue-agnostic surface the routes call;
  - a registry keyed by provider name (``ib`` | ``mt5``) that resolves a
    request's ``source=`` / ``broker=`` to the concrete adapter;
  - IB registered as the default, always-available provider (lazily, to avoid
    import cycles) — so ``source=ib`` behaviour is byte-for-byte unchanged.

MetaTrader is a *recognised but not-yet-available* provider: asking for it
resolves to a clean ``501`` rather than a confusing ``404``/``400``, which is
exactly the "nowhere to plug in" gap this phase closes. The MT5 adapter itself
lands in B2 (Phases 6–7).

Alpaca and OANDA follow the same shape as MT5 — a thin ``httpx`` client
implementing both protocols — but need no sidecar host: both are cloud REST
APIs reachable directly from this Linux service, gated by API-credential env
vars instead of a bridge URL (``ALPACA_API_KEY``/``ALPACA_API_SECRET`` and
``OANDA_API_TOKEN``/``OANDA_ACCOUNT_ID`` respectively).
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from fastapi import HTTPException

from observability import get_logger

logger = get_logger(__name__)

# Every provider the platform knows about. Membership here means "a valid value
# for source=/broker="; availability (a registered adapter) is separate.
SUPPORTED_PROVIDERS = ("ib", "mt5", "alpaca", "oanda")
DEFAULT_PROVIDER = "ib"


# --------------------------------------------------------------------------- #
# Adapter protocols
# --------------------------------------------------------------------------- #
@runtime_checkable
class MarketDataAdapter(Protocol):
    """Read-side venue surface: contract discovery + historical bars + quotes."""

    name: str

    def search_contracts(self, request: Any) -> Dict[str, Any]: ...

    def historical_bars(
        self,
        symbol: str,
        timeframe: str,
        period: str = "1Y",
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        indicators: Optional[List[str]] = None,
        account_mode: str = "paper",
    ) -> Any: ...

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> Any: ...

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]: ...


@runtime_checkable
class BrokerAdapter(Protocol):
    """Write-side venue surface: order lifecycle + positions/account."""

    name: str

    def place_order(self, request: Any) -> Dict[str, Any]: ...

    def cancel_order(self, order_id: int) -> Dict[str, Any]: ...

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]: ...

    def positions(self) -> List[Dict[str, Any]]: ...

    def account_summary(self) -> Dict[str, Any]: ...


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
_market_data: Dict[str, MarketDataAdapter] = {}
_broker: Dict[str, BrokerAdapter] = {}
_bootstrapped = False


def mt5_bridge_url() -> Optional[str]:
    """The MT5 sidecar base URL, or None when MT5 isn't configured. Read live
    so tests (and a deployment enabling MT5) don't need a process restart."""
    url = (os.getenv("MT5_BRIDGE_URL") or "").strip()
    return url or None


def mt5_bridge_secret() -> Optional[str]:
    """Shared secret sent as `X-MT5-Bridge-Secret` on every sidecar request, or
    None when unset. The sidecar HTTP contract otherwise has no auth story, so
    anything that can reach `MT5_BRIDGE_URL` can trade the account — see
    `mt5_adapter.py` for the header contract."""
    secret = (os.getenv("MT5_BRIDGE_SECRET") or "").strip()
    return secret or None


def alpaca_credentials() -> Optional[tuple[str, str]]:
    """``(key, secret)`` when both Alpaca credentials are set, else None. Read
    live, same as ``mt5_bridge_url()``, so tests can toggle availability
    without a process restart."""
    key = (os.getenv("ALPACA_API_KEY") or "").strip()
    secret = (os.getenv("ALPACA_API_SECRET") or "").strip()
    return (key, secret) if key and secret else None


def oanda_credentials() -> Optional[tuple[str, str]]:
    """``(token, account_id)`` when both OANDA credentials are set, else None."""
    token = (os.getenv("OANDA_API_TOKEN") or "").strip()
    account_id = (os.getenv("OANDA_ACCOUNT_ID") or "").strip()
    return (token, account_id) if token and account_id else None


def register(
    name: str,
    *,
    market_data: Optional[MarketDataAdapter] = None,
    broker: Optional[BrokerAdapter] = None,
) -> None:
    """Register a provider's adapters. Either side may be supplied
    independently (a data-only source registers only ``market_data``)."""
    key = name.lower()
    if market_data is not None:
        _market_data[key] = market_data
    if broker is not None:
        _broker[key] = broker


def _bootstrap() -> None:
    """Lazily register the built-in adapters on first use. Done lazily (rather
    than at import time) so this module stays free of the heavy IB/MT5 imports
    and avoids a cycle with the route modules that import the registry.

    IB is always registered. MT5 registers **both** its market-data (B2a) and
    broker/execution (B2b) adapters when ``MT5_BRIDGE_URL`` is set — otherwise
    ``mt5`` stays a recognised but unavailable provider (→ 501). Alpaca and
    OANDA follow the identical pattern, gated by API credentials instead of a
    bridge URL (no sidecar host — both are cloud REST APIs).
    """
    global _bootstrapped
    if _bootstrapped:
        return
    from ib_adapter import IBAdapter  # local import breaks the cycle

    ib = IBAdapter()
    register("ib", market_data=ib, broker=ib)

    bridge = mt5_bridge_url()
    if bridge:
        from mt5_adapter import MT5Adapter

        secret = mt5_bridge_secret()
        if not secret:
            logger.warning(
                "mt5_bridge_no_shared_secret",
                msg=(
                    "MT5_BRIDGE_URL is set without MT5_BRIDGE_SECRET — the sidecar "
                    "HTTP contract is unauthenticated; anything that can reach it "
                    "can query positions/account and place, cancel, or modify "
                    "orders on the MT5 account."
                ),
            )
        mt5 = MT5Adapter(bridge, shared_secret=secret)
        register("mt5", market_data=mt5, broker=mt5)

    alpaca_creds = alpaca_credentials()
    if alpaca_creds:
        from alpaca_adapter import AlpacaAdapter

        key, secret = alpaca_creds
        alpaca_paper = os.getenv("ALPACA_PAPER", "true").lower() != "false"
        alpaca = AlpacaAdapter(key, secret, paper=alpaca_paper)
        register("alpaca", market_data=alpaca, broker=alpaca)

    oanda_creds = oanda_credentials()
    if oanda_creds:
        from oanda_adapter import OANDAAdapter

        token, account_id = oanda_creds
        oanda = OANDAAdapter(
            token, account_id, environment=os.getenv("OANDA_ENVIRONMENT", "practice")
        )
        register("oanda", market_data=oanda, broker=oanda)

    _bootstrapped = True


def reset_registry() -> None:
    """Drop all registrations so the next resolve re-bootstraps. Test-only —
    lets a test toggle MT5_BRIDGE_URL and re-derive availability."""
    global _bootstrapped
    _market_data.clear()
    _broker.clear()
    _bootstrapped = False


def resolve_provider(name: Optional[str]) -> str:
    """Normalise a ``source=``/``broker=`` value to a supported provider name,
    defaulting to IB. Raises 400 for an unrecognised provider."""
    key = (name or "").strip().lower() or DEFAULT_PROVIDER
    if key not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider '{name}'. Supported: {list(SUPPORTED_PROVIDERS)}.",
        )
    return key


_UNAVAILABLE_HINTS = {
    "mt5": " Set MT5_BRIDGE_URL to enable the MT5 sidecar (data + execution).",
    "alpaca": " Set ALPACA_API_KEY and ALPACA_API_SECRET to enable Alpaca.",
    "oanda": " Set OANDA_API_TOKEN and OANDA_ACCOUNT_ID to enable OANDA.",
}


def _unavailable(provider: str, side: str) -> HTTPException:
    hint = _UNAVAILABLE_HINTS.get(provider, "")
    return HTTPException(
        status_code=501,
        detail=f"Provider '{provider}' has no {side} adapter available.{hint}",
    )


def get_market_data_adapter(source: Optional[str] = None) -> MarketDataAdapter:
    """Resolve ``source=`` to a market-data adapter (default IB)."""
    _bootstrap()
    provider = resolve_provider(source)
    adapter = _market_data.get(provider)
    if adapter is None:
        raise _unavailable(provider, "market-data")
    return adapter


def get_broker_adapter(broker: Optional[str] = None) -> BrokerAdapter:
    """Resolve ``broker=`` to a broker adapter (default IB)."""
    _bootstrap()
    provider = resolve_provider(broker)
    adapter = _broker.get(provider)
    if adapter is None:
        raise _unavailable(provider, "broker")
    return adapter


def provider_health() -> Dict[str, Any]:
    """Per-provider registration/availability snapshot, for /health surfacing."""
    _bootstrap()
    providers = {
        name: {
            "market_data": name in _market_data,
            "broker": name in _broker,
            "available": name in _market_data or name in _broker,
        }
        for name in SUPPORTED_PROVIDERS
    }
    return {"default": DEFAULT_PROVIDER, "providers": providers}
