"""
TWS API Service — FastAPI wiring and route handlers.

This file is the *thin shell* after the GAP_ANALYSIS §3.4 module split:

  - Pydantic schemas live in ``models.py``.
  - The ``IBApp`` class + connection-management helpers live in ``ib_client.py``.
  - Stateless converters (timeframe / period / account-mode), the symbol-
    discovery cache and the contract factory live in ``ib_helpers.py``.
  - The four ``process_bars*`` transformations live in ``bars_processing.py``.

Everything below imports those symbols and wires the FastAPI route
handlers around them. New routes should live in their own ``routes/``
submodules — these existing ones are kept here byte-for-byte to keep the
split mechanical and reviewable.
"""

import os
import time
import logging  # noqa: F401  (kept for backward-compat — handlers reference logging modules)
import asyncio
import math  # noqa: F401  (used by some handlers below)
import threading  # noqa: F401  (used by some handlers below)
import calendar  # noqa: F401  (used by some handlers below)
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from ibapi.client import EClient  # noqa: F401  (transitively re-exported)
from ibapi.wrapper import EWrapper  # noqa: F401  (transitively re-exported)
from ibapi.contract import Contract
from ibapi.order import Order  # noqa: F401
from ibapi.common import *  # noqa: F401, F403
from ibapi.ticktype import *  # noqa: F401, F403
import uvicorn

# Technical indicators + backtesting
import pandas as pd
import numpy as np  # noqa: F401  (used by some handlers below)
from indicators import calculator as indicator_calculator
from backtesting import backtest_engine, AVAILABLE_STRATEGIES

# Observability (structured logging + /metrics + X-Request-Id middleware)
from observability import attach_observability, get_logger

# Extracted modules — these now own what used to live at the top of this file.
from models import (
    MarketDataRequest,
    CandlestickBar,
    HistoricalDataResponse,
    RealTimeQuote,
    SearchRequest,
    AdvancedSearchRequest,
    SymbolDiscoveryRequest,
    AccountSummary,
    Position,
    Order as OrderModel,
    AccountData,
    ConnectionInfo,
    # StreamSubscribeRequest / StreamSymbolRequest are defined locally below
    # with stricter Field() validation than the models.py versions.
)
from ib_client import (
    IBApp,
    IB_HOST,
    IB_PORT,
    IB_CLIENT_ID,
    IB_TIMEOUT,
    get_ib_connection,
    get_connection_status as _get_connection_status_dict,
    disconnect_ib,
    verify_connection_health,
)
from ib_helpers import (
    get_data_type_for_account_mode,
    get_market_data_source,
    convert_timeframe,
    convert_period,
    create_contract,
    get_cache_key,
    is_cache_valid,
    get_cached_symbols,
    cache_symbols,
    get_cache_stats as _symbol_cache_stats,
    clear_symbol_cache as _clear_symbol_cache,
)
from bars_processing import (
    process_bars,
    process_bars_with_date_range,
    process_bars_with_indicators,
    process_bars_with_date_range_and_indicators,
)

logger = get_logger(__name__)

CORS_ORIGINS = os.getenv("IB_CORS_ORIGINS", "").split(",") if os.getenv("IB_CORS_ORIGINS") else []
DEFAULT_ACCOUNT_MODE = os.getenv("DEFAULT_ACCOUNT_MODE", "paper")

# The route handlers below reference `connection_status` as a mutable dict
# (mutated by ib_client.get_ib_connection). Bind the same dict reference
# here so existing handler bodies keep working without rewrites.
connection_status: Dict[str, Any] = _get_connection_status_dict()

# Startup and shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("Starting TWS API Service...")
    logger.info(f"Configuration: {IB_HOST}:{IB_PORT}, Client ID: {IB_CLIENT_ID}")
    
    logger.info("TWS API Service ready - connection will be established on first API call")
    
    yield
    
    # Cleanup on shutdown
    logger.info("Shutting down TWS API Service...")
    disconnect_ib()

# FastAPI app
app = FastAPI(
    title="TradingApp TWS API Service",
    description="Interactive Brokers TWS API service for TradingApp",
    version="4.0.0",
    lifespan=lifespan
)

# Observability wiring (X-Request-Id middleware, /metrics, structlog).
# Attach BEFORE CORS so X-Request-Id is set even on preflight responses.
attach_observability(app)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Order management (Tier 4 item 9). Mounting at the app root mirrors the
# pattern used by the read-only /account endpoints. Every route in
# orders.py double-checks the LIVE_TRADING_ENABLED gate.
from orders import router as orders_router  # noqa: E402  (intentional after app config)
app.include_router(orders_router)

# Health check endpoint - no IB connection test
@app.get("/health")
async def health_check():
    """Health check endpoint - service status only, no IB Gateway connection test"""
    return {
        "status": "healthy",
        "service": "TWS API Service",
        "version": "4.0.0",
        "timestamp": datetime.now().isoformat(),
        "note": "Service is running - IB Gateway connection tested only when endpoints are called"
    }

# Timezone configuration endpoint for debugging
@app.get("/timezone-info")
async def timezone_info():
    """Get timezone and timestamp configuration information for debugging"""
    import time
    
    current_time = datetime.now()
    current_utc = datetime.utcnow()
    
    return {
        "timezone_config": {
            "system_timezone": os.getenv('TZ', 'Not set'),
            "ib_timezone": os.getenv('IB_TIMEZONE', 'Not set'),
            "expected_format": os.getenv('EXPECTED_TIMESTAMP_FORMAT', 'Not set'),
            "data_timezone": os.getenv('DATA_TIMEZONE', 'Not set'),
            "ib_format_date": os.getenv('IB_FORMAT_DATE', 'Not set'),
        },
        "current_timestamps": {
            "local_time": current_time.isoformat(),
            "utc_time": current_utc.isoformat(),
            "unix_timestamp_seconds": int(current_time.timestamp()),
            "unix_timestamp_milliseconds": int(current_time.timestamp() * 1000),
        },
        "test_timestamps": {
            "seconds_interpretation": datetime.fromtimestamp(int(current_time.timestamp())).isoformat(),
            "milliseconds_interpretation": datetime.fromtimestamp(int(current_time.timestamp() * 1000) / 1000).isoformat(),
        },
        "configuration_status": {
            "timezone_properly_set": os.getenv('TZ') == 'UTC',
            "ib_format_configured": os.getenv('IB_FORMAT_DATE') == '2',
            "timestamp_format_correct": os.getenv('EXPECTED_TIMESTAMP_FORMAT') == 'unix_seconds',
        }
    }

# Root endpoint
@app.get("/")
async def root():
    """Service information"""
    return {
        "service": "TradingApp TWS API Service",
        "version": "4.0.0",
        "status": "running",
        "config": {
            "ib_host": IB_HOST,
            "ib_port": IB_PORT,
            "client_id": IB_CLIENT_ID
        },
        "connection": connection_status
    }

# Connection status endpoint
@app.get("/connection", response_model=ConnectionInfo)
async def get_connection_status():
    """Get connection status"""
    return ConnectionInfo(
        connected=connection_status['connected'],
        host=IB_HOST,
        port=IB_PORT,
        client_id=IB_CLIENT_ID,
        last_connected=connection_status['last_connected'],
        last_error=connection_status['last_error'],
        connection_count=connection_status['connection_count']
    )

# Connect endpoint
@app.post("/connect")
async def connect():
    """Manually connect to IB Gateway"""
    try:
        ib = get_ib_connection()
        return {
            "status": "connected",
            "message": "Successfully connected to IB Gateway",
            "connection_info": {
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": IB_CLIENT_ID,
                "connected_at": connection_status['last_connected']
            }
        }
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Connection failed: {str(e)}"
        )

# Disconnect endpoint
@app.post("/disconnect")
async def disconnect():
    """Manually disconnect from IB Gateway"""
    disconnect_ib()
    return {
        "status": "disconnected",
        "message": "Disconnected from IB Gateway"
    }

# Helper function to run TWS API operations in executor
async def run_tws_operation(operation):
    """Run TWS API operation in a separate thread"""
    
    def run_with_thread():
        """Run the operation in a thread"""
        try:
            return operation()
        except Exception as e:
            logger.error(f"TWS API operation failed: {e}")
            raise e
    
    # Run the operation in a thread
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_with_thread)

# Historical data endpoint
@app.get("/market-data/history", response_model=HistoricalDataResponse)
async def get_historical_data(
    symbol: str, 
    timeframe: str, 
    period: str = "1Y", 
    account_mode: str = "paper",
    start_date: str = None,
    end_date: str = None,
    indicators: str = None,
    secType: str = "STK",
    exchange: str = "SMART",
    currency: str = "USD"
):
    """Get historical market data with support for date ranges and technical indicators"""
    try:
        # Parse indicators parameter (comma-separated list)
        indicator_list = []
        if indicators:
            indicator_list = [indicator.strip() for indicator in indicators.split(',') if indicator.strip()]
        
        # Validate that we have either period OR date range, but not both
        has_date_range = start_date and end_date
        has_period = period and period != "CUSTOM"
        
        if not has_date_range and not has_period:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Must provide either period OR date range (start_date and end_date)"
            )
        
        if has_date_range and has_period:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot specify both period and date range. Use period OR start_date/end_date"
            )
        
        # Validate date range if provided
        if has_date_range:
            try:
                start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
                
                if start_dt >= end_dt:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Start date must be before end date"
                    )
                
                if end_dt > datetime.now():
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="End date cannot be in the future"
                    )
                    
                # Calculate duration for IB request
                duration_days = (end_dt - start_dt).days
                if duration_days > 365:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Date range cannot exceed 365 days"
                    )
                    
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date format. Use YYYY-MM-DD format"
                )
        
        # Validate basic request (for period-based requests)
        if has_period:
            request = MarketDataRequest(symbol=symbol, timeframe=timeframe, period=period)
        
        # Get connection
        ib = get_ib_connection()
        
        # Verify connection is healthy
        if not ib.isConnected():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available"
            )
        
        logger.info(f"IB connection verified - connected: {ib.isConnected()}")
        
        # Create contract
        contract = create_contract(symbol.upper(), secType, exchange, currency)
        logger.info(f"Requesting historical data for contract: {symbol} ({secType}) on {exchange} in {currency}")
        
        # Clear previous contract details
        ib.contracts = []
        
        # Request contract details to qualify the contract
        ib.reqContractDetails(1, contract)
        time.sleep(2)  # Wait for contract details
        
        logger.info(f"Contract details request completed. Found {len(ib.contracts)} contracts")
        
        if not ib.contracts:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Symbol {symbol} not found"
            )
        
        qualified_contract = ib.contracts[0]
        
        # Prepare data for IB request
        ib_timeframe = convert_timeframe(timeframe)
        data_type = get_data_type_for_account_mode(account_mode)
        data_source = get_market_data_source(account_mode)
        
        # Determine duration and end date for IB request
        if has_date_range:
            # For date range requests
            duration_days = (end_dt - start_dt).days
            ib_duration = f"{duration_days} D"
            end_date_str = end_dt.strftime("%Y%m%d %H:%M:%S")
            
            logger.info(f"Requesting historical data for {symbol} - {data_type} ({account_mode} mode)")
            logger.info(f"Date Range: {start_date} to {end_date} ({duration_days} days), Timeframe: {timeframe} -> {ib_timeframe}")
        else:
            # For period-based requests
            ib_duration = convert_period(period)
            end_date_str = ''  # Empty string means "now"
            
            logger.info(f"Requesting historical data for {symbol} - {data_type} ({account_mode} mode)")
            logger.info(f"Period: {period} -> {ib_duration}, Timeframe: {timeframe} -> {ib_timeframe}")
        
        # Set market data type based on account mode
        if account_mode.lower() == 'live':
            # Request live/real-time data (type 1)
            ib.reqMarketDataType(1)
            logger.info("Set market data type to live (type 1) for historical data")
        else:
            # Request delayed data (type 3) for paper trading
            ib.reqMarketDataType(3)
            logger.info("Set market data type to delayed (type 3) for historical data")
        
        # Small delay to allow market data type to be set
        time.sleep(1)
        
        # Clear previous historical data
        ib.historical_data = []
        
        # Use string format (formatDate=1) to avoid IB Gateway conversion issues
        # formatDate: 1 for YYYYMMDD HH:MM:SS format, 2 for Unix timestamp format
        # Using format 1 to avoid "unconverted data remains" errors from IB Gateway
        format_date = 1  # Force string format for compatibility
        
        ib.reqHistoricalData(
            2,  # reqId
            qualified_contract,
            end_date_str,  # endDateTime (empty string for "now", or specific date)
            ib_duration,  # duration
            ib_timeframe,
            'TRADES',
            1,  # useRTH
            format_date,  # formatDate: 1 for string format (more reliable)
            False,  # keepUpToDate
            []  # chartOptions
        )
        
        logger.info(f"Requested historical data with formatDate={format_date} (string format for compatibility)")
        
        # Wait for data with longer timeout and retry logic
        max_wait_time = 15  # seconds
        wait_interval = 1  # seconds
        total_wait_time = 0
        
        while len(ib.historical_data) == 0 and total_wait_time < max_wait_time:
            time.sleep(wait_interval)
            total_wait_time += wait_interval
            logger.info(f"Waiting for historical data... ({total_wait_time}/{max_wait_time}s) - bars received: {len(ib.historical_data)}")
        
        logger.info(f"Historical data request completed. Received {len(ib.historical_data)} bars after {total_wait_time}s")
        if len(ib.historical_data) > 0:
            logger.info(f"Sample bar: {ib.historical_data[0]}")
        else:
            logger.warning("No historical data received from IB Gateway")
        
        if not ib.historical_data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No historical data available for {symbol} after {total_wait_time}s timeout"
            )
        
        # Process and return data with indicators
        logger.info(f"Processing bars with indicators: {indicator_list}")
        if has_date_range:
            result = process_bars_with_date_range_and_indicators(ib.historical_data, symbol, timeframe, start_date, end_date, indicator_list)
        else:
            result = process_bars_with_indicators(ib.historical_data, symbol, timeframe, period, indicator_list)
        
        logger.info(f"Processed result: {result.count} bars returned")
        
        # Debug: Check first few timestamps being returned to frontend
        if result.bars and len(result.bars) > 0:
            logger.info("=== TIMESTAMP DEBUG - Values being sent to frontend ===")
            for i, bar in enumerate(result.bars[:3]):
                timestamp_date = datetime.fromtimestamp(bar.timestamp, tz=timezone.utc)
                logger.info(f"  Bar {i+1}: timestamp={bar.timestamp}, converts_to={timestamp_date}")
                logger.info(f"    Validation: {'VALID' if 1700000000 <= bar.timestamp <= 1800000000 else 'INVALID - FRONTEND WILL SHOW WRONG DATES'}")
            logger.info("=== END TIMESTAMP DEBUG ===")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting historical data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get historical data: {str(e)}"
        )

# Available indicators endpoint
@app.get("/indicators/available")
async def get_available_indicators():
    """Get list of all available technical indicators"""
    try:
        return {
            "indicators": indicator_calculator.get_available_indicators(),
            "usage": "Add indicators as comma-separated list in 'indicators' parameter, e.g., indicators=sma_20,rsi,bollinger"
        }
    except Exception as e:
        logger.error(f"Error getting available indicators: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available indicators: {str(e)}"
        )

# Backtesting endpoints
@app.get("/backtesting/strategies")
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
                "description": strategy_class.__doc__ or "No description available"
            }
        
        return {
            "strategies": strategies_info,
            "usage": "Use strategy key in backtest requests"
        }
    except Exception as e:
        logger.error(f"Error getting available strategies: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available strategies: {str(e)}"
        )

@app.post("/backtesting/run")
async def run_backtest(
    symbol: str,
    strategy: str,
    timeframe: str = "1hour",
    period: str = "1Y",
    initial_capital: float = 100000,
    commission: float = 0.001,
    start_date: str = None,
    end_date: str = None
):
    """Run backtest on historical data"""
    try:
        # Validate strategy
        if strategy not in AVAILABLE_STRATEGIES:
            available = list(AVAILABLE_STRATEGIES.keys())
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown strategy '{strategy}'. Available strategies: {available}"
            )
        
        # Get historical data first
        logger.info(f"Getting historical data for backtesting: {symbol}, {timeframe}, {period}")
        
        # Create a temporary IB connection to get data
        ib = get_ib_connection()
        
        if not verify_connection_health(ib):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available"
            )
        
        # Create contract
        qualified_contract = create_contract(symbol, 'STK', 'SMART', 'USD')
        
        # Determine date range
        has_date_range = start_date and end_date
        if has_date_range:
            # Validate date range
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")
            
            if start_dt >= end_dt:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Start date must be before end date"
                )
            
            duration_days = (end_dt - start_dt).days
            if duration_days > 365:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Date range cannot exceed 365 days for backtesting"
                )
                
            end_date_str = end_dt.strftime("%Y%m%d %H:%M:%S")
            ib_duration = f"{duration_days} D"
        else:
            end_date_str = ""
            ib_duration = convert_period(period)
        
        # Convert timeframe
        timeframe_map = {
            'tick': '1 secs',  # Tick data - use 1 second as closest approximation
            '1min': '1 min',
            '5min': '5 mins',
            '15min': '15 mins', 
            '30min': '30 mins',
            '1hour': '1 hour',
            '4hour': '4 hours',
            '8hour': '8 hours',
            '1day': '1 day'
        }
        ib_timeframe = timeframe_map.get(timeframe, '1 hour')
        
        # Clear previous data
        ib.historical_data = []
        
        # Request historical data
        ib.reqHistoricalData(
            3,  # reqId for backtest
            qualified_contract,
            end_date_str,
            ib_duration,
            ib_timeframe,
            'TRADES',
            1,  # useRTH
            1,  # formatDate
            False,  # keepUpToDate
            []  # chartOptions
        )
        
        # Wait for data
        time.sleep(8)  # Longer wait for more data
        
        if not ib.historical_data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No historical data available for {symbol} backtesting"
            )
        
        logger.info(f"Retrieved {len(ib.historical_data)} bars for backtesting")
        
        # Convert to DataFrame
        bars_data = []
        for bar in ib.historical_data:
            try:
                # Handle different date formats from IB
                if isinstance(bar.date, str):
                    # String format like "20250725 23:30:00"
                    if ' ' in bar.date:
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
                
                bars_data.append({
                    'timestamp': int(bar_datetime.timestamp()),
                    'open': float(bar.open),
                    'high': float(bar.high),
                    'low': float(bar.low),
                    'close': float(bar.close),
                    'volume': int(bar.volume)
                })
            except Exception as e:
                logger.warning(f"Error processing bar for backtesting: {e}, bar.date={bar.date}")
                continue
        
        if len(bars_data) < 50:  # Minimum data for meaningful backtest
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Insufficient data for backtesting. Got {len(bars_data)} bars, need at least 50"
            )
        
        df = pd.DataFrame(bars_data)
        df.index = pd.to_datetime(df['timestamp'], unit='s')
        
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
            "period": period if not has_date_range else "CUSTOM"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error running backtest: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to run backtest: {str(e)}"
        )

def get_realtime_data_sync(symbol: str, account_mode: str = "paper"):
    """Get real-time market data using TWS API"""
    try:
        data_type = get_data_type_for_account_mode(account_mode)
        data_source = get_market_data_source(account_mode)
        
        logger.info(f"Starting {data_type} data request for symbol: {symbol} ({account_mode} mode)")
        
        # Get connection
        ib = get_ib_connection()
        logger.info(f"Using shared TWS API connection, connected: {ib.isConnected()}")
        
        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")
        
        # Set market data type based on account mode
        if account_mode.lower() == 'live':
            # Request live/real-time data (type 1)
            ib.reqMarketDataType(1)
            logger.info("Requesting live market data (type 1)")
        else:
            # Request delayed data (type 3) for paper trading
            ib.reqMarketDataType(3)
            logger.info("Requesting delayed market data (type 3)")
        
        # Small delay to allow market data type to be set
        time.sleep(1)
        
        # Create contract
        contract = create_contract(symbol.upper())
        logger.info(f"Created contract for {symbol}: {contract}")
        
        # Request contract details to qualify the contract
        ib.reqContractDetails(3, contract)
        time.sleep(2)
        
        if not ib.contracts:
            logger.error(f"No qualified contracts found for symbol: {symbol}")
            raise Exception(f"Symbol {symbol} not found or cannot be qualified")
        
        qualified_contract = ib.contracts[0]
        logger.info(f"Using qualified contract: {qualified_contract}")
        
        # Request market data
        req_id = 4
        ib.reqMktData(req_id, qualified_contract, '', False, False, [])
        logger.info(f"Market data requested for {qualified_contract.symbol} with data type: {data_type}")
        
        # Wait for data
        time.sleep(3)
        
        # Get data from the client
        tick_data = ib.data.get(req_id, {})
        logger.info(f"Tick data received: {tick_data}")
        
        # Process quote
        bid = tick_data.get('bid') if tick_data.get('tickType') == TickTypeEnum.BID else None
        ask = tick_data.get('ask') if tick_data.get('tickType') == TickTypeEnum.ASK else None
        last = tick_data.get('last') if tick_data.get('tickType') == TickTypeEnum.LAST else None
        volume = tick_data.get('volume') if tick_data.get('tickType') == TickTypeEnum.VOLUME else None
        
        # If no last price, try to get it from bid/ask
        if not last and bid and ask:
            last = (float(bid) + float(ask)) / 2
            logger.info(f"Using midpoint price: {last}")
        
        # Process quote with better data handling
        quote = RealTimeQuote(
            symbol=symbol.upper(),
            bid=float(bid) if bid and not math.isnan(float(bid)) else None,
            ask=float(ask) if ask and not math.isnan(float(ask)) else None,
            last=float(last) if last and not math.isnan(float(last)) else None,
            volume=int(volume) if volume and not math.isnan(float(volume)) else None,
            timestamp=datetime.now().isoformat()
        )
        
        logger.info(f"Processed quote: {quote}")
        
        # Cancel market data subscription to clean up
        ib.cancelMktData(req_id)
        logger.info("Market data subscription cancelled")
        
        return quote
        
    except Exception as e:
        logger.error(f"Exception in get_realtime_data_sync: {type(e).__name__}: {str(e)}")
        logger.error(f"Exception details: {repr(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise Exception(f"Failed to get real-time data for {symbol}: {type(e).__name__}: {str(e)}")

# Tick data endpoint
@app.get("/market-data/tick")
async def get_tick_data(symbol: str, account_mode: str = "paper"):
    """Get high-frequency tick data"""
    try:
        logger.info(f"Tick data endpoint called for symbol: {symbol}")
        
        # Run the synchronous operation in a separate thread
        tick_data = await run_tws_operation(lambda: get_tick_data_sync(symbol, account_mode))
        
        logger.info(f"Successfully retrieved tick data for {symbol}")
        return tick_data
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in tick data endpoint: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Unexpected error in tick data endpoint: {type(e).__name__}: {error_str}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get tick data for {symbol}: {error_str}"
        )

def get_tick_data_sync(symbol: str, account_mode: str = "paper"):
    """Get tick data synchronously"""
    try:
        # Get connection
        ib = get_ib_connection()
        
        # Create contract
        contract = create_contract(symbol.upper(), 'STK', 'SMART', 'USD')
        
        # Clear previous contracts
        ib.contracts = []
        
        # Qualify contract
        ib.reqContractDetails(6, contract)
        time.sleep(2)
        
        if not ib.contracts:
            logger.error(f"No qualified contracts found for symbol: {symbol}")
            raise Exception(f"Symbol {symbol} not found or cannot be qualified")
        
        qualified_contract = ib.contracts[0]
        logger.info(f"Using qualified contract for tick data: {qualified_contract}")
        
        # Request tick data
        req_id = 7
        ib.reqMktData(req_id, qualified_contract, '', False, False, [])
        logger.info(f"Tick data requested for {qualified_contract.symbol}")
        
        # Wait for data
        time.sleep(5)  # Longer wait for tick data
        
        # Get data from the client
        tick_data = ib.data.get(req_id, {})
        logger.info(f"Tick data received: {tick_data}")
        
        # Process tick data
        tick_info = {
            "symbol": symbol.upper(),
            "timestamp": datetime.now().isoformat(),
            "bid": tick_data.get('bid'),
            "ask": tick_data.get('ask'),
            "last": tick_data.get('last'),
            "volume": tick_data.get('volume'),
            "high": tick_data.get('high'),
            "low": tick_data.get('low'),
            "close": tick_data.get('close'),
            "open": tick_data.get('open'),
            "tick_type": tick_data.get('tickType'),
            "exchange": tick_data.get('exchange'),
            "special_conditions": tick_data.get('specialConditions')
        }
        
        # Cancel market data subscription to clean up
        ib.cancelMktData(req_id)
        logger.info("Tick data subscription cancelled")
        
        return tick_info
        
    except Exception as e:
        logger.error(f"Exception in get_tick_data_sync: {type(e).__name__}: {str(e)}")
        logger.error(f"Exception details: {repr(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise Exception(f"Failed to get tick data for {symbol}: {type(e).__name__}: {str(e)}")

# Real-time data endpoint
@app.get("/market-data/realtime", response_model=RealTimeQuote)
async def get_realtime_data(symbol: str, account_mode: str = "paper"):
    """Get real-time market data"""
    try:
        logger.info(f"Real-time data endpoint called for symbol: {symbol}")
        
        # Run the synchronous operation in a separate thread
        quote = await run_tws_operation(lambda: get_realtime_data_sync(symbol, account_mode))
        
        logger.info(f"Successfully retrieved market data for {symbol}")
        return quote
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in endpoint: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Unexpected error in real-time data endpoint: {type(e).__name__}: {error_str}")
        
        # Handle specific IB Gateway subscription errors
        if "subscription" in error_str.lower() or "market data farm" in error_str.lower():
            error_message = f"Market data subscription issue for {symbol}. Using delayed data if available. Check IB Gateway market data subscriptions."
        elif "timeout" in error_str.lower():
            error_message = f"Timeout retrieving market data for {symbol}. IB Gateway may be busy or unresponsive."
        elif "not found" in error_str.lower() or "qualify" in error_str.lower():
            error_message = f"Symbol {symbol} not found or cannot be qualified by IB Gateway."
        else:
            error_message = f"Failed to get market data for {symbol}: {error_str}"
        
        logger.error(f"Error details: {error_message}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_message
        )

# ============================================================================
# Real-time streaming endpoints (Phase 4)
# ============================================================================
# These wrap the StreamingManager in `streaming.py`. The manager owns
# refcounted ``reqMktData`` subscriptions and publishes every tick to
# Redis so the backend can fan them out to Socket.IO clients.
#
# The endpoints are deliberately small — almost all the logic lives in
# the manager module (which has dedicated unit tests). The IBApp tick
# observer is attached lazily on the first subscribe so importing this
# module never touches an IB connection.

from streaming import streaming_manager  # noqa: E402  (intentional late import)


class StreamSubscribeRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)
    secType: str = Field(default="STK")
    exchange: str = Field(default="SMART")
    currency: str = Field(default="USD")


class StreamSymbolRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)


def _attach_streaming_if_needed() -> None:
    """Lazy-wire the StreamingManager to the live IBApp instance."""
    if getattr(streaming_manager, "_ib_app", None) is not None:
        return
    ib = get_ib_connection()

    def _resolve(symbol: str, sec_type: str, exchange: str, currency: str):
        # Re-use the existing contract helper so symbol semantics stay
        # consistent with the rest of the IB service. No `reqContractDetails`
        # round-trip here — `reqMktData` accepts the lightweight contract.
        return create_contract(symbol.upper(), sec_type, exchange, currency)

    streaming_manager.attach(ib, _resolve)


@app.post("/market-data/stream/subscribe")
async def stream_subscribe(req: StreamSubscribeRequest):
    """Start (or refcount-bump) a streaming market-data subscription."""
    try:
        _attach_streaming_if_needed()
        sub = await run_tws_operation(
            lambda: streaming_manager.subscribe(
                req.symbol, sec_type=req.secType, exchange=req.exchange, currency=req.currency
            )
        )
        return {
            "status": "subscribed",
            "symbol": sub.symbol,
            "req_id": sub.req_id,
            "ref_count": sub.ref_count,
            "channel": f"marketdata:tick:{sub.symbol}",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"stream subscribe failed for {req.symbol}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to subscribe to {req.symbol}: {exc}",
        )


@app.post("/market-data/stream/unsubscribe")
async def stream_unsubscribe(req: StreamSymbolRequest):
    """Drop one reference on a streaming subscription."""
    try:
        sub = streaming_manager.unsubscribe(req.symbol)
        if sub is None:
            return {"status": "not-subscribed", "symbol": req.symbol.upper()}
        return {
            "status": "unsubscribed" if sub.ref_count == 0 else "decremented",
            "symbol": sub.symbol,
            "ref_count": sub.ref_count,
        }
    except Exception as exc:
        logger.error(f"stream unsubscribe failed for {req.symbol}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to unsubscribe from {req.symbol}: {exc}",
        )


@app.get("/market-data/stream/status")
async def stream_status():
    """Diagnostics for the streaming pipeline (subs, refcounts, totals)."""
    return streaming_manager.status()


# Backwards-compatible aliases. The backend Socket.IO bridge has been
# calling these paths since before the streaming pipeline existed; the
# endpoints used to be missing entirely. Keeping the older names live
# lets older backend builds keep working during a rolling deploy.
@app.post("/market-data/subscribe")
async def stream_subscribe_legacy(req: StreamSubscribeRequest):
    return await stream_subscribe(req)


@app.post("/market-data/unsubscribe")
async def stream_unsubscribe_legacy(req: StreamSymbolRequest):
    return await stream_unsubscribe(req)


# Contract search endpoint
@app.post("/contract/search")
async def search_contracts(request: SearchRequest):
    """Enhanced search for contracts with better filtering and results"""
    try:
        # Log the account mode being used
        data_type = get_data_type_for_account_mode(request.account_mode)
        logger.info(f"Searching contracts for {request.symbol} ({request.secType}) in {request.account_mode} mode - {data_type} data")
        
        # Get connection
        ib = get_ib_connection()
        
        # Create contract with enhanced parameters
        contract = create_contract(request.symbol.upper(), request.secType, request.exchange, request.currency)
        
        # Clear previous contracts
        ib.contracts = []
        
        # Request contract details with longer timeout for better results
        ib.reqContractDetails(5, contract)
        time.sleep(3)  # Increased wait time for more comprehensive results
        
        if not ib.contracts:
            return {"results": [], "count": 0}
        
        # Enhanced results formatting with more details
        results = []
        for contract in ib.contracts:
            # Extract company name from description or symbol
            company_name = getattr(contract, 'longName', '') or contract.symbol
            
            # Create enhanced result object
            result = {
                "conid": str(contract.conId),
                "symbol": contract.symbol,
                "companyName": company_name,
                "description": f"{contract.symbol} - {company_name}",
                "secType": contract.secType,
                "exchange": contract.exchange,
                "currency": contract.currency,
                "primaryExchange": getattr(contract, 'primaryExchange', ''),
                "localSymbol": getattr(contract, 'localSymbol', ''),
                "tradingClass": getattr(contract, 'tradingClass', ''),
                "multiplier": getattr(contract, 'multiplier', ''),
                "strike": getattr(contract, 'strike', ''),
                "right": getattr(contract, 'right', ''),
                "expiry": getattr(contract, 'expiry', ''),
                "includeExpired": getattr(contract, 'includeExpired', False),
                "comboLegsDescrip": getattr(contract, 'comboLegsDescrip', ''),
                "contractMonth": getattr(contract, 'contractMonth', ''),
                "industry": getattr(contract, 'industry', ''),
                "category": getattr(contract, 'category', ''),
                "subcategory": getattr(contract, 'subcategory', ''),
                "timeZoneId": getattr(contract, 'timeZoneId', ''),
                "tradingHours": getattr(contract, 'tradingHours', ''),
                "liquidHours": getattr(contract, 'liquidHours', ''),
                "evRule": getattr(contract, 'evRule', ''),
                "evMultiplier": getattr(contract, 'evMultiplier', ''),
                "secIdList": getattr(contract, 'secIdList', []),
                "aggGroup": getattr(contract, 'aggGroup', ''),
                "underSymbol": getattr(contract, 'underSymbol', ''),
                "underSecType": getattr(contract, 'underSecType', ''),
                "marketRuleIds": getattr(contract, 'marketRuleIds', ''),
                "realExpirationDate": getattr(contract, 'realExpirationDate', ''),
                "lastTradingDay": getattr(contract, 'lastTradingDay', ''),
                "stockType": getattr(contract, 'stockType', ''),
                "minSize": getattr(contract, 'minSize', ''),
                "sizeIncrement": getattr(contract, 'sizeIncrement', ''),
                "suggestedSizeIncrement": getattr(contract, 'suggestedSizeIncrement', ''),
                "sections": []
            }
            
            # Add sections for multi-exchange contracts
            if hasattr(contract, 'sections') and contract.sections:
                for section in contract.sections:
                    result["sections"].append({
                        "exchange": section.exchange,
                        "secType": section.secType,
                        "expiry": section.expiry,
                        "strike": section.strike,
                        "right": section.right,
                        "multiplier": section.multiplier,
                        "tradingClass": section.tradingClass,
                        "localSymbol": section.localSymbol,
                        "includeExpired": section.includeExpired,
                        "comboLegsDescrip": section.comboLegsDescrip,
                        "contractMonth": section.contractMonth,
                        "industry": section.industry,
                        "category": section.category,
                        "subcategory": section.subcategory,
                        "timeZoneId": section.timeZoneId,
                        "tradingHours": section.tradingHours,
                        "liquidHours": section.liquidHours,
                        "evRule": section.evRule,
                        "evMultiplier": section.evMultiplier,
                        "secIdList": section.secIdList,
                        "aggGroup": section.aggGroup,
                        "underSymbol": section.underSymbol,
                        "underSecType": section.underSecType,
                        "marketRuleIds": section.marketRuleIds,
                        "realExpirationDate": section.realExpirationDate,
                        "lastTradingDay": section.lastTradingDay,
                        "stockType": section.stockType,
                        "minSize": section.minSize,
                        "sizeIncrement": section.sizeIncrement,
                        "suggestedSizeIncrement": section.suggestedSizeIncrement
                    })
            
            results.append(result)
        
        # Sort results by relevance (stocks first, then by exchange preference)
        def sort_key(result):
            # Priority: SMART exchange first, then primary exchanges
            exchange_priority = {
                'SMART': 0,
                'NYSE': 1,
                'NASDAQ': 2,
                'AMEX': 3
            }
            return (
                exchange_priority.get(result['exchange'], 999),
                result['symbol']
            )
        
        results.sort(key=sort_key)
        
        return {
            "results": results,
            "count": len(results),
            "search_params": {
                "symbol": request.symbol,
                "secType": request.secType,
                "exchange": request.exchange,
                "currency": request.currency,
                "searchByName": request.name
            },
            "timestamp": datetime.now().isoformat()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching contracts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to search contracts: {str(e)}"
        )

@app.post("/contract/advanced-search")
async def advanced_search_contracts(request: AdvancedSearchRequest):
    """Advanced search for contracts with additional filters"""
    try:
        # Log the account mode being used
        data_type = get_data_type_for_account_mode(request.account_mode)
        logger.info(f"Advanced search for {request.symbol or 'ALL'} ({request.secType}) in {request.account_mode} mode - {data_type} data")
        
        # Get connection
        ib = get_ib_connection()
        
        # Create contract with advanced parameters
        contract = create_contract(request.symbol.upper() if request.symbol else "", request.secType, request.exchange, request.currency)
        
        # Apply advanced filters
        if request.expiry:
            contract.expiry = request.expiry
        if request.strike > 0:
            contract.strike = request.strike
        if request.right:
            contract.right = request.right
        if request.multiplier:
            contract.multiplier = request.multiplier
        if request.includeExpired:
            contract.includeExpired = request.includeExpired
        
        # Clear previous contracts
        ib.contracts = []
        
        # Request contract details
        ib.reqContractDetails(6, contract)
        time.sleep(3)
        
        if not ib.contracts:
            return {"results": [], "count": 0}
        
        # Filter and format results
        results = []
        for contract in ib.contracts:
            # Apply additional client-side filtering
            if request.expiry and hasattr(contract, 'expiry') and contract.expiry != request.expiry:
                continue
            if request.strike > 0 and hasattr(contract, 'strike') and contract.strike != request.strike:
                continue
            if request.right and hasattr(contract, 'right') and contract.right != request.right:
                continue
            if request.multiplier and hasattr(contract, 'multiplier') and contract.multiplier != request.multiplier:
                continue
            
            # Extract company name
            company_name = getattr(contract, 'longName', '') or contract.symbol
            
            result = {
                "conid": str(contract.conId),
                "symbol": contract.symbol,
                "companyName": company_name,
                "description": f"{contract.symbol} - {company_name}",
                "secType": contract.secType,
                "exchange": contract.exchange,
                "currency": contract.currency,
                "primaryExchange": getattr(contract, 'primaryExchange', ''),
                "localSymbol": getattr(contract, 'localSymbol', ''),
                "tradingClass": getattr(contract, 'tradingClass', ''),
                "multiplier": getattr(contract, 'multiplier', ''),
                "strike": getattr(contract, 'strike', ''),
                "right": getattr(contract, 'right', ''),
                "expiry": getattr(contract, 'expiry', ''),
                "includeExpired": getattr(contract, 'includeExpired', False),
                "comboLegsDescrip": getattr(contract, 'comboLegsDescrip', ''),
                "contractMonth": getattr(contract, 'contractMonth', ''),
                "industry": getattr(contract, 'industry', ''),
                "category": getattr(contract, 'category', ''),
                "subcategory": getattr(contract, 'subcategory', ''),
                "timeZoneId": getattr(contract, 'timeZoneId', ''),
                "tradingHours": getattr(contract, 'tradingHours', ''),
                "liquidHours": getattr(contract, 'liquidHours', ''),
                "evRule": getattr(contract, 'evRule', ''),
                "evMultiplier": getattr(contract, 'evMultiplier', ''),
                "secIdList": getattr(contract, 'secIdList', []),
                "aggGroup": getattr(contract, 'aggGroup', ''),
                "underSymbol": getattr(contract, 'underSymbol', ''),
                "underSecType": getattr(contract, 'underSecType', ''),
                "marketRuleIds": getattr(contract, 'marketRuleIds', ''),
                "realExpirationDate": getattr(contract, 'realExpirationDate', ''),
                "lastTradingDay": getattr(contract, 'lastTradingDay', ''),
                "stockType": getattr(contract, 'stockType', ''),
                "minSize": getattr(contract, 'minSize', ''),
                "sizeIncrement": getattr(contract, 'sizeIncrement', ''),
                "suggestedSizeIncrement": getattr(contract, 'suggestedSizeIncrement', ''),
                "sections": []
            }
            
            # Add sections for multi-exchange contracts
            if hasattr(contract, 'sections') and contract.sections:
                for section in contract.sections:
                    result["sections"].append({
                        "exchange": section.exchange,
                        "secType": section.secType,
                        "expiry": section.expiry,
                        "strike": section.strike,
                        "right": section.right,
                        "multiplier": section.multiplier,
                        "tradingClass": section.tradingClass,
                        "localSymbol": section.localSymbol,
                        "includeExpired": section.includeExpired,
                        "comboLegsDescrip": section.comboLegsDescrip,
                        "contractMonth": section.contractMonth,
                        "industry": section.industry,
                        "category": section.category,
                        "subcategory": section.subcategory,
                        "timeZoneId": section.timeZoneId,
                        "tradingHours": section.tradingHours,
                        "liquidHours": section.liquidHours,
                        "evRule": section.evRule,
                        "evMultiplier": section.evMultiplier,
                        "secIdList": section.secIdList,
                        "aggGroup": section.aggGroup,
                        "underSymbol": section.underSymbol,
                        "underSecType": section.underSecType,
                        "marketRuleIds": section.marketRuleIds,
                        "realExpirationDate": section.realExpirationDate,
                        "lastTradingDay": section.lastTradingDay,
                        "stockType": section.stockType,
                        "minSize": section.minSize,
                        "sizeIncrement": section.sizeIncrement,
                        "suggestedSizeIncrement": section.suggestedSizeIncrement
                    })
            
            results.append(result)
        
        # Sort results
        def sort_key(result):
            exchange_priority = {
                'SMART': 0,
                'NYSE': 1,
                'NASDAQ': 2,
                'AMEX': 3
            }
            return (
                exchange_priority.get(result['exchange'], 999),
                result['symbol']
            )
        
        results.sort(key=sort_key)
        
        return {
            "results": results,
            "count": len(results),
            "search_params": {
                "symbol": request.symbol,
                "secType": request.secType,
                "exchange": request.exchange,
                "currency": request.currency,
                "expiry": request.expiry,
                "strike": request.strike,
                "right": request.right,
                "multiplier": request.multiplier,
                "includeExpired": request.includeExpired,
                "searchByName": request.name
            },
            "timestamp": datetime.now().isoformat()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in advanced contract search: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to perform advanced contract search: {str(e)}"
        )

# Account service functions
def get_account_summary_sync():
    """Get account summary information using TWS API"""
    try:
        ib = get_ib_connection()
        
        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")
        
        logger.info("Getting account summary using TWS API")
        
        # Get managed accounts
        if not ib.managed_accounts:
            # Request managed accounts
            ib.reqManagedAccts()
            time.sleep(2)
        
        if not ib.managed_accounts:
            raise Exception("No managed accounts found")
        
        account_id = ib.managed_accounts[0]
        logger.info(f"Using account: {account_id}")
        
        # Clear previous account data
        ib.account_summary = {}
        
        # Request account summary
        account_tags = ['NetLiquidation', 'AccountCode', 'Currency']
        ib.reqAccountSummary(6, 'All', ','.join(account_tags))
        time.sleep(3)
        
        # Process account summary
        account_data = ib.account_summary.get(account_id, {})
        currency = account_data.get('Currency', 'USD')
        
        logger.info(f"Retrieved account summary: {account_data}")
        
        return AccountSummary(
            account_id=account_id,
            currency=currency,
            last_updated=datetime.now().isoformat(),
            net_liquidation=float(account_data.get('NetLiquidation', 0)) if account_data.get('NetLiquidation') else None
        )
        
    except Exception as e:
        logger.error(f"Error getting account summary: {e}")
        raise Exception(f"Failed to get account summary: {str(e)}")

def get_positions_sync():
    """Get current positions using TWS API"""
    try:
        ib = get_ib_connection()
        
        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")
        
        logger.info("Requesting positions using TWS API")
        
        # Clear previous positions
        ib.positions = []
        
        # Request positions
        ib.reqPositions()
        time.sleep(3)
        
        position_list = []
        for pos in ib.positions:
            if pos['position'] != 0:  # Only include non-zero positions
                position_list.append(Position(
                    symbol=pos['contract'].symbol,
                    position=pos['position'],
                    market_price=None,  # TWS API doesn't provide this in position data
                    market_value=None,  # TWS API doesn't provide this in position data
                    average_cost=float(pos['avgCost']) if pos['avgCost'] and not math.isnan(float(pos['avgCost'])) else None,
                    unrealized_pnl=None,  # TWS API doesn't provide this in position data
                    currency=pos['contract'].currency
                ))
        
        logger.info(f"Retrieved {len(position_list)} positions")
        return position_list
        
    except Exception as e:
        logger.error(f"Error getting positions: {e}")
        raise Exception(f"Failed to get positions: {str(e)}")

def get_orders_sync():
    """Get current orders using TWS API"""
    try:
        ib = get_ib_connection()
        
        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")
        
        logger.info("Requesting orders using TWS API")
        
        # Clear previous orders
        ib.orders = []
        
        # Request all open orders
        ib.reqAllOpenOrders()
        time.sleep(3)
        
        order_list = []
        for order_data in ib.orders:
            order_list.append(OrderModel(
                order_id=order_data['orderId'],
                symbol=order_data['contract'].symbol,
                action=order_data['order'].action,
                quantity=order_data['order'].totalQuantity,
                order_type=order_data['order'].orderType,
                status=order_data['orderState'].status,
                filled_quantity=None,  # TWS API doesn't provide this in open orders
                remaining_quantity=None,  # TWS API doesn't provide this in open orders
                avg_fill_price=None  # TWS API doesn't provide this in open orders
            ))
        
        logger.info(f"Retrieved {len(order_list)} orders")
        return order_list
        
    except Exception as e:
        logger.error(f"Error getting orders: {e}")
        raise Exception(f"Failed to get orders: {str(e)}")

# Account endpoints
@app.get("/account/summary", response_model=AccountSummary)
async def get_account_summary():
    """Get account summary information"""
    try:
        logger.info("Account summary endpoint called")
        summary = await run_tws_operation(get_account_summary_sync)
        logger.info(f"Successfully retrieved account summary for account: {summary.account_id}")
        return summary
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in account summary: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account summary endpoint: {error_str}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account summary: {error_str}"
        )

@app.get("/account/positions", response_model=List[Position])
async def get_account_positions():
    """Get current account positions"""
    try:
        logger.info("Account positions endpoint called")
        positions = await run_tws_operation(get_positions_sync)
        logger.info(f"Successfully retrieved {len(positions)} positions")
        return positions
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in account positions: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account positions endpoint: {error_str}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account positions: {error_str}"
        )

@app.get("/account/orders", response_model=List[OrderModel])
async def get_account_orders():
    """Get current account orders"""
    try:
        logger.info("Account orders endpoint called")
        orders = await run_tws_operation(get_orders_sync)
        logger.info(f"Successfully retrieved {len(orders)} orders")
        return orders
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in account orders: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account orders endpoint: {error_str}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account orders: {error_str}"
        )

@app.get("/account/all", response_model=AccountData)
async def get_all_account_data():
    """Get all account data (summary, positions, orders) in one call - sequential for stability"""
    try:
        logger.info("All account data endpoint called - using sequential approach for stability")
        
        # Get account summary first (most important)
        try:
            summary = await run_tws_operation(get_account_summary_sync)
            logger.info(f"✅ Account summary retrieved for: {summary.account_id}")
        except Exception as e:
            logger.error(f"❌ Failed to get account summary: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to get account summary: {str(e)}"
            )
        
        # Get positions (optional - continue if fails)
        positions = []
        try:
            positions = await run_tws_operation(get_positions_sync)
            logger.info(f"✅ Positions retrieved: {len(positions)} positions")
        except Exception as e:
            logger.warning(f"⚠️ Failed to get positions (continuing): {e}")
        
        # Get orders (optional - continue if fails)  
        orders = []
        try:
            orders = await run_tws_operation(get_orders_sync)
            logger.info(f"✅ Orders retrieved: {len(orders)} orders")
        except Exception as e:
            logger.warning(f"⚠️ Failed to get orders (continuing): {e}")
        
        account_data = AccountData(
            account=summary,
            positions=positions,
            orders=orders,
            last_updated=datetime.now().isoformat()
        )
        
        logger.info(f"✅ Successfully retrieved account data for account: {summary.account_id} (summary + {len(positions)} positions + {len(orders)} orders)")
        return account_data
        
    except HTTPException as he:
        logger.error(f"HTTP Exception in all account data: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in all account data endpoint: {error_str}")
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get all account data: {error_str}"
        )

# Enhanced Symbol Discovery Endpoint (Phases 1-3)
@app.post("/symbols/discover")
async def discover_symbols(request: SymbolDiscoveryRequest):
    """
    Enhanced symbol discovery with 3-phase approach:
    Phase 1: reqContractDetails for precise filtering
    Phase 2: reqMatchingSymbols as fallback for broader discovery  
    Phase 3: Intelligent caching for performance
    """
    try:
        pattern = request.pattern.strip().upper()
        if not pattern:
            return {"results": [], "method": "none", "cached": False, "count": 0}
        
        # Phase 3: Check cache first
        cache_key = get_cache_key(pattern, request.secType, request.exchange, request.currency)
        cached_results = get_cached_symbols(cache_key)
        if cached_results:
            return {
                "results": cached_results[:request.max_results],
                "method": "cache",
                "cached": True,
                "count": len(cached_results)
            }
        
        logger.info(f"Symbol discovery for pattern: {pattern} ({request.secType}) on {request.exchange}")
        
        # Get connection
        ib = get_ib_connection()
        if not verify_connection_health(ib):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available"
            )
        
        results = []
        method_used = "none"
        
        # Phase 1: Try reqContractDetails first (precise filtering)
        try:
            logger.info(f"Phase 1: Trying reqContractDetails for {pattern}")
            
            # Support wildcard pattern matching
            search_patterns = []
            if len(pattern) == 1:
                # Single letter: try exact first, then common two-letter combinations
                search_patterns = [
                    pattern,  # Exact match (e.g., "A")
                    f"{pattern}A",  # AA (American Airlines, etc.)
                    f"{pattern}M",  # AM (American Express, AMD, etc.)
                    f"{pattern}P",  # AP (Apple, etc.)
                    f"{pattern}D",  # AD patterns
                    f"{pattern}I",  # AI patterns
                    f"{pattern}L",  # AL patterns
                    f"{pattern}B",  # AB patterns
                    f"{pattern}C",  # AC patterns
                    f"{pattern}G",  # AG patterns
                    f"{pattern}R",  # AR patterns
                    f"{pattern}S",  # AS patterns
                    f"{pattern}T",  # AT patterns
                    f"{pattern}V",  # AV patterns
                    f"{pattern}Z",  # AZ patterns
                ]
            elif len(pattern) >= 2:
                # Multiple letters: try exact and wildcard
                search_patterns = [pattern, f"{pattern}*"]
            else:
                search_patterns = [pattern]
            
            # Collect all contracts from all search patterns
            all_contracts = []
            
            for search_pattern in search_patterns:
                contract = create_contract(search_pattern, request.secType, request.exchange, request.currency)
                
                # Clear previous results for this specific search
                ib.contracts = []
                
                # Request contract details
                ib.reqContractDetails(10, contract)
                time.sleep(2)  # Wait for results
                
                logger.info(f"Found {len(ib.contracts)} contracts for pattern: {search_pattern}")
                
                # Collect all contracts from this search
                if ib.contracts:
                    all_contracts.extend(ib.contracts)
                
                # Stop early if we have lots of contracts already
                if len(all_contracts) >= request.max_results * 2:  # Get extra to allow for filtering
                    logger.info(f"Early stop: collected {len(all_contracts)} contracts")
                    break
            
            # Now process all collected contracts
            logger.info(f"Processing {len(all_contracts)} total contracts from all search patterns")
            
            for contract in all_contracts:
                # Filter results to match the original pattern (case-insensitive)
                if pattern.lower() in contract.symbol.lower():
                    # Extract company name (consistent with existing endpoint)
                    company_name = getattr(contract, 'longName', '') or contract.symbol
                    
                    result = {
                        "symbol": contract.symbol,
                        "company_name": company_name,
                        "description": f"{contract.symbol} - {company_name}",
                        "secType": contract.secType,
                        "exchange": contract.exchange,
                        "currency": contract.currency,
                        "conid": str(getattr(contract, 'conId', '')),
                        "primary_exchange": getattr(contract, 'primaryExchange', ''),
                        "local_symbol": getattr(contract, 'localSymbol', ''),
                        "trading_class": getattr(contract, 'tradingClass', ''),
                        "method": "reqContractDetails"
                    }
                    
                    # Avoid duplicates by symbol
                    if not any(r['symbol'] == result['symbol'] for r in results):
                        results.append(result)
                        logger.info(f"Added to results: {contract.symbol} ({contract.secType}) on {contract.exchange}")
                    
                    # Stop if we have enough results
                    if len(results) >= request.max_results:
                        break
            
            if results:
                method_used = "reqContractDetails"
                logger.info(f"Phase 1 success: Found {len(results)} symbols using reqContractDetails")
            else:
                logger.info(f"Phase 1: No results found for pattern {pattern} using reqContractDetails")
            
        except Exception as e:
            logger.error(f"Phase 1 (reqContractDetails) failed: {e}", exc_info=True)
        
        # Phase 2: Fallback to reqMatchingSymbols if needed and enabled
        if len(results) < 5 and request.use_fallback:  # Use fallback if we have fewer than 5 results
            try:
                logger.info(f"Phase 2: Trying reqMatchingSymbols for {pattern}")
                
                # Clear any previous data
                if hasattr(ib, 'symbols'):
                    ib.symbols = []
                else:
                    ib.symbols = []
                
                # Request matching symbols - try both exact and expanded patterns
                search_term = pattern
                if len(pattern) == 1:
                    # For single characters, search for common combinations
                    search_term = pattern  # Start with exact character
                
                ib.reqMatchingSymbols(11, search_term)
                time.sleep(3)  # Wait longer for matching symbols
                
                logger.info(f"Phase 2: reqMatchingSymbols returned {len(getattr(ib, 'symbols', []))} symbols")
                
                if hasattr(ib, 'symbols') and ib.symbols:
                    for contract_desc in ib.symbols:
                        contract_obj = contract_desc.contract
                        
                        # Filter by security type and exchange if specified
                        if (contract_obj.secType == request.secType and 
                            (request.exchange == 'SMART' or contract_obj.exchange == request.exchange) and
                            contract_obj.currency == request.currency):
                            
                            result = {
                                "symbol": contract_obj.symbol,
                                "company_name": getattr(contract_desc, 'derivativeSecTypes', [contract_obj.symbol])[0] if hasattr(contract_desc, 'derivativeSecTypes') else contract_obj.symbol,
                                "description": f"{contract_obj.symbol} - {getattr(contract_desc, 'derivativeSecTypes', ['N/A'])[0] if hasattr(contract_desc, 'derivativeSecTypes') else 'N/A'}",
                                "secType": contract_obj.secType,
                                "exchange": contract_obj.exchange,
                                "currency": contract_obj.currency,
                                "conid": getattr(contract_obj, 'conId', ''),
                                "primary_exchange": getattr(contract_obj, 'primaryExchange', ''),
                                "local_symbol": getattr(contract_obj, 'localSymbol', ''),
                                "trading_class": getattr(contract_obj, 'tradingClass', ''),
                                "method": "reqMatchingSymbols"
                            }
                            
                            # Avoid duplicates
                            if not any(r['symbol'] == result['symbol'] for r in results):
                                results.append(result)
                
                if results:
                    method_used = "reqMatchingSymbols"
                    logger.info(f"Phase 2 success: Found {len(results)} symbols using reqMatchingSymbols")
                
            except Exception as e:
                logger.warning(f"Phase 2 (reqMatchingSymbols) failed: {e}")
        
        # Sort results by symbol name for consistency
        results.sort(key=lambda x: x['symbol'])
        
        # Limit results
        limited_results = results[:request.max_results]
        
        # Phase 3: Cache the results
        if limited_results:
            cache_symbols(cache_key, limited_results)
        
        logger.info(f"Symbol discovery completed: {len(limited_results)} results using {method_used}")
        if limited_results:
            symbols_found = [r['symbol'] for r in limited_results]
            logger.info(f"Symbols found: {symbols_found}")
        
        return {
            "results": limited_results,
            "method": method_used,
            "cached": False,
            "count": len(limited_results),
            "pattern": pattern,
            "secType": request.secType,
            "exchange": request.exchange,
            "currency": request.currency
        }
        
    except Exception as e:
        logger.error(f"Error in symbol discovery: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Symbol discovery failed: {str(e)}"
        )

# Cache management endpoints
@app.get("/symbols/cache/stats")
async def get_cache_stats():
    """Get cache statistics"""
    stats = _symbol_cache_stats()
    return {
        "total_entries": stats["size"],
        "valid_entries": stats["valid_entries"],
        "expired_entries": stats["expired_entries"],
        "cache_size_limit": stats["max_size"],
        "ttl_seconds": stats["ttl_seconds"],
    }


@app.post("/symbols/cache/clear")
async def clear_cache():
    """Clear symbol cache"""
    removed = _clear_symbol_cache()
    logger.info("symbol_cache_cleared", removed=removed)
    return {"message": f"Cache cleared. Removed {removed} entries."}

if __name__ == "__main__":
    logger.info("Starting TWS API Service...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    ) 
