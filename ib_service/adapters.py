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
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from fastapi import HTTPException

# Every provider the platform knows about. Membership here means "a valid value
# for source=/broker="; availability (a registered adapter) is separate.
SUPPORTED_PROVIDERS = ("ib", "mt5")
DEFAULT_PROVIDER = "ib"


# --------------------------------------------------------------------------- #
# Adapter protocols
# --------------------------------------------------------------------------- #
@runtime_checkable
class MarketDataAdapter(Protocol):
    """Read-side venue surface: contract discovery + quotes."""

    name: str

    def search_contracts(self, request: Any) -> Dict[str, Any]: ...

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
_ib_registered = False


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


def _ensure_ib_registered() -> None:
    """Lazily register the IB adapter on first use. Done lazily (rather than at
    import time) so this module stays free of the heavy IB imports and avoids a
    cycle with the route modules that import the registry."""
    global _ib_registered
    if _ib_registered:
        return
    from ib_adapter import IBAdapter  # local import breaks the cycle

    adapter = IBAdapter()
    register("ib", market_data=adapter, broker=adapter)
    _ib_registered = True


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


def _unavailable(provider: str, side: str) -> HTTPException:
    return HTTPException(
        status_code=501,
        detail=(
            f"Provider '{provider}' has no {side} adapter yet. "
            f"Only '{DEFAULT_PROVIDER}' is available; MetaTrader (mt5) lands in a later phase."
        ),
    )


def get_market_data_adapter(source: Optional[str] = None) -> MarketDataAdapter:
    """Resolve ``source=`` to a market-data adapter (default IB)."""
    _ensure_ib_registered()
    provider = resolve_provider(source)
    adapter = _market_data.get(provider)
    if adapter is None:
        raise _unavailable(provider, "market-data")
    return adapter


def get_broker_adapter(broker: Optional[str] = None) -> BrokerAdapter:
    """Resolve ``broker=`` to a broker adapter (default IB)."""
    _ensure_ib_registered()
    provider = resolve_provider(broker)
    adapter = _broker.get(provider)
    if adapter is None:
        raise _unavailable(provider, "broker")
    return adapter


def provider_health() -> Dict[str, Any]:
    """Per-provider registration/availability snapshot, for /health surfacing."""
    _ensure_ib_registered()
    providers = {
        name: {
            "market_data": name in _market_data,
            "broker": name in _broker,
            "available": name in _market_data or name in _broker,
        }
        for name in SUPPORTED_PROVIDERS
    }
    return {"default": DEFAULT_PROVIDER, "providers": providers}
