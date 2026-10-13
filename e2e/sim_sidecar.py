"""A simulated MT5 terminal behind the real sidecar app, for end-to-end runs.

The sidecar (`mt5_sidecar/server.py`) is the production code; only the
`MetaTrader5` module under it is replaced, by the in-memory fake its own tests
use (`mt5_sidecar/tests/fake_mt5.py`), extended here so a strategy has
something to trade:

* **A moving market.** Price follows a fixed path that rises by `--drift`
  per minute, so bars close higher than they open and a 2-bar-low stop trails
  upward every bar. The path is a function of wall-clock time, so history and
  live quotes agree.
* **Stops that fire.** A long position whose stop is at or above the bid (or a
  short whose stop is at or below the ask) is closed at the stop, with a deal
  recorded, the way a terminal would.
* **A control route.** `POST /_sim` changes the simulation (`drop_sl`,
  `fail_reads`, `price_offset`, and a one-shot `strip_sl`); `GET /_sim` reports positions, deals and the
  requests the sidecar sent. Both sit behind the same secret as every route.

Run: python e2e/sim_sidecar.py --port 9101 --secret ... [--symbol EURUSD.a]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_ROOT = Path(__file__).resolve().parent.parent / "mt5_sidecar"
for path in (_ROOT, _ROOT / "tests"):
    sys.path.insert(0, str(path))

import uvicorn  # noqa: E402
from fake_mt5 import FakeMT5  # noqa: E402
from fastapi import Request  # noqa: E402

from config import load_config  # noqa: E402
from server import create_app  # noqa: E402
from terminal import Terminal  # noqa: E402

SPREAD = 0.00010
WIGGLE = 0.00005


class _LivePrices(dict):
    """`FakeMT5.prices`, read from the path at the moment of each lookup."""

    def __init__(self, sim: "SimMT5", names: List[str]) -> None:
        super().__init__({name: None for name in names})
        self._sim = sim

    def __getitem__(self, name: str) -> Tuple[float, float]:
        if name not in self.keys():
            raise KeyError(name)
        bid = self._sim.mid(self._sim.server_now())
        return round(bid, 5), round(bid + SPREAD, 5)


class SimMT5(FakeMT5):
    def __init__(
        self, *, symbol: str, drift: float, balance: float, login: int
    ) -> None:
        super().__init__(symbols=[symbol])
        self.start = time.time()
        self.drift = drift
        self.price_offset = 0.0
        self.balance = balance
        self.login = login
        self.prices = _LivePrices(self, [symbol])

    # --- the market ------------------------------------------------------ #
    def mid(self, t: float) -> float:
        return 1.08 + self.drift * (t - self.start) / 60.0 + self.price_offset

    def _bar(
        self, t: int, sec: int
    ) -> Tuple[int, float, float, float, float, int, int, int]:
        # A bar still forming closes at the current price, not its end.
        o, c = self.mid(t), self.mid(min(t + sec, self.server_now()))
        return (t, o, max(o, c) + WIGGLE, min(o, c) - WIGGLE, c, 100, 10, 0)

    def copy_rates_from_pos(self, name: str, timeframe: int, start: int, count: int):
        if name not in self.symbols:
            return None
        sec = self.TIMEFRAME_SECONDS.get(timeframe, 60)
        last = int(self.server_now() // sec) * sec
        return self._rows([last - i * sec for i in range(count - 1, -1, -1)], sec)

    def copy_rates_range(self, name, timeframe, date_from, date_to):
        if name not in self.symbols:
            return None
        sec = self.TIMEFRAME_SECONDS.get(timeframe, 60)
        start = int(date_from.timestamp() // sec) * sec
        end = min(int(date_to.timestamp()), int(self.server_now()))
        return self._rows(list(range(start, end + 1, sec)), sec)

    def _rows(self, times: List[int], sec: int):
        import numpy as np
        from fake_mt5 import RATE_DTYPE

        return np.array([self._bar(t, sec) for t in times], dtype=RATE_DTYPE)

    # --- stops fire ------------------------------------------------------ #
    def _fire_stops(self) -> None:
        for pos in list(self.positions):
            if not pos["sl"]:
                continue
            bid, ask = self.prices[pos["symbol"]]
            long_side = pos["type"] == 0
            if (long_side and bid <= pos["sl"]) or (not long_side and ask >= pos["sl"]):
                self.positions.remove(pos)
                request = {
                    "type": self.ORDER_TYPE_SELL if long_side else self.ORDER_TYPE_BUY,
                    "volume": pos["volume"],
                    "symbol": pos["symbol"],
                    "comment": "[sl]",
                }
                self._record_deal(request, self._ticket(), pos["ticket"], 1, pos["sl"])

    def positions_get(self, symbol: Optional[str] = None, ticket: Optional[int] = None):
        self._fire_stops()
        return super().positions_get(symbol, ticket)

    def history_deals_get(self, date_from, date_to):
        self._fire_stops()
        return super().history_deals_get(date_from, date_to)

    def account_info(self):
        self._fire_stops()
        return super().account_info()

    def order_send(self, request: Dict[str, Any]):
        self._fire_stops()
        return super().order_send(request)


def build(args: argparse.Namespace):
    sim = SimMT5(
        symbol=args.symbol, drift=args.drift, balance=args.balance, login=args.login
    )
    config = load_config({"MT5_BRIDGE_SECRET": args.secret})
    terminal = Terminal(sim, config)
    terminal.connect()
    app = create_app(terminal)

    @app.get("/_sim")
    def sim_state():
        with terminal.lock:
            return {
                "positions": [dict(p) for p in sim.positions],
                "deals": [dict(d) for d in sim.deals],
                "requests": [dict(r) for r in sim.requests],
                "bid": sim.prices[args.symbol][0],
            }

    @app.post("/_sim")
    async def sim_set(request: Request):
        body = await request.json()
        with terminal.lock:
            for key in ("drop_sl", "fail_reads", "price_offset"):
                if key in body:
                    setattr(sim, key, body[key])
            # One-shot: something at the venue removed the open positions' stops.
            if body.get("strip_sl"):
                for pos in sim.positions:
                    pos["sl"] = 0.0
        return {"ok": True}

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--secret", required=True)
    parser.add_argument("--symbol", default="EURUSDm")
    parser.add_argument(
        "--drift", type=float, default=0.0002, help="price rise per minute"
    )
    parser.add_argument("--balance", type=float, default=10_000.0)
    parser.add_argument("--login", type=int, default=5001)
    args = parser.parse_args()
    uvicorn.run(build(args), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
