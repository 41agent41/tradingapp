"""
Improved IB Service with connection pooling, data validation, and proper async patterns
"""

import asyncio
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
import structlog
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response


from ib_insync import Contract, Stock, util

# Import our improved components
from config import get_config
from models import (
    MarketDataRequest, HistoricalDataResponse, RealTimeQuote,
    ConnectionStatus, HealthStatus, ErrorResponse, AccountSummary,
    Position, Order, SubscriptionRequest, DataQualityMetrics,
    safe_float, safe_int
)
from connection_manager import connection_pool, get_connection_status, test_connection
from data_processor import data_processor

# Get configuration dynamically
config = get_config()


# Configure structured logging
structlog.configure(
    processors=[
        structlog.dev.ConsoleRenderer()
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger(__name__)

# Simple metrics tracking (no Prometheus)
class SimpleMetrics:
    def __init__(self):
        self.request_count = 0
        self.connection_status = 0
    
    def inc(self, *args, **kwargs):
        self.request_count += 1
    
    def observe(self, *args, **kwargs):
        pass
    
    def set(self, value, *args, **kwargs):
        if 'connection_status' in str(args):
            self.connection_status = value
    
    def labels(self, *args, **kwargs):
        return self

# Initialize simple metrics
REQUEST_COUNT = SimpleMetrics()
REQUEST_DURATION = SimpleMetrics()
CONNECTION_STATUS = SimpleMetrics()
DATA_QUALITY_SCORE = SimpleMetrics()

# Service state
service_start_time = time.time()
active_subscriptions: Dict[str, datetime] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan management"""
    # Startup
    logger.info("Starting IB Service", version="2.0.0")
    
    try:
        # Initialize connection pool (non-blocking)
        try:
            await connection_pool.initialize()
            logger.info("Connection pool initialized successfully")
        except Exception as e:
            logger.warning("Connection pool initialization failed, will retry on demand", error=str(e))
        
        # Initialize data processor (non-blocking)
        try:
            await data_processor.initialize()
            logger.info("Data processor initialized successfully")
        except Exception as e:
            logger.warning("Data processor initialization failed, will retry on demand", error=str(e))
        
        # Don't test initial connection - let it fail gracefully on first request
        logger.info("IB Service startup complete - connections will be established on demand")
        CONNECTION_STATUS.set(0)  # Start with disconnected status
        
    except Exception as e:
        logger.error("Failed to initialize IB Service", error=str(e))
        # Don't fail startup - service should continue running for health checks
    
    yield
    
    # Shutdown
    logger.info("Shutting down IB Service")
    
    try:
        await connection_pool.shutdown()
        await data_processor.shutdown()
        logger.info("IB Service shutdown complete")
    except Exception as e:
        logger.error("Error during shutdown", error=str(e))


# Create FastAPI app with improved configuration
app = FastAPI(
    title="TradingApp IB Service",
    version="2.0.0",
    description="Enhanced Interactive Brokers service with connection pooling and data validation",
    lifespan=lifespan
)

# Add CORS middleware with configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def track_request_metrics(endpoint: str, method: str = "GET"):
    """Dependency to track request metrics"""
    REQUEST_COUNT.labels(method=method, endpoint=endpoint).inc()
    start_time = time.time()
    
    yield
    
    REQUEST_DURATION.observe(time.time() - start_time)


def create_contract(symbol: str) -> Contract:
    """Create IB contract for symbol with validation"""
    try:
        # Validate symbol format
        if not symbol or not symbol.isalpha() or len(symbol) > 10:
            raise ValueError(f"Invalid symbol format: {symbol}")
        
        contract = Stock(symbol.upper(), 'SMART', 'USD')
        return contract
        
    except Exception as e:
        logger.error("Failed to create contract", symbol=symbol, error=str(e))
        raise HTTPException(status_code=400, detail=f"Invalid symbol: {symbol}")


@app.get("/")
async def root():
    """Service information and health status"""
    uptime = time.time() - service_start_time
    
    return {
        "service": "TradingApp IB Service",
        "version": "2.0.0",
        "status": "running",
        "uptime_seconds": uptime,
        "config": {
            "ib_host": config.ib_host,
            "ib_port": config.ib_port,
            "max_connections": config.max_connections,
            "cache_ttl": config.data_cache_ttl,
            "rate_limit": config.rate_limit_requests_per_minute
        },
        "endpoints": {
            "health": "/health",
            "connection": "/connection",
            "market_data": "/market-data/*",
            "account": "/account",
            "positions": "/positions",
            "orders": "/orders",
            "metrics": "/metrics"
        },
        "features": [
            "Connection pooling",
            "Data validation with Pydantic",
            "Caching with TTL",
            "Rate limiting",
            "Structured logging",
            "Health monitoring"
        ]
    }


@app.get("/debug")
async def debug_config():
    """Debug endpoint to show environment variables and configuration"""
    import os
    
    # Get all IB_ environment variables
    ib_env_vars = {k: v for k, v in os.environ.items() if k.startswith('IB_')}
    
    # Get current configuration values dynamically
    current_config_instance = get_config()
    current_config = {
        "ib_host": current_config_instance.ib_host,
        "ib_port": current_config_instance.ib_port,
        "ib_client_id": current_config_instance.ib_client_id,
        "ib_timeout": current_config_instance.ib_timeout,
        "max_connections": current_config_instance.max_connections,
        "data_cache_ttl": current_config_instance.data_cache_ttl,
        "rate_limit_requests_per_minute": current_config_instance.rate_limit_requests_per_minute
    }
    
    return {
        "environment_variables": ib_env_vars,
        "current_config": current_config,
        "env_file_loaded": os.path.exists("/app/.env"),
        "timestamp": datetime.utcnow().isoformat()
    }


@app.get("/health")
async def health_check():
    """Comprehensive health check"""
    uptime = time.time() - service_start_time
    
    # Check connection pool status (with error handling)
    try:
        pool_status = await connection_pool.get_status()
        pool_healthy = pool_status["healthy_connections"] > 0
    except Exception as e:
        logger.warning("Failed to get connection pool status", error=str(e))
        pool_status = {"total_connections": 0, "healthy_connections": 0, "available_connections": 0}
        pool_healthy = False
    
    # Check IB Gateway connectivity (with error handling)
    try:
        connection_test = await test_connection()
        gateway_healthy = connection_test
    except Exception as e:
        logger.warning("Failed to test IB Gateway connection", error=str(e))
        gateway_healthy = False
    
    # Determine overall health - service is healthy if it's running, even if connections fail
    is_healthy = True  # Service itself is healthy if it's responding
    connection_healthy = pool_healthy and gateway_healthy
    
    status = "healthy" if is_healthy else "unhealthy"
    
    services = {
        "connection_pool": {
            "status": "healthy" if pool_healthy else "unhealthy",
            "total_connections": pool_status.get("total_connections", 0),
            "healthy_connections": pool_status.get("healthy_connections", 0),
            "available_connections": pool_status.get("available_connections", 0)
        },
        "ib_gateway": {
            "status": "healthy" if gateway_healthy else "unhealthy",
            "host": config.ib_host,
            "port": config.ib_port
        },
        "data_processor": {
            "status": "healthy",
            "cache_size": len(data_processor.cache.cache) if hasattr(data_processor, 'cache') else 0
        }
    }
    
    return HealthStatus(
        status=status,
        services=services,
        uptime_seconds=uptime
    )


@app.get("/connection")
async def get_connection_info():
    """Get detailed connection status"""
    try:
        return await get_connection_status()
    except Exception as e:
        logger.warning("Failed to get connection status", error=str(e))
        # Return basic status if connection pool is not available
        return {
            "connected": False,
            "host": config.ib_host,
            "port": config.ib_port,
            "client_id": 0,
            "last_error": "Connection pool not available",
            "timestamp": datetime.utcnow().isoformat()
        }


@app.post("/connect")
async def connect_to_ib():
    """Force connection to IB Gateway"""
    try:
        success = await test_connection()
        if success:
            CONNECTION_STATUS.set(1)
            return {"message": "Successfully connected to IB Gateway", "connected": True}
        else:
            CONNECTION_STATUS.set(0)
            raise HTTPException(status_code=503, detail="Failed to connect to IB Gateway")
    except Exception as e:
        logger.error("Connection attempt failed", error=str(e))
        raise HTTPException(status_code=503, detail=f"Connection failed: {str(e)}")


@app.get("/market-data/history")
async def get_historical_data(
    symbol: str,
    timeframe: str,
    period: str = "1Y"
):
    """Get historical market data with validation and caching"""
    
    # Validate request using Pydantic
    try:
        request = MarketDataRequest(symbol=symbol, timeframe=timeframe, period=period)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")
    
    # Check cache first
    cached_data = await data_processor.get_cached_data(request)
    if cached_data:
        logger.info("Serving cached historical data", symbol=request.symbol)
        return cached_data
    
    # Fetch from IB Gateway
    try:
        # Get connection synchronously
        connection = connection_pool.get_connection_sync()
        try:
            # Create contract
            contract = create_contract(request.symbol)
            
            # Qualify contract using executor
            loop = asyncio.get_event_loop()
            qualified_contracts = await loop.run_in_executor(
                None,
                lambda: connection.ib_client.qualifyContracts(contract)
            )
            
            if not qualified_contracts:
                raise HTTPException(status_code=404, detail=f"Symbol {request.symbol} not found")
            
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
            
            ib_timeframe = ib_timeframe_map.get(request.timeframe, '1 hour')
            
            # Request historical data using executor
            bars = await loop.run_in_executor(
                None,
                lambda: connection.ib_client.reqHistoricalData(
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
                raise HTTPException(status_code=404, detail=f"No data available for {request.symbol}")
            
            # Process data through pipeline
            response = await data_processor.process_historical_data(bars, request)
            
            logger.info("Historical data fetched and processed",
                       symbol=request.symbol,
                       bars_count=len(response.bars))
            
            return response
        finally:
            connection_pool.release_connection(connection)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to fetch historical data", 
                    symbol=request.symbol, 
                    error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to fetch data: {str(e)}")


@app.get("/market-data/realtime")
async def get_realtime_data(symbol: str):
    """Get real-time market data"""
    
    try:
        # Get connection synchronously
        connection = connection_pool.get_connection_sync()
        try:
            contract = create_contract(symbol)
            
            # Qualify contract using executor
            loop = asyncio.get_event_loop()
            qualified_contracts = await loop.run_in_executor(
                None,
                lambda: connection.ib_client.qualifyContracts(contract)
            )
            
            if not qualified_contracts:
                raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")
            
            qualified_contract = qualified_contracts[0]
            
            # Get ticker data using executor
            ticker = await loop.run_in_executor(
                None,
                lambda: connection.ib_client.reqMktData(qualified_contract, '', False, False)
            )
            
            # Wait for data with timeout
            await asyncio.sleep(2)
            
            # Process real-time quote
            quote = await data_processor.process_realtime_quote(ticker, symbol.upper())
            
            if not quote:
                raise HTTPException(status_code=404, detail=f"No real-time data available for {symbol}")
            
            return quote
        finally:
            connection_pool.release_connection(connection)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to fetch real-time data", symbol=symbol, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to fetch real-time data: {str(e)}")


@app.post("/market-data/subscribe")
async def subscribe_market_data(request: SubscriptionRequest):
    """Subscribe to real-time market data updates"""
    
    try:
        # Add to active subscriptions
        active_subscriptions[request.symbol] = datetime.utcnow()
        
        logger.info("Market data subscription added", 
                   symbol=request.symbol, 
                   timeframe=request.timeframe)
        
        return {
            "message": f"Subscribed to {request.symbol}",
            "symbol": request.symbol,
            "timeframe": request.timeframe,
            "active_subscriptions": len(active_subscriptions)
        }
        
    except Exception as e:
        logger.error("Failed to subscribe to market data", 
                    symbol=request.symbol, 
                    error=str(e))
        raise HTTPException(status_code=500, detail=f"Subscription failed: {str(e)}")


@app.post("/market-data/unsubscribe")
async def unsubscribe_market_data(request: SubscriptionRequest):
    """Unsubscribe from real-time market data updates"""
    
    try:
        if request.symbol in active_subscriptions:
            del active_subscriptions[request.symbol]
            
        logger.info("Market data subscription removed", symbol=request.symbol)
        
        return {
            "message": f"Unsubscribed from {request.symbol}",
            "symbol": request.symbol,
            "active_subscriptions": len(active_subscriptions)
        }
        
    except Exception as e:
        logger.error("Failed to unsubscribe from market data", 
                    symbol=request.symbol, 
                    error=str(e))
        raise HTTPException(status_code=500, detail=f"Unsubscription failed: {str(e)}")


@app.get("/account")
async def get_account_info():
    """Get account information"""
    
    try:
        # Get connection synchronously
        connection = connection_pool.get_connection_sync()
        try:
            # Request account summary using executor
            loop = asyncio.get_event_loop()
            account_summary = await loop.run_in_executor(
                None,
                lambda: connection.ib_client.accountSummary()
            )
            
            # Process account data
            account_data = {}
            for item in account_summary:
                account_data[item.tag] = item.value
            
            return AccountSummary(
                account_id=account_data.get('AccountCode', 'Unknown'),
                net_liquidation=safe_float(account_data.get('NetLiquidation', 0)),
                total_cash=safe_float(account_data.get('TotalCashValue', 0)),
                settled_cash=safe_float(account_data.get('SettledCash', 0)),
                accrued_cash=safe_float(account_data.get('AccruedCash', 0)),
                buying_power=safe_float(account_data.get('BuyingPower', 0)),
                equity_with_loan=safe_float(account_data.get('EquityWithLoanValue', 0)),
                previous_day_equity=safe_float(account_data.get('PreviousDayEquityWithLoanValue', 0)),
                gross_position_value=safe_float(account_data.get('GrossPositionValue', 0)),
                currency=account_data.get('Currency', 'USD')
            )
        finally:
            connection_pool.release_connection(connection)
            
    except Exception as e:
        logger.error("Failed to fetch account info", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to fetch account info: {str(e)}")


@app.get("/pool-status")
async def get_pool_status():
    """Get connection pool detailed status"""
    return await connection_pool.get_status()


@app.get("/gateway-health")
async def get_gateway_health():
    """Get IB Gateway health status"""
    try:
        # Test connection to IB Gateway
        connection_test = await test_connection()
        
        if connection_test:
            return {
                "status": "healthy",
                "gateway": "connected",
                "host": config.ib_host,
                "port": config.ib_port,
                "timestamp": datetime.utcnow().isoformat()
            }
        else:
            return {
                "status": "unhealthy",
                "gateway": "disconnected",
                "host": config.ib_host,
                "port": config.ib_port,
                "error": "Connection refused - IB Gateway not accessible",
                "timestamp": datetime.utcnow().isoformat()
            }
    except Exception as e:
        return {
            "status": "unhealthy",
            "gateway": "error",
            "host": config.ib_host,
            "port": config.ib_port,
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }


if __name__ == "__main__":
    import uvicorn
    
    # Ensure we bind to the correct host and port
    uvicorn.run(
        "main:app",
        host="0.0.0.0",  # Bind to all interfaces
        port=8000,       # Use default port
        log_level=config.log_level.lower(),
        reload=config.debug
    ) 