from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
from typing import Dict, Any, Optional
from ib_async import IB, Contract, Stock, Order, MarketOrder
from ib_async.client import ConnectionError
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TradingApp IB Service", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://10.7.3.20:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global IB client
ib_client: Optional[IB] = None
connection_status = {
    "connected": False,
    "host": "10.7.3.21",
    "port": 4002,  # IB Gateway default socket port
    "client_id": 1,
    "last_error": None
}

async def connect_to_ib():
    """Connect to Interactive Brokers Gateway"""
    global ib_client, connection_status
    
    try:
        logger.info(f"Connecting to IB Gateway at {connection_status['host']}:{connection_status['port']}")
        
        ib_client = IB()
        await ib_client.connect(
            host=connection_status['host'],
            port=connection_status['port'],
            clientId=connection_status['client_id'],
            timeout=20
        )
        
        connection_status["connected"] = True
        connection_status["last_error"] = None
        logger.info("Successfully connected to Interactive Brokers Gateway")
        
        return True
        
    except ConnectionError as e:
        error_msg = f"Failed to connect to IB Gateway: {str(e)}"
        logger.error(error_msg)
        connection_status["connected"] = False
        connection_status["last_error"] = error_msg
        return False
    except Exception as e:
        error_msg = f"Unexpected error connecting to IB Gateway: {str(e)}"
        logger.error(error_msg)
        connection_status["connected"] = False
        connection_status["last_error"] = error_msg
        return False

async def disconnect_from_ib():
    """Disconnect from Interactive Brokers Gateway"""
    global ib_client, connection_status
    
    try:
        if ib_client and ib_client.isConnected():
            await ib_client.disconnect()
            logger.info("Disconnected from Interactive Brokers Gateway")
        
        connection_status["connected"] = False
        connection_status["last_error"] = None
        return True
        
    except Exception as e:
        error_msg = f"Error disconnecting from IB Gateway: {str(e)}"
        logger.error(error_msg)
        connection_status["last_error"] = error_msg
        return False

async def check_ib_gateway_health():
    """Check if IB Gateway is reachable and responding"""
    try:
        # Try to connect with a short timeout
        test_client = IB()
        await test_client.connect(
            host=connection_status['host'],
            port=connection_status['port'],
            clientId=999,  # Use a different client ID for health check
            timeout=5
        )
        await test_client.disconnect()
        return True
    except Exception as e:
        logger.warning(f"IB Gateway health check failed: {str(e)}")
        return False

@app.on_event("startup")
async def startup_event():
    """Startup event - attempt to connect to IB Gateway"""
    logger.info("Starting IB Service...")
    
    # Try to connect to IB Gateway, but don't fail if it's not available
    try:
        await connect_to_ib()
        if connection_status["connected"]:
            logger.info("Successfully connected to IB Gateway during startup")
        else:
            logger.warning("Could not connect to IB Gateway during startup, but service will continue running")
            logger.info("You can manually connect later using the /connect endpoint")
    except Exception as e:
        logger.error(f"Error during startup connection attempt: {str(e)}")
        logger.info("Service will continue running without IB Gateway connection")
        logger.info("You can manually connect later using the /connect endpoint")

@app.on_event("shutdown")
async def shutdown_event():
    """Shutdown event - disconnect from IB Gateway"""
    logger.info("Shutting down IB Service...")
    await disconnect_from_ib()

@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": "TradingApp IB Service",
        "version": "1.0.0",
        "status": "running",
        "connection": connection_status,
        "gateway_info": {
            "host": connection_status["host"],
            "port": connection_status["port"],
            "type": "IB Gateway (Socket)",
            "client_id": connection_status["client_id"]
        },
        "endpoints": {
            "health": "/health",
            "connection": "/connection",
            "connect": "/connect",
            "disconnect": "/disconnect",
            "gateway_health": "/gateway-health",
            "account": "/account",
            "positions": "/positions",
            "orders": "/orders"
        }
    }

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "ib_connected": connection_status["connected"],
        "service": "ib_service",
        "gateway_host": connection_status["host"],
        "gateway_port": connection_status["port"]
    }

@app.get("/gateway-health")
async def gateway_health():
    """Check IB Gateway connectivity"""
    gateway_reachable = await check_ib_gateway_health()
    return {
        "gateway_reachable": gateway_reachable,
        "gateway_host": connection_status["host"],
        "gateway_port": connection_status["port"],
        "service_connected": connection_status["connected"],
        "last_error": connection_status["last_error"]
    }

@app.get("/connection")
async def get_connection_status():
    """Get current connection status"""
    return connection_status

@app.post("/connect")
async def connect():
    """Manually connect to IB Gateway"""
    success = await connect_to_ib()
    if success:
        return {"message": "Successfully connected to Interactive Brokers Gateway", "status": connection_status}
    else:
        raise HTTPException(status_code=500, detail=connection_status["last_error"])

@app.post("/disconnect")
async def disconnect():
    """Manually disconnect from IB Gateway"""
    success = await disconnect_from_ib()
    if success:
        return {"message": "Successfully disconnected from Interactive Brokers Gateway", "status": connection_status}
    else:
        raise HTTPException(status_code=500, detail=connection_status["last_error"])

@app.get("/account")
async def get_account_info():
    """Get account information"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        # Request account information
        account_values = await ib_client.reqAccountUpdates(True)
        
        # Wait a bit for data to arrive
        await asyncio.sleep(1)
        
        # Get account summary
        accounts = ib_client.managedAccounts()
        
        return {
            "accounts": accounts,
            "account_values": [str(av) for av in account_values] if account_values else []
        }
        
    except Exception as e:
        logger.error(f"Error getting account info: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting account info: {str(e)}")

@app.get("/positions")
async def get_positions():
    """Get current positions"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        positions = ib_client.positions()
        
        position_list = []
        for position in positions:
            position_list.append({
                "contract": str(position.contract),
                "account": position.account,
                "position": position.position,
                "avgCost": position.avgCost
            })
        
        return {"positions": position_list}
        
    except Exception as e:
        logger.error(f"Error getting positions: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting positions: {str(e)}")

@app.get("/orders")
async def get_orders():
    """Get current orders"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        trades = ib_client.trades()
        
        order_list = []
        for trade in trades:
            order_list.append({
                "order": str(trade.order),
                "contract": str(trade.contract),
                "orderState": str(trade.orderState),
                "status": trade.orderState.status
            })
        
        return {"orders": order_list}
        
    except Exception as e:
        logger.error(f"Error getting orders: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting orders: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000) 