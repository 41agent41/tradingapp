"""
Client order ids: how a fill finds the order the app sent.

Every order carries the app's ``order_audit`` row id to the venue as
``audit-<id>``: Alpaca's ``client_order_id``, OANDA's ``clientExtensions.id``,
and the MT5 order comment. Fills that come back carrying it can be linked to
their audit row even when the place call timed out before the venue's own
order id was recorded, which is when linking by order id fails.
"""

from __future__ import annotations

import re
from typing import Any, Optional

PREFIX = "audit-"
_PATTERN = re.compile(r"(?:^|\s)audit-(\d+)(?:$|\s)")


def client_order_id(audit_id: Any) -> Optional[str]:
    """``audit-<id>`` for a positive integer audit id, else None."""
    try:
        value = int(audit_id)
    except (TypeError, ValueError):
        return None
    return f"{PREFIX}{value}" if value > 0 else None


def audit_id_from(value: Any) -> Optional[int]:
    """The audit id inside a client id or order comment, if there is one."""
    if value is None:
        return None
    match = _PATTERN.search(str(value).strip())
    return int(match.group(1)) if match else None
