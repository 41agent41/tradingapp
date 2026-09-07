"""Bridge between Jesse strategies and the app's existing strategy surface.

The service already has one strategy catalogue (``backtesting.AVAILABLE_STRATEGIES``),
one backtest entry point (``BacktestEngine.run_backtest``) and one live signal
endpoint (``POST /strategies/evaluate``, driven by ``RuleStrategy.evaluate`` /
``trail_stop``). ``JesseStrategyAdapter`` wears the same interface as those
strategies so a Jesse strategy plugs into all three without the routes, the
backend runner or the UI learning anything new:

* ``run_backtest(df, ...)`` — the engine delegates to the Jesse runner and gets
  back the same ``BacktestResults`` the ``/backtest`` page renders.
* ``evaluate(df, position)`` / ``trail_stop(df, position)`` — the live shape
  ``strategyRunner.ts`` consumes.

A Jesse strategy is selected the way a rule-set is: either by catalogue key
(``strategy=jesse_sma_crossover``) or with a definition object

    {"engine": "jesse", "strategy": "SMACrossover",
     "hyperparameters": {"fast": 10, "slow": 30}, "warmup_candles": 60}

which can be stored in ``strategy_definitions.rule_set`` and deployed as a live
run exactly like a declarative rule-set.
"""

from __future__ import annotations

from typing import Any, Dict, Type

import pandas as pd

import backtesting
from backtesting import BacktestResults, OrderStatus, OrderType, Trade, TradingStrategy

from . import backtest as jesse_backtest
from . import live as jesse_live
from . import registry
from .backtest import BacktestResult
from .models import StrategyError
from .strategy import Strategy, describe_hyperparameters, resolve_hyperparameters

ENGINE = "jesse"


def is_jesse_definition(rule_set: Any) -> bool:
    return isinstance(rule_set, dict) and str(rule_set.get("engine", "")).lower() == ENGINE


class JesseStrategyAdapter(TradingStrategy):
    """A Jesse ``Strategy`` class wearing the app's ``TradingStrategy`` interface."""

    engine = ENGINE

    def __init__(
        self,
        strategy_cls: Type[Strategy],
        hyperparameters: Dict[str, Any] | None = None,
        warmup_candles: int | None = None,
        exchange: str = "Interactive Brokers",
        timeframe: str | None = None,
    ) -> None:
        if not (isinstance(strategy_cls, type) and issubclass(strategy_cls, Strategy)):
            raise StrategyError(f"{strategy_cls!r} is not a jesse Strategy class")
        probe = strategy_cls()
        # Validate overrides up front so a bad definition fails at compile time.
        self.hyperparameters = resolve_hyperparameters(probe.hyperparameters(), hyperparameters)
        self.hyperparameter_spec = describe_hyperparameters(probe.hyperparameters())
        self.strategy_cls = strategy_cls
        self.warmup_candles = warmup_candles
        self.exchange = exchange
        self.timeframe = timeframe
        self.key = registry.key_for(strategy_cls)
        self.symbol = "UNKNOWN"
        self.last_result: BacktestResult | None = None
        super().__init__(name=probe.name, indicators=[])
        self.description = (strategy_cls.__doc__ or "").strip()

    # --- catalogue ------------------------------------------------------- #

    def describe(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "engine": ENGINE,
            "class_name": self.strategy_cls.__name__,
            "name": self.name,
            "description": self.description or "No description available",
            "hyperparameters": self.hyperparameter_spec,
            "module": self.strategy_cls.__module__,
        }

    # --- backtest -------------------------------------------------------- #

    def run_backtest(
        self,
        df: pd.DataFrame,
        *,
        symbol: str,
        initial_capital: float,
        commission: float,
        spec: Dict[str, Any] | None = None,
        timeframe: str | None = None,
    ) -> BacktestResults:
        """Run the Jesse backtester and translate to the app's ``BacktestResults``."""

        tf = timeframe or self.timeframe or _infer_timeframe(df)
        result = jesse_backtest.run(
            self.strategy_cls,
            df,
            symbol=symbol,
            timeframe=tf,
            exchange=self.exchange,
            starting_balance=initial_capital,
            fee_rate=commission,
            hyperparameters=self.hyperparameters,
            warmup_candles=self.warmup_candles,
        )
        self.last_result = result
        return to_backtest_results(result)

    # --- live ------------------------------------------------------------ #

    def evaluate(self, df: pd.DataFrame, position: Any = None) -> Dict[str, Any]:
        size = float(getattr(position, "size", 0.0) or 0.0)
        avg = float(getattr(position, "avg_price", 0.0) or 0.0)
        result = jesse_live.evaluate(
            self.strategy_cls,
            df,
            symbol=self.symbol,
            timeframe=self.timeframe or _infer_timeframe(df),
            position_size=size,
            position_avg_price=avg,
            hyperparameters=self.hyperparameters,
            exchange=self.exchange,
            warmup_candles=self.warmup_candles,
        )
        self._last_trail = result.pop("trail")
        return result

    def trail_stop(self, df: pd.DataFrame, position: Any = None) -> Dict[str, Any]:
        """The stop the strategy wants for the open position. ``evaluate`` has
        already computed it on the same bars; reuse rather than replay."""

        trail = getattr(self, "_last_trail", None)
        if trail is None:
            self.evaluate(df, position)
            trail = getattr(self, "_last_trail", None)
        return trail or {"stop_price": None, "direction": None, "error": None}


def _infer_timeframe(df: pd.DataFrame) -> str:
    from . import candles as C

    arr = C.from_dataframe(df)
    inferred = C.infer_timeframe(arr)
    if inferred is None:
        raise StrategyError(
            "Could not infer the candle timeframe from the bars; pass 'timeframe' explicitly."
        )
    return inferred


def to_backtest_results(result: BacktestResult) -> BacktestResults:
    """Jesse ``BacktestResult`` -> the app's ``BacktestResults`` (same UI payload)."""

    trades = []
    for t in result.trades:
        trades.append(
            Trade(
                entry_time=pd.Timestamp(t.opened_at, unit="ms").to_pydatetime(),
                exit_time=pd.Timestamp(t.closed_at, unit="ms").to_pydatetime(),
                entry_price=float(t.entry_price),
                exit_price=float(t.exit_price),
                quantity=float(t.qty),
                order_type=OrderType.BUY if t.is_long else OrderType.SELL,
                status=OrderStatus.FILLED,
                entry_reason=t.entry_reason,
                exit_reason=t.exit_reason,
            )
        )

    m = result.metrics
    wins = m.get("total_winning_trades", 0)
    losses = m.get("total_losing_trades", 0)
    profit_factor = m.get("profit_factor")
    return BacktestResults(
        symbol=result.symbol,
        start_date=result.start_time.to_pydatetime(),
        end_date=result.end_time.to_pydatetime(),
        initial_capital=result.starting_balance,
        final_capital=result.finishing_balance,
        total_trades=m.get("total", len(trades)),
        winning_trades=wins,
        losing_trades=losses,
        total_return=m.get("net_profit") or 0.0,
        total_return_percent=m.get("net_profit_percentage") or 0.0,
        max_drawdown=m.get("max_drawdown") or 0.0,
        sharpe_ratio=m.get("sharpe_ratio") if m.get("sharpe_ratio") is not None else 0.0,
        win_rate=(m.get("win_rate") or 0.0) * 100.0,
        average_win=m.get("average_win") or 0.0,
        average_loss=m.get("average_loss") or 0.0,
        profit_factor=profit_factor if profit_factor is not None else float("inf"),
        trades=trades,
        equity_curve=result.equity_curve,
        metrics={
            "engine": ENGINE,
            "strategy": result.strategy_name,
            "timeframe": result.timeframe,
            "hyperparameters": result.hyperparameters,
            "warmup_candles": result.warmup_candles,
            "candles_total": result.candles_total,
            **m,
        },
    )


def compile_jesse_definition(rule_set: Dict[str, Any]) -> JesseStrategyAdapter:
    """``{"engine": "jesse", "strategy": <key|ClassName>, ...}`` -> adapter."""

    if not is_jesse_definition(rule_set):
        raise StrategyError("Not a jesse definition: expected {'engine': 'jesse', ...}")
    name = rule_set.get("strategy")
    if not isinstance(name, str) or not name.strip():
        raise StrategyError("A jesse definition needs a 'strategy' key or class name.")
    cls = registry.get(name)

    hyperparameters = rule_set.get("hyperparameters")
    if hyperparameters is not None and not isinstance(hyperparameters, dict):
        raise StrategyError("'hyperparameters' must be an object of name -> value.")

    warmup = rule_set.get("warmup_candles")
    if warmup is not None:
        try:
            warmup = int(warmup)
        except (TypeError, ValueError):
            raise StrategyError("'warmup_candles' must be an integer.")
        if warmup < 0:
            raise StrategyError("'warmup_candles' cannot be negative.")

    timeframe = rule_set.get("timeframe")
    if timeframe is not None:
        from . import timeframes as tfmod

        try:
            timeframe = tfmod.to_app(str(timeframe))
        except tfmod.TimeframeError as exc:
            raise StrategyError(str(exc))

    return JesseStrategyAdapter(
        cls,
        hyperparameters=hyperparameters,
        warmup_candles=warmup,
        exchange=str(rule_set.get("exchange") or "Interactive Brokers"),
        timeframe=timeframe,
    )


def make_adapter_class(strategy_cls: Type[Strategy]) -> type:
    """Zero-arg adapter class for ``AVAILABLE_STRATEGIES`` (the catalogue
    instantiates entries with no arguments)."""

    def __init__(self):  # noqa: N807
        JesseStrategyAdapter.__init__(self, strategy_cls)

    return type(
        f"Jesse{strategy_cls.__name__}Adapter",
        (JesseStrategyAdapter,),
        {"__init__": __init__, "__doc__": strategy_cls.__doc__, "jesse_strategy": strategy_cls},
    )


def build_strategy_classes() -> Dict[str, type]:
    return {key: make_adapter_class(cls) for key, cls in registry.all_strategies().items()}


def register_into_catalogue() -> None:
    backtesting.AVAILABLE_STRATEGIES.update(build_strategy_classes())


# Discover the repository's jesse strategies and publish them into the shared
# catalogue on import (mirrors ``rule_strategy``'s registration side effect).
register_into_catalogue()
