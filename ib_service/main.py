from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
from typing import Dict, Any, Optional, List
from ib_async import IB, Contract, Stock, Order, MarketOrder, util
from datetime import datetime, timedelta
import pandas as pd
import os
import threading

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

def connect_to_ib_sync():
    """Synchronous function to connect to IB Gateway in separate thread"""
    global ib_client, connection_status
    
    # List of client IDs to try (in case of conflicts)
    client_ids_to_try = [1, 2, 3, 4, 5]
    
    for attempt, client_id in enumerate(client_ids_to_try, 1):
        try:
            # Disconnect existing client if any
            if ib_client and ib_client.isConnected():
                logger.info("Disconnecting existing IB client before reconnecting")
                ib_client.disconnect()
            
            logger.info(f"Attempt {attempt}: Connecting to IB Gateway at {connection_status['host']}:{connection_status['port']} with client ID {client_id}")
            
            # Create IB client - let it handle its own event loop
            ib_client = IB()
            
            # Add more detailed logging
            logger.info("IB client created, attempting connection...")
            
            ib_client.connect(
                host=connection_status['host'],
                port=connection_status['port'],
                clientId=client_id,
                timeout=10  # Reduced timeout for faster retries
            )
            
            # Verify connection was successful
            if ib_client.isConnected():
                connection_status["connected"] = True
                connection_status["client_id"] = client_id  # Update successful client ID
                connection_status["last_error"] = None
                logger.info(f"Successfully connected to Interactive Brokers Gateway with client ID {client_id}")
                return True
            else:
                logger.warning(f"Connection attempt {attempt} with client ID {client_id} failed - client reports not connected")
                continue
            
        except ConnectionRefusedError as e:
            error_msg = f"Connection refused by IB Gateway at {connection_status['host']}:{connection_status['port']} - {str(e)}"
            logger.error(error_msg)
            connection_status["connected"] = False
            connection_status["last_error"] = error_msg
            return False  # Don't retry on connection refused
            
        except TimeoutError as e:
            if attempt == len(client_ids_to_try):
                # Last attempt - log as error
                error_msg = f"API handshake timeout with IB Gateway. This usually means:\n"
                error_msg += "1. API connections are not enabled in IB Gateway settings\n"
                error_msg += "2. IB Gateway requires authentication/login\n"
                error_msg += f"3. All client IDs {client_ids_to_try} are in use\n"
                error_msg += f"Original error: {str(e)}"
                logger.error(error_msg)
                connection_status["connected"] = False
                connection_status["last_error"] = error_msg
                return False
            else:
                # Not last attempt - just warn and try next client ID
                logger.warning(f"Attempt {attempt} with client ID {client_id} timed out, trying next client ID...")
                continue
                
        except Exception as e:
            error_msg = f"Attempt {attempt} failed: {type(e).__name__}: {str(e)}"
            if not str(e):
                error_msg = f"Attempt {attempt} failed: {type(e).__name__} (no error message provided)"
            logger.warning(error_msg)
            
            if attempt == len(client_ids_to_try):
                # Last attempt
                logger.error(f"All connection attempts failed. Exception details: {repr(e)}")
                connection_status["connected"] = False
                connection_status["last_error"] = error_msg
                if ib_client:
                    ib_client = None
                return False
            else:
                continue
    
    # Should not reach here, but just in case
    error_msg = f"All {len(client_ids_to_try)} connection attempts failed"
    logger.error(error_msg)
    connection_status["connected"] = False
    connection_status["last_error"] = error_msg
    return False

async def connect_to_ib():
    """Async wrapper for IB Gateway connection"""
    # Run the synchronous connection in a thread pool to avoid event loop conflicts
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, connect_to_ib_sync)

def disconnect_from_ib_sync():
    """Synchronous function to disconnect from IB Gateway"""
    global ib_client, connection_status
    
    try:
        if ib_client and ib_client.isConnected():
            ib_client.disconnect()
            logger.info("Disconnected from Interactive Brokers Gateway")
        
        connection_status["connected"] = False
        connection_status["last_error"] = None
        return True
        
    except Exception as e:
        error_msg = f"Error disconnecting from IB Gateway: {str(e)}"
        logger.error(error_msg)
        connection_status["last_error"] = error_msg
        return False

async def disconnect_from_ib():
    """Async wrapper for IB Gateway disconnection"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, disconnect_from_ib_sync)

async def check_ib_gateway_health():
    """Check if IB Gateway is reachable and responding"""
    try:
        # First check if we have an existing connection
        if ib_client and ib_client.isConnected():
            logger.info("IB Gateway health check: Using existing connection")
            return True
        
        # For health check, try a simple socket connection test
        import socket
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)  # 5 second timeout
        
        result = sock.connect_ex((connection_status['host'], connection_status['port']))
        sock.close()
        
        if result == 0:
            logger.info("IB Gateway health check: Port is reachable")
            return True
        else:
            logger.warning(f"IB Gateway health check: Port not reachable (result: {result})")
            return False
            
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
            "orders": "/orders",
            "market_data_history": "/market-data/history",
            "market_data_realtime": "/market-data/realtime",
            "market_data_subscribe": "/market-data/subscribe",
            "market_data_unsubscribe": "/market-data/unsubscribe"
        }
    }

# Market Data Endpoints

def qualify_contract_sync(contract):
    """Synchronous function to qualify contract in separate thread"""
    global ib_client
    if not ib_client or not ib_client.isConnected():
        return None
    
    try:
        qualified_contracts = ib_client.qualifyContracts(contract)
        return qualified_contracts[0] if qualified_contracts else None
    except Exception as e:
        logger.error(f"Error qualifying contract: {str(e)}")
        return None

async def qualify_contract_async(contract):
    """Async wrapper for contract qualification"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, qualify_contract_sync, contract)

def get_account_summary_sync():
    """Synchronous function to get account summary in separate thread"""
    global ib_client
    if not ib_client or not ib_client.isConnected():
        return None, None
    
    try:
        # Get managed accounts
        accounts = ib_client.managedAccounts()
        if not accounts:
            return None, "No accounts found"
        
        # Use the first account
        account = accounts[0]
        
        # Get account values (simpler approach that works consistently)
        account_values = ib_client.accountValues()
        
        # Parse account values into a more usable format
        account_data = {}
        for value in account_values:
            if hasattr(value, 'tag') and hasattr(value, 'value'):
                account_data[value.tag] = {
                    "value": value.value,
                    "currency": getattr(value, 'currency', 'USD'),
                    "account": getattr(value, 'account', account)
                }
        
        return (account, account_data), None
        
    except Exception as e:
        logger.error(f"Error in get_account_summary_sync: {str(e)}")
        return None, str(e)

async def get_account_summary_async():
    """Async wrapper for account summary"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, get_account_summary_sync)

@app.get("/market-data/history")
async def get_historical_data(symbol: str, timeframe: str, period: str = "12M"):
    """Get historical market data for a symbol"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        # Validate symbol (for now, only support MSFT)
        if symbol.upper() != 'MSFT':
            raise HTTPException(status_code=400, detail=f"Only MSFT symbol is currently supported, got: {symbol}")
        
        # Create contract for MSFT stock
        contract = Stock('MSFT', 'SMART', 'USD')
        
        # Qualify the contract to populate conId (using thread executor)
        qualified_contract = await qualify_contract_async(contract)
        if not qualified_contract:
            raise HTTPException(status_code=404, detail=f"Could not qualify contract for {symbol}")
        
        # Map timeframe to IB bar sizes
        timeframe_map = {
            '5min': '5 mins',
            '15min': '15 mins', 
            '30min': '30 mins',
            '1hour': '1 hour',
            '4hour': '4 hours',
            '8hour': '8 hours',
            '1day': '1 day'
        }
        
        if timeframe not in timeframe_map:
            raise HTTPException(status_code=400, detail=f"Invalid timeframe: {timeframe}. Valid options: {list(timeframe_map.keys())}")
        
        bar_size = timeframe_map[timeframe]
        
        # Map period to duration string
        duration_map = {
            '12M': '1 Y',  # 12 months = 1 year
            '6M': '6 M',
            '3M': '3 M',
            '1M': '1 M',
            '1W': '1 W',
            '1D': '1 D'
        }
        
        duration = duration_map.get(period, '1 Y')
        
        logger.info(f"Requesting historical data for {symbol}: duration={duration}, barSize={bar_size}, contractId={qualified_contract.conId}")
        
        # Request historical data from IB
        bars = await ib_client.reqHistoricalDataAsync(
            qualified_contract,
            endDateTime='',  # Use current time
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow='TRADES',
            useRTH=True,  # Regular trading hours only
            formatDate=1  # Use epoch time
        )
        
        if not bars:
            return {
                "symbol": symbol.upper(),
                "timeframe": timeframe,
                "period": period,
                "bars": [],
                "count": 0,
                "contract_id": qualified_contract.conId,
                "message": "No historical data available"
            }
        
        # Convert bars to TradingView format
        formatted_bars = []
        for bar in bars:
            # Convert IB bar to timestamp (seconds since epoch)
            if hasattr(bar, 'date'):
                if isinstance(bar.date, datetime):
                    timestamp = int(bar.date.timestamp())
                else:
                    # If it's already a timestamp
                    timestamp = int(bar.date)
            else:
                continue
                
            formatted_bars.append({
                "time": timestamp,
                "open": float(bar.open),
                "high": float(bar.high),
                "low": float(bar.low),
                "close": float(bar.close),
                "volume": int(bar.volume) if hasattr(bar, 'volume') else 0
            })
        
        logger.info(f"Retrieved {len(formatted_bars)} bars for {symbol}")
        
        return {
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "period": period,
            "bars": formatted_bars,
            "count": len(formatted_bars),
            "duration": duration,
            "bar_size": bar_size,
            "contract_id": qualified_contract.conId
        }
        
    except Exception as e:
        logger.error(f"Error getting historical data for {symbol}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting historical data: {str(e)}")

@app.get("/market-data/realtime")
async def get_realtime_data(symbol: str):
    """Get real-time market data for a symbol"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        # Validate symbol (for now, only support MSFT)
        if symbol.upper() != 'MSFT':
            raise HTTPException(status_code=400, detail=f"Only MSFT symbol is currently supported, got: {symbol}")
        
        # Create contract for MSFT stock
        contract = Stock('MSFT', 'SMART', 'USD')
        
        # Qualify the contract to populate conId (using thread executor)
        qualified_contract = await qualify_contract_async(contract)
        if not qualified_contract:
            raise HTTPException(status_code=404, detail=f"Could not qualify contract for {symbol}")
        
        # Request market data
        ticker = ib_client.reqMktData(qualified_contract)
        
        # Wait briefly for data to arrive
        await asyncio.sleep(0.5)
        
        # Helper function to safely convert values, handling NaN
        def safe_float(value):
            if value is None:
                return None
            try:
                if str(value).lower() in ['nan', '']:
                    return None
                float_val = float(value)
                if float_val != float_val:  # Check for NaN
                    return None
                if float_val <= 0:  # Filter out zero or negative values
                    return None
                return float_val
            except (ValueError, TypeError):
                return None
        
        def safe_int(value):
            if value is None:
                return None
            try:
                if str(value).lower() in ['nan', '']:
                    return None
                float_val = float(value)
                if float_val != float_val:  # Check for NaN
                    return None
                if float_val < 0:  # Filter out negative values
                    return None
                return int(float_val)
            except (ValueError, TypeError):
                return None
        
        # Get the latest tick data with safe conversions
        bid = safe_float(ticker.bid)
        ask = safe_float(ticker.ask) 
        last = safe_float(ticker.last)
        close = safe_float(ticker.close)
        volume = safe_int(ticker.volume)
        
        # Check if we have any valid data
        has_data = any([bid, ask, last, close, volume])
        
        response_data = {
            "symbol": symbol.upper(),
            "bid": bid,
            "ask": ask,
            "last": last,
            "close": close,
            "volume": volume,
            "timestamp": datetime.now().isoformat(),
            "market_data_type": getattr(ticker, 'marketDataType', 'Unknown'),
            "contract_id": qualified_contract.conId,
            "has_valid_data": has_data
        }
        
        # Add market data status information
        if not has_data:
            response_data["status"] = "NO_DATA"
            response_data["message"] = "No real-time market data available. This may be due to: 1) Market data subscription required, 2) Markets closed, 3) Delayed data only"
        else:
            response_data["status"] = "SUCCESS"
            
        return response_data
        
    except Exception as e:
        logger.error(f"Error getting real-time data for {symbol}: {str(e)}")
        # Check if this is a market data subscription error
        if "10089" in str(e) or "subscription" in str(e).lower():
            return {
                "symbol": symbol.upper(),
                "status": "SUBSCRIPTION_REQUIRED",
                "message": "Real-time market data requires additional IB subscription. Delayed data may be available.",
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
        raise HTTPException(status_code=500, detail=f"Error getting real-time data: {str(e)}")

@app.post("/market-data/subscribe")
async def subscribe_market_data(request: Dict[str, Any]):
    """Subscribe to real-time market data"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        symbol = request.get('symbol', '').upper()
        timeframe = request.get('timeframe', 'tick')
        
        if not symbol:
            raise HTTPException(status_code=400, detail="Symbol is required")
        
        # Validate symbol (for now, only support MSFT)
        if symbol != 'MSFT':
            raise HTTPException(status_code=400, detail=f"Only MSFT symbol is currently supported, got: {symbol}")
        
        # Create and qualify contract (using thread executor)
        contract = Stock(symbol, 'SMART', 'USD')
        qualified_contract = await qualify_contract_async(contract)
        if not qualified_contract:
            raise HTTPException(status_code=404, detail=f"Could not qualify contract for {symbol}")
        
        # Subscribe to market data
        ticker = ib_client.reqMktData(qualified_contract)
        
        return {
            "status": "subscribed",
            "symbol": symbol,
            "timeframe": timeframe,
            "contract_id": qualified_contract.conId,
            "message": f"Subscribed to real-time data for {symbol}"
        }
        
    except Exception as e:
        logger.error(f"Error subscribing to market data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error subscribing to market data: {str(e)}")

@app.post("/market-data/unsubscribe")
async def unsubscribe_market_data(request: Dict[str, Any]):
    """Unsubscribe from real-time market data"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        symbol = request.get('symbol', '').upper()
        
        if not symbol:
            raise HTTPException(status_code=400, detail="Symbol is required")
        
        # Create and qualify contract (using thread executor)
        contract = Stock(symbol, 'SMART', 'USD')
        qualified_contract = await qualify_contract_async(contract)
        if not qualified_contract:
            raise HTTPException(status_code=404, detail=f"Could not qualify contract for {symbol}")
        
        # Cancel market data subscription
        ib_client.cancelMktData(qualified_contract)
        
        return {
            "status": "unsubscribed",
            "symbol": symbol,
            "contract_id": qualified_contract.conId,
            "message": f"Unsubscribed from real-time data for {symbol}"
        }
        
    except Exception as e:
        logger.error(f"Error unsubscribing from market data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error unsubscribing from market data: {str(e)}")

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
    """Enhanced health check for IB Gateway with detailed diagnostics"""
    health_status = await check_ib_gateway_health()
    return {"healthy": health_status, "timestamp": datetime.now().isoformat()}

@app.get("/diagnostics")
async def diagnostics():
    """Comprehensive diagnostic information for IB Gateway connection issues"""
    try:
        # Basic connectivity test
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        tcp_result = sock.connect_ex((connection_status['host'], connection_status['port']))
        sock.close()
        
        # Gather diagnostic info
        diagnostics_info = {
            "timestamp": datetime.now().isoformat(),
            "connection_status": connection_status.copy(),
            "tcp_connectivity": {
                "host": connection_status['host'],
                "port": connection_status['port'],
                "reachable": tcp_result == 0,
                "result_code": tcp_result
            },
            "ib_client_status": {
                "exists": ib_client is not None,
                "connected": ib_client.isConnected() if ib_client else False,
                "client_id": connection_status.get('client_id', 'Unknown')
            },
            "troubleshooting_guide": {
                "tcp_success_api_failure": tcp_result == 0 and not connection_status["connected"],
                "likely_causes": [
                    "IB Gateway API connections are disabled",
                    "IB Gateway requires login/authentication", 
                    "Market data permissions not configured",
                    "Gateway in wrong mode (paper vs live)",
                    "Client ID conflicts with other applications"
                ],
                "ib_gateway_checklist": [
                    "1. Open IB Gateway and log in with credentials",
                    "2. Go to Configure > Settings > API > Settings",
                    "3. Enable 'Enable ActiveX and Socket Clients'",
                    "4. Set Socket Port to 4002",
                    "5. Add trusted IP addresses (including Docker network IPs)",
                    "6. Ensure 'Read-Only API' is unchecked if you need trading",
                    "7. Check market data subscriptions for MSFT",
                    "8. Verify paper trading vs live account settings"
                ]
            }
        }
        
        # Add specific diagnosis based on current state
        if tcp_result == 0 and not connection_status["connected"]:
            diagnostics_info["diagnosis"] = "TCP_SUCCESS_API_FAILURE"
            diagnostics_info["recommendation"] = "IB Gateway is reachable but API handshake fails. Check IB Gateway API settings and authentication."
        elif tcp_result != 0:
            diagnostics_info["diagnosis"] = "TCP_FAILURE"
            diagnostics_info["recommendation"] = "Cannot reach IB Gateway. Check host/port and network connectivity."
        elif connection_status["connected"]:
            diagnostics_info["diagnosis"] = "CONNECTED"
            diagnostics_info["recommendation"] = "Connection is working properly."
        else:
            diagnostics_info["diagnosis"] = "UNKNOWN"
            diagnostics_info["recommendation"] = "Unclear state. Try manual connection via /connect endpoint."
            
        return diagnostics_info
        
    except Exception as e:
        return {
            "error": f"Diagnostics failed: {str(e)}",
            "timestamp": datetime.now().isoformat()
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

@app.post("/connect-with-retry")
async def connect_with_retry(max_attempts: int = 3, delay_seconds: int = 5):
    """Enhanced connection attempt with retry logic and detailed feedback"""
    results = []
    
    for attempt in range(1, max_attempts + 1):
        try:
            logger.info(f"Connection attempt {attempt}/{max_attempts}")
            
            # Attempt connection
            success = await connect_to_ib()
            
            attempt_result = {
                "attempt": attempt,
                "timestamp": datetime.now().isoformat(),
                "success": success,
                "connection_status": connection_status.copy()
            }
            
            if success:
                attempt_result["message"] = "Connection successful!"
                results.append(attempt_result)
                return {
                    "overall_success": True,
                    "successful_attempt": attempt,
                    "attempts": results,
                    "current_status": connection_status.copy()
                }
            else:
                attempt_result["message"] = f"Attempt {attempt} failed"
                results.append(attempt_result)
                
                # Wait before next attempt (except on last attempt)
                if attempt < max_attempts:
                    logger.info(f"Waiting {delay_seconds} seconds before next attempt...")
                    await asyncio.sleep(delay_seconds)
                    
        except Exception as e:
            attempt_result = {
                "attempt": attempt,
                "timestamp": datetime.now().isoformat(),
                "success": False,
                "error": str(e),
                "connection_status": connection_status.copy()
            }
            results.append(attempt_result)
    
    return {
        "overall_success": False,
        "attempts": results,
        "current_status": connection_status.copy(),
        "recommendation": "All connection attempts failed. Please check IB Gateway settings and diagnostics endpoint."
    }

@app.get("/account")
async def get_account_info():
    """Get detailed account information"""
    if not ib_client or not ib_client.isConnected():
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers Gateway")
    
    try:
        # Get account information using thread executor
        result, error = await get_account_summary_async()
        
        if error:
            raise HTTPException(status_code=500, detail=error)
        
        if not result:
            raise HTTPException(status_code=404, detail="No account data available")
        
        account, account_data = result
        
        # Extract key account information with safe conversions
        def safe_float_account(key, default="0"):
            try:
                value = account_data.get(key, {}).get("value", default)
                return float(value) if value and value != "" else 0.0
            except (ValueError, TypeError):
                return 0.0
        
        def safe_int_account(key, default="0"):
            try:
                value = account_data.get(key, {}).get("value", default)
                return int(float(value)) if value and value != "" else 0
            except (ValueError, TypeError):
                return 0
        
        def safe_str_account(key, default="Unknown"):
            try:
                value = account_data.get(key, {}).get("value", default)
                return str(value) if value else default
            except (TypeError):
                return default
        
        # Extract key account information
        account_info = {
            "account_number": account,
            "account_type": safe_str_account("AccountType", "Unknown"),
            "net_liquidation": safe_float_account("NetLiquidation"),
            "total_cash": safe_float_account("TotalCashValue"),
            "settled_cash": safe_float_account("SettledCash"),
            "buying_power": safe_float_account("BuyingPower"),
            "excess_liquidity": safe_float_account("ExcessLiquidity"),
            "day_trades_remaining": safe_int_account("DayTradesRemaining"),
            "currency": safe_str_account("Currency", "USD"),
            "last_updated": datetime.now().isoformat()
        }
        
        return {
            "status": "success",
            "account_info": account_info,
            "available_fields": list(account_data.keys())[:10]  # Show first 10 available fields
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
            contract = position.contract
            position_list.append({
                "symbol": contract.symbol if hasattr(contract, 'symbol') else 'Unknown',
                "secType": contract.secType if hasattr(contract, 'secType') else 'Unknown',
                "exchange": contract.exchange if hasattr(contract, 'exchange') else 'Unknown',
                "currency": contract.currency if hasattr(contract, 'currency') else 'USD',
                "account": position.account,
                "position": float(position.position),
                "avgCost": float(position.avgCost),
                "marketPrice": float(getattr(position, 'marketPrice', 0)),
                "marketValue": float(getattr(position, 'marketValue', 0)),
                "unrealizedPNL": float(getattr(position, 'unrealizedPNL', 0)),
                "realizedPNL": float(getattr(position, 'realizedPNL', 0))
            })
        
        return {
            "status": "success",
            "positions": position_list,
            "total_positions": len(position_list)
        }
        
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
            contract = trade.contract
            order = trade.order
            order_state = trade.orderState
            
            order_list.append({
                "orderId": order.orderId if hasattr(order, 'orderId') else 0,
                "symbol": contract.symbol if hasattr(contract, 'symbol') else 'Unknown',
                "secType": contract.secType if hasattr(contract, 'secType') else 'Unknown',
                "action": order.action if hasattr(order, 'action') else 'Unknown',
                "orderType": order.orderType if hasattr(order, 'orderType') else 'Unknown',
                "totalQuantity": float(order.totalQuantity) if hasattr(order, 'totalQuantity') else 0,
                "lmtPrice": float(order.lmtPrice) if hasattr(order, 'lmtPrice') and order.lmtPrice else 0,
                "auxPrice": float(order.auxPrice) if hasattr(order, 'auxPrice') and order.auxPrice else 0,
                "status": order_state.status if hasattr(order_state, 'status') else 'Unknown',
                "filled": float(getattr(order_state, 'filled', 0)),
                "remaining": float(getattr(order_state, 'remaining', 0)),
                "avgFillPrice": float(getattr(order_state, 'avgFillPrice', 0)),
                "permId": getattr(order_state, 'permId', 0),
                "parentId": getattr(order_state, 'parentId', 0),
                "lastFillPrice": float(getattr(order_state, 'lastFillPrice', 0)),
                "commission": float(getattr(order_state, 'commission', 0))
            })
        
        return {
            "status": "success", 
            "orders": order_list,
            "total_orders": len(order_list)
        }
        
    except Exception as e:
        logger.error(f"Error getting orders: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting orders: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000) 