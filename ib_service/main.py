"""
TWS API Service - Using official Interactive Brokers TWS API for reliable IB Gateway connections
"""

import os
import time
import logging
import asyncio
import math
import threading
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from ibapi.client import EClient
from ibapi.wrapper import EWrapper
from ibapi.contract import Contract
from ibapi.order import Order
from ibapi.common import *
from ibapi.ticktype import *
import uvicorn

# Technical indicators support
import pandas as pd
import numpy as np
from indicators import calculator as indicator_calculator

# Backtesting support
from backtesting import backtest_engine, AVAILABLE_STRATEGIES

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration from environment
IB_HOST = os.getenv('IB_HOST')
if not IB_HOST:
    raise ValueError("IB_HOST environment variable is required")

IB_PORT = int(os.getenv('IB_PORT', '4002'))
IB_CLIENT_ID = int(os.getenv('IB_CLIENT_ID', '1'))
IB_TIMEOUT = int(os.getenv('IB_TIMEOUT', '15'))
CORS_ORIGINS = os.getenv('IB_CORS_ORIGINS', '').split(',') if os.getenv('IB_CORS_ORIGINS') else []

# Trading account configuration
DEFAULT_ACCOUNT_MODE = os.getenv('DEFAULT_ACCOUNT_MODE', 'paper')  # 'paper' or 'live'

# Global IB connection
ib_client = None
connection_status = {
    'connected': False,
    'last_connected': None,
    'last_error': None,
    'connection_count': 0
}

# Data storage for async operations
historical_data = {}
real_time_data = {}
account_data = {}
positions_data = []
orders_data = []

class MarketDataRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=10)
    timeframe: str = Field(..., pattern=r'^(5min|15min|30min|1hour|4hour|8hour|1day)$')
    period: str = Field(default="1Y", pattern=r'^(1D|1W|1M|3M|6M|1Y)$')

class CandlestickBar(BaseModel):
    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: int
    
    # Technical Indicators (optional fields)
    sma_20: Optional[float] = None
    sma_50: Optional[float] = None
    ema_12: Optional[float] = None
    ema_26: Optional[float] = None
    rsi: Optional[float] = None
    macd: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_histogram: Optional[float] = None
    bb_upper: Optional[float] = None
    bb_middle: Optional[float] = None
    bb_lower: Optional[float] = None
    stoch_k: Optional[float] = None
    stoch_d: Optional[float] = None
    atr: Optional[float] = None
    obv: Optional[float] = None
    vwap: Optional[float] = None
    volume_sma: Optional[float] = None

class HistoricalDataResponse(BaseModel):
    symbol: str
    timeframe: str
    period: str
    bars: List[CandlestickBar]
    count: int
    last_updated: str

class RealTimeQuote(BaseModel):
    symbol: str
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    volume: Optional[int] = None
    timestamp: str

class SearchRequest(BaseModel):
    symbol: str
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    name: bool = False
    account_mode: str = "paper"

class AdvancedSearchRequest(BaseModel):
    symbol: str = ""
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    expiry: str = ""
    strike: float = 0
    right: str = ""
    multiplier: str = ""
    includeExpired: bool = False
    name: bool = False
    account_mode: str = "paper"

# Account-related models
class AccountSummary(BaseModel):
    account_id: str
    net_liquidation: Optional[float] = None
    currency: str = "USD"
    last_updated: str
    
    # Optional fields
    total_cash_value: Optional[float] = None
    buying_power: Optional[float] = None
    maintenance_margin: Optional[float] = None

class Position(BaseModel):
    symbol: str
    position: float
    market_price: Optional[float] = None
    market_value: Optional[float] = None
    average_cost: Optional[float] = None
    unrealized_pnl: Optional[float] = None
    currency: str = "USD"

class Order(BaseModel):
    order_id: int
    symbol: str
    action: str  # BUY/SELL
    quantity: float
    order_type: str
    status: str
    filled_quantity: Optional[float] = None
    remaining_quantity: Optional[float] = None
    avg_fill_price: Optional[float] = None

class AccountData(BaseModel):
    account: AccountSummary
    positions: List[Position]
    orders: List[Order]
    last_updated: str

class ConnectionInfo(BaseModel):
    connected: bool
    host: str
    port: int
    client_id: int
    last_connected: Optional[str] = None
    last_error: Optional[str] = None
    connection_count: int

class IBApp(EWrapper, EClient):
    """TWS API Application class"""
    
    def __init__(self):
        EClient.__init__(self, self)
        self.data = {}
        self.contracts = []
        self.historical_data = []
        self.account_summary = {}
        self.positions = []
        self.orders = []
        self.managed_accounts = []
        self.next_order_id = None
        self.connection_ready = threading.Event()
        
    def error(self, reqId, errorCode, errorString):
        """Handle TWS API errors"""
        logger.error(f"TWS API Error {errorCode}: {errorString} (reqId: {reqId})")
        
    def connectAck(self):
        """Called when connection is acknowledged"""
        logger.info("TWS API connection acknowledged")
        
    def nextValidId(self, orderId):
        """Called when next valid order ID is received"""
        self.next_order_id = orderId
        logger.info(f"Next valid order ID: {orderId}")
        
    def managedAccounts(self, accountsList):
        """Called when managed accounts are received"""
        self.managed_accounts = accountsList.split(',')
        logger.info(f"Managed accounts: {self.managed_accounts}")
        
    def contractDetails(self, reqId, contractDetails):
        """Called when contract details are received"""
        self.contracts.append(contractDetails.contract)
        logger.info(f"Contract details received for reqId {reqId}: {contractDetails.contract.symbol}")
        
    def contractDetailsEnd(self, reqId):
        """Called when contract details request is complete"""
        logger.info(f"Contract details request completed for reqId {reqId}")
        
    def historicalData(self, reqId, bar):
        """Called when historical data is received"""
        self.historical_data.append(bar)
        logger.debug(f"Historical data received for reqId {reqId}: {bar}")
        
    def historicalDataEnd(self, reqId, start, end):
        """Called when historical data request is complete"""
        logger.info(f"Historical data request completed for reqId {reqId}")
        
    def tickPrice(self, reqId, tickType, price, attrib):
        """Called when tick price is received"""
        if reqId not in self.data:
            self.data[reqId] = {}
        self.data[reqId]['price'] = price
        self.data[reqId]['tickType'] = tickType
        logger.debug(f"Tick price for reqId {reqId}: {tickType} = {price}")
        
    def tickSize(self, reqId, tickType, size):
        """Called when tick size is received"""
        if reqId not in self.data:
            self.data[reqId] = {}
        self.data[reqId]['size'] = size
        self.data[reqId]['tickType'] = tickType
        logger.debug(f"Tick size for reqId {reqId}: {tickType} = {size}")
        
    def accountSummary(self, reqId, account, tag, value, currency):
        """Called when account summary is received"""
        if account not in self.account_summary:
            self.account_summary[account] = {}
        self.account_summary[account][tag] = value
        logger.debug(f"Account summary for {account}: {tag} = {value}")
        
    def accountSummaryEnd(self, reqId):
        """Called when account summary request is complete"""
        logger.info(f"Account summary request completed for reqId {reqId}")
        
    def position(self, account, contract, position, avgCost):
        """Called when position is received"""
        self.positions.append({
            'account': account,
            'contract': contract,
            'position': position,
            'avgCost': avgCost
        })
        logger.debug(f"Position received: {contract.symbol} = {position}")
        
    def positionEnd(self):
        """Called when position request is complete"""
        logger.info("Position request completed")
        
    def openOrder(self, orderId, contract, order, orderState):
        """Called when open order is received"""
        self.orders.append({
            'orderId': orderId,
            'contract': contract,
            'order': order,
            'orderState': orderState
        })
        logger.debug(f"Open order received: {orderId} - {contract.symbol}")
        
    def orderStatus(self, orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld, mktCapPrice):
        """Called when order status is updated"""
        logger.debug(f"Order status: {orderId} - {status}")

def get_ib_connection():
    """Get or create IB connection with intelligent client ID retry"""
    global ib_client, connection_status
    
    try:
        # Check if we have a valid connection
        if ib_client and ib_client.isConnected():
            return ib_client
        
        # Clean up any existing connection first
        if ib_client:
            try:
                ib_client.disconnect()
                logger.info("Cleaned up previous connection")
            except:
                pass
            ib_client = None
        
        # Try multiple client IDs if the primary one is in use
        import random
        base_id = IB_CLIENT_ID
        client_ids_to_try = [base_id, base_id + 1, base_id + 2, base_id + 3, base_id + 4, base_id + 5]
        random.shuffle(client_ids_to_try[1:])
        last_error = None
        
        for client_id in client_ids_to_try:
            try:
                logger.info(f"Attempting connection to IB Gateway at {IB_HOST}:{IB_PORT} (Client ID: {client_id})")
                ib_client = IBApp()
                
                # Connect to TWS API
                ib_client.connect(IB_HOST, IB_PORT, client_id)
                
                # Start the message processing thread
                api_thread = threading.Thread(target=ib_client.run, daemon=True)
                api_thread.start()
                
                # Wait for connection to be established
                logger.info("Waiting for connection to stabilize...")
                time.sleep(5)
                
                # Verify connection
                connection_verified = False
                for verify_attempt in range(5):
                    if ib_client.isConnected():
                        connection_verified = True
                        logger.info(f"✅ Connection verified on attempt {verify_attempt + 1}")
                        break
                    else:
                        logger.warning(f"Connection verification attempt {verify_attempt + 1}/5 - not yet connected, waiting...")
                        time.sleep(3)
                
                if connection_verified:
                    connection_status.update({
                        'connected': True,
                        'last_connected': datetime.now().isoformat(),
                        'last_error': None,
                        'connection_count': connection_status['connection_count'] + 1
                    })
                    logger.info(f"✅ Successfully connected and verified IB Gateway at {IB_HOST}:{IB_PORT} (Client ID: {client_id})")
                    return ib_client
                else:
                    raise Exception("Connection call succeeded but connection verification failed after retries")
                    
            except Exception as e:
                error_msg = str(e)
                last_error = error_msg
                
                if "client id is already in use" in error_msg.lower() or "326" in error_msg:
                    logger.warning(f"⚠️  Client ID {client_id} is already in use, trying next ID...")
                    if ib_client:
                        try:
                            ib_client.disconnect()
                        except:
                            pass
                        ib_client = None
                    continue
                elif "peer closed" in error_msg.lower() or "connection established but" in error_msg.lower():
                    logger.warning(f"⚠️  Connection issue with Client ID {client_id}: {error_msg}. Trying next ID...")
                    if ib_client:
                        try:
                            ib_client.disconnect()
                        except:
                            pass
                        ib_client = None
                    time.sleep(2)
                    continue
                else:
                    logger.error(f"Connection error with Client ID {client_id}: {error_msg}")
                    if ib_client:
                        try:
                            ib_client.disconnect()
                        except:
                            pass
                        ib_client = None
                    break
        
        # If we get here, all client IDs failed
        logger.error(f"❌ Failed to connect with any client ID. Last error: {last_error}")
        
        # Provide helpful error message based on error type
        if "timeout" in str(last_error).lower():
            helpful_msg = f"IB Gateway connection timeout. Please check: 1) IB Gateway is running on {IB_HOST}, 2) API is enabled in IB Gateway settings, 3) Port {IB_PORT} is correct, 4) Network connectivity to {IB_HOST}"
        elif "refused" in str(last_error).lower():
            helpful_msg = f"IB Gateway refused connection. Please check: 1) IB Gateway API settings are enabled, 2) Port {IB_PORT} is correct, 3) Trusted IPs include this server, 4) IB Gateway is not in offline mode"
        elif "unreachable" in str(last_error).lower() or "no route to host" in str(last_error).lower():
            helpful_msg = f"Cannot reach {IB_HOST}. Please check: 1) IP address {IB_HOST} is correct, 2) Network connectivity, 3) Firewall settings"
        elif "client id is already in use" in str(last_error).lower():
            helpful_msg = f"All client IDs ({base_id}-{base_id+5}) are in use. Please: 1) Close other trading applications, 2) Restart IB Gateway, 3) Wait a few minutes for connections to timeout, 4) Check if multiple trading services are running"
        else:
            helpful_msg = f"IB Gateway connection failed: {last_error}"
        
        connection_status.update({
            'connected': False,
            'last_error': helpful_msg
        })
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=helpful_msg
        )
            
    except HTTPException:
        raise
    except Exception as e:
        error_msg = f"Unexpected connection error: {str(e)}"
        logger.error(error_msg)
        
        connection_status.update({
            'connected': False,
            'last_error': error_msg
        })
        
        if ib_client:
            try:
                ib_client.disconnect()
            except:
                pass
        ib_client = None
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=error_msg
        )

def verify_connection_health(ib_client):
    """Verify that an IB connection is healthy and responsive"""
    try:
        if not ib_client or not ib_client.isConnected():
            return False
        
        logger.debug("Connection health check passed - basic state verified")
        return True
            
    except Exception as e:
        logger.warning(f"Connection health check failed: {e}")
        return False

def disconnect_ib():
    """Disconnect from IB Gateway with improved cleanup"""
    global ib_client, connection_status
    
    if ib_client:
        try:
            if ib_client.isConnected():
                logger.info("Disconnecting from IB Gateway...")
                ib_client.disconnect()
                logger.info("✅ Successfully disconnected from IB Gateway")
            else:
                logger.info("IB Gateway already disconnected")
        except Exception as e:
            logger.error(f"Error during disconnection: {e}")
        finally:
            ib_client = None
            connection_status.update({
                'connected': False,
                'last_error': None
            })
            logger.info("Connection cleanup completed")

def create_contract(symbol: str, sec_type: str = 'STK', exchange: str = 'SMART', currency: str = 'USD'):
    """Create IB contract using TWS API"""
    contract = Contract()
    contract.symbol = symbol.upper()
    contract.secType = sec_type
    contract.exchange = exchange
    contract.currency = currency
    return contract

def get_data_type_for_account_mode(account_mode: str = 'paper') -> str:
    """Determine data type based on account mode"""
    if account_mode.lower() == 'live':
        return 'real-time'
    else:
        return 'delayed'  # Default to delayed for paper trading

def get_market_data_source(account_mode: str = 'paper') -> str:
    """Get market data source description based on account mode"""
    if account_mode.lower() == 'live':
        return 'Live Market Data (Real-time)'
    else:
        return 'Paper Trading Data (Delayed 15-20 min)'

def convert_timeframe(timeframe: str) -> str:
    """Convert timeframe to IB format"""
    timeframe_map = {
        '5min': '5 mins',
        '15min': '15 mins',
        '30min': '30 mins',
        '1hour': '1 hour',
        '4hour': '4 hours',
        '8hour': '8 hours',
        '1day': '1 day'
    }
    return timeframe_map.get(timeframe, '1 hour')

def convert_period(period: str) -> str:
    """Convert period to IB format (integer{SPACE}unit)"""
    period_map = {
        '1D': '1 D',
        '1W': '1 W', 
        '1M': '1 M',
        '3M': '3 M',
        '6M': '6 M',
        '1Y': '1 Y'
    }
    return period_map.get(period, '1 Y')

def process_bars(bars, symbol: str, timeframe: str, period: str) -> HistoricalDataResponse:
    """Process IB bars into candlestick data with simple UTC timezone handling"""
    candlesticks = []
    
    for bar in bars:
        try:
            # Handle different date formats from IB - treat as UTC directly
            if isinstance(bar.date, str):
                # String format like "20250725 23:30:00"
                if ' ' in bar.date:
                    # Parse as UTC datetime directly (IB Gateway times are effectively market times)
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d %H:%M:%S")
                    bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                else:
                    # Date only format like "20250725"
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d")
                    bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
            elif isinstance(bar.date, (int, float)):
                # Unix timestamp - assume UTC
                bar_datetime = datetime.fromtimestamp(bar.date, timezone.utc)
            else:
                # Assume it's already a datetime object
                if hasattr(bar.date, 'replace') and bar.date.tzinfo is None:
                    bar_datetime = bar.date.replace(tzinfo=timezone.utc)
                else:
                    bar_datetime = bar.date
            
            # Create Unix timestamp
            timestamp = int(bar_datetime.timestamp())
            
            # Debug logging for first few bars
            if len(candlesticks) < 3:
                logger.info(f"Bar date: {bar.date} -> datetime: {bar_datetime} -> timestamp: {timestamp}")
                logger.info(f"Timestamp verification: {datetime.fromtimestamp(timestamp)}")
            
            candlestick = CandlestickBar(
                timestamp=timestamp,
                open=float(bar.open),
                high=float(bar.high),
                low=float(bar.low),
                close=float(bar.close),
                volume=int(bar.volume)
            )
            candlesticks.append(candlestick)
        except Exception as e:
            logger.warning(f"Error processing bar: {e}, bar.date={bar.date}")
            continue
    
    # Sort bars by timestamp in descending order (newest first)
    candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
    
    logger.info(f"Processed {len(candlesticks)} bars for {symbol} {timeframe} {period}")
    if candlesticks:
        logger.info(f"Date range: {datetime.fromtimestamp(candlesticks[-1].timestamp)} to {datetime.fromtimestamp(candlesticks[0].timestamp)}")
        logger.info(f"Sample timestamps: {candlesticks[0].timestamp} (newest), {candlesticks[-1].timestamp} (oldest)")
        logger.info(f"Sample dates: {datetime.fromtimestamp(candlesticks[0].timestamp).strftime('%Y-%m-%d %H:%M:%S')} (newest), {datetime.fromtimestamp(candlesticks[-1].timestamp).strftime('%Y-%m-%d %H:%M:%S')} (oldest)")
    
    return HistoricalDataResponse(
        symbol=symbol,
        timeframe=timeframe,
        period=period,
        bars=candlesticks,
        count=len(candlesticks),
        last_updated=datetime.now().isoformat()
    )

def process_bars_with_date_range(bars, symbol: str, timeframe: str, start_date_str: str, end_date_str: str) -> HistoricalDataResponse:
    """Process IB bars with date range filtering and simple UTC timezone handling"""
    candlesticks = []
    
    start_dt = datetime.strptime(start_date_str, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date_str, "%Y-%m-%d")
    # Add one day to end_dt to include the entire end date
    end_dt = end_dt.replace(hour=23, minute=59, second=59)
    
    for bar in bars:
        try:
            # Handle different date formats from IB - treat as UTC directly
            if isinstance(bar.date, str):
                # String format like "20240101 09:30:00"
                if ' ' in bar.date:
                    # Parse as UTC datetime directly
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d %H:%M:%S")
                    bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                    bar_datetime_naive = bar_datetime.replace(tzinfo=None)
                else:
                    # Date only format like "20240101"
                    bar_datetime = datetime.strptime(bar.date, "%Y%m%d")
                    bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                    bar_datetime_naive = bar_datetime.replace(tzinfo=None)
            elif isinstance(bar.date, (int, float)):
                # Unix timestamp - assume UTC
                bar_datetime = datetime.fromtimestamp(bar.date, timezone.utc)
                bar_datetime_naive = bar_datetime.replace(tzinfo=None)
            else:
                # Assume it's already a datetime object
                if hasattr(bar.date, 'replace') and bar.date.tzinfo is None:
                    bar_datetime = bar.date.replace(tzinfo=timezone.utc)
                    bar_datetime_naive = bar.date
                else:
                    bar_datetime = bar.date
                    bar_datetime_naive = bar_datetime.replace(tzinfo=None) if bar_datetime.tzinfo else bar_datetime
            
            # Check if bar is within our date range
            if start_dt <= bar_datetime_naive <= end_dt:
                timestamp = int(bar_datetime.timestamp())
                
                candlestick = CandlestickBar(
                    timestamp=timestamp,
                    open=float(bar.open),
                    high=float(bar.high),
                    low=float(bar.low),
                    close=float(bar.close),
                    volume=int(bar.volume)
                )
                candlesticks.append(candlestick)
        except Exception as e:
            logger.warning(f"Error processing bar for date range: {e}, bar.date={bar.date}")
            continue
    
    # Sort bars by timestamp in descending order (newest first)
    candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
    
    logger.info(f"Processed {len(candlesticks)} bars for {symbol} {timeframe} date range {start_date_str} to {end_date_str}")
    if candlesticks:
        logger.info(f"Date range: {datetime.fromtimestamp(candlesticks[-1].timestamp)} to {datetime.fromtimestamp(candlesticks[0].timestamp)}")
    
    return HistoricalDataResponse(
        symbol=symbol,
        timeframe=timeframe,
        period="CUSTOM",  # Indicate it's a custom date range
        bars=candlesticks,
        count=len(candlesticks),
        last_updated=datetime.now().isoformat()
    )

def process_bars_with_indicators(bars, symbol: str, timeframe: str, period: str, indicators: List[str] = None) -> HistoricalDataResponse:
    """Process IB bars into candlestick data with technical indicators"""
    try:
        logger.info(f"process_bars_with_indicators called with {len(bars)} bars, indicators: {indicators}")
        
        # Convert bars to DataFrame for indicator calculations
        bars_data = []
        for i, bar in enumerate(bars):
            try:
                if i == 0:  # Log first bar details for debugging
                    logger.info(f"Processing first bar: date={bar.date}, open={bar.open}, high={bar.high}, low={bar.low}, close={bar.close}, volume={bar.volume}")
                
                # Handle different date formats from IB - treat as UTC directly
                if isinstance(bar.date, str):
                    # String format like "20250725 23:30:00"
                    if ' ' in bar.date:
                        # Parse as UTC datetime directly
                        bar_datetime = datetime.strptime(bar.date, "%Y%m%d %H:%M:%S")
                        bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                    else:
                        # Date only format like "20250725"
                        bar_datetime = datetime.strptime(bar.date, "%Y%m%d")
                        bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                elif isinstance(bar.date, (int, float)):
                    # Unix timestamp - assume UTC
                    bar_datetime = datetime.fromtimestamp(bar.date, timezone.utc)
                else:
                    # Assume it's already a datetime object
                    if hasattr(bar.date, 'replace') and bar.date.tzinfo is None:
                        bar_datetime = bar.date.replace(tzinfo=timezone.utc)
                    else:
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
                logger.warning(f"Error processing bar {i}: {e}, bar={bar}")
                continue
        
        logger.info(f"Successfully processed {len(bars_data)} bars from {len(bars)} raw bars")
        
        if not bars_data:
            return HistoricalDataResponse(
                symbol=symbol,
                timeframe=timeframe,
                period=period,
                bars=[],
                count=0,
                last_updated=datetime.now().isoformat()
            )
        
        # Calculate indicators if requested
        if indicators and len(indicators) > 0:
            # Convert to DataFrame for indicator calculations
            df = pd.DataFrame(bars_data)
            
            # Calculate indicators
            df_with_indicators = indicator_calculator.calculate_indicators(df, indicators)
            
            # Convert back to CandlestickBar objects
            candlesticks = []
            for _, row in df_with_indicators.iterrows():
                # Create base candlestick data
                candlestick_data = {
                    'timestamp': float(row['timestamp']),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': int(row['volume'])
                }
                
                # Add indicator values if they exist and are not NaN
                indicator_fields = [
                    'sma_20', 'sma_50', 'ema_12', 'ema_26', 'rsi', 
                    'macd', 'macd_signal', 'macd_histogram',
                    'bb_upper', 'bb_middle', 'bb_lower',
                    'stoch_k', 'stoch_d', 'atr', 'obv', 'vwap', 'volume_sma'
                ]
                
                for field in indicator_fields:
                    if field in row and pd.notna(row[field]):
                        candlestick_data[field] = float(row[field])
                
                candlestick = CandlestickBar(**candlestick_data)
                candlesticks.append(candlestick)
        else:
            # No indicators requested, use standard processing
            candlesticks = []
            for bar_data in bars_data:
                candlestick = CandlestickBar(**bar_data)
                candlesticks.append(candlestick)
        
        # Sort bars by timestamp in descending order (newest first)
        candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
        
        logger.info(f"Processed {len(candlesticks)} bars with indicators for {symbol} {timeframe} {period}")
        if candlesticks:
            logger.info(f"Date range: {datetime.fromtimestamp(candlesticks[-1].timestamp)} to {datetime.fromtimestamp(candlesticks[0].timestamp)}")
        
        return HistoricalDataResponse(
            symbol=symbol,
            timeframe=timeframe,
            period=period,
            bars=candlesticks,
            count=len(candlesticks),
            last_updated=datetime.now().isoformat()
        )
        
    except Exception as e:
        logger.error(f"Error processing bars with indicators: {e}")
        # Fallback to standard processing
        return process_bars(bars, symbol, timeframe, period)

def process_bars_with_date_range_and_indicators(bars, symbol: str, timeframe: str, start_date_str: str, end_date_str: str, indicators: List[str] = None) -> HistoricalDataResponse:
    """Process IB bars with date range filtering and technical indicators"""
    try:
        start_dt = datetime.strptime(start_date_str, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date_str, "%Y-%m-%d")
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        
        # Filter bars by date range and convert to DataFrame format
        bars_data = []
        for bar in bars:
            try:
                # Handle different date formats from IB - treat as UTC directly
                if isinstance(bar.date, str):
                    if ' ' in bar.date:
                        # Parse as UTC datetime directly
                        bar_datetime = datetime.strptime(bar.date, "%Y%m%d %H:%M:%S")
                        bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                        bar_datetime_naive = bar_datetime.replace(tzinfo=None)
                    else:
                        # Date only format like "20240101"
                        bar_datetime = datetime.strptime(bar.date, "%Y%m%d")
                        bar_datetime = bar_datetime.replace(tzinfo=timezone.utc)
                        bar_datetime_naive = bar_datetime.replace(tzinfo=None)
                elif isinstance(bar.date, (int, float)):
                    # Unix timestamp - assume UTC
                    bar_datetime = datetime.fromtimestamp(bar.date, timezone.utc)
                    bar_datetime_naive = bar_datetime.replace(tzinfo=None)
                else:
                    # Assume it's already a datetime object
                    if hasattr(bar.date, 'replace') and bar.date.tzinfo is None:
                        bar_datetime = bar.date.replace(tzinfo=timezone.utc)
                        bar_datetime_naive = bar.date
                    else:
                        bar_datetime = bar.date
                        bar_datetime_naive = bar_datetime.replace(tzinfo=None) if bar_datetime.tzinfo else bar_datetime
                
                # Check if bar is within our date range
                if start_dt <= bar_datetime_naive <= end_dt:
                    bars_data.append({
                        'timestamp': int(bar_datetime.timestamp()),
                        'open': float(bar.open),
                        'high': float(bar.high),
                        'low': float(bar.low),
                        'close': float(bar.close),
                        'volume': int(bar.volume)
                    })
            except Exception as e:
                logger.warning(f"Error processing bar for date range: {e}, bar.date={bar.date}")
                continue
        
        if not bars_data:
            return HistoricalDataResponse(
                symbol=symbol,
                timeframe=timeframe,
                period="CUSTOM",
                bars=[],
                count=0,
                last_updated=datetime.now().isoformat()
            )
        
        # Calculate indicators if requested
        if indicators and len(indicators) > 0:
            df = pd.DataFrame(bars_data)
            df_with_indicators = indicator_calculator.calculate_indicators(df, indicators)
            
            # Convert back to CandlestickBar objects
            candlesticks = []
            for _, row in df_with_indicators.iterrows():
                candlestick_data = {
                    'timestamp': float(row['timestamp']),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': int(row['volume'])
                }
                
                # Add indicator values if they exist and are not NaN
                indicator_fields = [
                    'sma_20', 'sma_50', 'ema_12', 'ema_26', 'rsi', 
                    'macd', 'macd_signal', 'macd_histogram',
                    'bb_upper', 'bb_middle', 'bb_lower',
                    'stoch_k', 'stoch_d', 'atr', 'obv', 'vwap', 'volume_sma'
                ]
                
                for field in indicator_fields:
                    if field in row and pd.notna(row[field]):
                        candlestick_data[field] = float(row[field])
                
                candlestick = CandlestickBar(**candlestick_data)
                candlesticks.append(candlestick)
        else:
            # No indicators requested
            candlesticks = []
            for bar_data in bars_data:
                candlestick = CandlestickBar(**bar_data)
                candlesticks.append(candlestick)
        
        # Sort bars by timestamp in descending order (newest first)
        candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
        
        logger.info(f"Processed {len(candlesticks)} bars with date range and indicators for {symbol} {timeframe}")
        if candlesticks:
            logger.info(f"Date range: {datetime.fromtimestamp(candlesticks[-1].timestamp)} to {datetime.fromtimestamp(candlesticks[0].timestamp)}")
        
        return HistoricalDataResponse(
            symbol=symbol,
            timeframe=timeframe,
            period="CUSTOM",
            bars=candlesticks,
            count=len(candlesticks),
            last_updated=datetime.now().isoformat()
        )
        
    except Exception as e:
        logger.error(f"Error processing bars with date range and indicators: {e}")
        # Fallback to standard date range processing
        return process_bars_with_date_range(bars, symbol, timeframe, start_date_str, end_date_str)

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

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    indicators: str = None
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
        contract = create_contract(symbol.upper())
        
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
        
        # Request historical data
        ib.reqHistoricalData(
            2,  # reqId
            qualified_contract,
            end_date_str,  # endDateTime (empty string for "now", or specific date)
            ib_duration,  # duration
            ib_timeframe,
            'TRADES',
            1,  # useRTH
            1,  # formatDate
            False,  # keepUpToDate
            []  # chartOptions
        )
        
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
            order_list.append(Order(
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

@app.get("/account/orders", response_model=List[Order])
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

if __name__ == "__main__":
    logger.info("Starting TWS API Service...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    ) 