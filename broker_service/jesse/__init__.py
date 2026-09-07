"""Jesse algorithmic-trading framework, embedded in the TradingApp broker service.

This is a self-contained port of the authoring model of `Jesse <https://jesse.trade>`_
— the ``Strategy`` class with ``should_long`` / ``go_long`` / ``update_position``
hooks, ``jesse.indicators`` (``ta``), ``jesse.utils`` sizing helpers, a candle-by-
candle backtester with Jesse's order semantics and metrics — wired to the data
and execution this service already has (IB Gateway and the other broker
adapters, TimescaleDB history, the backend's live strategy runner). It does
**not** depend on the ``jesse`` PyPI package: that ships as a standalone app
with its own Postgres/Redis/TA-Lib/numba stack and crypto-exchange drivers,
none of which fit a service that must run remotely against IB.

Quick start::

    from jesse.strategies import Strategy
    import jesse.indicators as ta
    from jesse import utils

    class MyStrategy(Strategy):
        def should_long(self):
            return ta.rsi(self.candles) < 30
        def go_long(self):
            qty = utils.size_to_qty(self.balance * 0.1, self.price)
            self.buy = qty, self.price
            self.stop_loss = qty, self.price * 0.98
            self.take_profit = qty, self.price * 1.04

    from jesse import backtest
    result = backtest.run(MyStrategy, candles_df, symbol="MSFT", timeframe="1hour")

Drop the class into ``broker_service/jesse_strategies/`` and it appears in the
``/backtest`` picker as ``jesse_my_strategy`` and can be deployed live with a
definition ``{"engine": "jesse", "strategy": "MyStrategy"}``.
"""

from __future__ import annotations

from . import backtest, candles, enums, helpers, indicators, live, registry, timeframes, utils
from .backtest import BacktestResult
from .enums import timeframes as TIMEFRAMES
from .models import ClosedTrade, Exchange, InsufficientMargin, Order, Position, StrategyError
from .strategy import Strategy

__version__ = "1.0.0"

__all__ = [
    "BacktestResult",
    "ClosedTrade",
    "Exchange",
    "InsufficientMargin",
    "Order",
    "Position",
    "Strategy",
    "StrategyError",
    "TIMEFRAMES",
    "backtest",
    "candles",
    "enums",
    "helpers",
    "indicators",
    "live",
    "registry",
    "timeframes",
    "utils",
]
