"""Trading-state models: ``Order``, ``Position``, ``ClosedTrade`` and the
``Exchange`` wallet a strategy reads its balance from.

Semantics follow Jesse's models (``jesse.models.Order/Position/ClosedTrade``)
closely enough that a strategy's hooks — ``on_open_position(order)``,
``self.position.pnl_percentage`` — behave the same. Timestamps are unix
**milliseconds** throughout, as in Jesse's candles.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List

from .enums import order_statuses, order_types, position_types, sides


class StrategyError(Exception):
    """A strategy asked for something impossible (missing ``self.buy`` after
    ``go_long``, a negative quantity, …). Author error, not a runtime fault."""


class InsufficientMargin(StrategyError):
    """An entry order was larger than the available margin."""


@dataclass
class Order:
    id: int
    symbol: str
    side: str  # sides.BUY | sides.SELL
    type: str  # order_types.*
    qty: float  # always a positive magnitude
    price: float  # limit/stop price; for MARKET the reference price at submission
    submitted_via: str  # order_submitted_via.*
    created_at: float  # ms — the candle (open time) on which it was submitted
    status: str = order_statuses.ACTIVE
    executed_at: float | None = None
    filled_price: float | None = None
    reduce_only: bool = False
    reason: str = ""

    @property
    def is_active(self) -> bool:
        return self.status == order_statuses.ACTIVE

    @property
    def is_executed(self) -> bool:
        return self.status == order_statuses.EXECUTED

    @property
    def is_canceled(self) -> bool:
        return self.status == order_statuses.CANCELED

    @property
    def is_buy(self) -> bool:
        return self.side == sides.BUY

    @property
    def is_sell(self) -> bool:
        return self.side == sides.SELL

    @property
    def value(self) -> float:
        return abs(self.qty * self.price)

    def cancel(self) -> None:
        if self.is_active:
            self.status = order_statuses.CANCELED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "side": self.side,
            "type": self.type,
            "qty": self.qty,
            "price": self.price,
            "submitted_via": self.submitted_via,
            "status": self.status,
            "created_at": self.created_at,
            "executed_at": self.executed_at,
            "filled_price": self.filled_price,
            "reduce_only": self.reduce_only,
            "reason": self.reason,
        }


class Exchange:
    """The wallet: what the strategy sees as ``self.balance`` and friends.

    ``balance`` is the wallet balance — realised PnL and fees applied, open
    positions *not* deducted (Jesse's futures-style accounting). Margin is what
    open positions and pending entry orders have reserved; ``available_margin``
    is what is left to trade with.
    """

    def __init__(
        self,
        name: str,
        starting_balance: float,
        fee_rate: float = 0.001,
        leverage: int = 1,
    ) -> None:
        if starting_balance <= 0:
            raise ValueError("starting_balance must be positive")
        if fee_rate < 0:
            raise ValueError("fee_rate cannot be negative")
        if leverage < 1:
            raise ValueError("leverage must be >= 1")
        self.name = name
        self.starting_balance = float(starting_balance)
        self.balance = float(starting_balance)
        self.fee_rate = float(fee_rate)
        self.leverage = int(leverage)
        self.total_fees = 0.0

    def charge_fee(self, notional: float) -> float:
        fee = abs(notional) * self.fee_rate
        self.balance -= fee
        self.total_fees += fee
        return fee

    def realize(self, pnl: float) -> None:
        self.balance += pnl


@dataclass
class Position:
    symbol: str
    exchange: Exchange
    qty: float = 0.0  # signed: > 0 long, < 0 short
    entry_price: float = 0.0
    opened_at: float | None = None
    closed_at: float | None = None
    current_price: float = 0.0
    strategy_name: str = ""

    # --- state ----------------------------------------------------------- #

    @property
    def type(self) -> str:
        if self.qty > 0:
            return position_types.LONG
        if self.qty < 0:
            return position_types.SHORT
        return position_types.CLOSE

    @property
    def is_open(self) -> bool:
        return self.qty != 0

    @property
    def is_close(self) -> bool:
        return self.qty == 0

    @property
    def is_long(self) -> bool:
        return self.qty > 0

    @property
    def is_short(self) -> bool:
        return self.qty < 0

    # --- valuation ------------------------------------------------------- #

    @property
    def value(self) -> float:
        """Notional at the current price."""

        return abs(self.qty) * self.current_price

    @property
    def total_cost(self) -> float:
        """Margin reserved: notional at entry divided by leverage."""

        return abs(self.qty) * self.entry_price / self.exchange.leverage

    @property
    def pnl(self) -> float:
        if self.is_close or self.entry_price == 0:
            return 0.0
        return (self.current_price - self.entry_price) * self.qty

    @property
    def pnl_percentage(self) -> float:
        """PnL as a percentage of the margin used (Jesse's ``pnl_percentage``)."""

        if self.is_close or self.entry_price == 0:
            return 0.0
        return self.pnl / self.total_cost * 100.0

    @property
    def roi(self) -> float:
        return self.pnl_percentage

    # --- mutation (only the broker calls these) -------------------------- #

    def _open(self, qty_signed: float, price: float, time_ms: float) -> None:
        self.qty = qty_signed
        self.entry_price = price
        self.opened_at = time_ms
        self.closed_at = None
        self.current_price = price

    def _increase(self, qty_abs: float, price: float) -> None:
        total = abs(self.qty) + qty_abs
        self.entry_price = (abs(self.qty) * self.entry_price + qty_abs * price) / total
        self.qty = total if self.is_long else -total

    def _reduce(self, qty_abs: float, price: float) -> float:
        """Reduce by ``qty_abs`` at ``price``; returns the realised PnL."""

        direction = 1.0 if self.is_long else -1.0
        realised = (price - self.entry_price) * qty_abs * direction
        remaining = abs(self.qty) - qty_abs
        self.qty = remaining * direction if remaining > 1e-12 else 0.0
        return realised

    def _close(self, time_ms: float) -> None:
        self.qty = 0.0
        self.closed_at = time_ms

    def to_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "type": self.type,
            "qty": self.qty,
            "entry_price": self.entry_price,
            "current_price": self.current_price,
            "pnl": self.pnl,
            "pnl_percentage": self.pnl_percentage,
            "opened_at": self.opened_at,
            "closed_at": self.closed_at,
        }


@dataclass
class ClosedTrade:
    """One realised trade: an entry (possibly several fills, averaged) and one
    exit fill. A position scaled out in two rungs therefore produces two
    ``ClosedTrade`` rows sharing an entry — the same convention the app's
    ``BacktestEngine`` uses for scale-out rungs, so the ``/backtest`` UI
    renders both engines identically."""

    id: int
    strategy_name: str
    symbol: str
    exchange: str
    timeframe: str
    type: str  # trade_types.LONG | SHORT
    qty: float
    entry_price: float
    exit_price: float
    opened_at: float
    closed_at: float
    fee: float = 0.0
    entry_reason: str = ""
    exit_reason: str = ""
    orders: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def pnl(self) -> float:
        """Net of fees."""

        direction = 1.0 if self.type == position_types.LONG else -1.0
        return (self.exit_price - self.entry_price) * self.qty * direction - self.fee

    @property
    def pnl_percentage(self) -> float:
        cost = self.qty * self.entry_price
        return self.pnl / cost * 100.0 if cost else 0.0

    @property
    def roi(self) -> float:
        return self.pnl_percentage

    @property
    def holding_period(self) -> float:
        """Seconds between entry and exit."""

        return (self.closed_at - self.opened_at) / 1000.0

    @property
    def is_long(self) -> bool:
        return self.type == position_types.LONG

    @property
    def is_short(self) -> bool:
        return self.type == position_types.SHORT

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "strategy_name": self.strategy_name,
            "symbol": self.symbol,
            "exchange": self.exchange,
            "timeframe": self.timeframe,
            "type": self.type,
            "qty": self.qty,
            "entry_price": self.entry_price,
            "exit_price": self.exit_price,
            "opened_at": self.opened_at,
            "closed_at": self.closed_at,
            "fee": self.fee,
            "pnl": self.pnl,
            "pnl_percentage": self.pnl_percentage,
            "holding_period": self.holding_period,
            "entry_reason": self.entry_reason,
            "exit_reason": self.exit_reason,
            "orders": list(self.orders),
        }


def order_type_for(side: str, price: float, current_price: float, submitted_via: str) -> str:
    """Jesse's rule for what an ``[qty, price]`` intent means.

    Entries: a buy above the market is a breakout **STOP**, below it a pullback
    **LIMIT**, at it a **MARKET** order (mirrored for sells). Stop-losses are
    always STOP orders on the losing side, take-profits LIMIT orders on the
    winning side; either already through its price executes at MARKET.
    """

    from .enums import order_submitted_via as via

    eps = 1e-12
    if submitted_via == via.STOP_LOSS:
        if side == sides.SELL:  # protecting a long
            return order_types.STOP if price < current_price - eps else order_types.MARKET
        return order_types.STOP if price > current_price + eps else order_types.MARKET
    if submitted_via == via.TAKE_PROFIT:
        if side == sides.SELL:
            return order_types.LIMIT if price > current_price + eps else order_types.MARKET
        return order_types.LIMIT if price < current_price - eps else order_types.MARKET
    if submitted_via == via.LIQUIDATE:
        return order_types.MARKET
    # Entry
    if abs(price - current_price) <= eps:
        return order_types.MARKET
    if side == sides.BUY:
        return order_types.STOP if price > current_price else order_types.LIMIT
    return order_types.STOP if price < current_price else order_types.LIMIT
