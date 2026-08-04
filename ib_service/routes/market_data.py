"""Historical, tick and real-time market-data endpoints (+ indicators list)."""

from __future__ import annotations

import math
import time
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from ibapi.ticktype import TickTypeEnum

from bars_processing import (
    process_bars_with_date_range_and_indicators,
    process_bars_with_indicators,
)
from ib_client import get_ib_connection, verify_connection_health
from ib_helpers import (
    convert_period,
    convert_timeframe,
    create_contract,
    get_data_type_for_account_mode,
)
from indicators import calculator as indicator_calculator
from models import HistoricalDataResponse, MarketDataRequest, RealTimeQuote
from observability import get_logger

from ._shared import run_tws_operation

logger = get_logger(__name__)
router = APIRouter()


@router.get("/market-data/history", response_model=HistoricalDataResponse)
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
    currency: str = "USD",
    source: str = "ib",
):
    """Get historical market data with support for date ranges and technical indicators"""
    try:
        # Broker-scoped source (B1): validate + resolve the venue. source=ib is
        # the default and keeps the existing IB path below unchanged; an unknown
        # source → 400 and a not-yet-available venue (mt5) → 501. Per-venue
        # historical dispatch through the adapter arrives with the MT5 data
        # adapter (B2a); today only IB serves bars.
        from adapters import get_market_data_adapter

        get_market_data_adapter(source)
        # Parse indicators parameter (comma-separated list)
        indicator_list = []
        if indicators:
            indicator_list = [ind.strip() for ind in indicators.split(",") if ind.strip()]

        # Validate that we have either period OR date range, but not both
        has_date_range = start_date and end_date
        has_period = period and period != "CUSTOM"

        if not has_date_range and not has_period:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Must provide either period OR date range (start_date and end_date)",
            )

        if has_date_range and has_period:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot specify both period and date range. Use period OR start_date/end_date",
            )

        # Validate date range if provided
        if has_date_range:
            try:
                start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")

                if start_dt >= end_dt:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Start date must be before end date",
                    )

                if end_dt > datetime.now():
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="End date cannot be in the future",
                    )

                # Calculate duration for IB request
                duration_days = (end_dt - start_dt).days
                if duration_days > 365:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Date range cannot exceed 365 days",
                    )

            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date format. Use YYYY-MM-DD format",
                )

        # Validate basic request (for period-based requests). Constructing the
        # model runs its pydantic validators and raises on bad input.
        if has_period:
            MarketDataRequest(symbol=symbol, timeframe=timeframe, period=period)

        # Get connection
        ib = get_ib_connection()

        # Verify connection is healthy
        if not ib.isConnected():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available",
            )

        logger.info(f"IB connection verified - connected: {ib.isConnected()}")

        # Create contract
        contract = create_contract(symbol.upper(), secType, exchange, currency)
        logger.info(
            f"Requesting historical data for contract: {symbol} ({secType}) on {exchange} in {currency}"
        )

        # Clear previous contract details
        ib.contracts = []

        # Request contract details to qualify the contract
        ib.reqContractDetails(1, contract)
        time.sleep(2)  # Wait for contract details

        logger.info(f"Contract details request completed. Found {len(ib.contracts)} contracts")

        if not ib.contracts:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Symbol {symbol} not found",
            )

        qualified_contract = ib.contracts[0]

        # Prepare data for IB request
        ib_timeframe = convert_timeframe(timeframe)
        data_type = get_data_type_for_account_mode(account_mode)

        # Determine duration and end date for IB request
        if has_date_range:
            # For date range requests
            duration_days = (end_dt - start_dt).days
            ib_duration = f"{duration_days} D"
            end_date_str = end_dt.strftime("%Y%m%d %H:%M:%S")

            logger.info(
                f"Requesting historical data for {symbol} - {data_type} ({account_mode} mode)"
            )
            logger.info(
                f"Date Range: {start_date} to {end_date} ({duration_days} days), "
                f"Timeframe: {timeframe} -> {ib_timeframe}"
            )
        else:
            # For period-based requests
            ib_duration = convert_period(period)
            end_date_str = ""  # Empty string means "now"

            logger.info(
                f"Requesting historical data for {symbol} - {data_type} ({account_mode} mode)"
            )
            logger.info(
                f"Period: {period} -> {ib_duration}, Timeframe: {timeframe} -> {ib_timeframe}"
            )

        # Set market data type based on account mode
        if account_mode.lower() == "live":
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
            "TRADES",
            1,  # useRTH
            format_date,  # formatDate: 1 for string format (more reliable)
            False,  # keepUpToDate
            [],  # chartOptions
        )

        logger.info(
            f"Requested historical data with formatDate={format_date} (string format for compatibility)"
        )

        # Wait for data with longer timeout and retry logic
        max_wait_time = 15  # seconds
        wait_interval = 1  # seconds
        total_wait_time = 0

        while len(ib.historical_data) == 0 and total_wait_time < max_wait_time:
            time.sleep(wait_interval)
            total_wait_time += wait_interval
            logger.info(
                f"Waiting for historical data... ({total_wait_time}/{max_wait_time}s) - "
                f"bars received: {len(ib.historical_data)}"
            )

        logger.info(
            f"Historical data request completed. Received {len(ib.historical_data)} bars "
            f"after {total_wait_time}s"
        )
        if len(ib.historical_data) > 0:
            logger.info(f"Sample bar: {ib.historical_data[0]}")
        else:
            logger.warning("No historical data received from IB Gateway")

        if not ib.historical_data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No historical data available for {symbol} after {total_wait_time}s timeout",
            )

        # Process and return data with indicators
        logger.info(f"Processing bars with indicators: {indicator_list}")
        if has_date_range:
            result = process_bars_with_date_range_and_indicators(
                ib.historical_data, symbol, timeframe, start_date, end_date, indicator_list
            )
        else:
            result = process_bars_with_indicators(
                ib.historical_data, symbol, timeframe, period, indicator_list
            )

        logger.info(f"Processed result: {result.count} bars returned")

        # Debug: Check first few timestamps being returned to frontend
        if result.bars and len(result.bars) > 0:
            logger.info("=== TIMESTAMP DEBUG - Values being sent to frontend ===")
            for i, bar in enumerate(result.bars[:3]):
                timestamp_date = datetime.fromtimestamp(bar.timestamp, tz=UTC)
                logger.info(
                    f"  Bar {i + 1}: timestamp={bar.timestamp}, converts_to={timestamp_date}"
                )
                valid = (
                    "VALID"
                    if 1700000000 <= bar.timestamp <= 1800000000
                    else ("INVALID - FRONTEND WILL SHOW WRONG DATES")
                )
                logger.info(f"    Validation: {valid}")
            logger.info("=== END TIMESTAMP DEBUG ===")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting historical data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get historical data: {str(e)}",
        )


@router.get("/indicators/available")
async def get_available_indicators():
    """Get list of all available technical indicators"""
    try:
        return {
            "indicators": indicator_calculator.get_available_indicators(),
            "usage": "Add indicators as comma-separated list in 'indicators' parameter, "
            "e.g., indicators=sma_20,rsi,bollinger",
        }
    except Exception as e:
        logger.error(f"Error getting available indicators: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available indicators: {str(e)}",
        )


def get_realtime_data_sync(symbol: str, account_mode: str = "paper"):
    """Get real-time market data using TWS API"""
    try:
        data_type = get_data_type_for_account_mode(account_mode)

        logger.info(f"Starting {data_type} data request for symbol: {symbol} ({account_mode} mode)")

        # Get connection
        ib = get_ib_connection()
        logger.info(f"Using shared TWS API connection, connected: {ib.isConnected()}")

        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")

        # Set market data type based on account mode
        if account_mode.lower() == "live":
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
        ib.reqMktData(req_id, qualified_contract, "", False, False, [])
        logger.info(
            f"Market data requested for {qualified_contract.symbol} with data type: {data_type}"
        )

        # Wait for data
        time.sleep(3)

        # Get data from the client
        tick_data = ib.data.get(req_id, {})
        logger.info(f"Tick data received: {tick_data}")

        # Process quote
        bid = tick_data.get("bid") if tick_data.get("tickType") == TickTypeEnum.BID else None
        ask = tick_data.get("ask") if tick_data.get("tickType") == TickTypeEnum.ASK else None
        last = tick_data.get("last") if tick_data.get("tickType") == TickTypeEnum.LAST else None
        volume = (
            tick_data.get("volume") if tick_data.get("tickType") == TickTypeEnum.VOLUME else None
        )

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
            timestamp=datetime.now().isoformat(),
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


@router.get("/market-data/tick")
async def get_tick_data(symbol: str, account_mode: str = "paper", source: str = "ib"):
    """Get high-frequency tick data"""
    try:
        logger.info(f"Tick data endpoint called for symbol: {symbol}")

        from adapters import get_market_data_adapter

        adapter = get_market_data_adapter(source)
        # Run the synchronous operation in a separate thread
        tick_data = await run_tws_operation(lambda: adapter.tick(symbol, account_mode))

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
            detail=f"Failed to get tick data for {symbol}: {error_str}",
        )


def get_tick_data_sync(symbol: str, account_mode: str = "paper"):
    """Get tick data synchronously"""
    try:
        # Get connection
        ib = get_ib_connection()

        # Create contract
        contract = create_contract(symbol.upper(), "STK", "SMART", "USD")

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
        ib.reqMktData(req_id, qualified_contract, "", False, False, [])
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
            "bid": tick_data.get("bid"),
            "ask": tick_data.get("ask"),
            "last": tick_data.get("last"),
            "volume": tick_data.get("volume"),
            "high": tick_data.get("high"),
            "low": tick_data.get("low"),
            "close": tick_data.get("close"),
            "open": tick_data.get("open"),
            "tick_type": tick_data.get("tickType"),
            "exchange": tick_data.get("exchange"),
            "special_conditions": tick_data.get("specialConditions"),
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


@router.get("/market-data/realtime", response_model=RealTimeQuote)
async def get_realtime_data(symbol: str, account_mode: str = "paper", source: str = "ib"):
    """Get real-time market data"""
    try:
        logger.info(f"Real-time data endpoint called for symbol: {symbol}")

        from adapters import get_market_data_adapter

        adapter = get_market_data_adapter(source)
        # Run the synchronous operation in a separate thread
        quote = await run_tws_operation(lambda: adapter.realtime_quote(symbol, account_mode))

        logger.info(f"Successfully retrieved market data for {symbol}")
        return quote

    except HTTPException as he:
        logger.error(f"HTTP Exception in endpoint: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(
            f"Unexpected error in real-time data endpoint: {type(e).__name__}: {error_str}"
        )

        # Handle specific IB Gateway subscription errors
        if "subscription" in error_str.lower() or "market data farm" in error_str.lower():
            error_message = (
                f"Market data subscription issue for {symbol}. Using delayed data if available. "
                "Check IB Gateway market data subscriptions."
            )
        elif "timeout" in error_str.lower():
            error_message = (
                f"Timeout retrieving market data for {symbol}. "
                "IB Gateway may be busy or unresponsive."
            )
        elif "not found" in error_str.lower() or "qualify" in error_str.lower():
            error_message = f"Symbol {symbol} not found or cannot be qualified by IB Gateway."
        else:
            error_message = f"Failed to get market data for {symbol}: {error_str}"

        logger.error(f"Error details: {error_message}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_message,
        )
