"""Broker / market-data adapter registry (Systematic Trading roadmap — B1, C-1).

B1 introduced the seam that let a second *platform* plug in: two ``Protocol``
shapes describing the venue-agnostic surface the routes call, and a registry
keyed by platform name.

C-1 moves that key one level down. A registry keyed by platform has exactly one
slot per platform, so it could hold one MT5 account, one IB account, one Alpaca
account — and "add a second account" had nowhere to go, in the same way "add
MetaTrader" had nowhere to go before B1. The registry is now keyed by
**connection**: the pair ``(platform, account)``, e.g. ``mt5:pepperstone-live``.

Topology comes from :mod:`connections` — a single manifest across all
platforms, with credentials referenced by environment-variable name. An
existing deployment that has never heard of the manifest keeps working: the
legacy per-platform variables synthesise one ``<platform>:default`` connection
each, which is byte-for-byte the old behaviour.

Resolution rules, all fail-closed:

  - unknown platform                        → 400
  - known platform, unknown account         → 400 (naming the accounts there are)
  - known connection, no adapter configured → 501
  - account_mode conflicts with the
    connection's declared mode              → 409

The last one is the reason `account_mode` lives on the connection at all.
Routing a live order to a demo account, or a demo order to a live one, becomes
a configuration impossibility rather than something operators must remember.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from fastapi import HTTPException

from connections import (
    DEFAULT_ACCOUNT,
    DEFAULT_PLATFORM,
    SUPPORTED_PLATFORMS,
    Connection,
    ManifestError,
    load_connections,
)
from observability import get_logger

logger = get_logger(__name__)

# Retained under their historical names: routes, tests and the health payload
# all speak "provider" for what is now precisely a *platform*.
SUPPORTED_PROVIDERS = SUPPORTED_PLATFORMS
DEFAULT_PROVIDER = DEFAULT_PLATFORM


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

    def open_orders(self) -> List[Dict[str, Any]]: ...

    def executions(self, days: int = 1) -> List[Dict[str, Any]]: ...

    def instrument_spec(self, symbol: str) -> Dict[str, Any]: ...


# --------------------------------------------------------------------------- #
# Registry state
# --------------------------------------------------------------------------- #
_market_data: Dict[tuple[str, str], MarketDataAdapter] = {}
_broker: Dict[tuple[str, str], BrokerAdapter] = {}
_connections: Dict[tuple[str, str], Connection] = {}
_defaults: Dict[str, str] = {}  # platform -> default account
_bootstrapped = False


def register(
    platform: str,
    account: str = DEFAULT_ACCOUNT,
    *,
    market_data: Optional[MarketDataAdapter] = None,
    broker: Optional[BrokerAdapter] = None,
) -> None:
    """Register a connection's adapters. Either side may be supplied
    independently (a data-only source registers only ``market_data``)."""
    key = (platform.lower(), account.lower())
    if market_data is not None:
        _market_data[key] = market_data
    if broker is not None:
        _broker[key] = broker


def _build_adapters(conn: Connection) -> tuple[Optional[Any], Optional[Any]]:
    """Construct the adapter pair for one connection. Imports are local so this
    module stays free of the heavy per-platform dependencies and avoids a cycle
    with the route modules that import the registry."""
    if conn.platform == "ib":
        from ib_adapter import IBAdapter

        ib = IBAdapter()
        return ib, ib

    if conn.platform == "mt5":
        from mt5_adapter import MT5Adapter

        mt5 = MT5Adapter(conn.url or "", shared_secret=conn.secret)
        return mt5, mt5

    if conn.platform == "alpaca":
        from alpaca_adapter import AlpacaAdapter

        alpaca = AlpacaAdapter(conn.api_key or "", conn.api_secret or "", paper=conn.paper)
        return alpaca, alpaca

    if conn.platform == "oanda":
        from oanda_adapter import OANDAAdapter

        oanda = OANDAAdapter(
            conn.token or "", conn.account_id or "", environment=conn.environment or "practice"
        )
        return oanda, oanda

    return None, None


def _bootstrap() -> None:
    """Lazily register every configured connection on first use.

    A malformed manifest raises rather than registering a subset: a connection
    that silently fails to register makes its traffic fall through to whichever
    connection *is* that platform's default, which is the one failure mode this
    component exists to prevent.
    """
    global _bootstrapped
    if _bootstrapped:
        return

    try:
        connections = load_connections()
    except ManifestError as exc:
        logger.error("connection_manifest_invalid", error=str(exc))
        raise HTTPException(500, f"Connection manifest is invalid: {exc}")

    for conn in connections:
        market_data, broker = _build_adapters(conn)
        if market_data is None and broker is None:
            continue
        register(conn.platform, conn.account, market_data=market_data, broker=broker)
        _connections[conn.key] = conn
        if conn.is_default:
            _defaults[conn.platform] = conn.account

    logger.info(
        "connections_registered",
        count=len(_connections),
        connections=[c.label for c in _connections.values()],
    )
    _bootstrapped = True


def reset_registry() -> None:
    """Drop all registrations so the next resolve re-bootstraps. Test-only —
    lets a test change the manifest and re-derive availability."""
    global _bootstrapped
    _market_data.clear()
    _broker.clear()
    _connections.clear()
    _defaults.clear()
    _bootstrapped = False


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #
def resolve_provider(name: Optional[str]) -> str:
    """Normalise a ``source=``/``broker=`` value to a supported platform name,
    defaulting to IB. Raises 400 for an unrecognised platform."""
    key = (name or "").strip().lower() or DEFAULT_PROVIDER
    if key not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider '{name}'. Supported: {list(SUPPORTED_PROVIDERS)}.",
        )
    return key


def resolve_connection(
    provider: Optional[str] = None,
    account: Optional[str] = None,
    *,
    account_mode: Optional[str] = None,
) -> Connection:
    """Resolve ``(source|broker, account)`` to a configured connection.

    An omitted account resolves to the platform's declared default, which is
    what keeps every pre-C-1 call site working unchanged.
    """
    _bootstrap()
    platform = resolve_provider(provider)

    requested = (account or "").strip().lower()
    if not requested:
        requested = _defaults.get(platform, DEFAULT_ACCOUNT)

    conn = _connections.get((platform, requested))
    if conn is None:
        known = sorted(a for (p, a) in _connections if p == platform)
        if not known:
            raise _unavailable(platform, "connection")
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown account '{requested}' for platform '{platform}'. " f"Configured: {known}."
            ),
        )

    if not conn.allows(account_mode):
        # 409, not 400: the request is well-formed and the connection exists —
        # they are simply incompatible, and quietly routing it somewhere else
        # would be the dangerous outcome.
        raise HTTPException(
            status_code=409,
            detail=(
                f"Connection '{conn.label}' is declared account_mode="
                f"'{conn.account_mode}' and cannot accept a '{account_mode}' order."
            ),
        )
    return conn


_UNAVAILABLE_HINTS = {
    "mt5": (
        " Configure an mt5 connection in BROKER_CONNECTIONS, or set MT5_BRIDGE_URL "
        "for the single-account shorthand."
    ),
    "alpaca": (
        " Configure an alpaca connection in BROKER_CONNECTIONS, or set ALPACA_API_KEY "
        "and ALPACA_API_SECRET."
    ),
    "oanda": (
        " Configure an oanda connection in BROKER_CONNECTIONS, or set OANDA_API_TOKEN "
        "and OANDA_ACCOUNT_ID."
    ),
}


def _unavailable(provider: str, side: str) -> HTTPException:
    hint = _UNAVAILABLE_HINTS.get(provider, "")
    return HTTPException(
        status_code=501,
        detail=f"Provider '{provider}' has no {side} adapter available.{hint}",
    )


def get_market_data_adapter(
    source: Optional[str] = None, account: Optional[str] = None
) -> MarketDataAdapter:
    """Resolve ``source=``/``account=`` to a market-data adapter (default IB)."""
    conn = resolve_connection(source, account)
    adapter = _market_data.get(conn.key)
    if adapter is None:
        raise _unavailable(conn.platform, "market-data")
    return adapter


def get_broker_adapter(
    broker: Optional[str] = None,
    account: Optional[str] = None,
    *,
    account_mode: Optional[str] = None,
) -> BrokerAdapter:
    """Resolve ``broker=``/``account=`` to a broker adapter (default IB).

    Pass ``account_mode`` on any order-placing path so the connection's declared
    mode is enforced before the request reaches a venue.
    """
    conn = resolve_connection(broker, account, account_mode=account_mode)
    adapter = _broker.get(conn.key)
    if adapter is None:
        raise _unavailable(conn.platform, "broker")
    return adapter


# --------------------------------------------------------------------------- #
# Introspection
# --------------------------------------------------------------------------- #
def list_connections() -> List[Connection]:
    """Every configured connection, for health and UI surfaces."""
    _bootstrap()
    return list(_connections.values())


def same_funds_groups() -> List[List[str]]:
    """Groups of connection labels that reach the same underlying money.

    Aggregate exposure must treat each group as one account. Nothing in any
    venue API reveals the overlap, so this reflects only what the manifest
    declares — an undeclared overlap is invisible here and double-counts.
    """
    _bootstrap()
    by_account = {c.account: c for c in _connections.values()}
    groups: Dict[str, List[str]] = {}
    for conn in _connections.values():
        if not conn.same_funds_as:
            continue
        peer = by_account.get(conn.same_funds_as)
        if peer is None:
            continue
        root = min(conn.account, peer.account)
        bucket = groups.setdefault(root, [])
        for label in (conn.label, peer.label):
            if label not in bucket:
                bucket.append(label)
    return [sorted(v) for v in groups.values()]


def provider_health() -> Dict[str, Any]:
    """Per-platform *and* per-connection availability snapshot, for /health.

    The ``providers`` block keeps its pre-C-1 shape so existing consumers are
    unaffected; a platform is "available" when at least one of its connections
    is. ``connections`` is the new, finer view.
    """
    try:
        _bootstrap()
    except HTTPException as exc:
        # A broken manifest must be visible on /health rather than turning the
        # health check itself into a 500.
        return {
            "default": DEFAULT_PROVIDER,
            "error": exc.detail,
            "providers": {
                name: {"market_data": False, "broker": False, "available": False}
                for name in SUPPORTED_PROVIDERS
            },
            "connections": {},
        }

    providers = {
        name: {
            "market_data": any(p == name for (p, _) in _market_data),
            "broker": any(p == name for (p, _) in _broker),
            "available": any(p == name for (p, _) in _connections),
            "default_account": _defaults.get(name),
            "accounts": sorted(a for (p, a) in _connections if p == name),
        }
        for name in SUPPORTED_PROVIDERS
    }

    connections = {
        conn.label: {
            "platform": conn.platform,
            "account": conn.account,
            "account_mode": conn.account_mode,
            "currency": conn.currency,
            "is_default": conn.is_default,
            "market_data": conn.key in _market_data,
            "broker": conn.key in _broker,
            "server_timezone": conn.server_timezone,
            "same_funds_as": conn.same_funds_as,
        }
        for conn in _connections.values()
    }

    return {
        "default": DEFAULT_PROVIDER,
        "providers": providers,
        "connections": connections,
        "same_funds_groups": same_funds_groups(),
    }


# --------------------------------------------------------------------------- #
# Legacy accessors — retained so pre-C-1 callers and tests keep working
# --------------------------------------------------------------------------- #
def mt5_bridge_url() -> Optional[str]:
    """The single-account MT5 sidecar URL, or None. Superseded by the manifest;
    still read live so a deployment enabling MT5 needs no process restart."""
    url = (os.getenv("MT5_BRIDGE_URL") or "").strip()
    return url or None


def mt5_bridge_secret() -> Optional[str]:
    secret = (os.getenv("MT5_BRIDGE_SECRET") or "").strip()
    return secret or None


def alpaca_credentials() -> Optional[tuple[str, str]]:
    key = (os.getenv("ALPACA_API_KEY") or "").strip()
    secret = (os.getenv("ALPACA_API_SECRET") or "").strip()
    return (key, secret) if key and secret else None


def oanda_credentials() -> Optional[tuple[str, str]]:
    token = (os.getenv("OANDA_API_TOKEN") or "").strip()
    account_id = (os.getenv("OANDA_ACCOUNT_ID") or "").strip()
    return (token, account_id) if token and account_id else None
