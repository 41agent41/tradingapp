"""
Simple connection manager for IB Gateway without complex async patterns
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

from config import get_config
from models import ConnectionStatus

# Get configuration dynamically
config = get_config()


logger = structlog.get_logger(__name__)


class ConnectionPoolError(Exception):
    """Custom exception for connection pool errors"""
    pass


class IBConnection:
    """Simple IB connection wrapper"""
    
    def __init__(self, client_id: int):
        self.client_id = client_id
        self.ib_client: Optional[IB] = None
        self.connected = False
        self.last_heartbeat = None
        self.connection_time = None
        self.last_error = None
        self.in_use = False
        self.lock = threading.Lock()
    
    def connect(self) -> bool:
        """Connect to IB Gateway synchronously"""
        with self.lock:
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
                
                # Connect synchronously
                self.ib_client.connect(
                    host=config.ib_host,
                    port=config.ib_port,
                    clientId=self.client_id,
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
                    
            except Exception as e:
                error_msg = f"Connection failed: {str(e)}"
                logger.error(error_msg, client_id=self.client_id, error=str(e))
                self.last_error = error_msg
                self.connected = False
                return False
    
    def disconnect(self):
        """Disconnect from IB Gateway"""
        with self.lock:
            try:
                if self.ib_client and self.ib_client.isConnected():
                    self.ib_client.disconnect()
                    
                self.connected = False
                self.in_use = False
                self.connection_time = None
                self.last_heartbeat = None
                
                logger.info("Disconnected from IB Gateway", client_id=self.client_id)
                
            except Exception as e:
                logger.error("Error during disconnect", 
                           client_id=self.client_id, 
                           error=str(e))
    
    def heartbeat(self) -> bool:
        """Perform heartbeat check"""
        if not self.connected or not self.ib_client:
            return False
        
        try:
            # Simple connection check
            is_connected = self.ib_client.isConnected()
            
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


class SimpleConnectionManager:
    """Simple connection manager that creates connections on demand"""
    
    def __init__(self):
        self.connections: Dict[int, IBConnection] = {}
        self.connection_lock = threading.Lock()
        self.initialized = False
        
    async def initialize(self):
        """Initialize the connection manager (no connections created)"""
        logger.info("Initializing simple connection manager")
        self.initialized = True
        logger.info("Connection manager initialized successfully")
    
    async def shutdown(self):
        """Shutdown the connection manager"""
        logger.info("Shutting down connection manager")
        
        with self.connection_lock:
            # Disconnect all connections
            for connection in self.connections.values():
                connection.disconnect()
            
            self.connections.clear()
        
        self.initialized = False
        logger.info("Connection manager shutdown complete")
    
    def _get_or_create_connection(self, client_id: int) -> IBConnection:
        """Get existing connection or create new one"""
        with self.connection_lock:
            if client_id not in self.connections:
                self.connections[client_id] = IBConnection(client_id)
            return self.connections[client_id]
    
    @asynccontextmanager
    async def get_connection(self):
        """Get a connection (creates on demand)"""
        if not self.initialized:
            await self.initialize()
        
        # Use client ID 1 for simplicity
        client_id = 1
        connection = self._get_or_create_connection(client_id)
        
        try:
            # Ensure connection is healthy
            if not connection.is_healthy():
                success = connection.connect()
                if not success:
                    raise ConnectionPoolError(f"Failed to establish connection for client {client_id}")
            
            connection.in_use = True
            yield connection
            
        finally:
            connection.in_use = False
    
    async def get_status(self) -> Dict[str, any]:
        """Get connection status information"""
        with self.connection_lock:
            healthy_connections = sum(
                1 for conn in self.connections.values() 
                if conn.is_healthy()
            )
            
            return {
                "total_connections": len(self.connections),
                "healthy_connections": healthy_connections,
                "available_connections": len(self.connections),
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


# Global connection manager instance
connection_pool = SimpleConnectionManager()


async def get_connection_status() -> ConnectionStatus:
    """Get current connection status"""
    if not connection_pool.initialized:
        return ConnectionStatus(
            connected=False,
            host=config.ib_host,
            port=config.ib_port,
            client_id=0,
            last_error="Connection manager not initialized"
        )
    
    # Get status of first connection
    with connection_pool.connection_lock:
        if connection_pool.connections:
            client_id, connection = next(iter(connection_pool.connections.items()))
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