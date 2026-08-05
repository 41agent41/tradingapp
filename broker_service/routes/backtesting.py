"""Backtesting endpoints — strategy catalogue and run."""

from __future__ import annotations

import time
from datetime import datetime

import pandas as pd
from fastapi import APIRouter, HTTPException, status

from backtesting import AVAILABLE_STRATEGIES, backtest_engine
from ib_client import get_ib_connection, verify_connection_health
from ib_helpers import convert_period, create_contract
from observability import get_logger

logger = get_logger(__name__)
router = APIRouter()


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
            "usage": "Use strategy key in backtest requests",
        }
    except Exception as e:
        logger.error(f"Error getting available strategies: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available strategies: {str(e)}",
        )


@router.post("/backtesting/run")
async def run_backtest(
    symbol: str,
    strategy: str,
    timeframe: str = "1hour",
    period: str = "1Y",
    initial_capital: float = 100000,
    commission: float = 0.001,
    start_date: str = None,
    end_date: str = None,
):
    """Run backtest on historical data"""
    try:
        # Validate strategy
        if strategy not in AVAILABLE_STRATEGIES:
            available = list(AVAILABLE_STRATEGIES.keys())
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown strategy '{strategy}'. Available strategies: {available}",
            )

        # Get historical data first
        logger.info(f"Getting historical data for backtesting: {symbol}, {timeframe}, {period}")

        # Create a temporary IB connection to get data
        ib = get_ib_connection()

        if not verify_connection_health(ib):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available",
            )

        # Create contract
        qualified_contract = create_contract(symbol, "STK", "SMART", "USD")

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

        # Convert timeframe
        timeframe_map = {
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
        ib_timeframe = timeframe_map.get(timeframe, "1 hour")

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

        # Convert to DataFrame
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

        if len(bars_data) < 50:  # Minimum data for meaningful backtest
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Insufficient data for backtesting. Got {len(bars_data)} bars, need at least 50",
            )

        df = pd.DataFrame(bars_data)
        df.index = pd.to_datetime(df["timestamp"], unit="s")

        # Create strategy instance
        strategy_class = AVAILABLE_STRATEGIES[strategy]
        strategy_instance = strategy_class()

        # Create backtest engine with specified parameters
        engine = backtest_engine.__class__(initial_capital=initial_capital, commission=commission)

        # Run backtest
        results = engine.run_backtest(df, strategy_instance, symbol)

        # Return results
        return {
            "success": True,
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
