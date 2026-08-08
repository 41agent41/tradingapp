"""Connection manifest — the topology of every account the service can reach.

Component C (C-1). Historically each platform was configured by its own pair of
environment variables (``MT5_BRIDGE_URL``, ``ALPACA_API_KEY``/``_SECRET``,
``OANDA_API_TOKEN``/``_ACCOUNT_ID``, IB's host/port), which structurally
allowed **exactly one account per platform**. This module replaces that with a
single manifest describing N connections across all platforms, and keeps the
legacy variables working as a one-connection shorthand.

Vocabulary, used consistently across the codebase:

  - **platform** — the protocol/integration: ``ib`` | ``mt5`` | ``alpaca`` | ``oanda``
  - **account**  — one set of credentials at one firm on one platform
  - **connection** — the addressable pair, written ``mt5:pepperstone-live``

### Secrets

The manifest carries *topology*, never credentials. Every secret is referenced
**by environment-variable name** (``secret_env``, ``token_env``, …) and read at
registration time. This keeps credentials out of config files, out of version
control, and out of anything the settings endpoint could surface.

### Manifest shape

``BROKER_CONNECTIONS`` (JSON array) or ``BROKER_CONNECTIONS_FILE`` (a path to
the same JSON). One entry per connection::

    [
      { "id": "pepperstone-live", "platform": "mt5",
        "url": "http://10.7.3.22:9100", "secret_env": "MT5_SECRET_PEPPERSTONE",
        "account_mode": "live", "currency": "USD", "default": true,
        "server_timezone": "Etc/GMT-2" },

      { "id": "oanda-native", "platform": "oanda",
        "token_env": "OANDA_API_TOKEN", "account_env": "OANDA_ACCOUNT_ID",
        "account_mode": "live", "currency": "USD",
        "same_funds_as": "oanda-mt5" }
    ]

``account_mode`` is a **binding constraint**, not a default: a ``live`` order
addressed to a connection declared ``paper`` is refused at the registry. That
makes trading a demo account with live sizing — and its far worse inverse — a
configuration impossibility rather than a matter of discipline.

``same_funds_as`` declares that two connections reach the *same underlying
money* (a firm offering both its own API and an MT5 bridge — OANDA and IG both
do). Nothing in either API reveals the overlap, so it has to be asserted by
hand; without it, aggregate exposure double-counts and two runs can trade one
account believing they are independent.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from observability import get_logger

logger = get_logger(__name__)

SUPPORTED_PLATFORMS = ("ib", "mt5", "alpaca", "oanda")
DEFAULT_PLATFORM = "ib"
DEFAULT_ACCOUNT = "default"
ACCOUNT_MODES = ("paper", "live")

# Mirrors `normaliseBrokerAccount` in backend/src/services/orderTypes.ts. The
# id appears in log lines, index keys and request ids, so it stays URL- and
# identifier-safe on both sides of the wire.
_ACCOUNT_MAX_LENGTH = 64


class ManifestError(ValueError):
    """Raised when the connection manifest is malformed. Fatal at startup —
    a misconfigured connection must never silently resolve to a *different*
    account."""


def _valid_account_id(value: str) -> bool:
    if not value or len(value) > _ACCOUNT_MAX_LENGTH:
        return False
    if not (value[0].isalnum() and value[0].islower() or value[0].isdigit()):
        return False
    return all(c.isdigit() or (c.isalpha() and c.islower()) or c in "-_" for c in value)


@dataclass(frozen=True)
class Connection:
    """One addressable account at one platform."""

    account: str
    platform: str
    account_mode: str = "paper"
    currency: str = "USD"
    is_default: bool = False
    # Platform-specific wiring. Only the fields relevant to `platform` are used.
    url: Optional[str] = None
    secret: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    token: Optional[str] = None
    account_id: Optional[str] = None
    environment: Optional[str] = None
    paper: bool = True
    # Operational metadata.
    server_timezone: Optional[str] = None
    same_funds_as: Optional[str] = None
    symbol_map: Dict[str, str] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        return (self.platform, self.account)

    @property
    def label(self) -> str:
        return f"{self.platform}:{self.account}"

    def allows(self, account_mode: Optional[str]) -> bool:
        """Whether an order in ``account_mode`` may be routed here. A connection
        declared ``paper`` refuses ``live`` traffic and vice versa."""
        if not account_mode:
            return True
        return account_mode.strip().lower() == self.account_mode


def _env(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    value = (os.getenv(name) or "").strip()
    return value or None


def _parse_entry(raw: Any, index: int) -> Connection:
    if not isinstance(raw, dict):
        raise ManifestError(f"connection #{index} must be an object, got {type(raw).__name__}")

    account = str(raw.get("id") or "").strip().lower()
    if not _valid_account_id(account):
        raise ManifestError(
            f"connection #{index} has an invalid id {raw.get('id')!r}: expected at most "
            f"{_ACCOUNT_MAX_LENGTH} characters of [a-z0-9_-] starting alphanumeric"
        )

    platform = str(raw.get("platform") or "").strip().lower()
    if platform not in SUPPORTED_PLATFORMS:
        raise ManifestError(
            f"connection '{account}' has unknown platform {raw.get('platform')!r}; "
            f"supported: {list(SUPPORTED_PLATFORMS)}"
        )

    account_mode = str(raw.get("account_mode") or "paper").strip().lower()
    if account_mode not in ACCOUNT_MODES:
        raise ManifestError(
            f"connection '{account}' has invalid account_mode {raw.get('account_mode')!r}; "
            f"expected one of {list(ACCOUNT_MODES)}"
        )

    symbol_map_raw = raw.get("symbol_map") or {}
    if not isinstance(symbol_map_raw, dict):
        raise ManifestError(f"connection '{account}': symbol_map must be an object")
    symbol_map = {str(k).upper(): str(v) for k, v in symbol_map_raw.items()}

    conn = Connection(
        account=account,
        platform=platform,
        account_mode=account_mode,
        currency=str(raw.get("currency") or "USD").strip().upper(),
        is_default=bool(raw.get("default")),
        url=(str(raw.get("url")).rstrip("/") if raw.get("url") else None),
        secret=_env(raw.get("secret_env")),
        api_key=_env(raw.get("key_env")),
        api_secret=_env(raw.get("secret_key_env")),
        token=_env(raw.get("token_env")),
        account_id=_env(raw.get("account_env")),
        environment=(str(raw.get("environment")).strip() if raw.get("environment") else None),
        paper=account_mode != "live",
        server_timezone=(
            str(raw.get("server_timezone")).strip() if raw.get("server_timezone") else None
        ),
        same_funds_as=(
            str(raw.get("same_funds_as")).strip().lower() if raw.get("same_funds_as") else None
        ),
        symbol_map=symbol_map,
    )
    _validate_platform_fields(conn)
    return conn


def _validate_platform_fields(conn: Connection) -> None:
    """Each platform needs different wiring; catch a missing field at startup
    rather than as a confusing 501 on the first request."""
    if conn.platform == "mt5":
        if not conn.url:
            raise ManifestError(f"connection '{conn.account}': mt5 requires a 'url' (sidecar base)")
        if not conn.secret:
            logger.warning(
                "connection_no_shared_secret",
                connection=conn.label,
                msg=(
                    "MT5 connection configured without a resolvable secret_env — the "
                    "sidecar HTTP contract is unauthenticated; anything that can reach "
                    "it can query positions/account and place, cancel, or modify orders."
                ),
            )
    elif conn.platform == "alpaca":
        if not (conn.api_key and conn.api_secret):
            raise ManifestError(
                f"connection '{conn.account}': alpaca requires 'key_env' and 'secret_key_env' "
                "naming environment variables that are set"
            )
    elif conn.platform == "oanda":
        if not (conn.token and conn.account_id):
            raise ManifestError(
                f"connection '{conn.account}': oanda requires 'token_env' and 'account_env' "
                "naming environment variables that are set"
            )


def _manifest_json() -> Optional[str]:
    inline = (os.getenv("BROKER_CONNECTIONS") or "").strip()
    path = (os.getenv("BROKER_CONNECTIONS_FILE") or "").strip()
    if inline and path:
        raise ManifestError(
            "Set BROKER_CONNECTIONS or BROKER_CONNECTIONS_FILE, not both — "
            "a silent precedence rule between two sources of connection topology "
            "is exactly how an order reaches the wrong account."
        )
    if inline:
        return inline
    if path:
        try:
            with open(path, encoding="utf-8") as fh:
                return fh.read()
        except OSError as exc:
            raise ManifestError(f"BROKER_CONNECTIONS_FILE {path!r} could not be read: {exc}")
    return None


def _legacy_connections() -> List[Connection]:
    """Synthesise one connection per platform from the pre-C-1 environment
    variables, so an existing deployment keeps working untouched. Each becomes
    ``<platform>:default``."""
    conns: List[Connection] = [
        # IB is always present: its host/port have defaults, and it is the
        # platform every existing deployment is using.
        Connection(
            account=DEFAULT_ACCOUNT,
            platform="ib",
            account_mode=_legacy_account_mode(),
            is_default=True,
        )
    ]

    mt5_url = (os.getenv("MT5_BRIDGE_URL") or "").strip()
    if mt5_url:
        conns.append(
            Connection(
                account=DEFAULT_ACCOUNT,
                platform="mt5",
                account_mode=_legacy_account_mode(),
                url=mt5_url.rstrip("/"),
                secret=_env("MT5_BRIDGE_SECRET"),
                is_default=True,
            )
        )
        if not _env("MT5_BRIDGE_SECRET"):
            logger.warning(
                "mt5_bridge_no_shared_secret",
                msg=(
                    "MT5_BRIDGE_URL is set without MT5_BRIDGE_SECRET — the sidecar "
                    "HTTP contract is unauthenticated; anything that can reach it "
                    "can query positions/account and place, cancel, or modify "
                    "orders on the MT5 account."
                ),
            )

    alpaca_key = _env("ALPACA_API_KEY")
    alpaca_secret = _env("ALPACA_API_SECRET")
    if alpaca_key and alpaca_secret:
        paper = (os.getenv("ALPACA_PAPER", "true") or "true").lower() != "false"
        conns.append(
            Connection(
                account=DEFAULT_ACCOUNT,
                platform="alpaca",
                account_mode="paper" if paper else "live",
                api_key=alpaca_key,
                api_secret=alpaca_secret,
                paper=paper,
                is_default=True,
            )
        )

    oanda_token = _env("OANDA_API_TOKEN")
    oanda_account = _env("OANDA_ACCOUNT_ID")
    if oanda_token and oanda_account:
        environment = os.getenv("OANDA_ENVIRONMENT", "practice")
        conns.append(
            Connection(
                account=DEFAULT_ACCOUNT,
                platform="oanda",
                account_mode="live" if environment == "live" else "paper",
                token=oanda_token,
                account_id=oanda_account,
                environment=environment,
                is_default=True,
            )
        )

    return conns


def _legacy_account_mode() -> str:
    """Pre-C-1 config had no per-connection mode; the app gated live trading
    globally. Keep that: the synthesised connection accepts whatever the
    global gate allows, so enabling the manifest is what starts enforcing
    per-connection modes."""
    return "live" if (os.getenv("LIVE_TRADING_ENABLED", "false").lower() == "true") else "paper"


def load_connections() -> List[Connection]:
    """Parse the manifest, or synthesise the legacy single-account topology.

    Raises :class:`ManifestError` on anything malformed — a bad manifest is a
    startup failure, never a partial registration, because a connection that
    silently fails to register makes its traffic fall through to whichever
    connection *is* the platform default.
    """
    raw_json = _manifest_json()
    if raw_json is None:
        return _legacy_connections()

    # Setting both the manifest and a legacy variable is ambiguous about which
    # wins, and the cost of guessing wrong is an order on the wrong account.
    legacy_set = [
        name
        for name in ("MT5_BRIDGE_URL", "ALPACA_API_KEY", "OANDA_API_TOKEN")
        if (os.getenv(name) or "").strip()
    ]
    if legacy_set:
        raise ManifestError(
            f"BROKER_CONNECTIONS is set alongside legacy variable(s) {legacy_set}. "
            "Move them into the manifest and unset them — supporting both would need "
            "a precedence rule, and guessing wrong routes orders to the wrong account."
        )

    try:
        parsed = json.loads(raw_json)
    except ValueError as exc:
        raise ManifestError(f"BROKER_CONNECTIONS is not valid JSON: {exc}")
    if not isinstance(parsed, list):
        raise ManifestError("BROKER_CONNECTIONS must be a JSON array of connection objects")
    if not parsed:
        raise ManifestError("BROKER_CONNECTIONS is empty — configure at least one connection")

    connections = [_parse_entry(entry, i) for i, entry in enumerate(parsed)]

    seen: Dict[tuple[str, str], Connection] = {}
    for conn in connections:
        if conn.key in seen:
            raise ManifestError(f"duplicate connection '{conn.label}' in BROKER_CONNECTIONS")
        seen[conn.key] = conn

    _validate_cross_references(connections)
    _apply_defaults(connections)
    return connections


def _validate_cross_references(connections: List[Connection]) -> None:
    by_account = {c.account: c for c in connections}
    for conn in connections:
        if conn.same_funds_as is None:
            continue
        if conn.same_funds_as == conn.account:
            raise ManifestError(f"connection '{conn.label}': same_funds_as cannot be itself")
        if conn.same_funds_as not in by_account:
            raise ManifestError(
                f"connection '{conn.label}': same_funds_as references unknown "
                f"connection id '{conn.same_funds_as}'"
            )


def _apply_defaults(connections: List[Connection]) -> None:
    """Every platform needs exactly one default connection — it is what an
    unqualified ``broker=mt5`` resolves to. More than one is ambiguous; none
    means the first declared for that platform."""
    by_platform: Dict[str, List[Connection]] = {}
    for conn in connections:
        by_platform.setdefault(conn.platform, []).append(conn)

    for platform, conns in by_platform.items():
        defaults = [c for c in conns if c.is_default]
        if len(defaults) > 1:
            raise ManifestError(
                f"platform '{platform}' has {len(defaults)} connections marked default "
                f"({[c.account for c in defaults]}); exactly one may be"
            )
        if not defaults:
            # `Connection` is frozen, so mark the first by replacing it in place.
            first = conns[0]
            connections[connections.index(first)] = Connection(
                **{**first.__dict__, "is_default": True}
            )
