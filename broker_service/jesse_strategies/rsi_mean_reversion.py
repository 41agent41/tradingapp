"""RSI mean reversion, long-only, fixed fraction of equity per trade."""

from __future__ import annotations

import jesse.indicators as ta
from jesse import utils
from jesse.strategies import Strategy


class RSIMeanReversion(Strategy):
    """Buy oversold, sell the bounce.

    Enters long when RSI drops below ``oversold`` while price is above the
    ``trend`` SMA (only fading dips in an uptrend). Spends ``equity_pct`` of
    equity per trade, protects with a stop ``stop_atr`` ATRs below entry and
    exits when RSI recovers through ``exit_level``.
    """

    def hyperparameters(self):
        return [
            {"name": "rsi_period", "type": int, "min": 2, "max": 50, "default": 14},
            {"name": "oversold", "type": float, "min": 5, "max": 45, "default": 30},
            {"name": "exit_level", "type": float, "min": 40, "max": 90, "default": 55},
            {"name": "trend", "type": int, "min": 20, "max": 400, "default": 100},
            {"name": "stop_atr", "type": float, "min": 0.5, "max": 6.0, "default": 2.5},
            {"name": "equity_pct", "type": float, "min": 1, "max": 100, "default": 25},
        ]

    @property
    def rsi(self) -> float:
        return ta.rsi(self.candles, self.hp["rsi_period"])

    @property
    def trend_sma(self) -> float:
        return ta.sma(self.candles, self.hp["trend"])

    def should_long(self) -> bool:
        trend = self.trend_sma
        return trend == trend and self.price > trend and self.rsi < self.hp["oversold"]

    def should_short(self) -> bool:
        return False

    def go_long(self):
        atr = ta.atr(self.candles, 14)
        size = self.available_margin * self.hp["equity_pct"] / 100.0
        qty = utils.size_to_qty(size, self.price, precision=0, fee_rate=self.fee_rate)
        self.buy = qty, self.price
        self.stop_loss = qty, self.price - self.hp["stop_atr"] * atr

    def update_position(self):
        if self.rsi > self.hp["exit_level"]:
            self.liquidate()

    def watch_list(self):
        return [("rsi", self.rsi), ("trend_sma", self.trend_sma)]
