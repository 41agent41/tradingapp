"""Live evaluation: the newest closed candle's decision for a real position.

The app's live runner (``backend/src/services/strategyRunner.ts``) is stateless
per bar: once per closed candle it posts the recent bars plus the venue's
current position to ``POST /strategies/evaluate`` and acts on the returned
``signal`` (``long`` / ``short`` / ``flat`` / ``none``) and ``stop_price``.
Orders are placed by the backend's ``ExecutionEngine``, never from here.

A Jesse strategy, however, is *stateful* — ``self.vars``, counters, the stop it
has been trailing. To honour that without persisting anything, ``evaluate``
**replays** the supplied bars through the simulated broker exactly as a
backtest would, so the strategy arrives at the last candle with the state it
would have had. Then, on that last candle only, the simulated position is
overwritten with the venue's truth (size + average price) before the strategy
runs — the venue is authoritative, the replay is context. What the strategy
then asks for is translated into the runner's signal vocabulary:

    flat + go_long()  -> signal 'long'  + the stop-loss / take-profit it declared
    flat + go_short() -> signal 'short'
    open + liquidate(), or a stop / take-profit level the last candle crossed
                      -> signal 'flat'
    open, otherwise   -> 'none', with the current stop-loss as the trail price
"""

from __future__ import annotations

from typing import Any, Dict, Type

import numpy as np
import pandas as pd

from . import candles as C
from . import timeframes as tf
from .backtest import DEFAULT_WARMUP
from .broker import SimulatedBroker
from .models import Exchange, Position
from .strategy import CandleStore, Strategy


def evaluate(
    strategy_cls: Type[Strategy],
    bars: pd.DataFrame | np.ndarray,
    *,
    symbol: str,
    timeframe: str,
    position_size: float = 0.0,
    position_avg_price: float = 0.0,
    hyperparameters: Dict[str, Any] | None = None,
    exchange: str = "Interactive Brokers",
    starting_balance: float = 100_000.0,
    fee_rate: float = 0.001,
    warmup_candles: int | None = None,
) -> Dict[str, Any]:
    arr = bars if isinstance(bars, np.ndarray) else C.from_dataframe(bars)
    C.validate(arr)
    n = len(arr)
    canonical_tf = tf.normalize(timeframe)
    if warmup_candles is None:
        warmup_candles = min(DEFAULT_WARMUP, max(0, n - 1))
    warmup_candles = max(0, min(warmup_candles, n - 1))

    strat = strategy_cls()
    wallet = Exchange(exchange, starting_balance, fee_rate=fee_rate)
    position = Position(symbol=symbol, exchange=wallet, strategy_name=strat.name)
    store = CandleStore(arr, canonical_tf)
    broker = SimulatedBroker(wallet, position, symbol, tf.to_app(canonical_tf), strat.name)
    strat._bind(store, broker, position, symbol, exchange, hyperparameters, mode="live")

    # Shadow replay — every candle but the last, exactly as the backtester runs them.
    last = n - 1
    for i in range(warmup_candles, last):
        store.index = i
        strat._process_fills(broker.on_candle(arr[i]))
        strat._execute(i - warmup_candles)
        position.current_price = float(arr[i][C.CLOSE])

    # The venue's position is the truth for the decision candle.
    store.index = last
    candle = arr[last]
    last_ts = float(candle[C.TIMESTAMP])
    close = float(candle[C.CLOSE])
    broker.sync_position(position_size, position_avg_price, last_ts)
    trades_before = len(broker.trades)
    if position.is_open:
        # Keep whatever stop/take-profit the strategy has been carrying, and
        # make sure they are (re)submitted against the real position.
        strat._pending_exit_intents = True
    else:
        strat._reset_intents()
    position.current_price = close

    broker.on_candle(candle)  # no-op for orders: sync cancelled them all
    decision = strat._execute(last - warmup_candles)
    position.current_price = close

    was_open = position_size != 0
    direction = "long" if position_size > 0 else "short" if position_size < 0 else None
    entry_orders = [
        o for o in broker.orders if o.submitted_via == "entry" and o.created_at == last_ts
    ]
    new_trades = broker.trades[trades_before:]

    signal = "none"
    entry_reason = ""
    exit_reason = ""
    entry = False
    exit_ = False

    if not was_open:
        if decision["entry_side"] and entry_orders:
            signal = decision["entry_side"]
            entry = True
            hook = "go_long()" if signal == "long" else "go_short()"
            entry_reason = f"{strat.name}: {hook}"
    else:
        if decision["liquidate"]:
            signal = "flat"
            exit_ = True
            exit_reason = f"{strat.name}: liquidate()"
        elif new_trades:
            # A stop-loss / take-profit already through its price on this candle
            # executed at market in the simulation: the position should be closed.
            signal = "flat"
            exit_ = True
            exit_reason = f"{strat.name}: {new_trades[-1].exit_reason}"
        elif _level_crossed(strat, direction, candle):
            signal = "flat"
            exit_ = True
            exit_reason = f"{strat.name}: {_level_crossed(strat, direction, candle)}"

    stop_price = strat.average_stop_loss if signal in ("long", "short") or was_open else None
    take_profit = strat.average_take_profit if signal in ("long", "short") or was_open else None

    trail: Dict[str, Any] = {"stop_price": None, "direction": None, "error": None}
    if was_open and signal != "flat":
        trail = {"stop_price": stop_price, "direction": direction, "error": None}

    bar_time = pd.Timestamp(last_ts, unit="ms")
    try:
        watch = [[str(k), _jsonable(v)] for k, v in strat.watch_list()]
    except Exception as exc:  # noqa: BLE001 — a watch-list bug must not block a signal
        watch = [["watch_list_error", str(exc)]]

    return {
        "signal": signal,
        "direction": "both",
        "engine": "jesse",
        "stop_price": stop_price,
        "stop_error": None,
        "has_stop_rule": stop_price is not None,
        "take_profit": take_profit,
        "entry_price": strat.average_entry_price if entry else None,
        "entry_orders": [o.to_dict() for o in entry_orders] if entry else [],
        "conflict": bool(decision["conflict"]),
        "entry": entry,
        "exit": exit_,
        "entry_reason": entry_reason,
        "exit_reason": exit_reason,
        "in_session": True,
        "bar_time": bar_time.isoformat(),
        "position": {"size": position_size, "avg_price": position_avg_price},
        "strategy": strat.name,
        "hyperparameters": dict(strat.hp),
        "watch_list": watch,
        "logs": strat.logs[-20:],
        "trail": trail,
    }


def _level_crossed(strat: Strategy, direction: str | None, candle: np.ndarray) -> str | None:
    """Did the closed candle trade through the strategy's stop or take-profit?

    The broker-side stop the runner placed should already have fired, but a
    take-profit is not held at the venue — so the closed candle is checked
    against both, and a crossing becomes an explicit ``flat``."""

    if direction is None:
        return None
    high, low = float(candle[C.HIGH]), float(candle[C.LOW])
    stop = strat.average_stop_loss
    take = strat.average_take_profit
    if direction == "long":
        if stop is not None and low <= stop:
            return "stop_loss"
        if take is not None and high >= take:
            return "take_profit"
    else:
        if stop is not None and high >= stop:
            return "stop_loss"
        if take is not None and low <= take:
            return "take_profit"
    return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, (np.floating, np.integer)):
        value = value.item()
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)
