"""An in-memory stand-in for the ``MetaTrader5`` package.

It implements the calls ``terminal.py`` makes, with the same names, return
types (named tuples, numpy record arrays for rates) and constants, and enough
trading behaviour to test against: netting and hedging accounts, stop-level
checks, requotes, a venue that drops the stop, and a server clock that runs
ahead of UTC.
"""

from __future__ import annotations

import time
from collections import namedtuple
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np

TerminalInfo = namedtuple("TerminalInfo", "connected trade_allowed name company build")
AccountInfo = namedtuple(
    "AccountInfo",
    "login trade_mode margin_mode leverage balance credit profit equity margin margin_free "
    "margin_level currency server company name",
)
SymbolInfo = namedtuple(
    "SymbolInfo",
    "name description path digits point volume_min volume_step volume_max trade_contract_size "
    "trade_stops_level trade_freeze_level trade_tick_value trade_tick_size currency_base "
    "currency_profit currency_margin filling_mode trade_mode visible",
)
Tick = namedtuple("Tick", "time bid ask last volume time_msc flags volume_real")
TradePosition = namedtuple(
    "TradePosition",
    "ticket time type magic identifier volume price_open sl tp price_current swap profit "
    "symbol comment",
)
TradeOrder = namedtuple(
    "TradeOrder",
    "ticket time_setup type state type_time type_filling magic volume_initial volume_current "
    "price_open sl tp price_current price_stoplimit symbol comment position_id",
)
TradeDeal = namedtuple(
    "TradeDeal",
    "ticket order time time_msc type entry magic position_id reason volume price commission "
    "swap profit fee symbol comment",
)
OrderSendResult = namedtuple(
    "OrderSendResult", "retcode deal order volume price bid ask comment request_id"
)

RATE_DTYPE = np.dtype(
    [
        ("time", "<i8"),
        ("open", "<f8"),
        ("high", "<f8"),
        ("low", "<f8"),
        ("close", "<f8"),
        ("tick_volume", "<u8"),
        ("spread", "<i4"),
        ("real_volume", "<u8"),
    ]
)


class FakeMT5:
    # --- constants, as the real package names them ----------------------- #
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_H8 = 16392
    TIMEFRAME_D1 = 16408
    TIMEFRAME_W1 = 32769
    TIMEFRAME_MN1 = 49153

    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_SLTP = 6
    TRADE_ACTION_MODIFY = 7
    TRADE_ACTION_REMOVE = 8

    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7

    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1

    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2

    ORDER_TIME_GTC = 0
    ORDER_TIME_DAY = 1

    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    ACCOUNT_TRADE_MODE_REAL = 2

    ACCOUNT_MARGIN_MODE_RETAIL_NETTING = 0
    ACCOUNT_MARGIN_MODE_EXCHANGE = 1
    ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2

    TIMEFRAME_SECONDS = {1: 60, 5: 300, 15: 900, 30: 1800, 16385: 3600, 16388: 14400}

    def __init__(
        self,
        *,
        hedging: bool = False,
        real: bool = False,
        server_offset_hours: float = 0.0,
        symbols: Optional[List[str]] = None,
    ) -> None:
        self.initialized = False
        self.init_ok = True
        self.init_calls: List[Any] = []
        self.connected = True
        self.trade_allowed = True
        self.login = 5001
        self.trade_mode = self.ACCOUNT_TRADE_MODE_REAL if real else self.ACCOUNT_TRADE_MODE_DEMO
        self.margin_mode = (
            self.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
            if hedging
            else self.ACCOUNT_MARGIN_MODE_RETAIL_NETTING
        )
        self.server_offset = server_offset_hours * 3600
        self.balance = 10_000.0
        self.symbols = {
            name: self._spec(name) for name in (symbols or ["EURUSDm", "GBPUSDm", "XAUUSD"])
        }
        self.prices = {name: (1.08000, 1.08010) for name in self.symbols}
        self.selected: List[str] = []
        self.positions: List[Dict[str, Any]] = []
        self.orders: List[Dict[str, Any]] = []
        self.deals: List[Dict[str, Any]] = []
        self.requests: List[Dict[str, Any]] = []
        self.rate_calls: List[Any] = []
        self.deal_calls: List[Any] = []
        self.next_ticket = 1000
        self.requotes = 0
        self.drop_sl = False
        self.reject_with: Optional[int] = None
        self.send_returns_none = False
        self.fail_reads = False
        self.error = (1, "Success")

    def _spec(self, name: str) -> SymbolInfo:
        return SymbolInfo(
            name=name,
            description=f"{name} description",
            path=f"Forex\\{name}",
            digits=5,
            point=0.00001,
            volume_min=0.01,
            volume_step=0.01,
            volume_max=100.0,
            trade_contract_size=100000.0,
            trade_stops_level=10,
            trade_freeze_level=0,
            trade_tick_value=1.0,
            trade_tick_size=0.00001,
            currency_base=name[:3],
            currency_profit="USD",
            currency_margin=name[:3],
            filling_mode=2,  # IOC only
            trade_mode=4,
            visible=True,
        )

    # --- helpers ------------------------------------------------------- #
    def server_now(self) -> float:
        return time.time() + self.server_offset

    def _ticket(self) -> int:
        self.next_ticket += 1
        return self.next_ticket

    def _result(self, retcode: int, **kw: Any) -> OrderSendResult:
        base = dict(deal=0, order=0, volume=0.0, price=0.0, bid=0.0, ask=0.0, comment="")
        base.update(kw)
        return OrderSendResult(retcode=retcode, request_id=len(self.requests), **base)

    def _position_tuple(self, p: Dict[str, Any]) -> TradePosition:
        bid, ask = self.prices[p["symbol"]]
        current = bid if p["type"] == 0 else ask
        sign = 1 if p["type"] == 0 else -1
        return TradePosition(
            ticket=p["ticket"],
            time=p["time"],
            type=p["type"],
            magic=p["magic"],
            identifier=p["ticket"],
            volume=p["volume"],
            price_open=p["price_open"],
            sl=p["sl"],
            tp=p["tp"],
            price_current=current,
            swap=0.0,
            profit=round((current - p["price_open"]) * p["volume"] * 100000 * sign, 2),
            symbol=p["symbol"],
            comment=p["comment"],
        )

    # --- connection ---------------------------------------------------- #
    def initialize(self, *args: Any, **kwargs: Any) -> bool:
        self.init_calls.append((args, kwargs))
        self.initialized = self.init_ok
        return self.init_ok

    def shutdown(self) -> None:
        self.initialized = False

    def last_error(self):
        return self.error

    def terminal_info(self):
        if not self.initialized:
            return None
        return TerminalInfo(self.connected, self.trade_allowed, "MetaTrader 5", "Fake", 4000)

    def account_info(self):
        if not self.initialized:
            return None
        profit = sum(self._position_tuple(p).profit for p in self.positions)
        return AccountInfo(
            login=self.login,
            trade_mode=self.trade_mode,
            margin_mode=self.margin_mode,
            leverage=100,
            balance=self.balance,
            credit=0.0,
            profit=profit,
            equity=self.balance + profit,
            margin=0.0,
            margin_free=self.balance + profit,
            margin_level=0.0,
            currency="USD",
            server="Fake-Demo",
            company="Fake Broker",
            name="Test",
        )

    # --- market data --------------------------------------------------- #
    def symbols_get(self, group: Optional[str] = None):
        return tuple(self.symbols.values())

    def symbol_info(self, name: str):
        return self.symbols.get(name)

    def symbol_select(self, name: str, enable: bool = True) -> bool:
        self.selected.append(name)
        return name in self.symbols

    def symbol_info_tick(self, name: str):
        if name not in self.symbols:
            return None
        bid, ask = self.prices[name]
        now = self.server_now()
        return Tick(int(now), bid, ask, 0.0, 0, int(now * 1000), 6, 0.0)

    def _bars(self, times: List[int]) -> np.ndarray:
        rows = [(t, 1.08, 1.081, 1.079, 1.0805, 100, 10, 0) for t in times]
        return np.array(rows, dtype=RATE_DTYPE)

    def copy_rates_from_pos(self, name: str, timeframe: int, start: int, count: int):
        self.rate_calls.append(("from_pos", name, timeframe, start, count))
        if name not in self.symbols:
            return None
        sec = self.TIMEFRAME_SECONDS.get(timeframe, 60)
        last = int(self.server_now() // sec) * sec
        return self._bars([last - i * sec for i in range(count - 1, -1, -1)])

    def copy_rates_range(self, name: str, timeframe: int, date_from: datetime, date_to: datetime):
        self.rate_calls.append(("range", name, timeframe, date_from, date_to))
        if name not in self.symbols:
            return None
        sec = self.TIMEFRAME_SECONDS.get(timeframe, 60)
        start = int(date_from.timestamp() // sec) * sec
        end = int(date_to.timestamp())
        return self._bars(list(range(start, end + 1, sec)))

    # --- account state ------------------------------------------------- #
    def positions_get(self, symbol: Optional[str] = None, ticket: Optional[int] = None):
        if not self.initialized or self.fail_reads:
            return None
        rows = self.positions
        if symbol is not None:
            rows = [p for p in rows if p["symbol"] == symbol]
        if ticket is not None:
            rows = [p for p in rows if p["ticket"] == ticket]
        return tuple(self._position_tuple(p) for p in rows)

    def orders_get(self, symbol: Optional[str] = None, ticket: Optional[int] = None):
        rows = self.orders
        if ticket is not None:
            rows = [o for o in rows if o["ticket"] == ticket]
        return tuple(TradeOrder(**o) for o in rows)

    def history_deals_get(self, date_from: datetime, date_to: datetime):
        self.deal_calls.append((date_from, date_to))
        lo, hi = date_from.timestamp(), date_to.timestamp()
        return tuple(TradeDeal(**d) for d in self.deals if lo <= d["time"] <= hi)

    # --- trading ------------------------------------------------------- #
    def order_send(self, request: Dict[str, Any]):
        self.requests.append(dict(request))
        if self.send_returns_none:
            return None
        if self.reject_with is not None:
            return self._result(self.reject_with, comment="rejected by test")
        action = request["action"]
        if action == self.TRADE_ACTION_DEAL:
            return self._deal(request)
        if action == self.TRADE_ACTION_PENDING:
            return self._pending(request)
        if action == self.TRADE_ACTION_SLTP:
            return self._sltp(request)
        if action == self.TRADE_ACTION_REMOVE:
            self.orders = [o for o in self.orders if o["ticket"] != request["order"]]
            return self._result(10009, order=request["order"])
        if action == self.TRADE_ACTION_MODIFY:
            for o in self.orders:
                if o["ticket"] == request["order"]:
                    o["price_open"] = request["price"]
                    o["price_stoplimit"] = request.get("stoplimit", o["price_stoplimit"])
            return self._result(10009, order=request["order"])
        return self._result(10013, comment="invalid request")

    def _stops_ok(self, symbol: str, buy: bool, sl: float) -> bool:
        if not sl:
            return True
        bid, ask = self.prices[symbol]
        ref = bid if buy else ask
        distance = (ref - sl) if buy else (sl - ref)
        return distance >= self.symbols[symbol].trade_stops_level * self.symbols[symbol].point

    def _record_deal(self, request, order: int, position: int, entry: int, price: float) -> int:
        ticket = self._ticket()
        now = self.server_now()
        self.deals.append(
            dict(
                ticket=ticket,
                order=order,
                time=int(now),
                time_msc=int(now * 1000),
                type=request["type"],
                entry=entry,
                magic=request.get("magic", 0),
                position_id=position,
                reason=3,
                volume=request["volume"],
                price=price,
                commission=0.0,
                swap=0.0,
                profit=0.0,
                fee=0.0,
                symbol=request["symbol"],
                comment=request.get("comment", ""),
            )
        )
        return ticket

    def _deal(self, request: Dict[str, Any]):
        if self.requotes > 0:
            self.requotes -= 1
            return self._result(10004, comment="Requote")
        symbol = request["symbol"]
        buy = request["type"] == self.ORDER_TYPE_BUY
        bid, ask = self.prices[symbol]
        price = ask if buy else bid
        if request.get("type_filling") not in (self.ORDER_FILLING_IOC,):
            return self._result(10030, comment="Unsupported filling mode")
        if not self._stops_ok(symbol, buy, request.get("sl", 0.0)):
            return self._result(10016, comment="Invalid stops")
        order = self._ticket()
        volume = request["volume"]
        sl = 0.0 if self.drop_sl else request.get("sl", 0.0)
        tp = request.get("tp", 0.0)

        target = request.get("position")
        if target is not None:  # hedging close by ticket
            pos = next(p for p in self.positions if p["ticket"] == target)
            pos["volume"] = round(pos["volume"] - volume, 8)
            if pos["volume"] <= 0:
                self.positions.remove(pos)
            deal = self._record_deal(request, order, target, 1, price)
            return self._result(10009, order=order, deal=deal, volume=volume, price=price)

        hedging = self.margin_mode == self.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
        existing = (
            None if hedging else next((p for p in self.positions if p["symbol"] == symbol), None)
        )
        if existing is None:
            self.positions.append(
                dict(
                    ticket=order,
                    time=int(self.server_now()),
                    type=0 if buy else 1,
                    magic=request.get("magic", 0),
                    volume=volume,
                    price_open=price,
                    sl=sl,
                    tp=tp,
                    symbol=symbol,
                    comment=request.get("comment", ""),
                )
            )
            deal = self._record_deal(request, order, order, 0, price)
        else:
            same_side = (existing["type"] == 0) == buy
            if same_side:
                existing["volume"] = round(existing["volume"] + volume, 8)
                if sl:
                    existing["sl"] = sl
                if tp:
                    existing["tp"] = tp
            else:
                remaining = round(existing["volume"] - volume, 8)
                if remaining > 0:
                    existing["volume"] = remaining
                elif remaining == 0:
                    self.positions.remove(existing)
                else:
                    existing.update(type=0 if buy else 1, volume=-remaining, price_open=price)
                    existing.update(sl=sl, tp=tp)
            deal = self._record_deal(request, order, existing["ticket"], 1, price)
        return self._result(10009, order=order, deal=deal, volume=volume, price=price)

    def _pending(self, request: Dict[str, Any]):
        ticket = self._ticket()
        self.orders.append(
            dict(
                ticket=ticket,
                time_setup=int(self.server_now()),
                type=request["type"],
                state=1,
                type_time=request.get("type_time", 0),
                type_filling=request.get("type_filling", 2),
                magic=request.get("magic", 0),
                volume_initial=request["volume"],
                volume_current=request["volume"],
                price_open=request["price"],
                sl=request.get("sl", 0.0),
                tp=request.get("tp", 0.0),
                price_current=request["price"],
                price_stoplimit=request.get("stoplimit", 0.0),
                symbol=request["symbol"],
                comment=request.get("comment", ""),
                position_id=0,
            )
        )
        return self._result(10008, order=ticket, volume=request["volume"])

    def _sltp(self, request: Dict[str, Any]):
        pos = next((p for p in self.positions if p["ticket"] == request["position"]), None)
        if pos is None:
            return self._result(10013, comment="position not found")
        if pos["sl"] == request["sl"] and pos["tp"] == request["tp"]:
            return self._result(10025, comment="No changes")
        if not self._stops_ok(pos["symbol"], pos["type"] == 0, request["sl"]):
            return self._result(10016, comment="Invalid stops")
        pos["sl"] = request["sl"]
        pos["tp"] = request["tp"]
        return self._result(10009)
