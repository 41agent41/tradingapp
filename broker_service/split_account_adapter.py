"""Split broker adapter — OANDA REST for account information, MT5 for execution.

OANDA is reachable two ways: its own v20 REST API (`oanda_adapter.py`) and its
MT5 offering, traded here through the sidecar (`mt5_adapter.py`). When an mt5
connection declares ``account_info_from: <oanda connection>`` (see
`connections.py`), the registry wraps the two in this adapter:

  - **account information** — ``account_summary`` (balance, NAV, margin) and
    ``positions`` — comes from the OANDA REST API;
  - **everything else** — placing, cancelling and modifying orders, protective
    stops, working orders, fills and instrument specs — still goes through the
    MT5 sidecar, exactly as it would without the switch.

### Positions are reported in MT5's vocabulary

The caller is an MT5 run: it sizes in lots and names instruments the way the
MT5 terminal does (``EURUSD``, ``EURUSD.a`` …). OANDA reports units and
``EUR_USD``. Handing those back unchanged would make a one-lot position read as
100,000 lots under the wrong symbol, so each OANDA position is translated:

  - **symbol** — matched to the MT5 position on the same instrument (compared
    on the canonical pair, so broker suffixes don't matter), falling back to the
    connection's ``symbol_map`` and then the bare pair;
  - **size** — OANDA units divided by the MT5 instrument's ``contract_size``;
  - **stop_loss / take_profit** — taken from the MT5 position, because the
    sidecar is the venue that holds the stop.

Every step fails closed: if the sidecar can't be read, an error is raised
rather than returning positions without their stops or in the wrong units.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional

from fastapi import HTTPException

from observability import get_logger

logger = get_logger(__name__)

_NON_ALNUM = re.compile(r"[^A-Z0-9]")


def _canonical(symbol: str) -> str:
    """``EUR.USD`` / ``EUR_USD`` / ``EURUSD.a`` / ``EURUSD_i`` -> ``EURUSD``.

    An MT5 broker suffix sits after a ``.`` or ``_`` and is dropped. OANDA (and
    the app's dotted form) use the same characters to split a currency pair, so
    a 3-letter head followed by a 3-letter currency is joined instead. CFDs
    reduce to their head on both sides (``US30_USD`` and ``US30.cash`` ->
    ``US30``).
    """
    parts = re.split(r"[._]", symbol.strip().upper())
    if len(parts) > 1 and len(parts[0]) == 3 and parts[1][:3].isalpha() and len(parts[1]) >= 3:
        return _NON_ALNUM.sub("", parts[0] + parts[1][:3])
    return _NON_ALNUM.sub("", parts[0])


class SplitAccountAdapter:
    """`BrokerAdapter` reading account information from one adapter (OANDA)
    and sending everything else to another (the MT5 sidecar)."""

    def __init__(
        self,
        *,
        execution: Any,
        account_info: Any,
        symbol_map: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._execution = execution
        self._account_info = account_info
        self._symbol_map = {str(k).upper(): str(v) for k, v in (symbol_map or {}).items()}
        self._native_to_canonical = {_canonical(v): k for k, v in self._symbol_map.items()}
        self.name = getattr(execution, "name", "mt5")
        # Orders go to the execution side, so its stop support is what counts.
        self.attaches_stops = bool(getattr(execution, "attaches_stops", False))

    # -- account information: OANDA ------------------------------------------ #
    def account_summary(self) -> Dict[str, Any]:
        return self._account_info.account_summary()

    def positions(self) -> List[Dict[str, Any]]:
        oanda_rows = self._account_info.positions()
        mt5_rows = self._execution.positions()

        mt5_by_canonical: Dict[str, Dict[str, Any]] = {}
        for row in mt5_rows:
            mt5_by_canonical[self._canonical_of_native(str(row.get("symbol") or ""))] = row

        positions: List[Dict[str, Any]] = []
        for row in oanda_rows:
            canonical = _canonical(str(row.get("symbol") or ""))
            mt5_row = mt5_by_canonical.pop(canonical, None)
            symbol = (
                str(mt5_row["symbol"])
                if mt5_row and mt5_row.get("symbol")
                else self._symbol_map.get(canonical, canonical)
            )
            contract_size = self._contract_size(symbol)
            positions.append(
                {
                    **row,
                    "symbol": symbol,
                    "position": float(row["position"]) / contract_size,
                    "stop_loss": mt5_row.get("stop_loss") if mt5_row else None,
                    "take_profit": mt5_row.get("take_profit") if mt5_row else None,
                }
            )

        if mt5_by_canonical:
            # OANDA is the authority here, but a position only the sidecar can
            # see means the two views disagree — worth an operator's attention.
            logger.warning(
                "split_account_positions_disagree",
                mt5_only=sorted(str(r.get("symbol")) for r in mt5_by_canonical.values()),
            )
        return positions

    def _canonical_of_native(self, native: str) -> str:
        key = _canonical(native)
        return self._native_to_canonical.get(key, key)

    def _contract_size(self, symbol: str) -> float:
        spec = self._execution.instrument_spec(symbol)
        size = spec.get("contract_size") if isinstance(spec, dict) else None
        try:
            value = float(size) if size is not None else 0.0
        except (TypeError, ValueError):
            value = 0.0
        if value <= 0:
            raise HTTPException(
                502,
                f"MT5 reported no contract size for {symbol}; cannot convert OANDA units to lots",
            )
        return value

    # -- execution and everything else: MT5 ------------------------------------ #
    def place_order(self, request: Any) -> Dict[str, Any]:
        return self._execution.place_order(request)

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        return self._execution.cancel_order(order_id)

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        return self._execution.modify_order(order_id, request)

    def open_orders(self) -> List[Dict[str, Any]]:
        return self._execution.open_orders()

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        return self._execution.executions(days)

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        return self._execution.instrument_spec(symbol)

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("_"):
            raise AttributeError(attr)
        # Venue extras such as MT5's `modify_position_stop` stay on the
        # execution side, so `hasattr` checks behave as they would unwrapped.
        return getattr(self._execution, attr)
