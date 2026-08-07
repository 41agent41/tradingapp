"""
Rule-driven strategy definitions (Systematic Trading roadmap — Phase 1 / A1).
==============================================================================

This module turns a **declarative rule-set** (plain JSON, editable in the UI)
into a :class:`RuleStrategy` — a subclass of
:class:`backtesting.TradingStrategy` whose ``generate_signals`` evaluates the
rules against each bar. Because it is a plain ``TradingStrategy`` it drops
straight into the existing :meth:`backtesting.BacktestEngine.run_backtest`
**unchanged**, and it registers alongside ``AVAILABLE_STRATEGIES`` so the
``/backtest`` page can select it like any other strategy.

Scope (Phase 1 — backtest only)
--------------------------------
The rule model is intentionally the *rich* one confirmed in
``SYSTEMATIC_TRADING_ROADMAP.md`` §A1:

* **Operands** — constants, bar fields (``open``/``high``/``low``/``close``/
  ``volume``), indicator columns (``sma_20``, ``rsi``, …), **multi-timeframe**
  indicator operands (``{"indicator": "rsi", "timeframe": "1hour"}``) and
  **position-aware** fields (``position.size`` / ``position.avg_price`` /
  ``position.unrealized_pct``).
* **Operators** — ``>`` ``<`` ``>=`` ``<=`` ``crosses_above`` ``crosses_below``.
* **Groups** — ``all`` / ``any``, nestable.
* **Sessions** — time-of-day / day-of-week windows in an explicit timezone;
  entry/exit rules only fire inside them, with an optional
  ``flat_at_session_end`` that forces a flat at each session boundary.

``sizing`` and ``scale_out`` are now **simulated as well as executed**: the
backtest engine resolves the sizing block through :mod:`sizing` and drives
:meth:`RuleStrategy.evaluate_scale_out` per bar for partial exits, so a
backtest and a live run of the same definition trade the same size and take
the same partial profits. ``risk`` remains live-only — its caps (orders per
day, daily loss) are session-scoped concepts a historical backtest has no
counterpart for.

Carried through but **not** simulated:

* **Position-aware operands** evaluate against the strategy's ``self.position``,
  which is ``0`` (flat) throughout the engine's single up-front
  ``generate_signals`` pass — exactly as the existing ``SimpleMAStrategy``
  already behaves. The operand *code* is fully general (see the unit tests that
  drive it with arbitrary position state); the live runner (A2/A3) is what
  threads real fills in. This keeps A1 a drop-in with **no engine change** and
  guarantees the ``SimpleMAStrategy`` parity case.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import time as dt_time
from typing import Any, Dict, List, Sequence, Union

import numpy as np
import pandas as pd
import pytz

from backtesting import TradingStrategy
from indicators import calculator as indicator_calculator

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #

BAR_FIELDS = {"open", "high", "low", "close", "volume"}
POSITION_FIELDS = {"size", "avg_price", "unrealized_pct"}
COMPARISON_OPERATORS = {">", "<", ">=", "<="}
CROSS_OPERATORS = {"crosses_above", "crosses_below"}
VALID_OPERATORS = COMPARISON_OPERATORS | CROSS_OPERATORS

# Map an indicator *column* (what a rule references) to the *request name*
# understood by ``IndicatorCalculator.calculate_indicators``. Several columns
# come from a single request (e.g. macd → macd/macd_signal/macd_histogram).
INDICATOR_COLUMN_TO_REQUEST: Dict[str, str] = {
    "sma_20": "sma_20",
    "sma_50": "sma_50",
    "ema_12": "ema_12",
    "ema_26": "ema_26",
    "rsi": "rsi",
    "macd": "macd",
    "macd_signal": "macd",
    "macd_histogram": "macd",
    "bb_upper": "bollinger",
    "bb_middle": "bollinger",
    "bb_lower": "bollinger",
    "stoch_k": "stochastic",
    "stoch_d": "stochastic",
    "atr": "atr",
    "obv": "obv",
    "vwap": "vwap",
    "volume_sma": "volume_sma",
}

# Timeframe token → pandas resample offset alias (for multi-timeframe operands).
TIMEFRAME_TO_OFFSET: Dict[str, str] = {
    "1min": "1min",
    "5min": "5min",
    "15min": "15min",
    "30min": "30min",
    "1hour": "1h",
    "4hour": "4h",
    "8hour": "8h",
    "1day": "1D",
}

_WEEKDAY_NAMES = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}


class RuleSetError(ValueError):
    """Raised when a rule-set fails to compile."""


# --------------------------------------------------------------------------- #
# Evaluation context + position state
# --------------------------------------------------------------------------- #


@dataclass
class Position:
    """The position state an operand may reference.

    In the Phase 1 backtest this is always flat (``size == 0``); the live
    runner (A2/A3) supplies real state. ``unrealized_pct`` is derived from the
    supplied ``last_price`` so a caller only has to set ``size``/``avg_price``.
    """

    size: float = 0.0
    avg_price: float = 0.0
    last_price: float = float("nan")

    @property
    def unrealized_pct(self) -> float:
        if self.size == 0 or self.avg_price <= 0 or not np.isfinite(self.last_price):
            return 0.0
        direction = 1.0 if self.size > 0 else -1.0
        return direction * (self.last_price - self.avg_price) / self.avg_price * 100.0


@dataclass
class EvalContext:
    """Everything an operand/condition needs to evaluate at one bar."""

    row: pd.Series
    prev: pd.Series | None
    position: Position

    def _column(self, name: str, previous: bool = False) -> float:
        source = self.prev if previous else self.row
        if source is None or name not in source:
            return float("nan")
        try:
            return float(source[name])
        except (TypeError, ValueError):
            return float("nan")


# --------------------------------------------------------------------------- #
# Operands
# --------------------------------------------------------------------------- #


class Operand:
    """Base operand — resolves to a float for the current (or previous) bar."""

    def value(self, ctx: EvalContext) -> float:  # pragma: no cover - abstract
        raise NotImplementedError

    def prev_value(self, ctx: EvalContext) -> float:  # pragma: no cover - abstract
        raise NotImplementedError

    # The set of primary-timeframe indicator *requests* this operand needs.
    def primary_requests(self) -> set[str]:
        return set()

    # (timeframe, column) pairs for higher-timeframe indicator operands.
    def higher_tf_columns(self) -> set[tuple[str, str]]:
        return set()


@dataclass
class ConstOperand(Operand):
    const: float

    def value(self, ctx: EvalContext) -> float:
        return self.const

    def prev_value(self, ctx: EvalContext) -> float:
        return self.const


@dataclass
class BarFieldOperand(Operand):
    field_name: str

    def value(self, ctx: EvalContext) -> float:
        return ctx._column(self.field_name)

    def prev_value(self, ctx: EvalContext) -> float:
        return ctx._column(self.field_name, previous=True)


@dataclass
class IndicatorOperand(Operand):
    indicator: str
    timeframe: str | None = None

    @property
    def column(self) -> str:
        return f"{self.indicator}@{self.timeframe}" if self.timeframe else self.indicator

    def value(self, ctx: EvalContext) -> float:
        return ctx._column(self.column)

    def prev_value(self, ctx: EvalContext) -> float:
        return ctx._column(self.column, previous=True)

    def primary_requests(self) -> set[str]:
        if self.timeframe:
            return set()
        return {INDICATOR_COLUMN_TO_REQUEST[self.indicator]}

    def higher_tf_columns(self) -> set[tuple[str, str]]:
        if self.timeframe:
            return {(self.timeframe, self.indicator)}
        return set()


@dataclass
class PositionOperand(Operand):
    field_name: str

    def value(self, ctx: EvalContext) -> float:
        return float(getattr(ctx.position, self.field_name))

    # Position has no "previous bar" — crosses on it never fire, which is the
    # intended behaviour (position fields are threshold checks, not crosses).
    def prev_value(self, ctx: EvalContext) -> float:
        return self.value(ctx)


def parse_operand(spec: Any) -> Operand:
    """Parse a single operand specification into an :class:`Operand`."""

    if isinstance(spec, bool):
        raise RuleSetError(f"Boolean is not a valid operand: {spec!r}")
    if isinstance(spec, (int, float)):
        return ConstOperand(float(spec))
    if isinstance(spec, str):
        if spec.startswith("position."):
            field_name = spec.split(".", 1)[1]
            if field_name not in POSITION_FIELDS:
                raise RuleSetError(
                    f"Unknown position field '{field_name}'. " f"Valid: {sorted(POSITION_FIELDS)}"
                )
            return PositionOperand(field_name)
        if spec in BAR_FIELDS:
            return BarFieldOperand(spec)
        if spec in INDICATOR_COLUMN_TO_REQUEST:
            return IndicatorOperand(spec)
        raise RuleSetError(
            f"Unknown operand '{spec}'. Expected a number, a bar field "
            f"{sorted(BAR_FIELDS)}, a known indicator column, or 'position.<field>'."
        )
    if isinstance(spec, dict):
        if "indicator" in spec:
            indicator = spec["indicator"]
            if indicator not in INDICATOR_COLUMN_TO_REQUEST:
                raise RuleSetError(f"Unknown indicator column '{indicator}'.")
            timeframe = spec.get("timeframe")
            if timeframe is not None and timeframe not in TIMEFRAME_TO_OFFSET:
                raise RuleSetError(
                    f"Unknown timeframe '{timeframe}'. Valid: {sorted(TIMEFRAME_TO_OFFSET)}"
                )
            return IndicatorOperand(indicator, timeframe)
        if "field" in spec and spec["field"] in BAR_FIELDS:
            return BarFieldOperand(spec["field"])
        raise RuleSetError(f"Unrecognised operand object: {spec!r}")
    raise RuleSetError(f"Unrecognised operand: {spec!r}")


# --------------------------------------------------------------------------- #
# Conditions + groups
# --------------------------------------------------------------------------- #


@dataclass
class Condition:
    left: Operand
    op: str
    right: Operand

    def evaluate(self, ctx: EvalContext) -> bool:
        lv = self.left.value(ctx)
        rv = self.right.value(ctx)
        if self.op in COMPARISON_OPERATORS:
            if not (np.isfinite(lv) and np.isfinite(rv)):
                return False
            if self.op == ">":
                return lv > rv
            if self.op == "<":
                return lv < rv
            if self.op == ">=":
                return lv >= rv
            return lv <= rv
        # Cross operators need the previous bar's values too.
        lp = self.left.prev_value(ctx)
        rp = self.right.prev_value(ctx)
        if not all(np.isfinite(v) for v in (lv, rv, lp, rp)):
            return False
        if self.op == "crosses_above":
            return lp <= rp and lv > rv
        return lp >= rp and lv < rv  # crosses_below


@dataclass
class Group:
    mode: str  # "all" or "any"
    children: List[Union[Group, Condition]] = field(default_factory=list)

    def evaluate(self, ctx: EvalContext) -> bool:
        if not self.children:
            # An empty group is vacuously false so an omitted entry/exit never
            # fires (rather than firing on every bar).
            return False
        results = (child.evaluate(ctx) for child in self.children)
        return all(results) if self.mode == "all" else any(results)


def _compile_condition(spec: Dict[str, Any]) -> Condition:
    if "op" not in spec or "left" not in spec or "right" not in spec:
        raise RuleSetError(f"Condition needs 'left', 'op' and 'right': {spec!r}")
    op = spec["op"]
    if op not in VALID_OPERATORS:
        raise RuleSetError(f"Unknown operator '{op}'. Valid: {sorted(VALID_OPERATORS)}")
    return Condition(parse_operand(spec["left"]), op, parse_operand(spec["right"]))


def _compile_group(spec: Any) -> Group:
    if not isinstance(spec, dict):
        raise RuleSetError(f"Rule group must be an object, got {spec!r}")
    if "all" in spec and "any" in spec:
        raise RuleSetError("A rule group may not have both 'all' and 'any'.")
    mode = "all" if "all" in spec else "any" if "any" in spec else None
    if mode is None:
        raise RuleSetError(f"Rule group needs an 'all' or 'any' list: {spec!r}")
    raw_children = spec[mode]
    if not isinstance(raw_children, list):
        raise RuleSetError(f"'{mode}' must be a list of conditions/groups.")
    children: List[Union[Group, Condition]] = []
    for child in raw_children:
        if isinstance(child, dict) and ("all" in child or "any" in child):
            children.append(_compile_group(child))
        else:
            children.append(_compile_condition(child))
    return Group(mode, children)


def _walk_operands(node: Union[Group, Condition]) -> Sequence[Operand]:
    if isinstance(node, Condition):
        return [node.left, node.right]
    operands: List[Operand] = []
    for child in node.children:
        operands.extend(_walk_operands(child))
    return operands


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #


@dataclass
class SessionWindow:
    tz: str
    days: set[int]  # weekday numbers (Mon=0 … Sun=6); empty = every day
    start: dt_time
    end: dt_time


def _parse_hhmm(value: str) -> dt_time:
    try:
        hh, mm = value.split(":")
        return dt_time(int(hh), int(mm))
    except (ValueError, AttributeError):
        raise RuleSetError(f"Invalid HH:MM time '{value}'.")


def _compile_sessions(specs: Any) -> List[SessionWindow]:
    if not specs:
        return []
    if not isinstance(specs, list):
        raise RuleSetError("'sessions' must be a list of window objects.")
    windows: List[SessionWindow] = []
    for spec in specs:
        tz = spec.get("tz", "UTC")
        try:
            pytz.timezone(tz)
        except pytz.UnknownTimeZoneError:
            raise RuleSetError(f"Unknown timezone '{tz}'.")
        day_names = spec.get("days") or []
        days: set[int] = set()
        for name in day_names:
            key = str(name).strip().lower()[:3]
            if key not in _WEEKDAY_NAMES:
                raise RuleSetError(f"Unknown day '{name}'.")
            days.add(_WEEKDAY_NAMES[key])
        windows.append(
            SessionWindow(
                tz=tz,
                days=days,
                start=_parse_hhmm(spec["from"]),
                end=_parse_hhmm(spec["to"]),
            )
        )
    return windows


def session_mask(index: pd.DatetimeIndex, windows: Sequence[SessionWindow]) -> np.ndarray:
    """Boolean mask: is each timestamp inside any of the session windows?

    A naive index is treated as UTC (matching how the backtest engine builds
    its index from unix seconds).
    """

    n = len(index)
    if not windows:
        return np.ones(n, dtype=bool)
    if not isinstance(index, pd.DatetimeIndex):
        raise RuleSetError("Sessions require a DatetimeIndex.")

    mask = np.zeros(n, dtype=bool)
    localized = index.tz_localize("UTC") if index.tz is None else index
    for window in windows:
        local = localized.tz_convert(window.tz)
        minutes = local.hour * 60 + local.minute
        start_min = window.start.hour * 60 + window.start.minute
        end_min = window.end.hour * 60 + window.end.minute
        if end_min >= start_min:
            time_ok = (minutes >= start_min) & (minutes <= end_min)
        else:  # window crosses midnight
            time_ok = (minutes >= start_min) | (minutes <= end_min)
        if window.days:
            day_ok = np.isin(local.dayofweek, list(window.days))
            mask |= np.asarray(day_ok) & np.asarray(time_ok)
        else:
            mask |= np.asarray(time_ok)
    return mask


# --------------------------------------------------------------------------- #
# RuleStrategy
# --------------------------------------------------------------------------- #


class RuleStrategy(TradingStrategy):
    """A :class:`TradingStrategy` compiled from a declarative rule-set."""

    def __init__(self, rule_set: Dict[str, Any]):
        if not isinstance(rule_set, dict):
            raise RuleSetError("rule_set must be an object.")

        self.rule_set = rule_set
        name = str(rule_set.get("name") or "Rule Strategy")

        if "entry" not in rule_set:
            raise RuleSetError("rule_set requires an 'entry' group.")
        self.entry = _compile_group(rule_set["entry"])
        # Exit is optional — a strategy may rely solely on session-flat / the
        # engine's end-of-backtest close.
        self.exit = _compile_group(rule_set["exit"]) if rule_set.get("exit") else Group("any", [])

        self.sessions = _compile_sessions(rule_set.get("sessions"))
        self.flat_at_session_end = bool(rule_set.get("flat_at_session_end", False))

        # `sizing` and `scale_out` are now simulated by the backtest engine as
        # well as driving live execution, so the rung conditions are compiled
        # here rather than merely shape-checked — `evaluate_scale_out` below is
        # what the engine drives per bar. `risk` stays live-only: its caps are
        # about order rate and daily loss across a *session*, which a backtest
        # over historical bars has no equivalent of.
        self.sizing = _validate_sizing(rule_set.get("sizing"))
        self.risk = dict(rule_set.get("risk") or {})
        self.scale_out = _validate_scale_out(rule_set.get("scale_out"))
        self._scale_out_conditions = [_compile_condition(rung["when"]) for rung in self.scale_out]
        self.broker = rule_set.get("broker")
        self.symbol = rule_set.get("symbol")
        self.primary_timeframe = rule_set.get("timeframe")

        # Resolve the indicator requirements from every operand — including the
        # scale-out rungs, so a rung that references an indicator the entry/exit
        # rules don't (say an ATR-based profit target) still gets its column
        # computed instead of evaluating against NaN and never firing.
        operands: List[Operand] = (
            list(_walk_operands(self.entry))
            + list(_walk_operands(self.exit))
            + [
                operand
                for condition in self._scale_out_conditions
                for operand in _walk_operands(condition)
            ]
        )
        primary_requests: set[str] = set()
        higher_tf: Dict[str, set[str]] = {}
        for operand in operands:
            primary_requests |= operand.primary_requests()
            for tf, col in operand.higher_tf_columns():
                higher_tf.setdefault(tf, set()).add(col)

        # Union in any explicitly-declared indicators (validated as requests).
        declared = rule_set.get("indicators") or []
        valid_requests = set(INDICATOR_COLUMN_TO_REQUEST.values())
        for req in declared:
            if req not in valid_requests:
                raise RuleSetError(
                    f"Unknown indicator '{req}' in 'indicators'. "
                    f"Valid requests: {sorted(valid_requests)}"
                )
            primary_requests.add(req)

        self._higher_tf_columns = higher_tf  # {timeframe: {column, …}}

        super().__init__(name=name, indicators=sorted(primary_requests))

    # -- signal generation -------------------------------------------------- #

    def _prepared(self, df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
        """Copy ``df``, merge higher-timeframe indicator columns and compute the
        session mask — shared by the batch backtest pass and live evaluation."""

        signals = df.copy()
        for timeframe, columns in self._higher_tf_columns.items():
            self._merge_higher_timeframe(signals, timeframe, columns)
        in_session = session_mask(signals.index, self.sessions)
        return signals, in_session

    def prepare_stateful(self, df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
        """Prepare a frame once for a **bar-by-bar** backtest pass.

        Returns the enriched frame (higher-timeframe columns merged) plus the
        session mask, so :meth:`evaluate_bar` can be called per bar with the
        engine's running position. Presence of this method is what tells
        :class:`backtesting.BacktestEngine` the strategy is position-aware.
        """

        return self._prepared(df)

    def evaluate_bar(
        self,
        signals: pd.DataFrame,
        i: int,
        in_session: np.ndarray,
        position_size: float = 0.0,
        avg_price: float = 0.0,
    ) -> Dict[str, Any]:
        """Evaluate the rules at bar ``i`` against a caller-supplied position.

        The position is passed as plain floats (rather than a :class:`Position`)
        so the backtest engine never has to import this module — keeping the
        dependency one-way (``rule_strategy`` → ``backtesting``).
        """

        row = signals.iloc[i]
        prev_row = signals.iloc[i - 1] if i >= 1 else None
        position = Position(
            size=float(position_size),
            avg_price=float(avg_price),
            last_price=float(row.get("close", float("nan"))),
        )
        ctx = EvalContext(row=row, prev=prev_row, position=position)

        buy = False
        sell = False
        buy_reason = ""
        sell_reason = ""

        if in_session[i]:
            if self.entry.evaluate(ctx):
                buy = True
                buy_reason = f"{self.name}: entry rules met"
            if self.exit.evaluate(ctx):
                sell = True
                sell_reason = f"{self.name}: exit rules met"

        # Force flat on the last in-session bar of each contiguous window.
        n = len(signals)
        if self.flat_at_session_end and in_session[i] and (i == n - 1 or not in_session[i + 1]):
            sell = True
            if not sell_reason:
                sell_reason = f"{self.name}: session-end flat"

        return {"buy": buy, "sell": sell, "buy_reason": buy_reason, "sell_reason": sell_reason}

    def evaluate_scale_out(
        self,
        signals: pd.DataFrame,
        i: int,
        position_size: float = 0.0,
        avg_price: float = 0.0,
    ) -> List[Dict[str, Any]]:
        """Which scale-out rungs fire at bar ``i`` for the given position.

        Returns one entry per firing rung as
        ``{"index": k, "reduce_pct": float, "reason": str}``. ``index`` is the
        rung's position in the declared list and is what lets the caller fire
        each rung **at most once per open trade** — without it, a rung like
        "reduce 50% at +3%" would re-fire on every subsequent bar that stayed
        above +3% and bleed the position to nothing.

        A rung is only meaningful against an open position, so a flat position
        fires nothing. Like :meth:`evaluate_bar`, the position is passed as
        plain floats so the backtest engine never imports this module.
        """

        if not self._scale_out_conditions or position_size == 0:
            return []

        row = signals.iloc[i]
        prev_row = signals.iloc[i - 1] if i >= 1 else None
        position = Position(
            size=float(position_size),
            avg_price=float(avg_price),
            last_price=float(row.get("close", float("nan"))),
        )
        ctx = EvalContext(row=row, prev=prev_row, position=position)

        fired: List[Dict[str, Any]] = []
        for index, condition in enumerate(self._scale_out_conditions):
            if not condition.evaluate(ctx):
                continue
            rung = self.scale_out[index]
            try:
                reduce_pct = float(rung.get("reduce_pct", 0))
            except (TypeError, ValueError):
                reduce_pct = 0.0
            if reduce_pct <= 0:
                continue
            fired.append(
                {
                    "index": index,
                    "reduce_pct": min(reduce_pct, 100.0),
                    "reason": f"{self.name}: scale-out rung {index + 1} ({reduce_pct:g}%)",
                }
            )
        return fired

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """Batch signal pass for engines that don't drive :meth:`evaluate_bar`.

        Position-aware operands see the strategy's static ``self.position``
        here, so a caller that wants live position semantics (the backtest
        engine, the live runner) must use :meth:`evaluate_bar` instead. The two
        share one implementation so they cannot drift.
        """

        # Merge higher-timeframe columns + session mask (no look-ahead — see
        # ``_merge_higher_timeframe``).
        signals, in_session = self._prepared(df)

        n = len(signals)
        buy = np.zeros(n, dtype=bool)
        sell = np.zeros(n, dtype=bool)
        buy_reason = [""] * n
        sell_reason = [""] * n

        for i in range(n):
            decision = self.evaluate_bar(signals, i, in_session, float(self.position), 0.0)
            buy[i] = decision["buy"]
            sell[i] = decision["sell"]
            buy_reason[i] = decision["buy_reason"]
            sell_reason[i] = decision["sell_reason"]

        signals["buy_signal"] = buy
        signals["sell_signal"] = sell
        signals["buy_reason"] = buy_reason
        signals["sell_reason"] = sell_reason
        return signals

    def evaluate(self, df: pd.DataFrame, position: Position | None = None) -> Dict[str, Any]:
        """Evaluate the rules against the **newest closed bar** of ``df`` for a
        given live ``position`` (Systematic Trading roadmap A2 — the stateless
        signal the live runner polls per closed bar).

        Unlike the backtest pass this threads real position state
        (``size`` + ``avg_price``), so position-aware operands are meaningful
        live. It computes the primary indicators itself (there is no engine to
        do it here), applies the shared higher-timeframe merge + session prep,
        and evaluates only the last bar. The returned ``signal`` is
        position-aware: ``buy`` only when flat, ``sell`` only when long.

        ``flat_at_session_end`` is intentionally *not* applied here — forcing a
        flat at a session boundary is a clock-driven concern the runner owns (it
        must observe that the session was left), not something derivable from a
        single closed bar.
        """

        if df is None or len(df) == 0:
            raise ValueError("evaluate() needs at least one bar.")

        position = position or Position()

        # Compute the primary-timeframe indicators the rules reference, then the
        # shared higher-TF merge + session prep.
        enriched = indicator_calculator.calculate_indicators(df, self.indicators)
        signals, in_session = self._prepared(enriched)

        last = len(signals) - 1
        row = signals.iloc[last]
        prev_row = signals.iloc[last - 1] if last >= 1 else None
        position.last_price = float(row.get("close", float("nan")))
        ctx = EvalContext(row=row, prev=prev_row, position=position)

        entry = bool(in_session[last] and self.entry.evaluate(ctx))
        exit_ = bool(in_session[last] and self.exit.evaluate(ctx))

        if entry and position.size <= 0:
            signal = "buy"
        elif exit_ and position.size > 0:
            signal = "sell"
        else:
            signal = "none"

        bar_time = signals.index[last]
        return {
            "signal": signal,
            "entry": entry,
            "exit": exit_,
            "entry_reason": f"{self.name}: entry rules met" if entry else "",
            "exit_reason": f"{self.name}: exit rules met" if exit_ else "",
            "in_session": bool(in_session[last]),
            "bar_time": (bar_time.isoformat() if hasattr(bar_time, "isoformat") else str(bar_time)),
            "position": {"size": position.size, "avg_price": position.avg_price},
            "strategy": self.name,
        }

    def _merge_higher_timeframe(
        self, signals: pd.DataFrame, timeframe: str, columns: set[str]
    ) -> None:
        """Resample to ``timeframe``, compute the needed indicators and merge
        them onto ``signals`` as ``<column>@<timeframe>`` columns.

        Each higher-timeframe bar covers ``[open, close)`` (``closed='left'``)
        and is stamped on its **close** (``label='right'``), then joined with an
        as-of *backward* merge, so a higher-timeframe value only becomes visible
        once its bar has closed — no look-ahead.
        """

        if not isinstance(signals.index, pd.DatetimeIndex):
            raise RuleSetError("Multi-timeframe operands require a DatetimeIndex.")

        offset = TIMEFRAME_TO_OFFSET[timeframe]
        ohlcv = signals[["open", "high", "low", "close", "volume"]]
        resampled = ohlcv.resample(offset, label="right", closed="left").agg(
            {
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }
        )
        resampled = resampled.dropna(subset=["close"])

        requests = sorted({INDICATOR_COLUMN_TO_REQUEST[col] for col in columns})
        enriched = indicator_calculator.calculate_indicators(resampled, requests)

        rename = {col: f"{col}@{timeframe}" for col in columns}
        higher = enriched[list(columns)].rename(columns=rename)

        merged = pd.merge_asof(
            signals[[]].sort_index(),
            higher.sort_index(),
            left_index=True,
            right_index=True,
            direction="backward",
        )
        for target in rename.values():
            signals[target] = merged[target].to_numpy()


# --------------------------------------------------------------------------- #
# Light validation for A3-only fields (carried through, not simulated in P1)
# --------------------------------------------------------------------------- #

_VALID_SIZING_TYPES = {"fixed", "notional", "pct_equity"}
_VALID_SIZING_UNITS = {"broker_default", "shares", "lots", "notional", "pct_equity"}


def _validate_sizing(spec: Any) -> Dict[str, Any]:
    if spec is None:
        return {"type": "fixed", "unit": "broker_default", "size": 0}
    if not isinstance(spec, dict):
        raise RuleSetError("'sizing' must be an object.")
    sizing_type = spec.get("type", "fixed")
    if sizing_type not in _VALID_SIZING_TYPES:
        raise RuleSetError(f"Unknown sizing type '{sizing_type}'.")
    unit = spec.get("unit", "broker_default")
    if unit not in _VALID_SIZING_UNITS:
        raise RuleSetError(f"Unknown sizing unit '{unit}'.")
    return dict(spec)


def _validate_scale_out(spec: Any) -> List[Dict[str, Any]]:
    if spec is None:
        return []
    if not isinstance(spec, list):
        raise RuleSetError("'scale_out' must be a list.")
    for rung in spec:
        if not isinstance(rung, dict) or "when" not in rung:
            raise RuleSetError("Each scale_out rung needs a 'when' condition.")
        _compile_condition(rung["when"])  # validate the condition shape
        # `reduce_pct` is what the rung actually *does*, so a malformed one is
        # rejected at compile time rather than silently reducing by nothing.
        if "reduce_pct" in rung:
            try:
                reduce_pct = float(rung["reduce_pct"])
            except (TypeError, ValueError):
                raise RuleSetError(f"scale_out reduce_pct must be a number: {rung['reduce_pct']!r}")
            if not 0 < reduce_pct <= 100:
                raise RuleSetError(f"scale_out reduce_pct must be in (0, 100], got {reduce_pct:g}.")
    return list(spec)


# --------------------------------------------------------------------------- #
# Public API — compile + example registry
# --------------------------------------------------------------------------- #


def compile_rule_strategy(rule_set: Dict[str, Any]) -> RuleStrategy:
    """Compile a rule-set dict into a ready-to-run :class:`RuleStrategy`."""

    return RuleStrategy(rule_set)


# A pure-rules restatement of the built-in ``SimpleMAStrategy`` (20/50 SMA).
# The position-aware gates mirror the class's ``position <= 0`` / ``position > 0``
# guards so it produces the *identical* backtest — see the parity test.
MA_CROSSOVER_PARITY_RULE_SET: Dict[str, Any] = {
    "name": "MA Crossover (20/50)",
    "description": "Rule-driven restatement of the built-in 20/50 SMA crossover.",
    "timeframe": "1day",
    "indicators": ["sma_20", "sma_50"],
    "entry": {
        "all": [
            {"left": "sma_20", "op": ">", "right": "sma_50"},
            {"left": "position.size", "op": "<=", "right": 0},
        ]
    },
    "exit": {
        "all": [
            {"left": "sma_20", "op": "<", "right": "sma_50"},
            {"left": "position.size", "op": ">", "right": 0},
        ]
    },
}

# Example strategies registered into the catalogue (see ``build_example_...``).
RULE_STRATEGY_EXAMPLES: Dict[str, Dict[str, Any]] = {
    "rule_ma_crossover": {
        "name": "MA Crossover (rules)",
        "description": (
            "Rule-driven 20/50 SMA crossover: go long when SMA20 crosses above "
            "SMA50 and exit when it crosses back below."
        ),
        "timeframe": "1day",
        "indicators": ["sma_20", "sma_50"],
        "entry": {"all": [{"left": "sma_20", "op": "crosses_above", "right": "sma_50"}]},
        "exit": {"all": [{"left": "sma_20", "op": "crosses_below", "right": "sma_50"}]},
        "sizing": {"type": "fixed", "unit": "broker_default", "size": 100},
        "risk": {"max_orders_per_day": 4},
    },
    # The showcase required by the Phase 1 DoD: multi-timeframe + session +
    # position-aware in one definition.
    "rule_mtf_session": {
        "name": "MA + 1h RSI, RTH session, pyramiding cap",
        "description": (
            "SMA20 crosses above SMA50 confirmed by a 1-hour RSI below 60, only "
            "inside the US regular session, capped by a position-size pyramiding "
            "limit. Exits on SMA cross-down, 1-hour RSI above 70, or a -2% "
            "unrealised stop; flat at session end."
        ),
        "symbol": "MSFT",
        "broker": "ib",
        "timeframe": "5min",
        "indicators": ["sma_20", "sma_50", "rsi"],
        "sessions": [
            {
                "tz": "America/New_York",
                "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
                "from": "09:45",
                "to": "15:30",
            }
        ],
        "flat_at_session_end": True,
        "entry": {
            "all": [
                {"left": "sma_20", "op": "crosses_above", "right": "sma_50"},
                {"left": {"indicator": "rsi", "timeframe": "1hour"}, "op": "<", "right": 60},
                {"left": "position.size", "op": "<", "right": 300},
            ]
        },
        "exit": {
            "any": [
                {"left": "sma_20", "op": "crosses_below", "right": "sma_50"},
                {"left": {"indicator": "rsi", "timeframe": "1hour"}, "op": ">", "right": 70},
                {"left": "position.unrealized_pct", "op": "<=", "right": -2.0},
            ]
        },
        "scale_out": [
            {
                "when": {"left": "position.unrealized_pct", "op": ">=", "right": 3.0},
                "reduce_pct": 50,
            }
        ],
        "sizing": {"type": "fixed", "unit": "shares", "size": 100},
        "risk": {"max_orders_per_day": 4, "stop_loss_pct": 2.0},
    },
}


def make_rule_strategy_class(rule_set: Dict[str, Any]) -> type:
    """Wrap a rule-set as a zero-arg strategy class for ``AVAILABLE_STRATEGIES``.

    The catalogue endpoint instantiates strategies with no arguments and reads
    ``.name`` / ``.indicators`` / ``.__doc__``, so the returned class binds the
    rule-set and exposes the description as its docstring.
    """

    description = str(rule_set.get("description") or rule_set.get("name") or "Rule strategy")

    class _RuleStrategyExample(RuleStrategy):
        def __init__(self) -> None:
            super().__init__(rule_set)

    _RuleStrategyExample.__doc__ = description
    _RuleStrategyExample.__name__ = "RuleStrategyExample"
    _RuleStrategyExample.__qualname__ = "RuleStrategyExample"
    return _RuleStrategyExample


def build_example_strategy_classes() -> Dict[str, type]:
    """Build ``{key: strategy_class}`` for every example rule-set."""

    return {key: make_rule_strategy_class(rs) for key, rs in RULE_STRATEGY_EXAMPLES.items()}


# Register the example rule strategies into the shared ``AVAILABLE_STRATEGIES``
# registry so the catalogue endpoint and ``/backtest`` expose them. This lives
# at the bottom (and uses a module-form import) so that whichever of
# ``backtesting`` / ``rule_strategy`` is imported first, the other is fully
# defined by the time this runs — see ``backtesting.py``'s trailing import.
import backtesting  # noqa: E402  (deferred to avoid a circular import)

backtesting.AVAILABLE_STRATEGIES.update(build_example_strategy_classes())
