"""
Fallback IB Service - Works with existing dependencies while Docker image is rebuilt
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
from typing import Dict, Any, Optional, List
from ib_insync import IB, Contract, Stock, util
from datetime import datetime, timedelta
import pandas as pd
import os
import threading
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TradingApp IB Service - Fallback", version="1.5.0")

# Parse CORS origins from environment variable or use defaults
cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
cors_origins = [origin.strip() for origin in cors_origins]

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global IB client
ib_client: Optional[IB] = None
connection_status = {
    "connected": False,
    "host": os.getenv("IB_HOST", "localhost"),
    "port": int(os.getenv("IB_PORT", "4002")),
    "client_id": int(os.getenv("IB_CLIENT_ID", "1")),
    "last_error": None
}

# Request models
class ContractSearchRequest(BaseModel):
    symbol: str
    secType: str
    name: Optional[bool] = False
    exchange: Optional[str] = None
    currency: Optional[str] = None

def connect_to_ib_sync():
    """Synchronous function to connect to IB Gateway"""
    global ib_client, connection_status
    
    client_ids_to_try = [1, 2, 3, 4, 5]
    
    for attempt, client_id in enumerate(client_ids_to_try, 1):
        try:
            if ib_client and ib_client.isConnected():
                logger.info("Disconnecting existing IB client before reconnecting")
                ib_client.disconnect()
            
            logger.info(f"Attempt {attempt}: Connecting to IB Gateway at {connection_status['host']}:{connection_status['port']} with client ID {client_id}")
            
            ib_client = IB()
            
            ib_client.connect(
                host=connection_status['host'],
                port=connection_status['port'],
                clientId=client_id,
                timeout=10
            )
        
            if ib_client.isConnected():
                connection_status["connected"] = True
                connection_status["client_id"] = client_id
                connection_status["last_error"] = None
                logger.info(f"Successfully connected to Interactive Brokers Gateway with client ID {client_id}")
                return True
            else:
                logger.warning(f"Connection attempt {attempt} with client ID {client_id} failed")
                continue
            
        except ConnectionRefusedError as e:
            error_msg = f"Connection refused by IB Gateway - {str(e)}"
            logger.error(error_msg)
            connection_status["connected"] = False
            connection_status["last_error"] = error_msg
            return False
            
        except Exception as e:
            error_msg = f"Attempt {attempt} failed: {type(e).__name__}: {str(e)}"
            logger.warning(error_msg)
            
            if attempt == len(client_ids_to_try):
                logger.error(f"All connection attempts failed")
                connection_status["connected"] = False
                connection_status["last_error"] = error_msg
                if ib_client:
                    ib_client = None
                return False
            else:
                continue
    
    return False

async def connect_to_ib():
    """Async wrapper for IB Gateway connection"""
    try:
        # Use ThreadPoolExecutor with proper event loop handling
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, connect_to_ib_sync)
    except RuntimeError as e:
        # If we're not in an event loop, run synchronously
        logger.warning(f"No event loop available, running connection synchronously: {str(e)}")
        return connect_to_ib_sync()
    except Exception as e:
        logger.error(f"Error in async connection wrapper: {str(e)}")
        return False

@app.on_event("startup")
async def startup_event():
    """Startup event - attempt to connect to IB Gateway"""
    logger.info("Starting IB Service (Fallback Version)...")
    
    try:
        # Try async connection first
        success = await connect_to_ib()
        if success and connection_status["connected"]:
            logger.info("Successfully connected to IB Gateway during startup")
        else:
            logger.warning("Could not connect to IB Gateway during startup")
    except Exception as e:
        logger.error(f"Error during startup connection attempt: {str(e)}")
        # Fallback to synchronous connection
        try:
            logger.info("Attempting synchronous connection as fallback...")
            connect_to_ib_sync()
            if connection_status["connected"]:
                logger.info("Successfully connected to IB Gateway using synchronous fallback")
            else:
                logger.warning("Synchronous connection also failed")
        except Exception as sync_error:
            logger.error(f"Synchronous connection fallback also failed: {str(sync_error)}")

@app.on_event("shutdown")
async def shutdown_event():
    """Shutdown event"""
    global ib_client
    logger.info("Shutting down IB Service...")
    
    try:
        if ib_client and ib_client.isConnected():
            ib_client.disconnect()
            logger.info("Disconnected from IB Gateway")
    except Exception as e:
        logger.error(f"Error during shutdown: {str(e)}")

@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": "TradingApp IB Service",
        "version": "1.5.0-fallback",
        "status": "running",
        "description": "Fallback version running with basic dependencies",
        "note": "Rebuild Docker image to use enhanced version with full features",
        "connection_status": connection_status["connected"],
        "endpoints": {
            "health": "/health",
            "connection": "/connection",
            "market_data": "/market-data/*",
            "contract": "/contract/*",
            "account": "/account"
        }
    }

@app.get("/health")
async def health():
    """Health check endpoint"""
    health_status = "healthy" if connection_status["connected"] else "unhealthy"
    
    return {
        "status": health_status,
        "timestamp": datetime.utcnow().isoformat(),
        "connection": {
            "ib_gateway": {
                "connected": connection_status["connected"],
                "host": connection_status["host"],
                "port": connection_status["port"],
                "client_id": connection_status.get("client_id", 0),
                "last_error": connection_status["last_error"]
            }
        },
        "message": "Fallback version - rebuild Docker image for full features"
    }

@app.get("/connection")
async def get_connection_status():
    """Get connection status"""
    return {
        "connected": connection_status["connected"],
        "host": connection_status["host"], 
        "port": connection_status["port"],
        "client_id": connection_status.get("client_id", 0),
        "last_error": connection_status["last_error"],
        "timestamp": datetime.utcnow().isoformat()
    }

@app.post("/connect")
async def connect():
    """Connect to IB Gateway"""
    try:
        # Try async connection first
        success = await connect_to_ib()
        if success and connection_status["connected"]:
            return {"message": "Successfully connected to IB Gateway", "connected": True}
        else:
            # Fallback to synchronous connection
            logger.info("Async connection failed, trying synchronous fallback...")
            success = connect_to_ib_sync()
            if success and connection_status["connected"]:
                return {"message": "Successfully connected to IB Gateway (synchronous)", "connected": True}
            else:
                raise HTTPException(status_code=503, detail="Failed to connect to IB Gateway")
    except Exception as e:
        logger.error(f"Connection attempt failed: {str(e)}")
        raise HTTPException(status_code=503, detail=f"Connection failed: {str(e)}")

@app.post("/contract/search")
async def search_contracts(request: ContractSearchRequest):
    """Search for contracts using IB API"""
    
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        # Validate inputs
        if not request.symbol or len(request.symbol) > 10:
            raise HTTPException(status_code=400, detail="Invalid symbol")
        
        # Valid security types
        valid_sectypes = ['STK', 'OPT', 'FUT', 'CASH', 'BOND', 'CFD', 'CMDTY', 'CRYPTO', 'WAR', 'FUND', 'IND', 'BAG']
        if request.secType not in valid_sectypes:
            raise HTTPException(status_code=400, detail=f"Invalid secType. Must be one of: {valid_sectypes}")
        
        logger.info(f"Searching for contracts: symbol={request.symbol}, secType={request.secType}, name={request.name}")
        
        # Create a base contract for search
        contract = Contract()
        contract.symbol = request.symbol.upper()
        contract.secType = request.secType
        
        if request.currency:
            contract.currency = request.currency.upper()
        elif request.secType == 'STK':
            contract.currency = 'USD'  # Default for stocks
        
        if request.exchange:
            contract.exchange = request.exchange.upper()
        elif request.secType == 'STK':
            contract.exchange = 'SMART'  # Default for stocks
        
        # Use reqContractDetails to search for contracts
        try:
            contract_details = ib_client.reqContractDetails(contract)
            
            if not contract_details:
                # If no exact match, try a more flexible search
                logger.info(f"No exact match found, trying flexible search")
                
                # For stocks, try different exchanges
                if request.secType == 'STK':
                    contract.exchange = ''  # Clear exchange for broader search
                    contract_details = ib_client.reqContractDetails(contract)
            
            # Transform results to match expected format
            results = []
            for detail in contract_details:
                contract_obj = detail.contract
                
                # Create result entry
                result_entry = {
                    "conid": str(contract_obj.conId),
                    "symbol": contract_obj.symbol,
                    "companyName": detail.longName or contract_obj.symbol,
                    "description": f"{contract_obj.primaryExchange or contract_obj.exchange}",
                    "secType": contract_obj.secType,
                    "currency": contract_obj.currency,
                    "exchange": contract_obj.exchange,
                    "primaryExchange": contract_obj.primaryExchange,
                    "sections": [
                        {
                            "secType": contract_obj.secType,
                            "exchange": contract_obj.exchange,
                            "currency": contract_obj.currency
                        }
                    ]
                }
                results.append(result_entry)
            
            logger.info(f"Found {len(results)} contracts for {request.symbol}")
            
            return {
                "results": results,
                "count": len(results),
                "symbol": request.symbol.upper(),
                "secType": request.secType,
                "searchByName": request.name,
                "timestamp": datetime.utcnow().isoformat()
            }
            
        except Exception as search_error:
            logger.error(f"Contract search error: {str(search_error)}")
            raise HTTPException(
                status_code=404, 
                detail=f"No contracts found for {request.symbol} ({request.secType}): {str(search_error)}"
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in contract search: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

def safe_float(value, default=0.0):
    """Safely convert value to float"""
    try:
        if value is None or value == '' or str(value).lower() in ['nan', 'none']:
            return default
        return float(value)
    except (ValueError, TypeError):
        return default

def safe_int(value, default=0):
    """Safely convert value to integer"""
    try:
        if value is None or value == '':
            return default
        return int(float(value))
    except (ValueError, TypeError):
        return default

@app.get("/market-data/history")
async def get_historical_data(symbol: str, timeframe: str, period: str = "90D"):
    """Get historical market data"""
    
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        # Validate inputs
        if not symbol or len(symbol) > 10:
            raise HTTPException(status_code=400, detail="Invalid symbol")
            
        valid_timeframes = ['5min', '15min', '30min', '1hour', '4hour', '8hour', '1day']
        if timeframe not in valid_timeframes:
            raise HTTPException(status_code=400, detail=f"Invalid timeframe. Must be one of: {valid_timeframes}")
        
        # Create contract
        contract = Stock(symbol.upper(), 'SMART', 'USD')
        
        # Qualify contract
        qualified_contracts = ib_client.qualifyContracts(contract)
        if not qualified_contracts:
            raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")
        
        qualified_contract = qualified_contracts[0]
        
        # Convert timeframe to IB format
        ib_timeframe_map = {
            '5min': '5 mins',
            '15min': '15 mins', 
            '30min': '30 mins',
            '1hour': '1 hour',
            '4hour': '4 hours',
            '8hour': '8 hours',
            '1day': '1 day'
        }
        
        ib_timeframe = ib_timeframe_map.get(timeframe, '1 hour')
        
        # Request historical data
        bars = ib_client.reqHistoricalData(
            qualified_contract,
            endDateTime='',
            durationStr=period,
            barSizeSetting=ib_timeframe,
            whatToShow='TRADES',
            useRTH=True,
            formatDate=1
        )
        
        if not bars:
            raise HTTPException(status_code=404, detail=f"No data available for {symbol}")
        
        # Convert to standard format
        formatted_bars = []
        for bar in bars:
            formatted_bars.append({
                "time": int(bar.date.timestamp()),
                "open": safe_float(bar.open),
                "high": safe_float(bar.high),
                "low": safe_float(bar.low),
                "close": safe_float(bar.close),
                "volume": safe_int(bar.volume)
            })
        
        return {
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "period": period,
            "bars": formatted_bars,
            "count": len(formatted_bars)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch historical data for {symbol}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch historical data: {str(e)}")

@app.get("/market-data/realtime")
async def get_realtime_data(symbol: str):
    """Get real-time market data"""
    
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        contract = Stock(symbol.upper(), 'SMART', 'USD')
        
        qualified_contracts = ib_client.qualifyContracts(contract)
        if not qualified_contracts:
            raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")
        
        qualified_contract = qualified_contracts[0]
        
        # Get ticker data
        ticker = ib_client.reqMktData(qualified_contract, '', False, False)
        
        # Wait for data
        await asyncio.sleep(2)
        
        return {
            "symbol": symbol.upper(),
            "bid": safe_float(ticker.bid),
            "ask": safe_float(ticker.ask),
            "last": safe_float(ticker.last),
            "volume": safe_int(ticker.volume),
            "timestamp": datetime.utcnow().isoformat(),
            "version": "fallback"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch real-time data for {symbol}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch real-time data: {str(e)}")

@app.post("/market-data/subscribe")
async def subscribe_market_data(request: dict):
    """Subscribe to real-time market data"""
    symbol = request.get("symbol")
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")
    
    # TODO: Implement subscription logic
    return {"message": f"Subscribed to {symbol}", "status": "pending"}

@app.post("/market-data/unsubscribe")
async def unsubscribe_market_data(request: dict):
    """Unsubscribe from real-time market data"""
    symbol = request.get("symbol")
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")
    
    # TODO: Implement unsubscription logic
    return {"message": f"Unsubscribed from {symbol}", "status": "completed"}

@app.get("/account")
async def get_account_info():
    """Get account information"""
    
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        # Get account summary
        account_values = ib_client.accountSummary()
        
        account_info = {}
        for item in account_values:
            account_info[item.tag] = item.value
        
        return {
            "account_info": account_info,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Failed to fetch account info: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch account info: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "main_fallback:app",
        host="0.0.0.0",
        port=8000,
        log_level="info"
    ) 