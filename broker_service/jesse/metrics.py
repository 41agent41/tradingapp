"""Performance statistics in Jesse's vocabulary (``jesse.statistics``).

``compute`` produces the metric names Jesse prints after a backtest
(``net_profit_percentage``, ``expectancy``, ``sharpe_ratio``, ``calmar_ratio``…)
from the closed-trade list and the per-candle equity curve. Ratios are
annualised from **daily** equity, so intraday and daily strategies are
comparable, and non-finite values are rendered as ``None`` for JSON.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Sequence

import numpy as np
import pandas as pd

from .models import ClosedTrade

TRADING_DAYS = 252


def _finite(value: float) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _streaks(pnls: Sequence[float]) -> Dict[str, int]:
    best_win = best_loss = current = 0
    for pnl in pnls:
        if pnl > 0:
            current = current + 1 if current > 0 else 1
            best_win = max(best_win, current)
        elif pnl < 0:
            current = current - 1 if current < 0 else -1
            best_loss = min(best_loss, current)
        else:
            current = 0
    return {"winning_streak": best_win, "losing_streak": abs(best_loss), "current_streak": current}


def trade_statistics(trades: Sequence[ClosedTrade]) -> Dict[str, Any]:
    """Trade-only metrics (no equity curve needed) — what ``self.metrics``
    returns inside a running strategy."""

    total = len(trades)
    if total == 0:
        return {
            "total": 0,
            "total_winning_trades": 0,
            "total_losing_trades": 0,
            "win_rate": 0.0,
            "net_profit": 0.0,
            "average_win": 0.0,
            "average_loss": 0.0,
            "expectancy": 0.0,
        }
    pnls = np.array([t.pnl for t in trades], dtype="float64")
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    win_rate = len(wins) / total
    average_win = float(wins.mean()) if len(wins) else 0.0
    average_loss = float(np.abs(losses).mean()) if len(losses) else 0.0
    loss_rate = len(losses) / total
    return {
        "total": total,
        "total_winning_trades": int(len(wins)),
        "total_losing_trades": int(len(losses)),
        "win_rate": win_rate,
        "net_profit": float(pnls.sum()),
        "average_win": average_win,
        "average_loss": average_loss,
        "expectancy": win_rate * average_win - loss_rate * average_loss,
    }


def compute(
    trades: Sequence[ClosedTrade],
    equity_curve: pd.Series,
    starting_balance: float,
    finishing_balance: float,
    open_position_pnl: float = 0.0,
    total_fees: float = 0.0,
) -> Dict[str, Any]:
    """Full Jesse-style metrics dict. ``equity_curve`` is indexed by datetime."""

    stats = trade_statistics(trades)
    total = stats["total"]
    pnls = np.array([t.pnl for t in trades], dtype="float64")
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]

    net_profit = finishing_balance - starting_balance
    gross_profit = float(wins.sum()) if len(wins) else 0.0
    gross_loss = float(np.abs(losses).sum()) if len(losses) else 0.0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")
    ratio_avg_win_loss = (
        stats["average_win"] / stats["average_loss"] if stats["average_loss"] > 0 else float("inf")
    )

    longs = [t for t in trades if t.is_long]
    shorts = [t for t in trades if t.is_short]

    holding = np.array([t.holding_period for t in trades], dtype="float64")
    winning_holding = np.array([t.holding_period for t in trades if t.pnl > 0], dtype="float64")
    losing_holding = np.array([t.holding_period for t in trades if t.pnl < 0], dtype="float64")

    # Drawdown from the per-candle curve.
    max_drawdown = 0.0
    if len(equity_curve):
        running_max = equity_curve.cummax()
        drawdown = (equity_curve - running_max) / running_max * 100.0
        max_drawdown = float(drawdown.min()) if len(drawdown) else 0.0

    # Ratios from daily equity so intraday and daily strategies are comparable.
    sharpe = sortino = calmar = omega = annual_return = float("nan")
    if len(equity_curve) >= 2 and isinstance(equity_curve.index, pd.DatetimeIndex):
        daily = equity_curve.resample("1D").last().dropna()
        days = max((equity_curve.index[-1] - equity_curve.index[0]).total_seconds() / 86400.0, 1.0)
        if finishing_balance > 0 and starting_balance > 0:
            annual_return = ((finishing_balance / starting_balance) ** (365.0 / days) - 1.0) * 100.0
        returns = daily.pct_change().dropna()
        if len(returns) >= 2:
            std = returns.std(ddof=1)
            mean = returns.mean()
            if std > 0:
                sharpe = float(mean / std * math.sqrt(TRADING_DAYS))
            downside = returns[returns < 0]
            downside_std = math.sqrt(float((downside**2).mean())) if len(downside) else 0.0
            if downside_std > 0:
                sortino = float(mean / downside_std * math.sqrt(TRADING_DAYS))
            losses_sum = float(-returns[returns < 0].sum())
            gains_sum = float(returns[returns > 0].sum())
            omega = gains_sum / losses_sum if losses_sum > 0 else float("inf")
        if max_drawdown < 0 and math.isfinite(annual_return):
            calmar = annual_return / abs(max_drawdown)

    win_rate = stats["win_rate"]
    kelly = (
        win_rate - (1 - win_rate) / ratio_avg_win_loss
        if math.isfinite(ratio_avg_win_loss) and ratio_avg_win_loss > 0
        else (win_rate if total else 0.0)
    )

    def _mean(values: np.ndarray) -> float:
        return float(values.mean()) if len(values) else 0.0

    metrics: Dict[str, Any] = {
        "total": total,
        "total_winning_trades": stats["total_winning_trades"],
        "total_losing_trades": stats["total_losing_trades"],
        "starting_balance": starting_balance,
        "finishing_balance": finishing_balance,
        "win_rate": win_rate,
        "ratio_avg_win_loss": ratio_avg_win_loss,
        "longs_count": len(longs),
        "longs_percentage": (len(longs) / total * 100.0) if total else 0.0,
        "shorts_count": len(shorts),
        "shorts_percentage": (len(shorts) / total * 100.0) if total else 0.0,
        "fee": total_fees,
        "net_profit": net_profit,
        "net_profit_percentage": net_profit / starting_balance * 100.0 if starting_balance else 0.0,
        "average_win": stats["average_win"],
        "average_loss": stats["average_loss"],
        "expectancy": stats["expectancy"],
        "expectancy_percentage": (
            stats["expectancy"] / starting_balance * 100.0 if starting_balance else 0.0
        ),
        "expected_net_profit_every_100_trades": stats["expectancy"] * 100.0,
        "average_holding_period": _mean(holding),
        "average_winning_holding_period": _mean(winning_holding),
        "average_losing_holding_period": _mean(losing_holding),
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "profit_factor": profit_factor,
        "max_drawdown": max_drawdown,
        "annual_return": annual_return,
        "sharpe_ratio": sharpe,
        "sortino_ratio": sortino,
        "calmar_ratio": calmar,
        "omega_ratio": omega,
        "total_open_trades": 1 if open_position_pnl != 0 else 0,
        "open_pl": open_position_pnl,
        "largest_winning_trade": float(wins.max()) if len(wins) else 0.0,
        "largest_losing_trade": float(losses.min()) if len(losses) else 0.0,
        "kelly_criterion": kelly,
        **_streaks(pnls.tolist()),
    }
    return {k: (_finite(v) if isinstance(v, float) else v) for k, v in metrics.items()}
