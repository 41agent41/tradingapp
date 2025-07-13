"""
Simplified IB Service - Synchronous architecture for reliable IB Gateway connections
"""

import os
import time
import logging
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
IB_HOST = os.getenv('IB_HOST', 'localhost')
IB_PORT = int(os.getenv('IB_PORT', '4002'))
IB_CLIENT_ID = int(os.getenv('IB_CLIENT_ID', '1'))
IB_TIMEOUT = int(os.getenv('IB_TIMEOUT', '30'))
CORS_ORIGINS = os.getenv('IB_CORS_ORIGINS', 'http://localhost:3000').split(',')

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
    timeframe: str = Field(..., regex=r'^(5min|15min|30min|1hour|4hour|8hour|1day)$')
    period: str = Field(default="1Y", regex=r'^(1D|1W|1M|3M|6M|1Y)$')

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
        logger.info(f"Connecting to IB Gateway at {IB_HOST}:{IB_PORT}")
        ib_client = IB()
        
        # Connect synchronously
        ib_client.connect(
            host=IB_HOST,
            port=IB_PORT,
            clientId=IB_CLIENT_ID,
            timeout=IB_TIMEOUT
        )
        
        if ib_client.isConnected():
            connection_status.update({
                'connected': True,
                'last_connected': datetime.now().isoformat(),
                'last_error': None,
                'connection_count': connection_status['connection_count'] + 1
            })
            logger.info("Successfully connected to IB Gateway")
            return ib_client
        else:
            raise Exception("Connection failed - client not connected")
            
    except Exception as e:
        error_msg = f"Connection failed: {str(e)}"
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
        "timestamp": datetime.now().isoformat()
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
        bars = ib.reqHistoricalData(
            qualified_contract,
            endDateTime='',
            durationStr=request.period,
            barSizeSetting=ib_timeframe,
            whatToShow='TRADES',
            useRTH=True,
            formatDate=1
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

# Real-time data endpoint
@app.get("/market-data/realtime", response_model=RealTimeQuote)
async def get_realtime_data(symbol: str):
    """Get real-time market data"""
    try:
        # Get connection
        ib = get_ib_connection()
        
        # Create and qualify contract
        contract = create_contract(symbol.upper())
        qualified_contracts = ib.qualifyContracts(contract)
        
        if not qualified_contracts:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Symbol {symbol} not found"
            )
        
        qualified_contract = qualified_contracts[0]
        
        # Get ticker data
        ticker = ib.reqMktData(qualified_contract, '', False, False)
        
        # Wait for data
        ib.sleep(2)
        
        # Process quote
        quote = RealTimeQuote(
            symbol=symbol.upper(),
            bid=float(ticker.bid) if ticker.bid and not util.isNan(ticker.bid) else None,
            ask=float(ticker.ask) if ticker.ask and not util.isNan(ticker.ask) else None,
            last=float(ticker.last) if ticker.last and not util.isNan(ticker.last) else None,
            volume=int(ticker.volume) if ticker.volume and not util.isNan(ticker.volume) else None,
            timestamp=datetime.now().isoformat()
        )
        
        # Cancel market data subscription
        ib.cancelMktData(qualified_contract)
        
        return quote
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting real-time data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get real-time data: {str(e)}"
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

if __name__ == "__main__":
    logger.info("Starting IB Service...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    ) 