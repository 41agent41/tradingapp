"""
Advanced connection manager for IB Gateway with pooling, heartbeat, and retry logic
"""

import asyncio
import time
from typing import Dict, List, Optional, Set
from datetime import datetime, timedelta
import structlog
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from ib_insync import IB, Contract, Stock
import threading
import concurrent.futures
from contextlib import asynccontextmanager

from config import config
from models import ConnectionStatus


logger = structlog.get_logger(__name__)


class ConnectionPoolError(Exception):
    """Custom exception for connection pool errors"""
    pass


class IBConnection:
    """Individual IB connection wrapper with heartbeat monitoring"""
    
    def __init__(self, client_id: int):
        self.client_id = client_id
        self.ib_client: Optional[IB] = None
        self.connected = False
        self.last_heartbeat = None
        self.connection_time = None
        self.last_error = None
        self.in_use = False
        self.lock = asyncio.Lock()
    
    async def connect(self) -> bool:
        """Connect to IB Gateway with improved error handling"""
        async with self.lock:
            try:
                if self.ib_client and self.ib_client.isConnected():
                    logger.info("Connection already established", client_id=self.client_id)
                    return True
                
                logger.info("Establishing connection to IB Gateway", 
                           client_id=self.client_id, 
                           host=config.ib_host, 
                           port=config.ib_port)
                
                # Create new IB client
                self.ib_client = IB()
                
                # Connect with timeout
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None, 
                        self._connect_sync
                    ),
                    timeout=config.ib_timeout
                )
                
                if self.ib_client.isConnected():
                    self.connected = True
                    self.connection_time = datetime.utcnow()
                    self.last_heartbeat = datetime.utcnow()
                    self.last_error = None
                    
                    logger.info("Successfully connected to IB Gateway", 
                               client_id=self.client_id)
                    return True
                else:
                    raise ConnectionPoolError("Connection established but client reports not connected")
                    
            except asyncio.TimeoutError:
                error_msg = f"Connection timeout after {config.ib_timeout} seconds"
                logger.error(error_msg, client_id=self.client_id)
                self.last_error = error_msg
                self.connected = False
                return False
                
            except Exception as e:
                error_msg = f"Connection failed: {str(e)}"
                logger.error(error_msg, client_id=self.client_id, error=str(e))
                self.last_error = error_msg
                self.connected = False
                return False
    
    def _connect_sync(self):
        """Synchronous connection method for executor"""
        self.ib_client.connect(
            host=config.ib_host,
            port=config.ib_port,
            clientId=self.client_id,
            timeout=config.ib_timeout
        )
    
    async def disconnect(self):
        """Disconnect from IB Gateway"""
        async with self.lock:
            try:
                if self.ib_client and self.ib_client.isConnected():
                    await asyncio.get_event_loop().run_in_executor(
                        None, 
                        self.ib_client.disconnect
                    )
                    
                self.connected = False
                self.in_use = False
                self.connection_time = None
                self.last_heartbeat = None
                
                logger.info("Disconnected from IB Gateway", client_id=self.client_id)
                
            except Exception as e:
                logger.error("Error during disconnect", 
                           client_id=self.client_id, 
                           error=str(e))
    
    async def heartbeat(self) -> bool:
        """Perform heartbeat check"""
        if not self.connected or not self.ib_client:
            return False
        
        try:
            # Simple connection check
            is_connected = await asyncio.get_event_loop().run_in_executor(
                None, 
                lambda: self.ib_client.isConnected()
            )
            
            if is_connected:
                self.last_heartbeat = datetime.utcnow()
                return True
            else:
                logger.warning("Heartbeat failed - connection lost", 
                             client_id=self.client_id)
                self.connected = False
                return False
                
        except Exception as e:
            logger.error("Heartbeat error", 
                        client_id=self.client_id, 
                        error=str(e))
            self.connected = False
            return False
    
    def is_healthy(self) -> bool:
        """Check if connection is healthy"""
        if not self.connected:
            return False
        
        # Check if heartbeat is recent
        if self.last_heartbeat:
            age = datetime.utcnow() - self.last_heartbeat
            return age.total_seconds() < config.heartbeat_timeout * 2
        
        return False


class IBConnectionPool:
    """Connection pool manager for IB Gateway connections"""
    
    def __init__(self):
        self.connections: Dict[int, IBConnection] = {}
        self.available_connections: asyncio.Queue = asyncio.Queue()
        self.max_connections = config.max_connections
        self.heartbeat_task: Optional[asyncio.Task] = None
        self.pool_lock = asyncio.Lock()
        self.initialized = False
        
    async def initialize(self):
        """Initialize the connection pool"""
        async with self.pool_lock:
            if self.initialized:
                return
            
            logger.info("Initializing IB connection pool", 
                       max_connections=self.max_connections)
            
            # Create connections
            for i in range(1, self.max_connections + 1):
                connection = IBConnection(client_id=i)
                self.connections[i] = connection
                await self.available_connections.put(connection)
            
            # Start heartbeat monitoring
            self.heartbeat_task = asyncio.create_task(self._heartbeat_monitor())
            self.initialized = True
            
            logger.info("Connection pool initialized successfully")
    
    async def shutdown(self):
        """Shutdown the connection pool"""
        logger.info("Shutting down connection pool")
        
        # Cancel heartbeat task
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            try:
                await self.heartbeat_task
            except asyncio.CancelledError:
                pass
        
        # Disconnect all connections
        for connection in self.connections.values():
            await connection.disconnect()
        
        self.initialized = False
        logger.info("Connection pool shutdown complete")
    
    @asynccontextmanager
    async def get_connection(self):
        """Get a connection from the pool with context manager"""
        if not self.initialized:
            await self.initialize()
        
        connection = None
        try:
            # Get available connection with timeout
            connection = await asyncio.wait_for(
                self.available_connections.get(), 
                timeout=30.0
            )
            
            # Ensure connection is healthy
            if not connection.is_healthy():
                success = await self._ensure_connected(connection)
                if not success:
                    raise ConnectionPoolError(f"Failed to establish connection for client {connection.client_id}")
            
            connection.in_use = True
            yield connection
            
        except asyncio.TimeoutError:
            raise ConnectionPoolError("Timeout waiting for available connection")
        
        finally:
            if connection:
                connection.in_use = False
                await self.available_connections.put(connection)
    
    async def _ensure_connected(self, connection: IBConnection) -> bool:
        """Ensure connection is established with retry logic"""
        if connection.is_healthy():
            return True
        
        @retry(
            stop=stop_after_attempt(config.connection_retry_attempts),
            wait=wait_exponential(
                multiplier=config.connection_retry_delay,
                max=config.connection_retry_max_delay
            ),
            retry=retry_if_exception_type((ConnectionPoolError, ConnectionRefusedError, TimeoutError))
        )
        async def _connect_with_retry():
            success = await connection.connect()
            if not success:
                raise ConnectionPoolError(f"Connection failed for client {connection.client_id}")
            return success
        
        try:
            return await _connect_with_retry()
        except Exception as e:
            logger.error("Failed to establish connection after retries", 
                        client_id=connection.client_id, 
                        error=str(e))
            return False
    
    async def _heartbeat_monitor(self):
        """Background task to monitor connection health"""
        logger.info("Starting heartbeat monitor")
        
        while True:
            try:
                await asyncio.sleep(config.heartbeat_interval)
                
                # Check all connections
                for connection in self.connections.values():
                    if connection.connected and not connection.in_use:
                        await connection.heartbeat()
                
            except asyncio.CancelledError:
                logger.info("Heartbeat monitor cancelled")
                break
            except Exception as e:
                logger.error("Error in heartbeat monitor", error=str(e))
    
    async def get_status(self) -> Dict[str, any]:
        """Get pool status information"""
        healthy_connections = sum(
            1 for conn in self.connections.values() 
            if conn.is_healthy()
        )
        
        return {
            "total_connections": len(self.connections),
            "healthy_connections": healthy_connections,
            "available_connections": self.available_connections.qsize(),
            "connections": {
                client_id: {
                    "connected": conn.connected,
                    "in_use": conn.in_use,
                    "last_heartbeat": conn.last_heartbeat.isoformat() if conn.last_heartbeat else None,
                    "connection_time": conn.connection_time.isoformat() if conn.connection_time else None,
                    "last_error": conn.last_error
                }
                for client_id, conn in self.connections.items()
            }
        }


# Global connection pool instance
connection_pool = IBConnectionPool()


async def get_connection_status() -> ConnectionStatus:
    """Get current connection status"""
    if not connection_pool.initialized:
        return ConnectionStatus(
            connected=False,
            host=config.ib_host,
            port=config.ib_port,
            client_id=0,
            last_error="Connection pool not initialized"
        )
    
    # Get status of first healthy connection
    for client_id, connection in connection_pool.connections.items():
        if connection.is_healthy():
            return ConnectionStatus(
                connected=True,
                host=config.ib_host,
                port=config.ib_port,
                client_id=client_id,
                connection_time=connection.connection_time,
                last_heartbeat=connection.last_heartbeat
            )
    
    # No healthy connections found
    return ConnectionStatus(
        connected=False,
        host=config.ib_host,
        port=config.ib_port,
        client_id=0,
        last_error="No healthy connections available"
    )


async def test_connection() -> bool:
    """Test if we can establish a connection to IB Gateway"""
    try:
        async with connection_pool.get_connection() as connection:
            return connection.is_healthy()
    except Exception as e:
        logger.error("Connection test failed", error=str(e))
        return False 