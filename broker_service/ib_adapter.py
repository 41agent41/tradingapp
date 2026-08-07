"""Interactive Brokers adapter (Systematic Trading roadmap — B1).

The concrete ``MarketDataAdapter`` + ``BrokerAdapter`` for IB. It is a thin
delegation layer: every method forwards to the sync worker that already
implements the behaviour (``orders.place_order_sync`` et al.), so routing an IB
flow "through the interface" is byte-for-byte identical to calling the worker
directly — no IB behaviour changes in this phase.

Each underlying worker is imported lazily inside the method. That keeps this
module free of heavy IB imports at module load and, crucially, avoids an import
cycle: the route modules import the registry (``adapters``), the registry
lazily imports this adapter, and this adapter reaches back into those same
route/worker modules only at call time.
"""

from __future__ import annotations

from typing import Any, Dict, List


class IBAdapter:
    """Adapter over the existing IB sync workers. Implements both the
    market-data and broker protocols in ``adapters``."""

    name = "ib"

    # -- BrokerAdapter ----------------------------------------------------- #
    def place_order(self, request: Any) -> Dict[str, Any]:
        from orders import place_order_sync

        return place_order_sync(request)

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        from orders import cancel_order_sync

        return cancel_order_sync(order_id)

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        from orders import modify_order_sync

        return modify_order_sync(order_id, request)

    def positions(self) -> List[Dict[str, Any]]:
        from routes.account import get_positions_sync

        return get_positions_sync()

    def account_summary(self) -> Dict[str, Any]:
        from routes.account import get_account_summary_sync

        return get_account_summary_sync()

    def open_orders(self) -> List[Dict[str, Any]]:
        from routes.account import get_orders_sync

        return get_orders_sync()

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        from routes.account import get_executions_sync

        return get_executions_sync(days)

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """IB stock orders are whole shares, so the spec is a constant rather
        than a round-trip to the Gateway.

        This is deliberately not derived from `reqContractDetails`: that would
        cost a Gateway call per sizing decision, and for the STK path the app
        actually trades the answer is fixed. Futures and options have real
        multipliers, and when the order path grows to size those natively this
        is where their contract multiplier belongs.
        """

        return {
            "symbol": symbol.upper(),
            "broker": "ib",
            "unit": "shares",
            "min_size": 1.0,
            "size_step": 1.0,
            "max_size": None,
            "contract_size": 1.0,
            "currency": "USD",
        }

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        from routes.contracts import search_contracts_sync

        return search_contracts_sync(request)

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> Any:
        from routes.market_data import get_realtime_data_sync

        return get_realtime_data_sync(symbol, account_mode)

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        from routes.market_data import get_tick_data_sync

        return get_tick_data_sync(symbol, account_mode)
