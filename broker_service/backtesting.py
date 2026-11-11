"""
Backtesting Module for TradingApp
==================================

Provides backtesting capabilities for technical analysis strategies.
Integrates with the indicators module to test trading strategies on historical data.

Author: TradingApp Development Team
Version: 1.0.0
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd

from indicators import calculator as indicator_calculator
from sizing import resolve_backtest_quantity, round_to_step
from stops import StopSpecError, is_more_protective, resolve_stop

logger = logging.getLogger(__name__)


class OrderType(Enum):
    BUY = "BUY"
    SELL = "SELL"


class OrderStatus(Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"


@dataclass
class Trade:
    """Represents a single trade"""

    entry_time: datetime
    exit_time: datetime | None
    entry_price: float
    exit_price: float | None
    # A float, not an int: venue-native sizing means a quantity can be 0.07
    # lots on MT5 or 1500.5 units on OANDA. Whole-share venues still produce
    # whole numbers.
    quantity: float
    order_type: OrderType
    status: OrderStatus
    entry_reason: str
    exit_reason: str | None = None

    @property
    def pnl(self) -> float:
        """Calculate profit/loss for the trade"""
        if self.exit_price is None:
            return 0.0

        if self.order_type == OrderType.BUY:
            return (self.exit_price - self.entry_price) * self.quantity
        else:  # SELL
            return (self.entry_price - self.exit_price) * self.quantity

    @property
    def pnl_percent(self) -> float:
        """Calculate profit/loss percentage"""
        if self.exit_price is None:
            return 0.0

        if self.order_type == OrderType.BUY:
            return ((self.exit_price - self.entry_price) / self.entry_price) * 100
        else:  # SELL
            return ((self.entry_price - self.exit_price) / self.entry_price) * 100

    @property
    def duration(self) -> timedelta | None:
        """Calculate trade duration"""
        if self.exit_time is None:
            return None
        return self.exit_time - self.entry_time


@dataclass
class BacktestResults:
    """Results from a backtest run"""

    symbol: str
    start_date: datetime
    end_date: datetime
    initial_capital: float
    final_capital: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    total_return: float
    total_return_percent: float
    max_drawdown: float
    sharpe_ratio: float
    win_rate: float
    average_win: float
    average_loss: float
    profit_factor: float
    trades: List[Trade]
    equity_curve: pd.Series
    # Engine-specific extras (the Jesse runner reports its full statistics
    # block here). Empty for the built-in engine, so its payload is unchanged.
    metrics: Dict[str, Any] = field(default_factory=dict)
    # How fills were simulated: whether a protective stop was in force, what it
    # was checked against, and how often it closed a trade. Empty when the
    # strategy declares no stop, so its payload is unchanged.
    fills: Dict[str, Any] = field(default_factory=dict)
    # What the spread cost: set when the bars carried the broker's bid-to-ask
    # spread, so entries and exits filled at the ask or the bid, not the mid.
    spread: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert results to dictionary for JSON serialization"""

        # Starlette's JSONResponse encodes with allow_nan=False, so any inf/NaN
        # (e.g. profit_factor when there are no losing trades) would raise on
        # serialization. Coerce non-finite floats to None instead.
        def _finite(value: float) -> float | None:
            return value if np.isfinite(value) else None

        return {
            "symbol": self.symbol,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "initial_capital": self.initial_capital,
            "final_capital": self.final_capital,
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "total_return": _finite(self.total_return),
            "total_return_percent": _finite(self.total_return_percent),
            "max_drawdown": _finite(self.max_drawdown),
            "sharpe_ratio": _finite(self.sharpe_ratio),
            "win_rate": _finite(self.win_rate),
            "average_win": _finite(self.average_win),
            "average_loss": _finite(self.average_loss),
            "profit_factor": _finite(self.profit_factor),
            "equity_curve": [
                {"time": int(pd.Timestamp(ts).timestamp()), "value": float(value)}
                for ts, value in self.equity_curve.items()
            ],
            "trades_summary": [
                {
                    "entry_time": trade.entry_time.isoformat(),
                    "exit_time": trade.exit_time.isoformat() if trade.exit_time else None,
                    "entry_price": trade.entry_price,
                    "exit_price": trade.exit_price,
                    "quantity": trade.quantity,
                    "order_type": trade.order_type.value,
                    "pnl": trade.pnl,
                    "pnl_percent": trade.pnl_percent,
                    "duration_hours": (
                        trade.duration.total_seconds() / 3600 if trade.duration else None
                    ),
                    "entry_reason": trade.entry_reason,
                    "exit_reason": trade.exit_reason,
                }
                for trade in self.trades
            ],
            **({"metrics": _json_safe(self.metrics)} if self.metrics else {}),
            **({"fills": _json_safe(self.fills)} if self.fills else {}),
            **({"spread": _json_safe(self.spread)} if self.spread else {}),
        }


def _json_safe(value: Any) -> Any:
    """Recursively coerce numpy scalars and non-finite floats for JSONResponse."""

    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (np.floating, np.integer)):
        value = value.item()
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


class TradingStrategy:
    """Base class for trading strategies"""

    def __init__(self, name: str, indicators: List[str] = None):
        self.name = name
        self.indicators = indicators or []
        self.position = 0  # Current position size
        self.trades: List[Trade] = []
        self.pending_orders: List[Trade] = []

    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Override this method to define buy conditions"""
        return False, "No buy signal"

    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Override this method to define sell conditions"""
        return False, "No sell signal"

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """Generate buy/sell signals for the entire dataset"""
        signals = df.copy()
        signals["buy_signal"] = False
        signals["sell_signal"] = False
        signals["buy_reason"] = ""
        signals["sell_reason"] = ""

        for i in range(len(df)):
            current_data = df.iloc[i]

            buy_signal, buy_reason = self.should_buy(current_data)
            sell_signal, sell_reason = self.should_sell(current_data)

            signals.iloc[i, signals.columns.get_loc("buy_signal")] = buy_signal
            signals.iloc[i, signals.columns.get_loc("sell_signal")] = sell_signal
            signals.iloc[i, signals.columns.get_loc("buy_reason")] = (
                buy_reason if buy_signal else ""
            )
            signals.iloc[i, signals.columns.get_loc("sell_reason")] = (
                sell_reason if sell_signal else ""
            )

        return signals


class SimpleMAStrategy(TradingStrategy):
    """Simple Moving Average Crossover Strategy"""

    def __init__(self, fast_period: int = 20, slow_period: int = 50):
        super().__init__(
            name=f"MA Crossover ({fast_period}/{slow_period})", indicators=["sma_20", "sma_50"]
        )
        self.fast_period = fast_period
        self.slow_period = slow_period

    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Buy when fast MA crosses above slow MA"""
        if pd.isna(data.get("sma_20")) or pd.isna(data.get("sma_50")):
            return False, "Insufficient MA data"

        # Check if fast MA just crossed above slow MA
        fast_ma = data["sma_20"]
        slow_ma = data["sma_50"]

        if fast_ma > slow_ma and self.position <= 0:
            return True, f"MA Crossover: Fast MA ({fast_ma:.2f}) > Slow MA ({slow_ma:.2f})"

        return False, "No MA crossover signal"

    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Sell when fast MA crosses below slow MA"""
        if pd.isna(data.get("sma_20")) or pd.isna(data.get("sma_50")):
            return False, "Insufficient MA data"

        # Check if fast MA just crossed below slow MA
        fast_ma = data["sma_20"]
        slow_ma = data["sma_50"]

        if fast_ma < slow_ma and self.position > 0:
            return True, f"MA Cross Down: Fast MA ({fast_ma:.2f}) < Slow MA ({slow_ma:.2f})"

        return False, "No MA sell signal"


class RSIStrategy(TradingStrategy):
    """RSI Mean Reversion Strategy"""

    def __init__(self, oversold_level: float = 30, overbought_level: float = 70):
        super().__init__(
            name=f"RSI Strategy ({oversold_level}/{overbought_level})", indicators=["rsi"]
        )
        self.oversold_level = oversold_level
        self.overbought_level = overbought_level

    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Buy when RSI is oversold"""
        if pd.isna(data.get("rsi")):
            return False, "No RSI data"

        rsi = data["rsi"]

        if rsi < self.oversold_level and self.position <= 0:
            return True, f"RSI Oversold: {rsi:.2f} < {self.oversold_level}"

        return False, "RSI not oversold"

    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Sell when RSI is overbought"""
        if pd.isna(data.get("rsi")):
            return False, "No RSI data"

        rsi = data["rsi"]

        if rsi > self.overbought_level and self.position > 0:
            return True, f"RSI Overbought: {rsi:.2f} > {self.overbought_level}"

        return False, "RSI not overbought"


class _MinutePath:
    """The 1-minute bars inside each bar of a backtest, for filling a stop.

    A bar's minutes are those from its own time up to the next bar's. Bars
    with no minutes (none were stored for that stretch) fall back to their own
    open, high and low.
    """

    def __init__(self, index: pd.Index, minute_bars: pd.DataFrame | None):
        self.count = 0
        self.bars_with_minutes = 0
        self._starts = self._ends = None
        if minute_bars is None or len(minute_bars) == 0:
            return
        bar_times = pd.DatetimeIndex(index).asi8
        self._times = pd.DatetimeIndex(minute_bars.index)
        minute_times = self._times.asi8
        self._open = minute_bars["open"].to_numpy(dtype=float)
        self._high = minute_bars["high"].to_numpy(dtype=float)
        self._low = minute_bars["low"].to_numpy(dtype=float)
        self._starts = np.searchsorted(minute_times, bar_times, side="left")
        self._ends = np.append(self._starts[1:], len(minute_times))
        self.count = int(len(minute_times) - self._starts[0]) if len(bar_times) else 0
        self.bars_with_minutes = int(np.count_nonzero(self._ends > self._starts))

    def stop_fill(
        self, i: int, bar: pd.Series, stop: float, going_long: bool, half_spread: float = 0.0
    ) -> Tuple[float, datetime, bool] | None:
        """Where and when a resting stop fills inside bar ``i``, if it does.

        Returns ``(price, time, on_minutes)``. The price is the stop, or the
        open of the minute (or bar) that started beyond it: a stop becomes a
        market order when touched, so a gap fills at the worse price.

        The bars are mid prices. With ``half_spread``, a long's stop is hit
        when the bid (mid less half the spread) reaches it and a short's when
        the ask does, and a gap fills at the open's bid or ask.
        """

        # The mid price at which the bid (long) or ask (short) is at the stop.
        level = stop + half_spread if going_long else stop - half_spread

        if self._starts is not None and self._ends[i] > self._starts[i]:
            lo, hi = int(self._starts[i]), int(self._ends[i])
            reached = self._low[lo:hi] <= level if going_long else self._high[lo:hi] >= level
            if reached.any():
                k = lo + int(np.argmax(reached))
                opened = float(self._open[k])
                price = (
                    min(opened - half_spread, stop)
                    if going_long
                    else max(opened + half_spread, stop)
                )
                return price, self._times[k].to_pydatetime(), True

        # No minute reached it. The bar's own range still can: minutes can be
        # missing inside a bar, and the bar is the broker's record of it.
        reached = bar["low"] <= level if going_long else bar["high"] >= level
        if not reached:
            return None
        opened = float(bar["open"])
        price = min(opened - half_spread, stop) if going_long else max(opened + half_spread, stop)
        when = bar.name if isinstance(bar.name, datetime) else datetime.fromtimestamp(bar.name)
        return price, when, False


class BacktestEngine:
    """Main backtesting engine"""

    def __init__(self, initial_capital: float = 100000, commission: float = 0.001):
        self.initial_capital = initial_capital
        self.commission = commission  # Commission as percentage of trade value

    def run_backtest(
        self,
        df: pd.DataFrame,
        strategy: TradingStrategy,
        symbol: str = "UNKNOWN",
        spec: Dict[str, Any] | None = None,
        minute_bars: pd.DataFrame | None = None,
    ) -> BacktestResults:
        """Run backtest on historical data.

        A strategy that declares a protective ``stop`` has it simulated the way
        the live runner works it: resolved at entry, held at that price while
        the next bar forms, tightened (never loosened) at each bar close, and
        filled inside the bar when price reaches it. ``minute_bars`` are
        1-minute bars over the same range; with them a stop fills on the minute
        it was reached, at the stop or at that minute's open when price gapped
        through. Without them the bar's own range decides.

        ``spec`` is the venue's :class:`models.InstrumentSpec` for the symbol,
        which is what lets a `sizing` block mean the same thing here as it does
        live — "100" is 100 shares on IB but 100 *lots* on MT5. Omitted, sizing
        resolves in whole shares, the behaviour every equity backtest has
        always had.
        """

        logger.info(f"Starting backtest for {strategy.name} on {symbol}")

        # The broker's spread on each bar, when the bars carry it (E-15). It
        # is taken off the frame so rules and indicators see prices only.
        spread_column = df["spread"] if "spread" in df.columns else None
        if spread_column is not None:
            df = df.drop(columns=["spread"])

        # A strategy that brings its own simulation (the Jesse adapter, whose
        # order semantics — resting limit/stop entries, bracket exits, partial
        # take-profits — this bar-close engine cannot express) runs itself and
        # returns the same ``BacktestResults`` shape.
        own_runner = getattr(strategy, "run_backtest", None)
        if callable(own_runner):
            return own_runner(
                df,
                symbol=symbol,
                initial_capital=self.initial_capital,
                commission=self.commission,
                spec=spec,
            )

        # Calculate indicators if not present
        df_with_indicators = indicator_calculator.calculate_indicators(df, strategy.indicators)

        # Position-aware strategies (rule-sets referencing position.size /
        # position.avg_price / position.unrealized_pct — e.g. a -2% stop or a
        # pyramiding cap) must see the *running* position, so their signals are
        # evaluated bar-by-bar inside the loop below against the open trade.
        # Evaluating them in a single up-front pass would silently read a flat
        # position on every bar, so those rules could never fire and a backtest
        # would disagree with the live runner. A strategy without the stateful
        # hooks keeps the original one-shot `generate_signals` pass.
        evaluate_bar = getattr(strategy, "evaluate_bar", None)
        prepare_stateful = getattr(strategy, "prepare_stateful", None)
        stateful = callable(evaluate_bar) and callable(prepare_stateful)

        if stateful:
            signals, in_session = prepare_stateful(df_with_indicators)
        else:
            signals = strategy.generate_signals(df_with_indicators)
            in_session = None

        # A definition's `sizing` block and `scale_out` rungs used to be inert
        # here — the engine was all-in / all-out, so a strategy sized at 100
        # shares backtested as though it bought the whole account, and a
        # "take half off at +3%" rung never reduced anything. A backtest could
        # therefore disagree with the live run of the *same definition* even
        # when every signal matched. Both are now simulated: the size comes
        # from the sizing block (falling back to the historical all-in
        # behaviour when a strategy declares none, which is what the built-in
        # strategies do), and rungs fire per bar against the open trade.
        sizing_spec = getattr(strategy, "sizing", None)
        # The venue's size increment, used both to size an entry and to round a
        # partial exit. Defaults to whole units when no spec is supplied.
        size_step = float((spec or {}).get("size_step") or 1.0) or 1.0
        evaluate_scale_out = getattr(strategy, "evaluate_scale_out", None)
        scale_out_enabled = callable(evaluate_scale_out) and bool(
            getattr(strategy, "scale_out", None)
        )

        # Initialize tracking variables
        capital = self.initial_capital
        position = 0
        trades: List[Trade] = []
        equity_curve = []
        open_trade: Trade | None = None
        # Rungs already taken on the currently-open trade. Cleared on every new
        # entry so a rung fires at most once per trade rather than on every
        # subsequent bar that stays past its threshold.
        fired_rungs: set[int] = set()

        # The protective stop (E-03). Live, the entry goes out with the stop
        # the rules resolve and the broker holds it, so it fills inside a bar,
        # not at its close. `stop_price` is the stop in force on the open
        # trade; it only exists for a strategy that declares a `stop` block.
        stop_spec = getattr(strategy, "stop", None)
        stop_price: float | None = None
        minutes = _MinutePath(signals.index, minute_bars) if stop_spec else None
        stop_exits = 0
        stop_exits_on_minutes = 0
        entries_refused = 0

        # Bars are mid prices. Where a bar has a spread, a buy fills half of
        # it above the mid (the ask) and a sell half below (the bid). A bar
        # without one fills at the mid, as every bar did before.
        half_spreads = np.zeros(len(signals))
        bars_with_spread = 0
        if spread_column is not None:
            aligned = pd.to_numeric(spread_column.reindex(signals.index), errors="coerce")
            values = aligned.to_numpy(dtype=float)
            known = np.isfinite(values) & (values > 0)
            half_spreads = np.where(known, values, 0.0) / 2
            bars_with_spread = int(np.count_nonzero(known))
        spread_cost = 0.0
        spread_fills = 0

        # Process each bar
        for i, (timestamp, data) in enumerate(signals.iterrows()):
            current_price = data["close"]
            current_time = (
                timestamp if isinstance(timestamp, datetime) else datetime.fromtimestamp(timestamp)
            )
            half = float(half_spreads[i])
            # What a buy and a sell fill at on this bar's close.
            ask_price = current_price + half
            bid_price = current_price - half

            # The stop was resting at the broker while this bar formed, so it
            # is checked before anything the bar's close decides. A trade it
            # closes is gone by the close: the rules then see a flat position.
            if open_trade and stop_price is not None:
                going_long = open_trade.order_type == OrderType.BUY
                fill = minutes.stop_fill(i, data, stop_price, going_long, half)
                if fill is not None:
                    fill_price, fill_time, on_minutes = fill
                    open_trade.exit_time = fill_time
                    open_trade.exit_price = fill_price
                    open_trade.status = OrderStatus.FILLED
                    gapped = fill_price != stop_price
                    open_trade.exit_reason = (
                        f"Stop {stop_price:.5f} gapped through, filled at the open"
                        if gapped
                        else f"Stop hit at {stop_price:.5f}"
                    )
                    capital += (
                        open_trade.pnl - abs(open_trade.quantity * fill_price) * self.commission
                    )
                    spread_cost += half * open_trade.quantity
                    spread_fills += 1 if half else 0
                    position = 0
                    strategy.position = position
                    trades.append(open_trade)
                    open_trade = None
                    stop_price = None
                    stop_exits += 1
                    stop_exits_on_minutes += 1 if on_minutes else 0

            if stateful:
                decision = evaluate_bar(
                    signals,
                    i,
                    in_session,
                    float(position),
                    float(open_trade.entry_price) if open_trade else 0.0,
                )
                buy_signal = decision["buy"]
                sell_signal = decision["sell"]
                short_signal = decision.get("short", False)
                buy_reason = decision["buy_reason"]
                sell_reason = decision["sell_reason"]
                short_reason = decision.get("short_reason", "")
            else:
                buy_signal = data["buy_signal"]
                sell_signal = data["sell_signal"]
                buy_reason = data["buy_reason"]
                sell_reason = data["sell_reason"]
                # Batch-pass strategies (the built-in long-only ones) never
                # emit a short side.
                short_signal = False
                short_reason = ""

            # Check for exit signals first
            if open_trade and sell_signal:
                # Close position: a long sells at the bid, a short buys back
                # at the ask.
                exit_price = ask_price if open_trade.order_type == OrderType.SELL else bid_price
                open_trade.exit_time = current_time
                open_trade.exit_price = exit_price
                open_trade.status = OrderStatus.FILLED
                open_trade.exit_reason = sell_reason
                spread_cost += half * open_trade.quantity
                spread_fills += 1 if half else 0

                # Calculate commission
                trade_value = abs(open_trade.quantity * exit_price)
                commission_cost = trade_value * self.commission

                # Update capital
                capital += open_trade.pnl - commission_cost
                position = 0
                strategy.position = position
                trades.append(open_trade)
                open_trade = None

                logger.debug(f"Closed position at {current_price:.2f}, PnL: {trades[-1].pnl:.2f}")

            # Partial exits. Checked *after* the full exit — if both fire on the
            # same bar the exit wins and there is nothing left to scale out of.
            if open_trade and scale_out_enabled:
                for rung in evaluate_scale_out(
                    signals, i, float(position), float(open_trade.entry_price)
                ):
                    if rung["index"] in fired_rungs:
                        continue
                    fired_rungs.add(rung["index"])
                    # Reduce onto the venue's own size step, so a partial exit
                    # is an order the venue would actually accept rather than
                    # an arbitrary fraction of the position.
                    slice_qty = round_to_step(
                        open_trade.quantity * rung["reduce_pct"] / 100, size_step
                    )
                    if slice_qty <= 0:
                        continue
                    remaining = round_to_step(open_trade.quantity - slice_qty, size_step)
                    slice_price = (
                        ask_price if open_trade.order_type == OrderType.SELL else bid_price
                    )
                    spread_cost += half * slice_qty
                    spread_fills += 1 if half else 0
                    closed = Trade(
                        entry_time=open_trade.entry_time,
                        exit_time=current_time,
                        entry_price=open_trade.entry_price,
                        exit_price=slice_price,
                        quantity=slice_qty,
                        order_type=open_trade.order_type,
                        status=OrderStatus.FILLED,
                        entry_reason=open_trade.entry_reason,
                        exit_reason=rung["reason"],
                    )
                    capital += closed.pnl - abs(slice_qty * slice_price) * self.commission
                    trades.append(closed)

                    if remaining <= 0:
                        # The rung took the whole position — the trade is done.
                        open_trade = None
                        position = 0
                        strategy.position = position
                        break
                    open_trade.quantity = remaining
                    # `open_trade.quantity` is a magnitude; `position` is
                    # signed. Dropping the sign here would make a partially
                    # scaled-out short read as long to every position-aware
                    # rule on the next bar.
                    position = -remaining if open_trade.order_type == OrderType.SELL else remaining
                    strategy.position = position
                    logger.debug(
                        f"Scaled out {slice_qty} at {current_price:.2f}, {remaining} remaining"
                    )

            entered_this_bar = False
            # Check for entry signals. Long and short are mutually exclusive
            # here because `evaluate` refuses a bar where both fire, and E12
            # defers direct reversal — a position is always closed before the
            # opposite side is considered.
            if not open_trade and (buy_signal or short_signal):
                going_short = short_signal and not buy_signal
                # Size the entry from the strategy's `sizing` block; a strategy
                # without one keeps the original "use all available capital"
                # behaviour so the built-in strategies backtest unchanged.
                # The stop comes first: `risk_pct` sizes from the distance to
                # it, and an entry whose declared stop cannot be resolved is
                # refused, as it is live, rather than opened unprotected.
                entry_stop: float | None = None
                stop_failed = False
                if stop_spec:
                    try:
                        entry_stop = resolve_stop(
                            stop_spec,
                            signals.iloc[: i + 1],
                            direction="short" if going_short else "long",
                            reference_price=float(current_price),
                        )
                    except StopSpecError as exc:
                        stop_failed = True
                        entries_refused += 1
                        logger.debug(f"Entry refused: stop rule failed to resolve: {exc}")

                # A long buys at the ask, a short sells at the bid.
                entry_price = bid_price if going_short else ask_price
                sized, sizing_reason = resolve_backtest_quantity(
                    sizing_spec, entry_price, capital, spec, stop_price=entry_stop
                )
                if stop_failed:
                    quantity = 0.0
                elif sized is None:
                    quantity = float(int(capital / entry_price))
                else:
                    quantity = sized
                    if quantity <= 0:
                        logger.debug(f"Entry skipped: {sizing_reason}")

                if quantity > 0:
                    # Open position. `Trade.pnl` already computes the SELL side
                    # as (entry - exit) * quantity, so a short needs only the
                    # right order_type and a **negative** position: every
                    # position-aware rule (a -2% stop, a pyramiding cap) reads
                    # `position.size`, and an unsigned short would read as long.
                    trade_value = quantity * entry_price
                    commission_cost = trade_value * self.commission
                    spread_cost += half * quantity
                    spread_fills += 1 if half else 0

                    open_trade = Trade(
                        entry_time=current_time,
                        exit_time=None,
                        entry_price=entry_price,
                        exit_price=None,
                        quantity=quantity,
                        order_type=OrderType.SELL if going_short else OrderType.BUY,
                        status=OrderStatus.FILLED,
                        entry_reason=short_reason if going_short else buy_reason,
                    )

                    capital -= commission_cost
                    position = -quantity if going_short else quantity
                    strategy.position = position
                    fired_rungs.clear()
                    stop_price = entry_stop
                    entered_this_bar = True

                    logger.debug(f"Opened position at {current_price:.2f}, Quantity: {quantity}")

            # Trail the stop to what the rules want at this close. Only ever
            # tighter: live, the broker holds the stop and the app moves it
            # only when the new one protects more. A stop that cannot be
            # resolved on this bar leaves the one in force.
            if open_trade and stop_spec and not entered_this_bar:
                side = "short" if open_trade.order_type == OrderType.SELL else "long"
                try:
                    desired = resolve_stop(
                        stop_spec,
                        signals.iloc[: i + 1],
                        direction=side,
                        reference_price=float(current_price),
                    )
                except StopSpecError:
                    desired = None
                if desired is not None and is_more_protective(desired, stop_price, side):
                    stop_price = desired
            if not open_trade:
                stop_price = None

            # Calculate current equity
            current_equity = capital
            if open_trade:
                # Direction-aware: a short gains as price falls. Using the long
                # formula would draw an equity curve that moves the wrong way
                # for every short trade.
                direction = -1.0 if open_trade.order_type == OrderType.SELL else 1.0
                unrealized_pnl = (
                    (current_price - open_trade.entry_price) * open_trade.quantity * direction
                )
                current_equity += unrealized_pnl

            equity_curve.append(current_equity)

        # Close any remaining open position
        if open_trade:
            last_half = float(half_spreads[-1]) if len(half_spreads) else 0.0
            final_price = signals.iloc[-1]["close"] + (
                last_half if open_trade.order_type == OrderType.SELL else -last_half
            )
            spread_cost += last_half * open_trade.quantity
            spread_fills += 1 if last_half else 0
            open_trade.exit_time = (
                signals.index[-1]
                if isinstance(signals.index[-1], datetime)
                else datetime.fromtimestamp(signals.index[-1])
            )
            open_trade.exit_price = final_price
            open_trade.status = OrderStatus.FILLED
            open_trade.exit_reason = "End of backtest"

            trade_value = abs(open_trade.quantity * final_price)
            commission_cost = trade_value * self.commission
            capital += open_trade.pnl - commission_cost
            trades.append(open_trade)

        # Calculate performance metrics
        results = self._calculate_performance_metrics(
            symbol=symbol,
            start_date=(
                signals.index[0]
                if isinstance(signals.index[0], datetime)
                else datetime.fromtimestamp(signals.index[0])
            ),
            end_date=(
                signals.index[-1]
                if isinstance(signals.index[-1], datetime)
                else datetime.fromtimestamp(signals.index[-1])
            ),
            initial_capital=self.initial_capital,
            final_capital=capital,
            trades=trades,
            equity_curve=pd.Series(equity_curve, index=signals.index),
        )

        if stop_spec:
            results.fills = {
                "stop": True,
                # What a stop was checked against: the 1-minute bars inside
                # each bar where there were any, otherwise the bar's own range.
                "model": "1min" if minutes.bars_with_minutes else "bar",
                "bars": len(signals),
                "bars_with_minutes": minutes.bars_with_minutes,
                "minute_bars": minutes.count,
                "stop_exits": stop_exits,
                "stop_exits_on_minutes": stop_exits_on_minutes,
                "entries_refused": entries_refused,
            }

        if spread_column is not None and bars_with_spread:
            results.spread = {
                "applied": True,
                "bars": len(signals),
                "bars_with_spread": bars_with_spread,
                # Fills that paid half a spread, and what that came to in all.
                "fills": spread_fills,
                "cost": round(spread_cost, 6),
                "average": round(float(half_spreads[half_spreads > 0].mean() * 2), 8),
            }

        logger.info(
            f"Backtest completed: {len(trades)} trades, {results.total_return_percent:.2f}% return"
        )

        return results

    def _calculate_performance_metrics(
        self,
        symbol: str,
        start_date: datetime,
        end_date: datetime,
        initial_capital: float,
        final_capital: float,
        trades: List[Trade],
        equity_curve: pd.Series,
    ) -> BacktestResults:
        """Calculate performance metrics from trades"""

        total_return = final_capital - initial_capital
        total_return_percent = (total_return / initial_capital) * 100

        # Trade statistics
        total_trades = len(trades)
        winning_trades = len([t for t in trades if t.pnl > 0])
        losing_trades = len([t for t in trades if t.pnl < 0])

        win_rate = (winning_trades / total_trades * 100) if total_trades > 0 else 0

        # Average win/loss
        wins = [t.pnl for t in trades if t.pnl > 0]
        losses = [abs(t.pnl) for t in trades if t.pnl < 0]

        average_win = np.mean(wins) if wins else 0
        average_loss = np.mean(losses) if losses else 0

        # Profit factor
        total_wins = sum(wins) if wins else 0
        total_losses = sum(losses) if losses else 0
        profit_factor = (total_wins / total_losses) if total_losses > 0 else float("inf")

        # Maximum drawdown
        running_max = equity_curve.expanding().max()
        drawdown = (equity_curve - running_max) / running_max * 100
        max_drawdown = drawdown.min()

        # Sharpe ratio (simplified - assuming daily returns)
        returns = equity_curve.pct_change().dropna()
        sharpe_ratio = (returns.mean() / returns.std() * np.sqrt(252)) if returns.std() > 0 else 0

        return BacktestResults(
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            initial_capital=initial_capital,
            final_capital=final_capital,
            total_trades=total_trades,
            winning_trades=winning_trades,
            losing_trades=losing_trades,
            total_return=total_return,
            total_return_percent=total_return_percent,
            max_drawdown=max_drawdown,
            sharpe_ratio=sharpe_ratio,
            win_rate=win_rate,
            average_win=average_win,
            average_loss=average_loss,
            profit_factor=profit_factor,
            trades=trades,
            equity_curve=equity_curve,
        )


# Global backtesting engine instance
backtest_engine = BacktestEngine()

# Available strategies
AVAILABLE_STRATEGIES = {"ma_crossover": SimpleMAStrategy, "rsi_mean_reversion": RSIStrategy}

# Rule-driven strategies (Systematic Trading roadmap — Phase 1 / A1) register
# themselves into ``AVAILABLE_STRATEGIES`` on import. This is deferred to the
# bottom of the module (module-form import) so ``rule_strategy`` can import
# ``TradingStrategy`` from here without a circular-import failure. The Jesse
# framework's strategies (``jesse_strategies/``) register the same way, as
# ``jesse_<name>`` keys, through the adapter (``jesse/adapter.py``) that gives
# them this engine's ``TradingStrategy`` interface.
import jesse.adapter  # noqa: E402,F401  (imported for its registration side effect)
import rule_strategy  # noqa: E402,F401  (imported for its registration side effect)
