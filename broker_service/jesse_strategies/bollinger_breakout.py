"""Bollinger Band breakout with a volume confirmation and a trailing stop."""

from __future__ import annotations

import jesse.indicators as ta
from jesse import utils
from jesse.strategies import Strategy


class BollingerBreakout(Strategy):
    """Volatility breakout in both directions.

    Buys a stop order just above the upper Bollinger Band (sells one just below
    the lower band) when volume is above its moving average, so the entry only
    triggers if the breakout follows through. The stop-loss starts at the
    middle band and trails it candle by candle; the resting entry is cancelled
    if it has not triggered by the next candle.
    """

    def hyperparameters(self):
        return [
            {"name": "bb_period", "type": int, "min": 10, "max": 100, "default": 20},
            {"name": "bb_dev", "type": float, "min": 1.0, "max": 3.5, "default": 2.0},
            {"name": "vol_period", "type": int, "min": 5, "max": 100, "default": 20},
            {"name": "vol_mult", "type": float, "min": 0.5, "max": 3.0, "default": 1.2},
            {"name": "risk_pct", "type": float, "min": 0.1, "max": 5.0, "default": 1.0},
            {"name": "breakout_pad_pct", "type": float, "min": 0.0, "max": 1.0, "default": 0.05},
        ]

    @property
    def bands(self):
        return ta.bollinger_bands(
            self.candles, self.hp["bb_period"], self.hp["bb_dev"], self.hp["bb_dev"]
        )

    @property
    def volume_confirms(self) -> bool:
        vol_ma = ta.sma(self.candles, self.hp["vol_period"], source_type="volume")
        return vol_ma == vol_ma and self.volume > self.hp["vol_mult"] * vol_ma

    def before(self):
        self.vars["bands"] = self.bands

    def should_long(self) -> bool:
        b = self.vars["bands"]
        return self.volume_confirms and self.price > b.middleband and self.high < b.upperband

    def should_short(self) -> bool:
        b = self.vars["bands"]
        return self.volume_confirms and self.price < b.middleband and self.low > b.lowerband

    def should_cancel_entry(self) -> bool:
        return True

    def go_long(self):
        b = self.vars["bands"]
        entry = b.upperband * (1 + self.hp["breakout_pad_pct"] / 100.0)
        stop = b.middleband
        qty = utils.risk_to_qty(self.available_margin, self.hp["risk_pct"], entry, stop)
        self.buy = qty, entry
        self.stop_loss = qty, stop

    def go_short(self):
        b = self.vars["bands"]
        entry = b.lowerband * (1 - self.hp["breakout_pad_pct"] / 100.0)
        stop = b.middleband
        qty = utils.risk_to_qty(self.available_margin, self.hp["risk_pct"], entry, stop)
        self.sell = qty, entry
        self.stop_loss = qty, stop

    def update_position(self):
        # Trail the stop with the middle band, only ever tightening it.
        middle = self.vars["bands"].middleband
        qty = abs(self.position.qty)
        current = self.average_stop_loss
        if self.is_long and middle > (current or float("-inf")):
            self.stop_loss = qty, middle
        elif self.is_short and middle < (current or float("inf")):
            self.stop_loss = qty, middle

    def watch_list(self):
        b = self.vars.get("bands") or self.bands
        return [("upper", b.upperband), ("middle", b.middleband), ("lower", b.lowerband)]
