"""The ``Strategy`` base class — Jesse's authoring model.

A strategy is a Python class that answers a handful of questions once per
closed candle. Subclass it, implement the hooks you need, and the same class
backtests and drives live signals:

    from jesse.strategies import Strategy
    import jesse.indicators as ta
    from jesse import utils

    class SMACrossover(Strategy):
        def hyperparameters(self):
            return [
                {"name": "fast", "type": int, "min": 5, "max": 50, "default": 20},
                {"name": "slow", "type": int, "min": 20, "max": 200, "default": 50},
            ]

        @property
        def fast(self):
            return ta.sma(self.candles, self.hp["fast"], sequential=True)

        @property
        def slow(self):
            return ta.sma(self.candles, self.hp["slow"], sequential=True)

        def should_long(self) -> bool:
            return utils.crossed(self.fast, self.slow, "above")

        def should_short(self) -> bool:
            return utils.crossed(self.fast, self.slow, "below")

        def go_long(self):
            stop = self.price - 2 * ta.atr(self.candles, 14)
            qty = utils.risk_to_qty(self.balance, 1, self.price, stop, fee_rate=self.fee_rate)
            self.buy = qty, self.price
            self.stop_loss = qty, stop
            self.take_profit = qty, self.price + 2 * (self.price - stop)

        def go_short(self): ...

        def update_position(self):
            if self.is_long and self.position.pnl_percentage > 1:
                self.stop_loss = self.position.qty, max(self.position.entry_price, self.slow[-1])

Lifecycle on every candle (identical to upstream Jesse):

    before()
      position closed, no entry orders ─▶ should_long()/should_short() ─▶ filters()
                                          ─▶ go_long()/go_short() ─▶ submit self.buy/self.sell
      position closed, entry pending    ─▶ should_cancel_entry() ─▶ cancel
      position open                     ─▶ update_position() (stop_loss/take_profit/liquidate)
    after()

Order intents are ``qty, price`` tuples or lists of them. A price equal to
``self.price`` is a market order, a buy above / sell below is a stop (breakout),
the opposite a limit (pullback). ``self.stop_loss`` / ``self.take_profit`` are
submitted once the entry fills; changing them in ``update_position`` replaces
the resting exit orders (that is how you trail).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Sequence, Tuple

import numpy as np

from . import candles as C
from . import timeframes as tf
from .broker import Fill, SimulatedBroker
from .enums import order_submitted_via as via
from .enums import sides
from .models import ClosedTrade, InsufficientMargin, Order, Position, StrategyError

logger = logging.getLogger(__name__)

OrderIntent = Tuple[float, float]


class CandleStore:
    """Holds the primary candles plus lazily built higher-timeframe resamples,
    and exposes only what has **closed** at the current candle."""

    def __init__(self, candles: np.ndarray, timeframe: str) -> None:
        C.validate(candles)
        # CandleArray carries the per-store indicator cache (see candles.py).
        self.candles = C.CandleArray(candles)
        self.timeframe = tf.normalize(timeframe)
        self.index = 0
        self._resampled: Dict[str, C.CandleArray] = {}

    @property
    def current(self) -> np.ndarray:
        return self.candles[self.index]

    @property
    def visible(self) -> np.ndarray:
        return self.candles[: self.index + 1]

    @property
    def close_time_ms(self) -> float:
        return float(self.current[C.TIMESTAMP]) + tf.to_milliseconds(self.timeframe)

    def get(self, timeframe: str) -> np.ndarray:
        target = tf.normalize(timeframe)
        if target == self.timeframe:
            return self.visible
        if not tf.is_higher(target, self.timeframe):
            raise StrategyError(
                f"get_candles('{timeframe}') needs a timeframe larger than the "
                f"strategy's '{tf.to_app(self.timeframe)}' (lower timeframes are not stored)."
            )
        if target not in self._resampled:
            self._resampled[target] = C.CandleArray(
                C.resample(np.asarray(self.candles), self.timeframe, target)
            )
        return C.closed_before(self._resampled[target], target, self.close_time_ms)


class Strategy:
    """Base class for every Jesse strategy. See the module docstring."""

    # Set by the runner; read-only for the strategy author.
    name: str = ""
    symbol: str = ""
    exchange: str = ""
    timeframe: str = ""
    hp: Dict[str, Any]

    def __init__(self) -> None:
        self.name = self.name or type(self).__name__
        self.vars: Dict[str, Any] = {}
        self.shared_vars: Dict[str, Any] = {}
        self.hp = {}
        self.buy: Any = None
        self.sell: Any = None
        self.stop_loss: Any = None
        self.take_profit: Any = None
        self.logs: List[Dict[str, Any]] = []
        self.is_backtesting = True
        self.is_livetrading = False
        self.is_papertrading = False
        self.increased_count = 0
        self.reduced_count = 0
        self._store: CandleStore | None = None
        self._broker: SimulatedBroker | None = None
        self._position: Position | None = None
        self._index = -1
        self._liquidate_requested = False
        self._last_stop_loss: List[OrderIntent] = []
        self._last_take_profit: List[OrderIntent] = []
        self._pending_exit_intents = False
        self._conflicts = 0
        self._last_decision: Dict[str, Any] = {}

    # ------------------------------------------------------------------ #
    # Hooks — override these
    # ------------------------------------------------------------------ #

    def before(self) -> None:
        """Runs first on every candle, before any decision."""

    def after(self) -> None:
        """Runs last on every candle."""

    def should_long(self) -> bool:
        return False

    def should_short(self) -> bool:
        return False

    def should_cancel_entry(self) -> bool:
        """While an entry order is resting unfilled: cancel it?"""

        return False

    def go_long(self) -> None:
        raise NotImplementedError(f"{self.name}.go_long() is not implemented")

    def go_short(self) -> None:
        raise NotImplementedError(f"{self.name}.go_short() is not implemented")

    def update_position(self) -> None:
        """Runs on every candle while a position is open."""

    def filters(self) -> List[Callable[[], bool]]:
        """Callables that must all return truthy for an entry to proceed."""

        return []

    def hyperparameters(self) -> List[Dict[str, Any]]:
        """``[{"name", "type", "min", "max", "default"}, ...]`` — read via ``self.hp``."""

        return []

    def dna(self) -> str:
        return ""

    def watch_list(self) -> List[Tuple[str, Any]]:
        """``[(label, value), ...]`` shown alongside the live signal."""

        return []

    def on_open_position(self, order: Order) -> None:
        pass

    def on_close_position(self, order: Order) -> None:
        pass

    def on_increased_position(self, order: Order) -> None:
        pass

    def on_reduced_position(self, order: Order) -> None:
        pass

    def on_stop_loss(self, order: Order) -> None:
        pass

    def on_take_profit(self, order: Order) -> None:
        pass

    def on_cancel(self) -> None:
        pass

    def terminate(self) -> None:
        """Runs once after the last candle."""

    # ------------------------------------------------------------------ #
    # Actions
    # ------------------------------------------------------------------ #

    def liquidate(self) -> None:
        """Close the open position at market on this candle."""

        if self.position.is_open:
            self._liquidate_requested = True

    def log(self, msg: str, log_type: str = "info", send_notification: bool = False, **_: Any):
        entry = {
            "time": self.time if self._store is not None else None,
            "type": log_type,
            "message": str(msg),
        }
        self.logs.append(entry)
        getattr(logger, log_type if log_type in ("info", "warning", "error") else "info")(
            "%s: %s", self.name, msg
        )

    def get_candles(self, exchange: str, symbol: str, timeframe: str) -> np.ndarray:
        """Candles for another timeframe of the same instrument (only closed
        higher-timeframe candles are visible — no look-ahead)."""

        if symbol and self.symbol and symbol.upper() != self.symbol.upper():
            raise StrategyError(
                f"get_candles() for '{symbol}' — only the strategy's own symbol "
                f"'{self.symbol}' is available."
            )
        return self._require_store().get(timeframe)

    # ------------------------------------------------------------------ #
    # Candle / price properties
    # ------------------------------------------------------------------ #

    def _require_store(self) -> CandleStore:
        if self._store is None:
            raise StrategyError("Strategy is not bound to a candle store yet.")
        return self._store

    @property
    def candles(self) -> np.ndarray:
        return self._require_store().visible

    @property
    def current_candle(self) -> np.ndarray:
        return self._require_store().current

    @property
    def index(self) -> int:
        return self._index

    @property
    def time(self) -> float:
        """Close time of the current candle, unix ms."""

        return self._require_store().close_time_ms

    @property
    def price(self) -> float:
        return float(self.current_candle[C.CLOSE])

    @property
    def close(self) -> float:
        return self.price

    @property
    def open(self) -> float:
        return float(self.current_candle[C.OPEN])

    @property
    def high(self) -> float:
        return float(self.current_candle[C.HIGH])

    @property
    def low(self) -> float:
        return float(self.current_candle[C.LOW])

    @property
    def volume(self) -> float:
        return float(self.current_candle[C.VOLUME])

    # ------------------------------------------------------------------ #
    # Position / wallet properties
    # ------------------------------------------------------------------ #

    def _require_broker(self) -> SimulatedBroker:
        if self._broker is None:
            raise StrategyError("Strategy is not bound to a broker yet.")
        return self._broker

    @property
    def position(self) -> Position:
        if self._position is None:
            raise StrategyError("Strategy is not bound to a position yet.")
        return self._position

    @property
    def is_long(self) -> bool:
        return self.position.is_long

    @property
    def is_short(self) -> bool:
        return self.position.is_short

    @property
    def is_open(self) -> bool:
        return self.position.is_open

    @property
    def is_close(self) -> bool:
        return self.position.is_close

    @property
    def balance(self) -> float:
        return self._require_broker().exchange.balance

    @property
    def capital(self) -> float:
        return self.balance

    @property
    def available_margin(self) -> float:
        return self._require_broker().available_margin()

    @property
    def portfolio_value(self) -> float:
        return self._require_broker().portfolio_value()

    @property
    def leverage(self) -> int:
        return self._require_broker().exchange.leverage

    @property
    def fee_rate(self) -> float:
        return self._require_broker().exchange.fee_rate

    @property
    def trades(self) -> List[ClosedTrade]:
        return self._require_broker().trades

    @property
    def orders(self) -> List[Order]:
        return self._require_broker().orders

    @property
    def has_long_entry_order(self) -> bool:
        return any(o.is_buy for o in self._require_broker().active_entry_orders())

    @property
    def has_short_entry_order(self) -> bool:
        return any(o.is_sell for o in self._require_broker().active_entry_orders())

    @property
    def has_active_entry_orders(self) -> bool:
        return bool(self._require_broker().active_entry_orders())

    @property
    def average_entry_price(self) -> float | None:
        intents = self._normalize(self.buy if self.buy is not None else self.sell, "entry")
        return self._weighted_price(intents)

    @property
    def average_stop_loss(self) -> float | None:
        return self._weighted_price(self._normalize(self.stop_loss, "stop_loss"))

    @property
    def average_take_profit(self) -> float | None:
        return self._weighted_price(self._normalize(self.take_profit, "take_profit"))

    @property
    def metrics(self) -> Dict[str, Any]:
        from .metrics import trade_statistics

        return trade_statistics(self.trades)

    # ------------------------------------------------------------------ #
    # Runner plumbing
    # ------------------------------------------------------------------ #

    def _bind(
        self,
        store: CandleStore,
        broker: SimulatedBroker,
        position: Position,
        symbol: str,
        exchange: str,
        hyperparameters: Dict[str, Any] | None = None,
        mode: str = "backtest",
    ) -> None:
        self._store = store
        self._broker = broker
        self._position = position
        self.symbol = symbol
        self.exchange = exchange
        self.timeframe = tf.to_app(store.timeframe)
        self.hp = resolve_hyperparameters(self.hyperparameters(), hyperparameters)
        self.is_backtesting = mode == "backtest"
        self.is_livetrading = mode == "live"
        self.is_papertrading = mode == "paper"

    def _reset_intents(self) -> None:
        self.buy = None
        self.sell = None
        self.stop_loss = None
        self.take_profit = None
        self._last_stop_loss = []
        self._last_take_profit = []

    @staticmethod
    def _normalize(value: Any, label: str) -> List[OrderIntent]:
        """``(qty, price)`` | ``[(qty, price), ...]`` | ``None`` -> list of pairs."""

        if value is None:
            return []
        arr = np.asarray(value, dtype="float64")
        if arr.ndim == 1:
            if arr.shape[0] != 2:
                raise StrategyError(f"self.{label} must be (qty, price), got {value!r}")
            arr = arr.reshape(1, 2)
        if arr.ndim != 2 or arr.shape[1] != 2:
            raise StrategyError(
                f"self.{label} must be (qty, price) or a list of them, got {value!r}"
            )
        intents: List[OrderIntent] = []
        for qty, price in arr:
            if not np.isfinite(qty) or not np.isfinite(price):
                raise StrategyError(f"self.{label} contains NaN/inf: {value!r}")
            if qty <= 0:
                raise StrategyError(f"self.{label} quantity must be positive, got {qty}")
            if price <= 0:
                raise StrategyError(f"self.{label} price must be positive, got {price}")
            intents.append((float(qty), float(price)))
        return intents

    @staticmethod
    def _weighted_price(intents: Sequence[OrderIntent]) -> float | None:
        if not intents:
            return None
        total_qty = sum(q for q, _ in intents)
        return sum(q * p for q, p in intents) / total_qty if total_qty else None

    def _run_filters(self) -> bool:
        for check in self.filters():
            if not check():
                return False
        return True

    # --- the per-candle state machine ----------------------------------- #

    def _execute(self, index: int) -> Dict[str, Any]:
        """Run one candle. Returns a decision record used by the live evaluator."""

        self._index = index
        broker = self._require_broker()
        decision: Dict[str, Any] = {
            "entry_side": None,
            "conflict": False,
            "liquidate": False,
            "cancelled_entry": False,
            "filtered": False,
        }

        self.before()

        if self.position.is_close and not broker.active_entry_orders():
            should_long = bool(self.should_long())
            should_short = bool(self.should_short())
            if should_long and should_short:
                self._conflicts += 1
                decision["conflict"] = True
                self.log(
                    "should_long() and should_short() both returned True; ignoring both",
                    "warning",
                )
            elif should_long or should_short:
                self._reset_intents()
                if self._run_filters():
                    if should_long:
                        self.go_long()
                        self._validate_entry(sides.BUY)
                        decision["entry_side"] = "long"
                    else:
                        self.go_short()
                        self._validate_entry(sides.SELL)
                        decision["entry_side"] = "short"
                    self._submit_entry(sides.BUY if should_long else sides.SELL)
                else:
                    decision["filtered"] = True
        elif self.position.is_close:
            if self.should_cancel_entry():
                broker.cancel_entry_orders()
                self._reset_intents()
                self.on_cancel()
                decision["cancelled_entry"] = True
        else:
            self.update_position()
            if self._liquidate_requested:
                self._liquidate_requested = False
                decision["liquidate"] = True
                broker.cancel_exit_orders()
                self._submit_liquidation()
            else:
                self._sync_exit_orders()

        self.after()
        self._last_decision = decision
        return decision

    def _validate_entry(self, side: str) -> None:
        intent = self.buy if side == sides.BUY else self.sell
        if intent is None:
            hook = "go_long" if side == sides.BUY else "go_short"
            attr = "buy" if side == sides.BUY else "sell"
            raise StrategyError(f"{self.name}.{hook}() must set self.{attr}")
        self._normalize(intent, "buy" if side == sides.BUY else "sell")
        # Exits are validated now so a bad stop fails at decision time, not fill time.
        self._normalize(self.stop_loss, "stop_loss")
        self._normalize(self.take_profit, "take_profit")

    def _submit_entry(self, side: str) -> None:
        broker = self._require_broker()
        intents = self._normalize(self.buy if side == sides.BUY else self.sell, "entry")
        time_ms = float(self.current_candle[C.TIMESTAMP])
        hook = "go_long" if side == sides.BUY else "go_short"
        for qty, price in intents:
            try:
                order = broker.submit(
                    side,
                    qty,
                    price,
                    via.ENTRY,
                    current_price=self.price,
                    time_ms=time_ms,
                    reason=f"{self.name}: {hook}()",
                )
            except InsufficientMargin as exc:
                broker.rejected.append({"time": time_ms, "reason": str(exc), "hook": hook})
                self.log(f"entry rejected: {exc}", "warning")
                continue
            order.reason = f"{self.name}: {hook}() {order.type} @ {price:.4f}"
        # Market entries fill on this same close.
        for fill in broker.fill_market_orders(self.price, time_ms):
            self._on_fill(fill)

    def _submit_liquidation(self) -> None:
        broker = self._require_broker()
        qty = abs(self.position.qty)
        side = sides.SELL if self.position.is_long else sides.BUY
        time_ms = float(self.current_candle[C.TIMESTAMP])
        order = broker.submit(
            side, qty, self.price, via.LIQUIDATE, self.price, time_ms, reason="liquidate"
        )
        order.reason = f"{self.name}: liquidate()"
        for fill in broker.fill_market_orders(self.price, time_ms):
            self._on_fill(fill)

    def _exit_side(self) -> str:
        return sides.SELL if self.position.is_long else sides.BUY

    def _sync_exit_orders(self) -> None:
        """Re-submit stop-loss / take-profit orders when the strategy changed
        them (in ``update_position``), or submit them for the first time after
        an entry filled."""

        broker = self._require_broker()
        if self.position.is_close:
            return
        stop = self._normalize(self.stop_loss, "stop_loss")
        take = self._normalize(self.take_profit, "take_profit")
        time_ms = float(self.current_candle[C.TIMESTAMP])
        changed = False

        if stop != self._last_stop_loss or self._pending_exit_intents:
            broker.cancel_exit_orders(via.STOP_LOSS)
            for qty, price in stop:
                self._submit_exit(via.STOP_LOSS, qty, price, time_ms)
            self._last_stop_loss = stop
            changed = True
        if take != self._last_take_profit or self._pending_exit_intents:
            broker.cancel_exit_orders(via.TAKE_PROFIT)
            for qty, price in take:
                self._submit_exit(via.TAKE_PROFIT, qty, price, time_ms)
            self._last_take_profit = take
            changed = True
        self._pending_exit_intents = False

        if changed:
            # A stop already through its price becomes a market exit right now.
            for fill in broker.fill_market_orders(self.price, time_ms):
                self._on_fill(fill)

    def _submit_exit(self, kind: str, qty: float, price: float, time_ms: float) -> None:
        broker = self._require_broker()
        if self.position.is_close:
            return
        try:
            order = broker.submit(
                self._exit_side(), qty, price, kind, self.price, time_ms, reason=kind
            )
        except InsufficientMargin as exc:
            self.log(f"{kind} rejected: {exc}", "warning")
            return
        order.reason = f"{self.name}: {kind} {order.type} @ {price:.4f}"

    def _on_fill(self, fill: Fill) -> None:
        order = fill.order
        if fill.opened_position:
            self.increased_count = 0
            self.reduced_count = 0
            self.on_open_position(order)
            # Exit intents declared in go_long/go_short become live now.
            self._pending_exit_intents = True
            self._sync_exit_orders()
        elif fill.increased_position:
            self.increased_count += 1
            self.on_increased_position(order)
        elif fill.closed_position:
            if order.submitted_via == via.STOP_LOSS:
                self.on_stop_loss(order)
            elif order.submitted_via == via.TAKE_PROFIT:
                self.on_take_profit(order)
            self.on_close_position(order)
            self._reset_intents()
        elif fill.reduced_position:
            self.reduced_count += 1
            if order.submitted_via == via.STOP_LOSS:
                self.on_stop_loss(order)
            elif order.submitted_via == via.TAKE_PROFIT:
                self.on_take_profit(order)
            self.on_reduced_position(order)

    def _process_fills(self, fills: Sequence[Fill]) -> None:
        for fill in fills:
            self._on_fill(fill)


# --------------------------------------------------------------------------- #
# Hyperparameters
# --------------------------------------------------------------------------- #


def resolve_hyperparameters(
    spec: Sequence[Dict[str, Any]], overrides: Dict[str, Any] | None
) -> Dict[str, Any]:
    """Defaults from ``hyperparameters()`` merged with caller ``overrides``,
    type-coerced and range-checked. Unknown override names are rejected so a
    typo cannot silently run the defaults."""

    resolved: Dict[str, Any] = {}
    names = set()
    for item in spec:
        name = item.get("name")
        if not name:
            raise StrategyError(f"hyperparameter without a name: {item!r}")
        names.add(name)
        resolved[name] = item.get("default")

    for name, value in (overrides or {}).items():
        if name not in names:
            raise StrategyError(
                f"Unknown hyperparameter '{name}'. Declared: {sorted(names) or 'none'}"
            )
        item = next(i for i in spec if i.get("name") == name)
        kind = item.get("type", type(item.get("default")))
        try:
            if kind is bool:
                coerced = value if isinstance(value, bool) else str(value).lower() in ("1", "true")
            elif kind is int:
                coerced = int(value)
            elif kind is float:
                coerced = float(value)
            else:
                coerced = value
        except (TypeError, ValueError):
            raise StrategyError(f"hyperparameter '{name}' expects {kind.__name__}, got {value!r}")
        lo, hi = item.get("min"), item.get("max")
        if lo is not None and coerced < lo:
            raise StrategyError(f"hyperparameter '{name}' = {coerced} is below its min {lo}")
        if hi is not None and coerced > hi:
            raise StrategyError(f"hyperparameter '{name}' = {coerced} is above its max {hi}")
        resolved[name] = coerced
    return resolved


def describe_hyperparameters(spec: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """JSON-safe rendering of a ``hyperparameters()`` spec (``type`` as a name)."""

    out = []
    for item in spec:
        kind = item.get("type", type(item.get("default")))
        out.append(
            {
                "name": item.get("name"),
                "type": getattr(kind, "__name__", str(kind)),
                "min": item.get("min"),
                "max": item.get("max"),
                "default": item.get("default"),
            }
        )
    return out
