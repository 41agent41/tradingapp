"""Everything the sidecar does with the MetaTrader5 package.

The ``mt5`` module is passed in rather than imported, so the same code runs
against the real package on Windows (or Windows Python under Wine) and against
the fake in ``tests/fake_mt5.py`` in CI. Every public method returns the shapes
documented in ``broker_service/mt5_adapter.py``.

The MetaTrader5 package is not thread-safe and talks to a single terminal, so
callers hold ``Terminal.lock`` around every call (``server.py`` does).
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from typing import Any, Dict, Iterable, List, Optional

from config import Config
from server_time import ServerClock

# MT5's own timeframe names, as the adapter sends them.
_TIMEFRAMES = {
    "M1": "TIMEFRAME_M1",
    "M5": "TIMEFRAME_M5",
    "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H4": "TIMEFRAME_H4",
    "H8": "TIMEFRAME_H8",
    "D1": "TIMEFRAME_D1",
    "W1": "TIMEFRAME_W1",
    "MN1": "TIMEFRAME_MN1",
}

_MAX_BARS = 100_000
# MT5 truncates order comments beyond this.
_COMMENT_MAX = 31
# A market order is re-priced and resent this many times on a requote.
_MARKET_ATTEMPTS = 3

# Retcodes (MqlTradeResult.retcode). Kept as numbers because they are part of
# the terminal's protocol and identical in every build.
RETCODE_REQUOTE = 10004
RETCODE_PLACED = 10008
RETCODE_DONE = 10009
RETCODE_DONE_PARTIAL = 10010
RETCODE_NO_CHANGES = 10025
RETCODE_PRICE_CHANGED = 10020
RETCODE_PRICE_OFF = 10021
RETCODE_CLIENT_AUTOTRADING_DISABLED = 10027
RETCODE_CONNECTION = 10031
_RETRYABLE = {RETCODE_REQUOTE, RETCODE_PRICE_CHANGED, RETCODE_PRICE_OFF}
_SUCCESS = {RETCODE_DONE, RETCODE_DONE_PARTIAL, RETCODE_PLACED}

_EPS = 1e-9


class TerminalError(Exception):
    """A request the sidecar refuses or the terminal rejected.

    ``status`` is the HTTP status the server answers with: 4xx for a request
    that will fail the same way again, 503 when the terminal is unavailable.
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Terminal:
    def __init__(self, mt5: Any, config: Config) -> None:
        self.mt5 = mt5
        self.cfg = config
        self.clock = ServerClock(config.server_tz)
        self.lock = threading.RLock()
        self._symbols: Dict[str, str] = {}

    # ------------------------------------------------------------------ #
    # Connection
    # ------------------------------------------------------------------ #
    def connect(self) -> None:
        kwargs: Dict[str, Any] = {}
        if self.cfg.login:
            kwargs["login"] = self.cfg.login
            if self.cfg.password:
                kwargs["password"] = self.cfg.password
            if self.cfg.server:
                kwargs["server"] = self.cfg.server
        if self.cfg.portable:
            kwargs["portable"] = True
        # With a path, initialize() also launches the terminal if it is not
        # running, so a crashed terminal comes back on the next request.
        args = (self.cfg.terminal_path,) if self.cfg.terminal_path else ()
        if not self.mt5.initialize(*args, **kwargs):
            raise TerminalError(503, f"MT5 initialize failed: {self.mt5.last_error()}")
        self._symbols.clear()

    def ensure(self) -> Any:
        """Reattach if the terminal restarted, and refuse while it is offline."""
        info = self.mt5.terminal_info()
        if info is None:
            self.connect()
            info = self.mt5.terminal_info()
        if info is None or not info.connected:
            raise TerminalError(503, "MT5 terminal is not connected to the trade server")
        return info

    def _required(self, value: Any, what: str) -> Any:
        """``positions_get()`` and friends return None on failure and an empty
        tuple when there is nothing. Reading None as "no positions" would tell
        the app it is flat when it may not be."""
        if value is None:
            raise TerminalError(503, f"MT5 {what} unavailable: {self.mt5.last_error()}")
        return value

    def _account(self) -> Any:
        account = self.mt5.account_info()
        if account is None:
            raise TerminalError(503, f"MT5 account unavailable: {self.mt5.last_error()}")
        if self.cfg.login and int(account.login) != self.cfg.login:
            raise TerminalError(
                503,
                f"terminal is logged in to {account.login}, not MT5_LOGIN={self.cfg.login}",
            )
        return account

    def _hedging(self, account: Any) -> bool:
        return account.margin_mode == self.mt5.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING

    def _account_type(self, account: Any) -> str:
        if account.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_REAL:
            return "real"
        if account.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_CONTEST:
            return "contest"
        return "demo"

    # ------------------------------------------------------------------ #
    # Read side
    # ------------------------------------------------------------------ #
    def health(self) -> Dict[str, Any]:
        try:
            info = self.ensure()
            account = self._account()
        except TerminalError as exc:
            return {"status": "disconnected", "terminal_connected": False, "error": exc.message}
        trade_allowed = bool(info.trade_allowed)
        return {
            # Market data still works with Algo Trading off, but orders do not.
            "status": "ok" if trade_allowed else "trading_disabled",
            "terminal_connected": True,
            "trade_allowed": trade_allowed,
            "login": int(account.login),
            "server": account.server,
            "company": account.company,
            "currency": account.currency,
            "account_type": self._account_type(account),
            "margin_mode": "hedging" if self._hedging(account) else "netting",
            "server_tz": self.cfg.server_tz,
            "allow_real": self.cfg.allow_real,
        }

    def resolve(self, symbol: str) -> str:
        """The terminal's own spelling of ``symbol``, matched case-insensitively.

        The app sends venue symbols in their own case (``EURUSDm``) but may
        upper-case them elsewhere, so an exact match wins and a case-insensitive
        one is the fallback.
        """
        wanted = (symbol or "").strip()
        if not wanted:
            raise TerminalError(400, "symbol is required")
        self.ensure()
        name = self._lookup(wanted)
        if name is None:
            self._refresh_symbols()
            name = self._lookup(wanted)
        if name is None:
            raise TerminalError(404, f"symbol {wanted} not found on this account")
        # Off-Market-Watch symbols return no ticks until selected.
        self.mt5.symbol_select(name, True)
        return name

    def _lookup(self, wanted: str) -> Optional[str]:
        if wanted in self._symbols.values():
            return wanted
        return self._symbols.get(wanted.upper())

    def _refresh_symbols(self) -> None:
        self._symbols = {s.name.upper(): s.name for s in self.mt5.symbols_get() or ()}

    def symbols(self, query: str = "", limit: int = 50) -> Dict[str, Any]:
        self.ensure()
        q = (query or "").strip().upper()
        results = []
        for s in self.mt5.symbols_get() or ():
            description = getattr(s, "description", "") or ""
            if q and q not in s.name.upper() and q not in description.upper():
                continue
            results.append(
                {
                    "symbol": s.name,
                    "description": description or s.name,
                    "currency": getattr(s, "currency_profit", "") or "",
                    "secType": "CFD",
                    "exchange": "MT5",
                    "path": getattr(s, "path", "") or "",
                }
            )
            if len(results) >= max(1, limit):
                break
        return {"results": results, "count": len(results)}

    def history(
        self,
        symbol: str,
        timeframe: str,
        count: Optional[int] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Dict[str, Any]:
        const = _TIMEFRAMES.get((timeframe or "").upper())
        if const is None or not hasattr(self.mt5, const):
            raise TerminalError(400, f"timeframe {timeframe} is not supported")
        tf = getattr(self.mt5, const)
        name = self.resolve(symbol)
        if start and end:
            rates = self.mt5.copy_rates_range(
                name,
                tf,
                self.clock.server_datetime(_parse_time(start)),
                self.clock.server_datetime(_parse_time(end)),
            )
        else:
            n = max(1, min(int(count or 500), _MAX_BARS))
            rates = self.mt5.copy_rates_from_pos(name, tf, 0, n)
        if rates is None:
            raise TerminalError(502, f"no history for {name}: {self.mt5.last_error()}")
        bars = []
        for r in _rows(rates):
            bars.append(
                {
                    "time": int(self.clock.to_utc(r["time"])),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": int(r.get("tick_volume") or r.get("real_volume") or 0),
                }
            )
        return {"symbol": name, "timeframe": timeframe.upper(), "bars": bars}

    def tick(self, symbol: str) -> Dict[str, Any]:
        name = self.resolve(symbol)
        t = self.mt5.symbol_info_tick(name)
        if t is None:
            raise TerminalError(502, f"no tick for {name}: {self.mt5.last_error()}")
        server_ms = getattr(t, "time_msc", 0) or t.time * 1000
        return {
            "symbol": name,
            "bid": _nz(t.bid),
            "ask": _nz(t.ask),
            "last": _nz(t.last),
            "volume": int(getattr(t, "volume", 0) or 0),
            "time": round(self.clock.to_utc(server_ms / 1000.0), 3),
        }

    def symbol_info(self, symbol: str) -> Dict[str, Any]:
        name = self.resolve(symbol)
        info = self.mt5.symbol_info(name)
        if info is None:
            raise TerminalError(404, f"symbol {name} not found: {self.mt5.last_error()}")
        d = info._asdict()
        keys = (
            "description",
            "digits",
            "point",
            "volume_min",
            "volume_step",
            "volume_max",
            "trade_contract_size",
            "trade_stops_level",
            "trade_freeze_level",
            "trade_tick_value",
            "trade_tick_size",
            "currency_base",
            "currency_profit",
            "currency_margin",
            "filling_mode",
            "trade_mode",
        )
        # No "symbol" key: the adapter reads a nested {"symbol": {...}} when
        # one is present, and a bare string there would hide every field.
        return {"name": name, **{k: d.get(k) for k in keys}}

    def account(self) -> Dict[str, Any]:
        self.ensure()
        account = self._account()
        d = account._asdict()
        keys = (
            "login",
            "server",
            "company",
            "currency",
            "leverage",
            "balance",
            "credit",
            "profit",
            "equity",
            "margin",
            "margin_free",
            "margin_level",
        )
        return {
            **{k: d.get(k) for k in keys},
            "account_type": self._account_type(account),
            "margin_mode": "hedging" if self._hedging(account) else "netting",
        }

    def positions(self) -> Dict[str, Any]:
        self.ensure()
        rows = _rows(self._required(self.mt5.positions_get(), "positions"))
        by_symbol: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            by_symbol.setdefault(r["symbol"], []).append(r)
        out = []
        for name, tickets in by_symbol.items():
            row = self._aggregate(name, tickets)
            if row is not None:
                out.append(row)
        return {"positions": out}

    def _aggregate(self, name: str, tickets: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """One row per symbol, as the app expects.

        A hedging account can hold several tickets on one symbol. The row
        reports the net exposure, and the *least* protective stop among the
        tickets on the net side, with 0 when any of them has none: a ticket
        without a stop is exposure without protection, and the app must see it.
        """
        net = round(sum(_signed(t) for t in tickets), 8)
        if abs(net) < _EPS:
            return None
        long_ = net > 0
        side = [t for t in tickets if (_signed(t) > 0) == long_]
        volume = sum(float(t["volume"]) for t in side)
        price_open = sum(float(t["price_open"]) * float(t["volume"]) for t in side) / volume
        stops = [float(t.get("sl") or 0.0) for t in side]
        if any(s == 0.0 for s in stops):
            sl = 0.0
        else:
            sl = min(stops) if long_ else max(stops)
        targets = {float(t.get("tp") or 0.0) for t in side}
        tp = targets.pop() if len(targets) == 1 else 0.0
        return {
            "symbol": name,
            "type": 0 if long_ else 1,
            "volume": abs(net),
            "price_open": round(price_open, 10),
            "price_current": float(side[0].get("price_current") or 0.0),
            "sl": sl,
            "tp": tp,
            "profit": round(sum(float(t.get("profit") or 0.0) for t in tickets), 2),
            "swap": round(sum(float(t.get("swap") or 0.0) for t in tickets), 2),
            "tickets": [int(t["ticket"]) for t in tickets],
        }

    def orders(self) -> Dict[str, Any]:
        self.ensure()
        out = []
        for o in _rows(self._required(self.mt5.orders_get(), "orders")):
            order_type = int(o["type"])
            out.append(
                {
                    "ticket": int(o["ticket"]),
                    "symbol": o["symbol"],
                    "type": order_type,
                    "action": "SELL" if order_type % 2 == 1 else "BUY",
                    "order_type": self._order_type_name(order_type),
                    "volume_initial": float(o.get("volume_initial") or 0.0),
                    "volume_current": float(o.get("volume_current") or 0.0),
                    "price_open": float(o.get("price_open") or 0.0),
                    "sl": float(o.get("sl") or 0.0),
                    "tp": float(o.get("tp") or 0.0),
                    "comment": o.get("comment") or "",
                    "state": o.get("state"),
                    "time_setup": int(self.clock.to_utc(o.get("time_setup") or 0)),
                }
            )
        return {"orders": out}

    def _order_type_name(self, order_type: int) -> str:
        m = self.mt5
        if order_type in (m.ORDER_TYPE_BUY_LIMIT, m.ORDER_TYPE_SELL_LIMIT):
            return "LMT"
        if order_type in (m.ORDER_TYPE_BUY_STOP, m.ORDER_TYPE_SELL_STOP):
            return "STP"
        if order_type in (m.ORDER_TYPE_BUY_STOP_LIMIT, m.ORDER_TYPE_SELL_STOP_LIMIT):
            return "STP_LMT"
        return "MKT"

    def deals(self, days: int = 1) -> Dict[str, Any]:
        self.ensure()
        now = time.time()
        since = now - max(1, int(days)) * 86400
        # The upper bound is padded because the server clock may run ahead of
        # UTC by the server's offset.
        rows = self.mt5.history_deals_get(
            self.clock.server_datetime(since), self.clock.server_datetime(now + 86400)
        )
        if rows is None:
            raise TerminalError(502, f"deal history unavailable: {self.mt5.last_error()}")
        out = []
        for d in _rows(rows):
            at = self.clock.to_utc(d["time"])
            if at < since:
                continue
            out.append(
                {
                    "ticket": int(d["ticket"]),
                    "order": int(d.get("order") or 0),
                    "position_id": int(d.get("position_id") or 0),
                    "symbol": d.get("symbol") or "",
                    "type": int(d["type"]),
                    "entry": int(d.get("entry") or 0),
                    "volume": float(d.get("volume") or 0.0),
                    "price": float(d.get("price") or 0.0),
                    "commission": float(d.get("commission") or 0.0),
                    "swap": float(d.get("swap") or 0.0),
                    "fee": float(d.get("fee") or 0.0),
                    "profit": float(d.get("profit") or 0.0),
                    "magic": int(d.get("magic") or 0),
                    "comment": d.get("comment") or "",
                    "time": int(at),
                }
            )
        return {"deals": out}

    # ------------------------------------------------------------------ #
    # Trading
    # ------------------------------------------------------------------ #
    def place_order(self, body: Dict[str, Any]) -> Dict[str, Any]:
        info = self.ensure()
        account = self._account()
        self._check_account_mode(account, body.get("account_mode"))
        if not info.trade_allowed:
            raise TerminalError(
                409, "Algo Trading is switched off in the MT5 terminal; orders cannot be sent"
            )

        name = self.resolve(str(body.get("symbol") or ""))
        spec = self.mt5.symbol_info(name)
        if spec is None:
            raise TerminalError(404, f"symbol {name} not found")
        action = str(body.get("action") or "").upper()
        if action not in ("BUY", "SELL"):
            raise TerminalError(400, "action must be BUY or SELL")
        volume = _check_volume(spec, body.get("quantity"))
        order_type = str(body.get("order_type") or "MKT").upper()
        digits = int(getattr(spec, "digits", 5) or 5)
        sl = _price(body.get("sl"), digits)
        tp = _price(body.get("tp"), digits)

        request: Dict[str, Any] = {
            "symbol": name,
            "volume": volume,
            "magic": self.cfg.magic,
            "comment": str(body.get("comment") or "")[:_COMMENT_MAX],
            # SL and TP go in the same request as the entry, so the position
            # never exists without its stop.
            "sl": sl or 0.0,
            "tp": tp or 0.0,
        }

        if order_type == "MKT":
            if self._hedging(account):
                opposite = self._opposite_tickets(name, action)
                if opposite:
                    return self._close_hedged(name, action, volume, opposite, spec)
            request.update(
                {
                    "action": self.mt5.TRADE_ACTION_DEAL,
                    "type": self._side(action),
                    "deviation": self.cfg.deviation,
                    "type_filling": self._filling(spec),
                    "type_time": self.mt5.ORDER_TIME_GTC,
                }
            )
            result = self._send_market(request, name, action)
            position = self._position_for(result.order, name)
            return self._order_result(result, position)

        request.update(self._pending_fields(order_type, action, body, digits))
        result = self._send(request)
        pending = _first(self.mt5.orders_get(ticket=result.order))
        return self._order_result(result, pending)

    def _check_account_mode(self, account: Any, account_mode: Any) -> None:
        mode = str(account_mode or "paper").lower()
        real = account.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_REAL
        if real and not self.cfg.allow_real:
            raise TerminalError(
                403,
                "this sidecar is attached to a real-money account and MT5_ALLOW_REAL is not set",
            )
        if real and mode != "live":
            raise TerminalError(403, f"{mode} order refused: the account is a real-money account")
        if not real and mode == "live":
            raise TerminalError(403, "live order refused: the account is a demo account")

    def _side(self, action: str) -> int:
        return self.mt5.ORDER_TYPE_BUY if action == "BUY" else self.mt5.ORDER_TYPE_SELL

    def _filling(self, spec: Any) -> int:
        """The first fill policy the symbol allows (SYMBOL_FILLING_* bits)."""
        mode = int(getattr(spec, "filling_mode", 0) or 0)
        if mode & 1:
            return self.mt5.ORDER_FILLING_FOK
        if mode & 2:
            return self.mt5.ORDER_FILLING_IOC
        return self.mt5.ORDER_FILLING_RETURN

    def _pending_fields(
        self, order_type: str, action: str, body: Dict[str, Any], digits: int
    ) -> Dict[str, Any]:
        m = self.mt5
        buy = action == "BUY"
        limit = _price(body.get("limit_price"), digits)
        stop = _price(body.get("stop_price"), digits)
        tif = str(body.get("tif") or "GTC").upper()
        if tif not in ("GTC", "DAY"):
            raise TerminalError(400, f"tif {tif} is not supported for pending orders on MT5")
        fields: Dict[str, Any] = {
            "action": m.TRADE_ACTION_PENDING,
            "type_filling": m.ORDER_FILLING_RETURN,
            "type_time": m.ORDER_TIME_DAY if tif == "DAY" else m.ORDER_TIME_GTC,
        }
        if order_type == "LMT":
            if not limit:
                raise TerminalError(400, "limit_price is required for LMT orders")
            fields.update(type=m.ORDER_TYPE_BUY_LIMIT if buy else m.ORDER_TYPE_SELL_LIMIT)
            fields["price"] = limit
        elif order_type == "STP":
            if not stop:
                raise TerminalError(400, "stop_price is required for STP orders")
            fields.update(type=m.ORDER_TYPE_BUY_STOP if buy else m.ORDER_TYPE_SELL_STOP)
            fields["price"] = stop
        elif order_type == "STP_LMT":
            if not stop or not limit:
                raise TerminalError(400, "stop_price and limit_price are required for STP_LMT")
            fields.update(type=m.ORDER_TYPE_BUY_STOP_LIMIT if buy else m.ORDER_TYPE_SELL_STOP_LIMIT)
            fields["price"] = stop
            fields["stoplimit"] = limit
        else:
            raise TerminalError(400, f"order_type {order_type} is not supported")
        return fields

    def _send(self, request: Dict[str, Any]) -> Any:
        result = self.mt5.order_send(request)
        if result is None:
            raise TerminalError(503, f"order_send failed: {self.mt5.last_error()}")
        if result.retcode not in _SUCCESS:
            raise _rejected(result)
        return result

    def _send_market(self, request: Dict[str, Any], name: str, action: str) -> Any:
        result = None
        for _ in range(_MARKET_ATTEMPTS):
            tick = self.mt5.symbol_info_tick(name)
            if tick is None:
                raise TerminalError(502, f"no price for {name}: {self.mt5.last_error()}")
            request["price"] = tick.ask if action == "BUY" else tick.bid
            result = self.mt5.order_send(request)
            if result is None:
                raise TerminalError(503, f"order_send failed: {self.mt5.last_error()}")
            if result.retcode not in _RETRYABLE:
                break
        if result.retcode not in _SUCCESS:
            raise _rejected(result)
        return result

    def _position_for(self, order_ticket: int, name: str) -> Optional[Any]:
        """The position an order opened or added to.

        On a hedging account the position's ticket is the opening order's; on
        a netting account there is at most one position per symbol.
        """
        found = _first(self.mt5.positions_get(ticket=order_ticket))
        if found is not None:
            return found
        on_symbol = self.mt5.positions_get(symbol=name) or ()
        return on_symbol[0] if len(on_symbol) == 1 else None

    def _order_result(self, result: Any, holder: Optional[Any]) -> Dict[str, Any]:
        """The response to ``POST /orders``.

        ``sl``/``tp`` are read back from the position (or pending order), not
        copied from the request, so a stop the venue dropped shows as null.
        """
        status = {
            RETCODE_DONE: "filled",
            RETCODE_DONE_PARTIAL: "partially_filled",
            RETCODE_PLACED: "submitted",
        }.get(result.retcode, "submitted")
        return {
            "order_id": int(result.order),
            "ticket": int(result.order),
            "deal": int(getattr(result, "deal", 0) or 0),
            "status": status,
            "retcode": int(result.retcode),
            "price": _nz(getattr(result, "price", None)),
            "volume": _nz(getattr(result, "volume", None)),
            "sl": _nz(getattr(holder, "sl", None)) if holder is not None else None,
            "tp": _nz(getattr(holder, "tp", None)) if holder is not None else None,
        }

    def _opposite_tickets(self, name: str, action: str) -> List[Dict[str, Any]]:
        closing_type = (
            self.mt5.POSITION_TYPE_SELL if action == "BUY" else self.mt5.POSITION_TYPE_BUY
        )
        held = self._required(self.mt5.positions_get(symbol=name), "positions")
        rows = [p for p in _rows(held) if p["type"] == closing_type]
        return sorted(rows, key=lambda p: (p.get("time") or 0, p["ticket"]))

    def _close_hedged(
        self,
        name: str,
        action: str,
        volume: float,
        opposite: List[Dict[str, Any]],
        spec: Any,
    ) -> Dict[str, Any]:
        """Close opposite tickets oldest first, as a netting account would.

        On a hedging account a SELL against a long opens a second, short
        ticket unless it names the position it closes. Reversing through flat
        would need an entry with its own stop, so it is refused.
        """
        held = sum(float(p["volume"]) for p in opposite)
        if volume > held + _EPS:
            raise TerminalError(
                400,
                f"{action} {volume} would reverse a {held}-lot hedged position; "
                "close it first, then enter",
            )
        remaining = volume
        last = None
        for p in opposite:
            if remaining <= _EPS:
                break
            chunk = round(min(remaining, float(p["volume"])), 8)
            request = {
                "action": self.mt5.TRADE_ACTION_DEAL,
                "symbol": name,
                "volume": chunk,
                "type": self._side(action),
                "position": int(p["ticket"]),
                "deviation": self.cfg.deviation,
                "type_filling": self._filling(spec),
                "type_time": self.mt5.ORDER_TIME_GTC,
                "magic": self.cfg.magic,
            }
            try:
                last = self._send_market(request, name, action)
            except TerminalError as exc:
                closed = round(volume - remaining, 8)
                raise TerminalError(
                    exc.status, f"closed {closed} of {volume} lots, then: {exc.message}"
                ) from exc
            remaining = round(remaining - chunk, 8)
        return self._order_result(last, None)

    def modify_stop(self, symbol: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """``TRADE_ACTION_SLTP`` on every ticket of the symbol's net side.

        An absent or null ``tp`` keeps each ticket's take-profit, and a null
        ``sl`` keeps its stop: this endpoint never clears protection.
        """
        self.ensure()
        name = self.resolve(symbol)
        spec = self.mt5.symbol_info(name)
        digits = int(getattr(spec, "digits", 5) or 5)
        sl = _price(body.get("sl"), digits)
        tp = _price(body.get("tp"), digits)
        if sl is None and tp is None:
            raise TerminalError(400, "sl or tp is required")

        tickets = _rows(self._required(self.mt5.positions_get(symbol=name), "positions"))
        net = sum(_signed(t) for t in tickets)
        if abs(net) < _EPS:
            raise TerminalError(404, f"no open position on {name}")
        side = [t for t in tickets if (_signed(t) > 0) == (net > 0)]
        for t in side:
            new_sl = sl if sl is not None else float(t.get("sl") or 0.0)
            new_tp = tp if tp is not None else float(t.get("tp") or 0.0)
            if new_sl == float(t.get("sl") or 0.0) and new_tp == float(t.get("tp") or 0.0):
                continue
            result = self.mt5.order_send(
                {
                    "action": self.mt5.TRADE_ACTION_SLTP,
                    "position": int(t["ticket"]),
                    "symbol": name,
                    "sl": new_sl,
                    "tp": new_tp,
                    "magic": self.cfg.magic,
                }
            )
            if result is None:
                raise TerminalError(503, f"order_send failed: {self.mt5.last_error()}")
            if result.retcode not in (RETCODE_DONE, RETCODE_NO_CHANGES):
                raise _rejected(result)

        row = self._aggregate(name, _rows(self.mt5.positions_get(symbol=name)))
        return {
            "status": "modified",
            "sl": _nz(row["sl"]) if row else None,
            "tp": _nz(row["tp"]) if row else None,
        }

    def cancel_order(self, ticket: int) -> Dict[str, Any]:
        self.ensure()
        if _first(self.mt5.orders_get(ticket=ticket)) is None:
            return {"status": "not_found"}
        self._send({"action": self.mt5.TRADE_ACTION_REMOVE, "order": int(ticket)})
        return {"status": "cancelled"}

    def modify_order(self, ticket: int, body: Dict[str, Any]) -> Dict[str, Any]:
        self.ensure()
        order = _first(self.mt5.orders_get(ticket=ticket))
        if order is None:
            raise TerminalError(404, f"no working order {ticket}")
        quantity = body.get("quantity")
        if quantity is not None and abs(float(quantity) - float(order.volume_current)) > _EPS:
            raise TerminalError(
                400, "MT5 cannot change a working order's volume; cancel it and place a new one"
            )
        spec = self.mt5.symbol_info(order.symbol)
        digits = int(getattr(spec, "digits", 5) or 5)
        kind = self._order_type_name(int(order.type))
        limit = _price(body.get("limit_price"), digits)
        stop = _price(body.get("stop_price"), digits)
        request: Dict[str, Any] = {
            "action": self.mt5.TRADE_ACTION_MODIFY,
            "order": int(ticket),
            "symbol": order.symbol,
            "price": float(order.price_open),
            "sl": float(order.sl or 0.0),
            "tp": float(order.tp or 0.0),
            "type_time": order.type_time,
        }
        if kind == "LMT" and limit:
            request["price"] = limit
        elif kind == "STP" and stop:
            request["price"] = stop
        elif kind == "STP_LMT":
            if stop:
                request["price"] = stop
            if limit:
                request["stoplimit"] = limit
        self._send(request)
        return {"status": "modified"}


# ---------------------------------------------------------------------- #
# Helpers
# ---------------------------------------------------------------------- #
def _rows(data: Any) -> List[Dict[str, Any]]:
    """MT5 results as dicts: numpy record arrays (rates) or named tuples."""
    if data is None:
        return []
    names = getattr(getattr(data, "dtype", None), "names", None)
    if names:
        return [{n: _plain(r[n]) for n in names} for r in data]
    out = []
    for r in data:
        if isinstance(r, dict):
            out.append(dict(r))
        elif hasattr(r, "_asdict"):
            out.append(r._asdict())
    return out


def _plain(value: Any) -> Any:
    return value.item() if hasattr(value, "item") else value


def _first(items: Optional[Iterable[Any]]) -> Optional[Any]:
    for item in items or ():
        return item
    return None


def _signed(position: Dict[str, Any]) -> float:
    volume = float(position["volume"])
    return -volume if int(position["type"]) == 1 else volume


def _nz(value: Any) -> Optional[float]:
    """MT5 uses 0.0 for "not set"; the app uses null."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v != 0.0 else None


def _price(value: Any, digits: int) -> Optional[float]:
    try:
        v = float(value) if value is not None else None
    except (TypeError, ValueError) as exc:
        raise TerminalError(400, f"invalid price {value!r}") from exc
    if v is None or v == 0.0:
        return None
    if v < 0:
        raise TerminalError(400, f"invalid price {value!r}")
    return round(v, digits)


def _check_volume(spec: Any, quantity: Any) -> float:
    """Refuse a volume the symbol does not allow rather than rounding it."""
    try:
        volume = float(quantity)
    except (TypeError, ValueError):
        raise TerminalError(400, f"invalid quantity {quantity!r}")
    step = float(getattr(spec, "volume_step", 0.0) or 0.0)
    vmin = float(getattr(spec, "volume_min", 0.0) or 0.0)
    vmax = float(getattr(spec, "volume_max", 0.0) or 0.0)
    if volume <= 0 or volume < vmin - _EPS:
        raise TerminalError(400, f"quantity {volume} is below the minimum {vmin} lots")
    if vmax and volume > vmax + _EPS:
        raise TerminalError(400, f"quantity {volume} is above the maximum {vmax} lots")
    if step:
        steps = volume / step
        if abs(steps - round(steps)) > 1e-6:
            raise TerminalError(400, f"quantity {volume} is not a multiple of the {step}-lot step")
    return round(volume, 8)


def _rejected(result: Any) -> TerminalError:
    code = int(result.retcode)
    text = f"MT5 rejected the request: retcode {code} ({getattr(result, 'comment', '')})"
    if code == RETCODE_CONNECTION:
        return TerminalError(503, text)
    if code == RETCODE_CLIENT_AUTOTRADING_DISABLED:
        return TerminalError(409, text)
    return TerminalError(400, text)


def _parse_time(value: str) -> float:
    s = str(value).strip()
    try:
        return float(s)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TerminalError(400, f"invalid time {value!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()
