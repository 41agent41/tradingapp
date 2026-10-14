"""Broker connections added on the Settings page.

The backend owns them: it keeps them in its database with the secrets
encrypted, and sends the decrypted set here (``PUT /connections/managed``)
whenever one changes and whenever this service's ``revision`` on ``/health``
differs from its own (after this service restarts, the set is empty until the
backend sends it again, within a few seconds).

``.env`` wins, per platform: a platform with any connection in ``.env`` (the
manifest or the legacy variables) ignores the app's connections for it, and
``/health`` lists those as ``overridden`` so the page can say why. That keeps
an existing install exactly as it was, and gives ``.env`` the same
break-glass role it has for settings.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import app_settings
import ib_client
from connections import (
    Connection,
    ManifestError,
    load_connections,
    parse_managed,
    set_priority_override,
)
from observability import get_logger

logger = get_logger(__name__)

_revision: Optional[str] = None
_connections: List[Connection] = []
_overridden: List[str] = []

# IB's address from .env, so dropping an app-added IB connection restores it.
_ENV_IB = (ib_client.IB_HOST, ib_client.IB_PORT, ib_client.IB_CLIENT_ID)


def revision() -> Optional[str]:
    return _revision


def overridden() -> List[str]:
    return list(_overridden)


def merged_connections() -> List[Connection]:
    """Every connection in effect: ``.env``'s, then the app's for platforms
    ``.env`` does not configure. Raises :class:`ManifestError` like
    :func:`connections.load_connections`."""
    env = load_connections()
    env_platforms = {c.platform for c in env}
    return env + [c for c in _connections if c.platform not in env_platforms]


def apply(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Replace the app's connections and broker priority. Validates the whole
    set first; on a bad entry nothing changes and ManifestError is raised."""
    global _revision, _connections, _overridden

    parsed = parse_managed(payload.get("connections") or [])
    try:
        env_platforms = {c.platform for c in load_connections()}
    except ManifestError:
        # A broken .env shows on /health either way; don't block the app's set.
        env_platforms = set()

    _connections = parsed
    _overridden = [c.label for c in parsed if c.platform in env_platforms]
    _revision = str(payload.get("revision") or "") or None
    set_priority_override(payload.get("priority") or None)
    app_settings.apply(payload.get("settings"))
    _configure_ib(next((c for c in parsed if c.platform == "ib"), None), env_platforms)

    from adapters import reset_registry

    reset_registry()
    logger.info(
        "managed_connections_applied",
        revision=_revision,
        connections=[c.label for c in parsed],
        overridden=_overridden,
    )
    return {
        "revision": _revision,
        "connections": [c.label for c in parsed],
        "overridden": overridden(),
    }


def _configure_ib(conn: Optional[Connection], env_platforms: set) -> None:
    """IB has one process-wide gateway client, addressed by module globals in
    ib_client. Point it at the app's IB connection, or back at .env's."""
    if "ib" in env_platforms or conn is None:
        host, port, client_id = _ENV_IB
    else:
        host = conn.host
        port = conn.port or _ENV_IB[1]
        client_id = conn.client_id if conn.client_id is not None else _ENV_IB[2]
    if (host, port, client_id) == (ib_client.IB_HOST, ib_client.IB_PORT, ib_client.IB_CLIENT_ID):
        return
    ib_client.disconnect_ib()
    ib_client.IB_HOST, ib_client.IB_PORT, ib_client.IB_CLIENT_ID = host, port, client_id
    logger.info("ib_gateway_address_changed", host=host, port=port, client_id=client_id)


def reset() -> None:
    """Forget the app's connections. Test-only."""
    global _revision, _connections, _overridden
    _revision, _connections, _overridden = None, [], []
    set_priority_override(None)
    app_settings.reset()
