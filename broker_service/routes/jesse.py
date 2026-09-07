"""Jesse framework endpoints — catalogue, source, and a bars-in backtest.

  GET  /jesse/strategies          — every Jesse strategy with its hyperparameters
  GET  /jesse/strategies/{key}    — one strategy, including its Python source
  GET  /jesse/indicators          — the ``ta.*`` functions available to authors
  POST /jesse/backtest            — run a strategy on caller-supplied bars

The IB-backed backtest and the live signal both go through the shared routes
(``POST /backtesting/run`` with ``strategy=jesse_…`` or a
``{"engine": "jesse"}`` body; ``POST /strategies/evaluate`` likewise), so the
backend and UI need no Jesse-specific path. This module is the authoring-side
surface: what exists, how it is parameterised, and a way to backtest against
bars the caller already has (e.g. from TimescaleDB) without touching IB.
"""

from __future__ import annotations

import inspect
from typing import Any, Dict, List

import pandas as pd
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from jesse import backtest as jesse_backtest
from jesse import indicators as ta
from jesse import registry
from jesse import timeframes as tf
from jesse.adapter import to_backtest_results
from jesse.models import StrategyError
from jesse.strategy import describe_hyperparameters
from observability import get_logger

logger = get_logger(__name__)
router = APIRouter()

MIN_BARS = 20


def _describe(key: str, cls) -> Dict[str, Any]:
    instance = cls()
    return {
        "key": key,
        "engine": "jesse",
        "class_name": cls.__name__,
        "name": instance.name,
        "description": (cls.__doc__ or "").strip() or "No description available",
        "hyperparameters": describe_hyperparameters(instance.hyperparameters()),
        "module": cls.__module__,
    }


@router.get("/jesse/strategies")
async def list_jesse_strategies() -> Dict[str, Any]:
    strategies = {key: _describe(key, cls) for key, cls in registry.all_strategies().items()}
    return {
        "strategies": strategies,
        "count": len(strategies),
        "timeframes": [tf.to_app(t) for t in tf.SUPPORTED],
        "definition_example": {
            "engine": "jesse",
            "strategy": next(iter(strategies), "jesse_sma_crossover"),
            "hyperparameters": {},
        },
    }


@router.get("/jesse/strategies/{key}")
async def get_jesse_strategy(key: str) -> Dict[str, Any]:
    try:
        cls = registry.get(key)
    except StrategyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    info = _describe(registry.key_for(cls), cls)
    try:
        info["source"] = inspect.getsource(cls)
    except (OSError, TypeError):
        info["source"] = None
    return info


@router.get("/jesse/indicators")
async def list_jesse_indicators() -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    for name in ta.AVAILABLE:
        fn = getattr(ta, name)
        items.append(
            {
                "name": name,
                "signature": str(inspect.signature(fn)),
                "description": (fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else "",
            }
        )
    return {"indicators": items, "count": len(items)}


class BarInput(BaseModel):
    timestamp: int = Field(..., description="Unix epoch seconds")
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class JesseBacktestRequest(BaseModel):
    strategy: str = Field(..., description="Catalogue key or class name")
    bars: List[BarInput] = Field(..., min_length=1)
    symbol: str = "MSFT"
    timeframe: str = Field(..., description="Bar timeframe, e.g. '5min' or '5m'")
    hyperparameters: Dict[str, Any] | None = None
    starting_balance: float = Field(100_000.0, gt=0)
    fee_rate: float = Field(0.001, ge=0, le=1)
    leverage: int = Field(1, ge=1, le=100)
    warmup_candles: int | None = Field(None, ge=0)
    include_orders: bool = False
    include_logs: bool = False


@router.post("/jesse/backtest")
async def run_jesse_backtest(request: JesseBacktestRequest) -> Dict[str, Any]:
    """Backtest a Jesse strategy on the bars in the request body."""

    try:
        cls = registry.get(request.strategy)
    except StrategyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    if len(request.bars) < MIN_BARS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Need at least {MIN_BARS} bars, got {len(request.bars)}",
        )
    try:
        timeframe = tf.to_app(request.timeframe)
    except tf.TimeframeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    df = pd.DataFrame([bar.model_dump() for bar in request.bars]).sort_values("timestamp")
    df.index = pd.to_datetime(df["timestamp"], unit="s")

    try:
        result = jesse_backtest.run(
            cls,
            df,
            symbol=request.symbol.upper(),
            timeframe=timeframe,
            starting_balance=request.starting_balance,
            fee_rate=request.fee_rate,
            leverage=request.leverage,
            hyperparameters=request.hyperparameters,
            warmup_candles=request.warmup_candles,
        )
    except StrategyError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    payload = result.to_dict()
    if not request.include_orders:
        payload.pop("orders", None)
    if not request.include_logs:
        payload.pop("logs", None)
    # The same shape the /backtest page renders, for callers that want parity.
    payload["results"] = to_backtest_results(result).to_dict()
    return {"success": True, **payload}
