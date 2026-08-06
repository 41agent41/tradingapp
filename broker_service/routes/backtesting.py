"""Backtesting endpoints — strategy catalogue and run.

The run endpoint accepts either a registered strategy key (``strategy=``) or an
inline declarative ``rule_set`` in the JSON body (the same shape
``/strategies/evaluate`` takes), so a user-created definition can be backtested
before it is deployed as a live run — the "if it can't be backtested, it can't
be traded" parity rule from ``SYSTEMATIC_TRADING_ROADMAP.md``.

Instrument scope: ``sec_type`` / ``exchange`` / ``currency`` select the
contract (previously hardcoded to STK/SMART/USD) and ``source=`` dispatches
the data fetch through the broker-scoped adapter registry, so a backtest can
run on any instrument any configured venue serves bars for.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Dict

import pandas as pd
from fastapi import APIRouter, Body, HTTPException, status
from pydantic import BaseModel

from backtesting import AVAILABLE_STRATEGIES, backtest_engine
from ib_client import get_ib_connection, verify_connection_health
from ib_helpers import convert_period, create_contract
from observability import get_logger
from rule_strategy import RuleSetError, compile_rule_strategy

logger = get_logger(__name__)
router = APIRouter()

MIN_BARS = 50  # minimum data for a meaningful backtest

TIMEFRAME_MAP = {
    "tick": "1 secs",  # Tick data - use 1 second as closest approximation
    "1min": "1 min",
    "5min": "5 mins",
    "15min": "15 mins",
    "30min": "30 mins",
    "1hour": "1 hour",
    "4hour": "4 hours",
    "8hour": "8 hours",
    "1day": "1 day",
}


class BacktestRunBody(BaseModel):
    """Optional JSON body for ``POST /backtesting/run``.

    ``rule_set`` is a declarative rule-set (see ``rule_strategy.py``) compiled
    on the fly — mutually exclusive with the ``strategy`` query parameter.
    """

    rule_set: Dict[str, Any] | None = None


@router.get("/backtesting/strategies")
async def get_available_strategies():
    """Get list of available backtesting strategies"""
    try:
        strategies_info = {}
        for key, strategy_class in AVAILABLE_STRATEGIES.items():
            # Create temporary instance to get info
            temp_strategy = strategy_class()
            strategies_info[key] = {
                "name": temp_strategy.name,
                "indicators": temp_strategy.indicators,
                "description": strategy_class.__doc__ or "No description available",
            }

        return {
            "strategies": strategies_info,
            "usage": "Use strategy key in backtest requests, or POST a rule_set body",
        }
    except Exception as e:
        logger.error(f"Error getting available strategies: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available strategies: {str(e)}",
        )


def _resolve_strategy_instance(strategy: str | None, rule_set: Dict[str, Any] | None):
    """Exactly one of a registered key or an inline rule-set selects the strategy."""

    if bool(strategy) == bool(rule_set):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide exactly one of the 'strategy' parameter or a 'rule_set' body.",
        )
    if rule_set is not None:
        try:
            return compile_rule_strategy(rule_set)
        except RuleSetError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if strategy not in AVAILABLE_STRATEGIES:
        available = list(AVAILABLE_STRATEGIES.keys())
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown strategy '{strategy}'. Available strategies: {available}",
        )
    return AVAILABLE_STRATEGIES[strategy]()


def _fetch_ib_bars(
    symbol: str,
    sec_type: str,
    exchange: str,
    currency: str,
    ib_timeframe: str,
    ib_duration: str,
    end_date_str: str,
) -> list[dict]:
    """Fetch and shape historical bars from IB for the backtest."""

    ib = get_ib_connection()
    if not verify_connection_health(ib):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="IB Gateway connection is not available",
        )

    # Qualify the contract so non-default instruments (futures, FX, non-USD)
    # resolve the same way the /market-data/history route resolves them.
    contract = create_contract(symbol, sec_type, exchange, currency)
    ib.contracts = []
    ib.reqContractDetails(1, contract)
    time.sleep(2)
    if not ib.contracts:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Symbol {symbol} ({sec_type} on {exchange} in {currency}) not found",
        )
    qualified_contract = ib.contracts[0]

    # Clear previous data
    ib.historical_data = []

    # Request historical data
    ib.reqHistoricalData(
        3,  # reqId for backtest
        qualified_contract,
        end_date_str,
        ib_duration,
        ib_timeframe,
        "TRADES",
        1,  # useRTH
        1,  # formatDate
        False,  # keepUpToDate
        [],  # chartOptions
    )

    # Wait for data
    time.sleep(8)  # Longer wait for more data

    if not ib.historical_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No historical data available for {symbol} backtesting",
        )

    logger.info(f"Retrieved {len(ib.historical_data)} bars for backtesting")

    bars_data = []
    for bar in ib.historical_data:
        try:
            # Handle different date formats from IB
            if isinstance(bar.date, str):
                # String format like "20250725 23:30:00"
                if " " in bar.date:
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d %H:%M:%S")
                else:
                    # Date only format like "20250725"
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d")
            elif isinstance(bar.date, (int, float)):
                # Unix timestamp
                bar_datetime = datetime.fromtimestamp(bar.date)
            else:
                # Assume it's already a datetime object
                bar_datetime = bar.date

            bars_data.append(
                {
                    "timestamp": int(bar_datetime.timestamp()),
                    "open": float(bar.open),
                    "high": float(bar.high),
                    "low": float(bar.low),
                    "close": float(bar.close),
                    "volume": int(bar.volume),
                }
            )
        except Exception as e:
            logger.warning(f"Error processing bar for backtesting: {e}, bar.date={bar.date}")
            continue
    return bars_data


def _fetch_adapter_bars(
    source: str,
    symbol: str,
    timeframe: str,
    period: str,
    start_date: str | None,
    end_date: str | None,
) -> list[dict]:
    """Fetch bars for a non-IB venue through its market-data adapter."""

    from adapters import get_market_data_adapter

    adapter = get_market_data_adapter(source)
    result = adapter.historical_bars(
        symbol,
        timeframe,
        period,
        start_date=start_date,
        end_date=end_date,
        indicators=None,
        account_mode="paper",
    )
    return [
        {
            "timestamp": int(bar.timestamp),
            "open": float(bar.open),
            "high": float(bar.high),
            "low": float(bar.low),
            "close": float(bar.close),
            "volume": int(bar.volume or 0),
        }
        for bar in result.bars
    ]


@router.post("/backtesting/run")
async def run_backtest(
    symbol: str,
    strategy: str = None,
    timeframe: str = "1hour",
    period: str = "1Y",
    initial_capital: float = 100000,
    commission: float = 0.001,
    start_date: str = None,
    end_date: str = None,
    sec_type: str = "STK",
    exchange: str = "SMART",
    currency: str = "USD",
    source: str = "ib",
    body: BacktestRunBody | None = Body(None),
):
    """Run backtest on historical data"""
    try:
        rule_set = body.rule_set if body else None
        strategy_instance = _resolve_strategy_instance(strategy, rule_set)

        # Resolve the venue up front so an unknown/unconfigured source fails
        # fast (400/501), before any data is fetched.
        from adapters import resolve_provider

        provider = resolve_provider(source)

        logger.info(
            f"Getting historical data for backtesting: {symbol} ({sec_type} on {exchange} "
            f"in {currency}, source={provider}), {timeframe}, {period}"
        )

        # Determine date range
        has_date_range = start_date and end_date
        if has_date_range:
            # Validate date range
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")

            if start_dt >= end_dt:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Start date must be before end date",
                )

            duration_days = (end_dt - start_dt).days
            if duration_days > 365:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Date range cannot exceed 365 days for backtesting",
                )

            end_date_str = end_dt.strftime("%Y%m%d %H:%M:%S")
            ib_duration = f"{duration_days} D"
        else:
            end_date_str = ""
            ib_duration = convert_period(period)

        if provider == "ib":
            ib_timeframe = TIMEFRAME_MAP.get(timeframe, "1 hour")
            bars_data = _fetch_ib_bars(
                symbol.upper(),
                sec_type,
                exchange,
                currency,
                ib_timeframe,
                ib_duration,
                end_date_str,
            )
        else:
            bars_data = _fetch_adapter_bars(
                source, symbol.upper(), timeframe, period, start_date, end_date
            )

        if len(bars_data) < MIN_BARS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Insufficient data for backtesting. Got {len(bars_data)} bars, "
                    f"need at least {MIN_BARS}"
                ),
            )

        df = pd.DataFrame(bars_data)
        df.index = pd.to_datetime(df["timestamp"], unit="s")

        # Create backtest engine with specified parameters
        engine = backtest_engine.__class__(initial_capital=initial_capital, commission=commission)

        # Run backtest
        results = engine.run_backtest(df, strategy_instance, symbol)

        # Return results
        return {
            "success": True,
            "strategy": strategy or strategy_instance.name,
            "results": results.to_dict(),
            "data_points": len(df),
            "timeframe": timeframe,
            "period": period if not has_date_range else "CUSTOM",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error running backtest: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to run backtest: {str(e)}",
        )
