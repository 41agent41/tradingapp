"""Run a ``Strategy`` over historical candles.

    from jesse import backtest
    result = backtest.run(SMACrossover, candles, symbol="MSFT", timeframe="1hour")
    result.metrics["net_profit_percentage"], result.trades, result.equity_curve

The runner feeds candles one at a time: fills resting orders against the new
candle, lets the strategy react to the fills (hooks), then executes the
strategy's per-candle logic on the closed candle. The first ``warmup_candles``
are visible to indicators but never traded, which is what lets a strategy call
``ta.sma(self.candles, 200)`` on its first decision without a NaN guard.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Type, Union

import numpy as np
import pandas as pd

from . import candles as C
from . import metrics as stats
from . import timeframes as tf
from .broker import SimulatedBroker
from .models import ClosedTrade, Exchange, Position, StrategyError
from .strategy import CandleStore, Strategy, describe_hyperparameters

DEFAULT_WARMUP = 50


@dataclass
class BacktestResult:
    strategy_name: str
    symbol: str
    exchange: str
    timeframe: str
    starting_balance: float
    finishing_balance: float
    trades: List[ClosedTrade]
    equity_curve: pd.Series
    metrics: Dict[str, Any]
    hyperparameters: Dict[str, Any]
    candles_total: int
    warmup_candles: int
    orders: List[Dict[str, Any]] = field(default_factory=list)
    logs: List[Dict[str, Any]] = field(default_factory=list)
    rejected_orders: List[Dict[str, Any]] = field(default_factory=list)
    conflicts: int = 0

    @property
    def start_time(self) -> pd.Timestamp:
        return pd.Timestamp(self.equity_curve.index[0])

    @property
    def end_time(self) -> pd.Timestamp:
        return pd.Timestamp(self.equity_curve.index[-1])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "strategy": self.strategy_name,
            "symbol": self.symbol,
            "exchange": self.exchange,
            "timeframe": self.timeframe,
            "starting_balance": self.starting_balance,
            "finishing_balance": self.finishing_balance,
            "hyperparameters": self.hyperparameters,
            "candles_total": self.candles_total,
            "warmup_candles": self.warmup_candles,
            "metrics": self.metrics,
            "trades": [t.to_dict() for t in self.trades],
            "equity_curve": [
                {"time": int(pd.Timestamp(ts).timestamp()), "value": float(v)}
                for ts, v in self.equity_curve.items()
            ],
            "orders": self.orders,
            "logs": self.logs,
            "rejected_orders": self.rejected_orders,
            "conflicts": self.conflicts,
        }


def _instantiate(strategy: Union[Strategy, Type[Strategy]]) -> Strategy:
    if isinstance(strategy, Strategy):
        return strategy
    if isinstance(strategy, type) and issubclass(strategy, Strategy):
        return strategy()
    raise StrategyError(f"{strategy!r} is not a jesse Strategy class or instance")


def run(
    strategy: Union[Strategy, Type[Strategy]],
    candles: Union[np.ndarray, pd.DataFrame],
    *,
    symbol: str,
    timeframe: str,
    exchange: str = "Interactive Brokers",
    starting_balance: float = 100_000.0,
    fee_rate: float = 0.001,
    leverage: int = 1,
    hyperparameters: Dict[str, Any] | None = None,
    warmup_candles: int | None = None,
    mode: str = "backtest",
) -> BacktestResult:
    """Backtest ``strategy`` on ``candles`` (Jesse array or OHLCV frame)."""

    arr = candles if isinstance(candles, np.ndarray) else C.from_dataframe(candles)
    C.validate(arr)
    n = len(arr)
    canonical_tf = tf.normalize(timeframe)

    if warmup_candles is None:
        warmup_candles = min(DEFAULT_WARMUP, max(0, n - 1))
    if warmup_candles < 0 or warmup_candles >= n:
        raise StrategyError(
            f"warmup_candles must be in [0, {n - 1}] for {n} candles, got {warmup_candles}"
        )

    strat = _instantiate(strategy)
    wallet = Exchange(exchange, starting_balance, fee_rate=fee_rate, leverage=leverage)
    position = Position(symbol=symbol, exchange=wallet, strategy_name=strat.name)
    store = CandleStore(arr, canonical_tf)
    broker = SimulatedBroker(wallet, position, symbol, tf.to_app(canonical_tf), strat.name)
    strat._bind(store, broker, position, symbol, exchange, hyperparameters, mode=mode)

    equity: List[float] = []
    for i in range(warmup_candles, n):
        store.index = i
        candle = arr[i]
        fills = broker.on_candle(candle)
        strat._process_fills(fills)
        strat._execute(i - warmup_candles)
        position.current_price = float(candle[C.CLOSE])
        equity.append(broker.portfolio_value())

    strat.terminate()

    # An open position at the end is marked at the last close so the reported
    # balance is what liquidating would have returned (Jesse does the same).
    open_pnl = position.pnl
    finishing_balance = wallet.balance + open_pnl
    index = pd.to_datetime(arr[warmup_candles:, C.TIMESTAMP], unit="ms")
    equity_curve = pd.Series(equity, index=index, dtype="float64")

    metrics = stats.compute(
        broker.trades,
        equity_curve,
        starting_balance=starting_balance,
        finishing_balance=finishing_balance,
        open_position_pnl=open_pnl,
        total_fees=wallet.total_fees,
    )
    metrics["conflicts"] = strat._conflicts
    metrics["rejected_orders"] = len(broker.rejected)

    return BacktestResult(
        strategy_name=strat.name,
        symbol=symbol,
        exchange=exchange,
        timeframe=tf.to_app(canonical_tf),
        starting_balance=starting_balance,
        finishing_balance=finishing_balance,
        trades=list(broker.trades),
        equity_curve=equity_curve,
        metrics=metrics,
        hyperparameters=dict(strat.hp),
        candles_total=n,
        warmup_candles=warmup_candles,
        orders=[o.to_dict() for o in broker.orders],
        logs=list(strat.logs),
        rejected_orders=list(broker.rejected),
        conflicts=strat._conflicts,
    )


def describe(strategy_cls: Type[Strategy]) -> Dict[str, Any]:
    """Catalogue entry for a strategy class."""

    instance = strategy_cls()
    return {
        "class_name": strategy_cls.__name__,
        "name": instance.name,
        "description": (strategy_cls.__doc__ or "").strip() or "No description available",
        "hyperparameters": describe_hyperparameters(instance.hyperparameters()),
        "module": strategy_cls.__module__,
    }
