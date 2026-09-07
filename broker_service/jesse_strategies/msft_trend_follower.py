"""Multi-timeframe pullback strategy tuned for MSFT on 5-minute candles."""

from __future__ import annotations

import jesse.indicators as ta
from jesse import utils
from jesse.strategies import Strategy


class MSFTTrendFollower(Strategy):
    """Trend-following pullbacks with a higher-timeframe filter.

    Designed for MSFT 5-minute candles. The trend is read from the anchor
    timeframe (``utils.anchor_timeframe``; 30-minute for 5-minute candles): a
    long is only considered while the anchor EMA is rising and price is above
    it. On the trading timeframe a pullback to the fast EMA followed by a
    close back above it is the trigger. Risk is 1% of equity to a 2-ATR stop,
    half the position is taken off at 1.5R and the rest at 3R, and after the
    first target the stop moves to break-even.
    """

    def hyperparameters(self):
        return [
            {"name": "anchor_ema", "type": int, "min": 10, "max": 200, "default": 50},
            {"name": "fast_ema", "type": int, "min": 5, "max": 50, "default": 20},
            {"name": "atr_period", "type": int, "min": 5, "max": 50, "default": 14},
            {"name": "atr_mult", "type": float, "min": 0.5, "max": 5.0, "default": 2.0},
            {"name": "risk_pct", "type": float, "min": 0.1, "max": 3.0, "default": 1.0},
            {"name": "first_target_r", "type": float, "min": 0.5, "max": 4.0, "default": 1.5},
            {"name": "second_target_r", "type": float, "min": 1.0, "max": 8.0, "default": 3.0},
        ]

    # --- context ---------------------------------------------------------- #

    @property
    def anchor_candles(self):
        return self.get_candles(self.exchange, self.symbol, utils.anchor_timeframe(self.timeframe))

    @property
    def anchor_trend(self) -> int:
        """+1 rising anchor EMA with price above it, -1 the mirror, 0 otherwise."""

        candles = self.anchor_candles
        if len(candles) < self.hp["anchor_ema"] + 2:
            return 0
        ema = ta.ema(candles, self.hp["anchor_ema"], sequential=True)
        if ema[-1] != ema[-1] or ema[-2] != ema[-2]:
            return 0
        if ema[-1] > ema[-2] and self.price > ema[-1]:
            return 1
        if ema[-1] < ema[-2] and self.price < ema[-1]:
            return -1
        return 0

    @property
    def fast_ema(self):
        return ta.ema(self.candles, self.hp["fast_ema"], sequential=True)

    @property
    def atr(self) -> float:
        return ta.atr(self.candles, self.hp["atr_period"])

    def pulled_back_and_reclaimed(self, direction: int) -> bool:
        ema = self.fast_ema
        if len(ema) < 2 or ema[-1] != ema[-1] or ema[-2] != ema[-2]:
            return False
        if direction > 0:
            return self.low <= ema[-1] and self.close > ema[-1] and self.candles[-2][2] <= ema[-2]
        return self.high >= ema[-1] and self.close < ema[-1] and self.candles[-2][2] >= ema[-2]

    # --- decisions -------------------------------------------------------- #

    def should_long(self) -> bool:
        return self.anchor_trend > 0 and self.pulled_back_and_reclaimed(+1)

    def should_short(self) -> bool:
        return self.anchor_trend < 0 and self.pulled_back_and_reclaimed(-1)

    def filters(self):
        return [self.filter_atr]

    def filter_atr(self) -> bool:
        atr = self.atr
        return atr == atr and atr > 0

    def _plan(self, direction: int):
        entry = self.price
        risk = self.hp["atr_mult"] * self.atr
        stop = entry - direction * risk
        qty = utils.risk_to_qty(
            self.available_margin,
            self.hp["risk_pct"],
            entry,
            stop,
            precision=0,
            fee_rate=self.fee_rate,
        )
        if qty < 2:
            qty = max(qty, 1)
            half, rest = qty, 0
        else:
            half = int(qty // 2)
            rest = int(qty - half)
        first = entry + direction * self.hp["first_target_r"] * risk
        second = entry + direction * self.hp["second_target_r"] * risk
        self.vars["entry"] = entry
        self.vars["risk"] = risk
        self.vars["breakeven_set"] = False
        targets = [(half, first)] + ([(rest, second)] if rest else [])
        return qty, entry, stop, targets

    def go_long(self):
        qty, entry, stop, targets = self._plan(+1)
        self.buy = qty, entry
        self.stop_loss = qty, stop
        self.take_profit = targets

    def go_short(self):
        qty, entry, stop, targets = self._plan(-1)
        self.sell = qty, entry
        self.stop_loss = qty, stop
        self.take_profit = targets

    def on_reduced_position(self, order):
        # First target hit: protect the rest at break-even.
        if not self.vars.get("breakeven_set"):
            remaining = abs(self.position.qty)
            self.stop_loss = remaining, self.position.entry_price
            self.vars["breakeven_set"] = True

    def update_position(self):
        # Give up on a trade whose anchor trend has reversed.
        if self.is_long and self.anchor_trend < 0:
            self.liquidate()
        elif self.is_short and self.anchor_trend > 0:
            self.liquidate()

    def watch_list(self):
        return [
            ("anchor_trend", self.anchor_trend),
            ("fast_ema", self.fast_ema[-1]),
            ("atr", self.atr),
        ]
