"""The simulated exchange: turns a strategy's order intents into ``Order``
objects, fills them against candles, and keeps the ``Position`` and wallet
consistent.

Fill model (deliberately conservative — a backtest should under-promise):

* **MARKET** orders fill at the close of the candle on which they were
  submitted (a strategy decides on a closed candle, so that is the price it saw).
* **LIMIT / STOP** orders become eligible on the *next* candle and fill when
  that candle's range reaches their price. A gap through the price fills at the
  open, never at the better limit price.
* If a stop-loss and a take-profit could both fill in one candle the stop-loss
  wins — the pessimistic reading, since the intra-candle path is unknown.
* Exit orders are reduce-only and capped at the open quantity; closing the
  position cancels every remaining order, exactly as Jesse does.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Dict, List

import numpy as np

from . import candles as C
from .enums import order_statuses, order_types
from .enums import order_submitted_via as via
from .models import ClosedTrade, Exchange, InsufficientMargin, Order, Position, order_type_for

logger = logging.getLogger(__name__)


@dataclass
class Fill:
    order: Order
    price: float
    time_ms: float
    qty: float
    opened_position: bool = False
    closed_position: bool = False
    increased_position: bool = False
    reduced_position: bool = False
    trade: ClosedTrade | None = None


class SimulatedBroker:
    def __init__(
        self,
        exchange: Exchange,
        position: Position,
        symbol: str,
        timeframe: str,
        strategy_name: str,
    ) -> None:
        self.exchange = exchange
        self.position = position
        self.symbol = symbol
        self.timeframe = timeframe
        self.strategy_name = strategy_name
        self.orders: List[Order] = []
        self.trades: List[ClosedTrade] = []
        self.rejected: List[Dict[str, object]] = []
        self._next_order_id = 1
        self._next_trade_id = 1
        # The entry reason attached to the *current* position for the trade log.
        self._entry_reason = ""
        self._entry_orders: List[Dict[str, object]] = []
        self._entry_fee = 0.0

    # ------------------------------------------------------------------ #
    # Queries
    # ------------------------------------------------------------------ #

    @property
    def active_orders(self) -> List[Order]:
        return [o for o in self.orders if o.is_active]

    def active_entry_orders(self) -> List[Order]:
        return [o for o in self.active_orders if o.submitted_via == via.ENTRY]

    def active_exit_orders(self, kind: str | None = None) -> List[Order]:
        return [
            o
            for o in self.active_orders
            if o.submitted_via in (via.STOP_LOSS, via.TAKE_PROFIT)
            and (kind is None or o.submitted_via == kind)
        ]

    def reserved_margin(self) -> float:
        pending = sum(o.value for o in self.active_entry_orders()) / self.exchange.leverage
        return self.position.total_cost + pending

    def available_margin(self) -> float:
        return self.exchange.balance + self.position.pnl - self.reserved_margin()

    def portfolio_value(self) -> float:
        return self.exchange.balance + self.position.pnl

    # ------------------------------------------------------------------ #
    # Submission
    # ------------------------------------------------------------------ #

    def submit(
        self,
        side: str,
        qty: float,
        price: float,
        submitted_via: str,
        current_price: float,
        time_ms: float,
        reason: str = "",
    ) -> Order:
        qty = float(qty)
        price = float(price)
        if not np.isfinite(qty) or qty <= 0:
            raise InsufficientMargin(f"Order quantity must be a positive number, got {qty!r}")
        if not np.isfinite(price) or price <= 0:
            raise InsufficientMargin(f"Order price must be a positive number, got {price!r}")

        order_type = order_type_for(side, price, current_price, submitted_via)
        reduce_only = submitted_via != via.ENTRY
        if reduce_only:
            # Cap at what is open; there is nothing else to reduce.
            qty = min(qty, abs(self.position.qty))
            if qty <= 0:
                raise InsufficientMargin("Cannot submit an exit order without an open position.")
        else:
            needed = qty * price / self.exchange.leverage
            if needed > self.available_margin() + 1e-9:
                raise InsufficientMargin(
                    f"Entry needs {needed:.2f} margin but only "
                    f"{self.available_margin():.2f} is available."
                )

        order = Order(
            id=self._next_order_id,
            symbol=self.symbol,
            side=side,
            type=order_type,
            qty=qty,
            price=price,
            submitted_via=submitted_via,
            created_at=time_ms,
            reduce_only=reduce_only,
            reason=reason,
        )
        self._next_order_id += 1
        self.orders.append(order)
        return order

    def cancel(self, order: Order) -> None:
        order.cancel()

    def cancel_all(self, submitted_via: str | None = None) -> int:
        count = 0
        for order in self.active_orders:
            if submitted_via is None or order.submitted_via == submitted_via:
                order.cancel()
                count += 1
        return count

    def cancel_entry_orders(self) -> int:
        return self.cancel_all(via.ENTRY)

    def cancel_exit_orders(self, kind: str | None = None) -> int:
        count = 0
        for order in self.active_exit_orders(kind):
            order.cancel()
            count += 1
        return count

    # ------------------------------------------------------------------ #
    # Filling
    # ------------------------------------------------------------------ #

    def fill_market_orders(self, price: float, time_ms: float) -> List[Fill]:
        """MARKET orders execute immediately at ``price`` (the close the
        strategy decided on)."""

        fills: List[Fill] = []
        for order in self.active_orders:
            if order.type == order_types.MARKET:
                fills.append(self._execute(order, price, time_ms))
        return fills

    def on_candle(self, candle: np.ndarray) -> List[Fill]:
        """Try to fill every eligible resting order against ``candle``."""

        open_ = float(candle[C.OPEN])
        high = float(candle[C.HIGH])
        low = float(candle[C.LOW])
        close = float(candle[C.CLOSE])
        time_ms = float(candle[C.TIMESTAMP])

        fills: List[Fill] = []
        # Pessimistic priority: stop-losses first, then take-profits, entries last.
        priority = {via.STOP_LOSS: 0, via.LIQUIDATE: 0, via.TAKE_PROFIT: 1, via.ENTRY: 2}
        for order in sorted(self.active_orders, key=lambda o: (priority[o.submitted_via], o.id)):
            if not order.is_active:
                continue  # cancelled by an earlier fill in this candle
            if order.created_at >= time_ms:
                continue  # submitted on this candle's close; eligible next candle
            fill_price = self._fill_price(order, open_, high, low)
            if fill_price is None:
                continue
            fills.append(self._execute(order, fill_price, time_ms))
            if self.position.is_close and order.reduce_only:
                # Position gone: nothing left for the remaining exits to do.
                self.cancel_exit_orders()

        self.position.current_price = close
        return fills

    @staticmethod
    def _fill_price(order: Order, open_: float, high: float, low: float) -> float | None:
        if order.type == order_types.LIMIT:
            if order.is_buy and low <= order.price:
                return min(open_, order.price)
            if order.is_sell and high >= order.price:
                return max(open_, order.price)
            return None
        if order.type == order_types.STOP:
            if order.is_buy and high >= order.price:
                return max(open_, order.price)
            if order.is_sell and low <= order.price:
                return min(open_, order.price)
            return None
        # A MARKET order still resting here means it was submitted mid-candle
        # processing (e.g. a stop already through its price): fill at the open.
        return open_

    def _execute(self, order: Order, price: float, time_ms: float) -> Fill:
        order.status = order_statuses.EXECUTED
        order.executed_at = time_ms
        order.filled_price = price
        fee = self.exchange.charge_fee(order.qty * price)
        fill = Fill(order=order, price=price, time_ms=time_ms, qty=order.qty)

        signed = order.qty if order.is_buy else -order.qty
        pos = self.position

        if order.reduce_only or (pos.is_open and np.sign(signed) != np.sign(pos.qty)):
            qty_to_reduce = min(order.qty, abs(pos.qty))
            realised = pos._reduce(qty_to_reduce, price)
            self.exchange.realize(realised)
            # Attribute the entry fee proportionally to the slice being closed.
            share = qty_to_reduce / (qty_to_reduce + abs(pos.qty)) if pos.is_open else 1.0
            entry_fee_part = self._entry_fee * share
            self._entry_fee -= entry_fee_part
            trade = ClosedTrade(
                id=self._next_trade_id,
                strategy_name=self.strategy_name,
                symbol=self.symbol,
                exchange=self.exchange.name,
                timeframe=self.timeframe,
                type="long" if signed < 0 else "short",
                qty=qty_to_reduce,
                entry_price=pos.entry_price,
                exit_price=price,
                opened_at=pos.opened_at or time_ms,
                closed_at=time_ms,
                fee=fee + entry_fee_part,
                entry_reason=self._entry_reason,
                exit_reason=order.reason or order.submitted_via,
                orders=[*self._entry_orders, order.to_dict()],
            )
            self._next_trade_id += 1
            self.trades.append(trade)
            fill.trade = trade
            if pos.is_close:
                pos._close(time_ms)
                fill.closed_position = True
                self._entry_reason = ""
                self._entry_orders = []
                self._entry_fee = 0.0
                # Any leftover from an oversized reversal order is ignored: Jesse
                # defers reversals to a later candle as well.
                self.cancel_all()
            else:
                fill.reduced_position = True
            return fill

        if pos.is_close:
            pos._open(signed, price, time_ms)
            fill.opened_position = True
            self._entry_reason = order.reason
            self._entry_orders = [order.to_dict()]
            self._entry_fee = fee
        else:
            pos._increase(order.qty, price)
            fill.increased_position = True
            self._entry_orders.append(order.to_dict())
            self._entry_fee += fee
        return fill

    # ------------------------------------------------------------------ #
    # Live-sync helper
    # ------------------------------------------------------------------ #

    def sync_position(self, qty: float, avg_price: float, time_ms: float) -> None:
        """Overwrite the simulated position with the venue's truth (live mode)."""

        self.cancel_all()
        if qty == 0:
            if self.position.is_open:
                self.position._close(time_ms)
            self.position.qty = 0.0
            return
        self.position._open(float(qty), float(avg_price), time_ms)
        self._entry_reason = "live position"
        self._entry_orders = []
        self._entry_fee = 0.0


FillHandler = Callable[[Fill], None]
