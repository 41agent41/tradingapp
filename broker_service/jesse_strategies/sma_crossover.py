"""SMA crossover, long and short, risk-sized with an ATR stop."""

from __future__ import annotations

import jesse.indicators as ta
from jesse import utils
from jesse.strategies import Strategy


class SMACrossover(Strategy):
    """Fast/slow SMA crossover.

    Goes long when the fast SMA crosses above the slow SMA and short on the
    opposite cross. Each trade risks ``risk_pct`` of the balance to an ATR-based
    stop and targets ``reward_ratio`` times that risk; an open trade is closed
    early if the averages cross back against it.
    """

    def hyperparameters(self):
        return [
            {"name": "fast", "type": int, "min": 3, "max": 100, "default": 20},
            {"name": "slow", "type": int, "min": 10, "max": 400, "default": 50},
            {"name": "atr_period", "type": int, "min": 5, "max": 50, "default": 14},
            {"name": "atr_mult", "type": float, "min": 0.5, "max": 6.0, "default": 2.0},
            {"name": "risk_pct", "type": float, "min": 0.1, "max": 5.0, "default": 1.0},
            {"name": "reward_ratio", "type": float, "min": 0.5, "max": 6.0, "default": 2.0},
        ]

    @property
    def fast(self):
        return ta.sma(self.candles, self.hp["fast"], sequential=True)

    @property
    def slow(self):
        return ta.sma(self.candles, self.hp["slow"], sequential=True)

    @property
    def atr(self):
        return ta.atr(self.candles, self.hp["atr_period"])

    def should_long(self) -> bool:
        return utils.crossed(self.fast, self.slow, direction="above")

    def should_short(self) -> bool:
        return utils.crossed(self.fast, self.slow, direction="below")

    def should_cancel_entry(self) -> bool:
        return True

    def filters(self):
        return [self.filter_atr_available]

    def filter_atr_available(self) -> bool:
        atr = self.atr
        return atr == atr and atr > 0  # not NaN, strictly positive

    def go_long(self):
        entry = self.price
        stop = entry - self.hp["atr_mult"] * self.atr
        qty = utils.risk_to_qty(
            self.available_margin, self.hp["risk_pct"], entry, stop, fee_rate=self.fee_rate
        )
        self.buy = qty, entry
        self.stop_loss = qty, stop
        self.take_profit = qty, entry + self.hp["reward_ratio"] * (entry - stop)

    def go_short(self):
        entry = self.price
        stop = entry + self.hp["atr_mult"] * self.atr
        qty = utils.risk_to_qty(
            self.available_margin, self.hp["risk_pct"], entry, stop, fee_rate=self.fee_rate
        )
        self.sell = qty, entry
        self.stop_loss = qty, stop
        self.take_profit = qty, entry - self.hp["reward_ratio"] * (stop - entry)

    def update_position(self):
        # Exit early when the trend flips against the open trade.
        if self.is_long and utils.crossed(self.fast, self.slow, direction="below"):
            self.liquidate()
        elif self.is_short and utils.crossed(self.fast, self.slow, direction="above"):
            self.liquidate()

    def watch_list(self):
        return [
            ("fast", self.fast[-1]),
            ("slow", self.slow[-1]),
            ("atr", self.atr),
        ]
