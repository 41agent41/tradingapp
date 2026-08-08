"""Systematic-strategy evaluation endpoint (Systematic Trading roadmap A2).

Stateless: given OHLCV bars + a rule-set (or a registered rule-strategy key)
and an optional live position, return the signal for the **newest closed bar**.
No IB gateway, no database and no order placement — it just runs the compiled
rules, so the backend strategy runner (A2) can poll it once per closed bar.

  POST /strategies/evaluate — evaluate a rule-set against the latest bar,
                              plus the trail stop for an open position (E-3)
"""

from __future__ import annotations

from typing import Any, Dict, List

import pandas as pd
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from backtesting import AVAILABLE_STRATEGIES
from observability import get_logger
from rule_strategy import Position, RuleSetError, RuleStrategy, compile_rule_strategy

logger = get_logger(__name__)
router = APIRouter()


class BarInput(BaseModel):
    timestamp: int = Field(..., description="Unix epoch seconds for the bar")
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class PositionInput(BaseModel):
    size: float = 0.0
    avg_price: float = 0.0


class EvaluateRequest(BaseModel):
    bars: List[BarInput] = Field(..., min_length=1)
    rule_set: Dict[str, Any] | None = Field(
        None, description="Inline declarative rule-set (mutually exclusive with 'strategy')."
    )
    strategy: str | None = Field(
        None, description="Registered rule-strategy key (mutually exclusive with 'rule_set')."
    )
    position: PositionInput | None = Field(
        None, description="Current live position; defaults to flat."
    )


def _resolve_strategy(request: EvaluateRequest) -> RuleStrategy:
    """Compile the inline rule-set or look up a registered rule strategy."""

    if bool(request.rule_set) == bool(request.strategy):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide exactly one of 'rule_set' or 'strategy'.",
        )

    if request.rule_set is not None:
        try:
            return compile_rule_strategy(request.rule_set)
        except RuleSetError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    strategy_cls = AVAILABLE_STRATEGIES.get(request.strategy)
    if strategy_cls is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown strategy '{request.strategy}'.",
        )
    strat = strategy_cls()
    if not isinstance(strat, RuleStrategy):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Strategy '{request.strategy}' is not a rule-driven strategy.",
        )
    return strat


@router.post("/strategies/evaluate")
async def evaluate_strategy(request: EvaluateRequest) -> Dict[str, Any]:
    """Evaluate a rule strategy against the latest bar and return its signal."""

    strat = _resolve_strategy(request)

    # Build the OHLCV frame with a datetime index from unix seconds, matching
    # the convention used everywhere else in the service.
    df = pd.DataFrame([bar.model_dump() for bar in request.bars]).sort_values("timestamp")
    df.index = pd.to_datetime(df["timestamp"], unit="s")

    position = Position(
        size=request.position.size if request.position else 0.0,
        avg_price=request.position.avg_price if request.position else 0.0,
    )

    try:
        result = strat.evaluate(df, position)
    except (RuleSetError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # The trail rides along with the evaluation (E-3). Trailing is not a
    # signal — it happens on every bar a position is open, including bars the
    # rules say nothing about — but computing it here means the caller gets the
    # decision and the desired stop from one round trip, off the same bars.
    trail: Dict[str, Any] = {"stop_price": None, "direction": None, "error": None}
    if position.size != 0:
        try:
            trail = strat.trail_stop(df, position)
        except (RuleSetError, ValueError) as exc:
            trail = {"stop_price": None, "direction": None, "error": str(exc)}

    return {"success": True, "bars_evaluated": len(df), "trail": trail, **result}
