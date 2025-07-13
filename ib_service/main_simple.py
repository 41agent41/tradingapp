"""
Simple IB Service - Fixed asyncio handling with basic functionality
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
import concurrent.futures

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TradingApp IB Service - Simple", version="1.5.1")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://10.7.3.20:3000"],
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
    """Async wrapper for IB Gateway connection with proper event loop handling"""
    try:
        # Get the current event loop, or create a new one if none exists
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No event loop in current thread, create one
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        # Use ThreadPoolExecutor to run the sync function
        with concurrent.futures.ThreadPoolExecutor() as executor:
            return await loop.run_in_executor(executor, connect_to_ib_sync)
    except Exception as e:
        logger.error(f"Error in async connection wrapper: {str(e)}")
        return False

@app.on_event("startup")
async def startup_event():
    """Startup event - attempt to connect to IB Gateway"""
    logger.info("Starting IB Service (Simple Version)...")
    
    try:
        await connect_to_ib()
        if connection_status["connected"]:
            logger.info("Successfully connected to IB Gateway during startup")
        else:
            logger.warning("Could not connect to IB Gateway during startup")
    except Exception as e:
        logger.error(f"Error during startup connection attempt: {str(e)}")

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
        "version": "1.5.1-simple",
        "status": "running",
        "description": "Simple version with fixed asyncio handling",
        "connection_status": connection_status["connected"],
        "endpoints": {
            "health": "/health",
            "connection": "/connection",
            "market_data": "/market-data/*",
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
        "message": "Simple version with fixed asyncio handling"
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
        success = await connect_to_ib()
        if success:
            return {"message": "Successfully connected to IB Gateway", "connected": True}
        else:
            return {"message": "Failed to connect to IB Gateway", "connected": False, "error": connection_status["last_error"]}
    except Exception as e:
        return {"message": "Error during connection", "connected": False, "error": str(e)}

def safe_float(value, default=0.0):
    """Safely convert value to float"""
    try:
        if value is None:
            return default
        return float(value)
    except (ValueError, TypeError):
        return default

def safe_int(value, default=0):
    """Safely convert value to int"""
    try:
        if value is None:
            return default
        return int(value)
    except (ValueError, TypeError):
        return default

@app.get("/market-data/history")
async def get_historical_data(symbol: str, timeframe: str, period: str = "90D"):
    """Get historical market data"""
    if not connection_status["connected"]:
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        # Create contract
        contract = Stock(symbol.upper(), 'SMART', 'USD')
        
        # Convert timeframe to IB format
        timeframe_map = {
            '5min': '5 mins',
            '15min': '15 mins', 
            '30min': '30 mins',
            '1hour': '1 hour',
            '4hour': '4 hours',
            '8hour': '8 hours',
            '1day': '1 day'
        }
        
        ib_timeframe = timeframe_map.get(timeframe, '1 day')
        
        def get_historical_data_sync():
            """Synchronous function to get historical data"""
            bars = ib_client.reqHistoricalData(
                contract,
                '',
                period,
                ib_timeframe,
                'TRADES',
                1,  # useRTH
                1,  # formatDate
                False,  # keepUpToDate
                []
            )
            return bars
        
        # Use ThreadPoolExecutor to avoid asyncio issues
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            bars = await loop.run_in_executor(executor, get_historical_data_sync)
        
        # Convert to response format
        data = []
        for bar in bars:
            data.append({
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
            "bars": data,
            "count": len(data),
            "source": "Interactive Brokers"
        }
        
    except Exception as e:
        logger.error(f"Error getting historical data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error retrieving data: {str(e)}")

@app.get("/market-data/realtime")
async def get_realtime_data(symbol: str):
    """Get real-time market data"""
    if not connection_status["connected"]:
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        contract = Stock(symbol.upper(), 'SMART', 'USD')
        
        def get_realtime_data_sync():
            """Synchronous function to get real-time data"""
            ticker = ib_client.reqMktData(contract, '', False, False, [])
            ib_client.sleep(1)  # Wait for data
            return ticker
        
        # Use ThreadPoolExecutor to avoid asyncio issues
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            ticker = await loop.run_in_executor(executor, get_realtime_data_sync)
        
        return {
            "symbol": symbol.upper(),
            "bid": safe_float(ticker.bid),
            "ask": safe_float(ticker.ask),
            "last": safe_float(ticker.last),
            "bid_size": safe_int(ticker.bidSize),
            "ask_size": safe_int(ticker.askSize),
            "volume": safe_int(ticker.volume),
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error getting realtime data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error retrieving data: {str(e)}")

@app.post("/market-data/subscribe")
async def subscribe_market_data(request: dict):
    """Subscribe to market data"""
    return {"message": "Subscription endpoint - not implemented in simple version"}

@app.post("/market-data/unsubscribe")
async def unsubscribe_market_data(request: dict):
    """Unsubscribe from market data"""
    return {"message": "Unsubscription endpoint - not implemented in simple version"}

@app.get("/account")
async def get_account_info():
    """Get account information"""
    if not connection_status["connected"]:
        raise HTTPException(status_code=503, detail="Not connected to IB Gateway")
    
    try:
        def get_account_info_sync():
            """Synchronous function to get account info"""
            account = ib_client.accountSummary()
            return account
        
        # Use ThreadPoolExecutor to avoid asyncio issues
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            account_data = await loop.run_in_executor(executor, get_account_info_sync)
        
        # Convert to response format
        account_info = {}
        for item in account_data:
            account_info[item.tag] = item.value
        
        return {
            "account_id": account_info.get("AccountCode", "Unknown"),
            "net_liquidation": safe_float(account_info.get("NetLiquidation", 0)),
            "total_cash": safe_float(account_info.get("TotalCashValue", 0)),
            "buying_power": safe_float(account_info.get("BuyingPower", 0)),
            "equity": safe_float(account_info.get("EquityWithLoanValue", 0)),
            "currency": account_info.get("Currency", "USD"),
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error getting account info: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error retrieving account info: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000) 