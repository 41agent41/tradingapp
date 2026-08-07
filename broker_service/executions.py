"""Execution (fill) normalisation — the venue-agnostic fills feed.

Until now the platform's position model was built on *submitted orders*: the
backend's `order_audit` table recorded what the app asked a venue to trade, and
both the `ORDER_MAX_POSITION` guard and a systematic run's `position.size` were
derived from it. That is wrong in three well-known ways — a partial fill, a
rejection that arrives *after* the acknowledgement, and any manual trade placed
outside the app all leave the audit log and the account disagreeing, silently.

This module is the read side of the fix: every venue's execution reports,
normalised to one shape (`models.Execution`) so the backend can persist them,
derive fill-authoritative positions, and compute realised P&L — which is in
turn what makes a `risk.max_daily_loss` cap enforceable rather than decorative.

Everything here is **pure**: the IB plumbing (a `reqExecutions` round-trip)
lives in `routes/account.py` alongside the other synchronous IB helpers, and
each cloud venue's HTTP fetch lives in its own adapter. What is shared — and
what actually holds the sharp edges — is the normalisation:

- **IB's unset-double sentinel.** `commission` and `realizedPNL` come back as
  ``1.7976931348623157e+308`` (``UNSET_DOUBLE``) rather than null when IB has
  nothing to report. Persisting that as a number would poison every P&L sum
  downstream, so it is coerced to ``None``.
- **IB's execution timestamps.** The wire format has drifted across API
  versions: ``"YYYYMMDD  HH:MM:SS"`` (two spaces), ``"YYYYMMDD-HH:MM:SS"``, and
  on TWS 10.19+ a trailing timezone name (``"20260807-12:30:45 US/Eastern"``).
  Worse, when no timezone is supplied the value is in the *Gateway's* local
  timezone, not UTC — so reading it as UTC silently shifts every fill by the
  account's offset. A naive timestamp is therefore interpreted in
  ``IB_TIMEZONE`` (the knob that already documents the Gateway's timezone,
  defaulting to UTC) and converted to UTC from there.
"""

from __future__ import annotations

import math
import os
from datetime import UTC, datetime
from typing import Any, Dict, Optional

import pytz

from observability import get_logger

logger = get_logger(__name__)

# ibapi's "this field has no value" sentinel for doubles.
IB_UNSET_DOUBLE = 1.7976931348623157e308

# IB reports BOT/SLD; the app speaks BUY/SELL everywhere else.
_IB_SIDE_TO_ACTION = {"BOT": "BUY", "SLD": "SELL"}


def finite_or_none(value: Any) -> Optional[float]:
    """A float, or None for anything unusable — including IB's unset sentinel.

    ``None``, non-numeric input, NaN/inf and ``UNSET_DOUBLE`` all collapse to
    ``None`` so a downstream sum never has to defend against them.
    """
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(number) >= IB_UNSET_DOUBLE:
        return None
    return number


def ib_timezone() -> str:
    """The Gateway's timezone, used to interpret naive execution timestamps.

    Read live rather than at import so a deployment (or a test) can change it
    without a process restart, matching how the adapter registry reads its
    own env.
    """
    return (os.getenv("IB_TIMEZONE") or "").strip() or "UTC"


def parse_ib_exec_time(raw: Any, default_tz: Optional[str] = None) -> str:
    """Parse an IB execution timestamp into an ISO-8601 **UTC** string.

    Accepts every format IB has used: ``"YYYYMMDD  HH:MM:SS"``,
    ``"YYYYMMDD-HH:MM:SS"``, ``"YYYYMMDD HH:MM:SS"``, and any of those with a
    trailing timezone name. A timestamp that carries its own timezone wins;
    otherwise it is read in ``default_tz`` (``IB_TIMEZONE``). An unparseable
    value falls back to *now*, so one malformed fill can't sink the batch —
    it is logged rather than raised.
    """
    text = str(raw or "").strip()
    if not text:
        return datetime.now(UTC).isoformat()

    tz_name = default_tz or ib_timezone()
    parts = text.split()
    # A trailing token that isn't a time is IB's timezone name (TWS 10.19+).
    if len(parts) >= 2 and ":" in parts[-2] and ":" not in parts[-1]:
        tz_name = parts[-1]
        parts = parts[:-1]
    stamp = " ".join(parts)

    for fmt in ("%Y%m%d %H:%M:%S", "%Y%m%d-%H:%M:%S", "%Y%m%d"):
        try:
            naive = datetime.strptime(stamp, fmt)
            break
        except ValueError:
            continue
    else:
        logger.warning("ib_exec_time_unparseable", raw=text)
        return datetime.now(UTC).isoformat()

    try:
        tz = pytz.timezone(tz_name)
    except pytz.UnknownTimeZoneError:
        logger.warning("ib_exec_time_unknown_timezone", tz=tz_name)
        tz = pytz.UTC
    return tz.localize(naive).astimezone(UTC).isoformat()


def normalise_ib_execution(
    contract: Any,
    execution: Any,
    commission_report: Any = None,
) -> Dict[str, Any]:
    """One IB `execDetails` (+ its `commissionReport`) → the app's shape.

    The two arrive on independent callbacks that can land in either order, so
    the report is optional — a fill with no commission yet is still a real
    fill and is reported with ``commission=None`` rather than withheld. The
    next poll picks the commission up (same ``exec_id``, so the backend
    updates rather than duplicates).
    """
    side = _IB_SIDE_TO_ACTION.get(str(getattr(execution, "side", "")).upper(), "BUY")
    return {
        "exec_id": str(getattr(execution, "execId", "") or ""),
        "order_id": (
            str(getattr(execution, "orderId", "")) if getattr(execution, "orderId", None) else None
        ),
        "symbol": str(getattr(contract, "symbol", "") or "").upper(),
        "side": side,
        # IB reports `shares` unsigned with the direction in `side`; the app's
        # contract is the same, so the magnitude is carried through as-is.
        "quantity": abs(finite_or_none(getattr(execution, "shares", 0)) or 0.0),
        "price": finite_or_none(getattr(execution, "price", 0)) or 0.0,
        "commission": finite_or_none(getattr(commission_report, "commission", None)),
        "realized_pnl": finite_or_none(getattr(commission_report, "realizedPNL", None)),
        "executed_at": parse_ib_exec_time(getattr(execution, "time", None)),
        "account": str(getattr(execution, "acctNumber", "") or "") or None,
        "currency": str(getattr(contract, "currency", "") or "USD").upper(),
        "broker": "ib",
    }
