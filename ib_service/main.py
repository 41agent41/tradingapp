"""
Simplified IB Service - Synchronous architecture for reliable IB Gateway connections
"""

import os
import time
import logging
import asyncio
from typing import Dict, List, Optional, Any
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from ib_insync import IB, Stock, Contract, util
import uvicorn

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

# Global IB connection
ib_client = None
connection_status = {
    'connected': False,
    'last_connected': None,
    'last_error': None,
    'connection_count': 0
}

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

# Account-related models
class AccountSummary(BaseModel):
    account_id: str
    net_liquidation: Optional[float] = None
    total_cash_value: Optional[float] = None
    buying_power: Optional[float] = None
    maintenance_margin: Optional[float] = None
    currency: str = "USD"
    last_updated: str

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

def get_ib_connection():
    """Get or create IB connection"""
    global ib_client, connection_status
    
    try:
        # Check if we have a valid connection
        if ib_client and ib_client.isConnected():
            return ib_client
        
        # Create new connection
        logger.info(f"Connecting to IB Gateway at {IB_HOST}:{IB_PORT} (Client ID: {IB_CLIENT_ID})")
        ib_client = IB()
        
        # Connect synchronously with better error handling
        try:
            ib_client.connect(
                host=IB_HOST,
                port=IB_PORT,
                clientId=IB_CLIENT_ID,
                timeout=IB_TIMEOUT
            )
        except TimeoutError:
            raise Exception(f"Connection timeout - IB Gateway at {IB_HOST}:{IB_PORT} is not responding. Check if IB Gateway is running and API is enabled.")
        except ConnectionRefusedError:
            raise Exception(f"Connection refused - IB Gateway at {IB_HOST}:{IB_PORT} is not accepting connections. Check if port {IB_PORT} is correct and API is enabled.")
        except OSError as e:
            if "No route to host" in str(e):
                raise Exception(f"Network unreachable - Cannot reach {IB_HOST}. Check IP address and network connectivity.")
            else:
                raise Exception(f"Network error: {str(e)}")
        
        if ib_client.isConnected():
            connection_status.update({
                'connected': True,
                'last_connected': datetime.now().isoformat(),
                'last_error': None,
                'connection_count': connection_status['connection_count'] + 1
            })
            logger.info(f"Successfully connected to IB Gateway at {IB_HOST}:{IB_PORT}")
            return ib_client
        else:
            raise Exception("Connection established but client reports not connected")
            
    except Exception as e:
        error_msg = str(e)
        logger.error(f"IB Gateway connection failed: {error_msg}")
        
        # Provide helpful error message based on error type
        if "timeout" in error_msg.lower():
            helpful_msg = f"IB Gateway connection timeout. Please check: 1) IB Gateway is running on {IB_HOST}, 2) API is enabled in IB Gateway settings, 3) Port {IB_PORT} is correct"
        elif "refused" in error_msg.lower():
            helpful_msg = f"IB Gateway refused connection. Please check: 1) IB Gateway API settings are enabled, 2) Port {IB_PORT} is correct, 3) Trusted IPs include this server"
        elif "unreachable" in error_msg.lower():
            helpful_msg = f"Cannot reach {IB_HOST}. Please check: 1) IP address is correct, 2) Network connectivity, 3) Firewall settings"
        else:
            helpful_msg = error_msg
        
        connection_status.update({
            'connected': False,
            'last_error': helpful_msg
        })
        
        if ib_client:
            try:
                ib_client.disconnect()
            except:
                pass
        ib_client = None
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=helpful_msg
        )

def disconnect_ib():
    """Disconnect from IB Gateway"""
    global ib_client, connection_status
    
    if ib_client:
        try:
            ib_client.disconnect()
            logger.info("Disconnected from IB Gateway")
        except Exception as e:
            logger.error(f"Error disconnecting: {e}")
        finally:
            ib_client = None
            connection_status['connected'] = False

def create_contract(symbol: str, sec_type: str = 'STK', exchange: str = 'SMART', currency: str = 'USD'):
    """Create IB contract"""
    if sec_type == 'STK':
        return Stock(symbol, exchange, currency)
    else:
        contract = Contract()
        contract.symbol = symbol
        contract.secType = sec_type
        contract.exchange = exchange
        contract.currency = currency
        return contract

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

def process_bars(bars, symbol: str, timeframe: str, period: str) -> HistoricalDataResponse:
    """Process IB bars into candlestick data"""
    candlesticks = []
    
    for bar in bars:
        try:
            candlestick = CandlestickBar(
                timestamp=bar.date.timestamp(),
                open=float(bar.open),
                high=float(bar.high),
                low=float(bar.low),
                close=float(bar.close),
                volume=int(bar.volume)
            )
            candlesticks.append(candlestick)
        except Exception as e:
            logger.warning(f"Error processing bar: {e}")
            continue
    
    return HistoricalDataResponse(
        symbol=symbol,
        timeframe=timeframe,
        period=period,
        bars=candlesticks,
        count=len(candlesticks),
        last_updated=datetime.now().isoformat()
    )

# Startup and shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("Starting IB Service...")
    logger.info(f"Configuration: {IB_HOST}:{IB_PORT}, Client ID: {IB_CLIENT_ID}")
    
    # Test connection on startup
    try:
        get_ib_connection()
        logger.info("Initial connection test successful")
    except Exception as e:
        logger.warning(f"Initial connection test failed: {e}")
    
    yield
    
    # Cleanup on shutdown
    logger.info("Shutting down IB Service...")
    disconnect_ib()

# FastAPI app
app = FastAPI(
    title="TradingApp IB Service",
    description="Simplified Interactive Brokers service for TradingApp",
    version="3.0.0",
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

# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "IB Service",
        "version": "3.0.0",
        "timestamp": datetime.now().isoformat(),
        "connection": {
            "ib_gateway": {
                "connected": connection_status.get('connected', False),
                "last_connected": connection_status.get('last_connected'),
                "last_error": connection_status.get('last_error'),
                "connection_count": connection_status.get('connection_count', 0)
            }
        }
    }

# Root endpoint
@app.get("/")
async def root():
    """Service information"""
    return {
        "service": "TradingApp IB Service",
        "version": "3.0.0",
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

# Historical data endpoint
@app.get("/market-data/history", response_model=HistoricalDataResponse)
async def get_historical_data(symbol: str, timeframe: str, period: str = "1Y"):
    """Get historical market data"""
    try:
        # Validate request
        request = MarketDataRequest(symbol=symbol, timeframe=timeframe, period=period)
        
        # Get connection
        ib = get_ib_connection()
        
        # Create and qualify contract
        contract = create_contract(request.symbol.upper())
        qualified_contracts = ib.qualifyContracts(contract)
        
        if not qualified_contracts:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Symbol {request.symbol} not found"
            )
        
        qualified_contract = qualified_contracts[0]
        
        # Get historical data
        ib_timeframe = convert_timeframe(request.timeframe)
        
        logger.info(f"Requesting historical data for {request.symbol}")
        
        # Run the historical data request in executor
        bars = await run_ib_operation(
            lambda: ib.reqHistoricalData(
                qualified_contract,
                endDateTime='',
                durationStr=request.period,
                barSizeSetting=ib_timeframe,
                whatToShow='TRADES',
                useRTH=True,
                formatDate=1
            )
        )
        
        if not bars:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No historical data available for {request.symbol}"
            )
        
        # Process and return data
        return process_bars(bars, request.symbol, request.timeframe, request.period)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting historical data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get historical data: {str(e)}"
        )

# Helper function to run IB operations in executor with proper event loop
async def run_ib_operation(operation):
    """Run IB operation in a separate thread with its own event loop"""
    
    def run_with_event_loop():
        """Create a new event loop for the thread and run the operation"""
        # Create a new event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # Run the operation in the new event loop
            return operation()
        finally:
            # Clean up the event loop
            loop.close()
    
    # Run the operation in a thread with its own event loop
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_with_event_loop)

def get_realtime_data_sync(symbol: str):
    """Optimized function to get real-time data using shared connection"""
    try:
        logger.info(f"Starting real-time data request for symbol: {symbol}")
        
        # Use the shared connection instead of creating a new one
        ib = get_ib_connection()
        logger.info(f"Using shared IB connection, connected: {ib.isConnected()}")
        
        # Create and qualify contract
        contract = create_contract(symbol.upper())
        logger.info(f"Created contract for {symbol}: {contract}")
        
        qualified_contracts = ib.qualifyContracts(contract)
        logger.info(f"Qualified contracts count: {len(qualified_contracts)}")
        
        if not qualified_contracts:
            logger.error(f"No qualified contracts found for symbol: {symbol}")
            raise Exception(f"Symbol {symbol} not found or cannot be qualified")
        
        qualified_contract = qualified_contracts[0]
        logger.info(f"Using qualified contract: {qualified_contract}")
        
        # Request delayed market data (since subscription is required for live data)
        logger.info(f"Requesting delayed market data for {qualified_contract.symbol}")
        ib.reqMarketDataType(3)  # Request delayed-frozen market data
        logger.info("Note: Using delayed market data. Real-time data requires additional IB subscription.")
        
        # Get ticker data - use snapshot for efficiency
        ticker = ib.reqMktData(qualified_contract, '', True, False)  # Snapshot request
        logger.info(f"Market data requested, ticker: {ticker}")
        
        # Reduced wait time for better performance
        logger.info("Waiting 2 seconds for market data to populate...")
        ib.sleep(2)
        
        logger.info(f"Ticker data after wait - bid: {ticker.bid}, ask: {ticker.ask}, last: {ticker.last}, volume: {ticker.volume}")
        
        # If no last price, try to get it from bid/ask
        last_price = None
        if ticker.last and not util.isNan(ticker.last):
            last_price = float(ticker.last)
        elif ticker.bid and ticker.ask and not util.isNan(ticker.bid) and not util.isNan(ticker.ask):
            # Use midpoint if no last price available
            last_price = (float(ticker.bid) + float(ticker.ask)) / 2
            logger.info(f"Using midpoint price: {last_price}")
        
        # Process quote with better data handling
        quote = RealTimeQuote(
            symbol=symbol.upper(),
            bid=float(ticker.bid) if ticker.bid and not util.isNan(ticker.bid) else None,
            ask=float(ticker.ask) if ticker.ask and not util.isNan(ticker.ask) else None,
            last=last_price,
            volume=int(ticker.volume) if ticker.volume and not util.isNan(ticker.volume) else None,
            timestamp=datetime.now().isoformat()
        )
        
        logger.info(f"Processed quote: {quote}")
        
        # Cancel market data subscription to clean up
        ib.cancelMktData(qualified_contract)
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
async def get_realtime_data(symbol: str):
    """Get real-time market data (may be delayed if subscription not available)"""
    try:
        logger.info(f"Real-time data endpoint called for symbol: {symbol}")
        
        # Run the synchronous operation in a separate thread
        quote = await run_ib_operation(lambda: get_realtime_data_sync(symbol))
        
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
async def search_contracts(
    symbol: str,
    secType: str = "STK",
    exchange: str = "SMART",
    currency: str = "USD"
):
    """Search for contracts"""
    try:
        # Get connection
        ib = get_ib_connection()
        
        # Create contract
        contract = create_contract(symbol.upper(), secType, exchange, currency)
        
        # Qualify contracts
        qualified_contracts = ib.qualifyContracts(contract)
        
        if not qualified_contracts:
            return {"results": [], "count": 0}
        
        # Format results
        results = []
        for contract in qualified_contracts:
            results.append({
                "symbol": contract.symbol,
                "secType": contract.secType,
                "exchange": contract.exchange,
                "currency": contract.currency,
                "primaryExchange": getattr(contract, 'primaryExchange', ''),
                "conId": contract.conId,
                "localSymbol": getattr(contract, 'localSymbol', ''),
                "tradingClass": getattr(contract, 'tradingClass', '')
            })
        
        return {
            "results": results,
            "count": len(results),
            "search_params": {
                "symbol": symbol,
                "secType": secType,
                "exchange": exchange,
                "currency": currency
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching contracts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to search contracts: {str(e)}"
        )

# Account service functions
def get_account_summary_sync():
    """Get account summary information"""
    try:
        ib = get_ib_connection()
        
        # Request account summary
        account_tags = [
            'NetLiquidation', 'TotalCashValue', 'BuyingPower', 
            'MaintMarginReq', 'AccountCode', 'Currency'
        ]
        
        summaries = ib.reqAccountSummary('All', ','.join(account_tags))
        ib.sleep(2)  # Wait for data
        
        # Process account summary
        account_data = {}
        account_id = "Unknown"
        currency = "USD"
        
        for summary in summaries:
            tag = summary.tag
            value = summary.value
            
            if tag == 'AccountCode':
                account_id = value
            elif tag == 'Currency':
                currency = value
            elif tag == 'NetLiquidation':
                account_data['net_liquidation'] = float(value) if value else None
            elif tag == 'TotalCashValue':
                account_data['total_cash_value'] = float(value) if value else None
            elif tag == 'BuyingPower':
                account_data['buying_power'] = float(value) if value else None
            elif tag == 'MaintMarginReq':
                account_data['maintenance_margin'] = float(value) if value else None
        
        return AccountSummary(
            account_id=account_id,
            currency=currency,
            last_updated=datetime.now().isoformat(),
            **account_data
        )
        
    except Exception as e:
        logger.error(f"Error getting account summary: {e}")
        raise Exception(f"Failed to get account summary: {str(e)}")

def get_positions_sync():
    """Get current positions"""
    try:
        ib = get_ib_connection()
        
        # Request positions
        positions = ib.reqPositions()
        ib.sleep(2)  # Wait for data
        
        position_list = []
        for pos in positions:
            if pos.position != 0:  # Only include non-zero positions
                position_list.append(Position(
                    symbol=pos.contract.symbol,
                    position=pos.position,
                    market_price=pos.marketPrice if pos.marketPrice and not util.isNan(pos.marketPrice) else None,
                    market_value=pos.marketValue if pos.marketValue and not util.isNan(pos.marketValue) else None,
                    average_cost=pos.avgCost if pos.avgCost and not util.isNan(pos.avgCost) else None,
                    unrealized_pnl=pos.unrealizedPNL if pos.unrealizedPNL and not util.isNan(pos.unrealizedPNL) else None,
                    currency=pos.contract.currency
                ))
        
        ib.cancelPositions()  # Clean up subscription
        return position_list
        
    except Exception as e:
        logger.error(f"Error getting positions: {e}")
        raise Exception(f"Failed to get positions: {str(e)}")

def get_orders_sync():
    """Get current orders"""
    try:
        ib = get_ib_connection()
        
        # Request all orders
        orders = ib.reqAllOpenOrders()
        ib.sleep(2)  # Wait for data
        
        order_list = []
        for order in orders:
            order_list.append(Order(
                order_id=order.orderId,
                symbol=order.contract.symbol,
                action=order.order.action,
                quantity=order.order.totalQuantity,
                order_type=order.order.orderType,
                status=order.orderStatus.status,
                filled_quantity=order.orderStatus.filled if order.orderStatus.filled else None,
                remaining_quantity=order.orderStatus.remaining if order.orderStatus.remaining else None,
                avg_fill_price=order.orderStatus.avgFillPrice if order.orderStatus.avgFillPrice and order.orderStatus.avgFillPrice > 0 else None
            ))
        
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
        summary = await run_ib_operation(get_account_summary_sync)
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
        positions = await run_ib_operation(get_positions_sync)
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
        orders = await run_ib_operation(get_orders_sync)
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
    """Get all account data (summary, positions, orders) in one call"""
    try:
        logger.info("All account data endpoint called")
        
        # Run all account operations concurrently
        summary_task = run_ib_operation(get_account_summary_sync)
        positions_task = run_ib_operation(get_positions_sync)
        orders_task = run_ib_operation(get_orders_sync)
        
        # Wait for all tasks to complete
        summary, positions, orders = await asyncio.gather(summary_task, positions_task, orders_task)
        
        account_data = AccountData(
            account=summary,
            positions=positions,
            orders=orders,
            last_updated=datetime.now().isoformat()
        )
        
        logger.info(f"Successfully retrieved all account data for account: {summary.account_id}")
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
    logger.info("Starting IB Service...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    ) 