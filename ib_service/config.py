"""
Configuration management for IB Service using Pydantic Settings
"""

from pydantic import Field, validator
from pydantic_settings import BaseSettings
from typing import List, Optional
import os


class IBServiceConfig(BaseSettings):
    """Configuration for IB Service with validation and type safety"""
    
    # Server Configuration
    host: str = Field(default="0.0.0.0", description="Server host")
    port: int = Field(default=8000, description="Server port")
    debug: bool = Field(default=False, description="Debug mode")
    log_level: str = Field(default="INFO", description="Logging level")
    
    # IB Gateway Configuration
    ib_host: str = Field(default="localhost", description="IB Gateway host")
    ib_port: int = Field(default=4002, description="IB Gateway port")
    ib_client_id: int = Field(default=1, description="IB client ID")
    ib_timeout: int = Field(default=30, description="IB connection timeout in seconds")
    
    # Connection Pool Configuration
    max_connections: int = Field(default=5, description="Maximum IB connections")
    connection_retry_attempts: int = Field(default=5, description="Connection retry attempts")
    connection_retry_delay: float = Field(default=1.0, description="Initial retry delay in seconds")
    connection_retry_max_delay: float = Field(default=60.0, description="Maximum retry delay in seconds")
    connection_retry_exponential_base: float = Field(default=2.0, description="Exponential backoff base")
    
    # Heartbeat Configuration
    heartbeat_interval: int = Field(default=30, description="Heartbeat interval in seconds")
    heartbeat_timeout: int = Field(default=10, description="Heartbeat timeout in seconds")
    
    # Data Processing Configuration
    data_cache_ttl: int = Field(default=300, description="Data cache TTL in seconds")
    max_historical_bars: int = Field(default=10000, description="Maximum historical bars to fetch")
    rate_limit_requests_per_minute: int = Field(default=100, description="Rate limit for API requests")
    
    # CORS Configuration - Use string field and convert in validator
    cors_origins: str = Field(
        default="http://localhost:3000",
        description="Allowed CORS origins (comma-separated)"
    )
    
    # Monitoring Configuration
    metrics_enabled: bool = Field(default=True, description="Enable Prometheus metrics")
    health_check_enabled: bool = Field(default=True, description="Enable health checks")
    
    @validator('ib_port')
    def validate_ib_port(cls, v):
        if not (1 <= v <= 65535):
            raise ValueError('IB port must be between 1 and 65535')
        return v
    
    @validator('ib_client_id')
    def validate_client_id(cls, v):
        if not (1 <= v <= 32):
            raise ValueError('IB client ID must be between 1 and 32')
        return v
    
    @validator('log_level')
    def validate_log_level(cls, v):
        valid_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
        if v.upper() not in valid_levels:
            raise ValueError(f'Log level must be one of: {valid_levels}')
        return v.upper()
    
    @validator('cors_origins')
    def validate_cors_origins(cls, v):
        if not v or not v.strip():
            return "http://localhost:3000"
        return v.strip()
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Get CORS origins as a list"""
        if not self.cors_origins:
            return ["http://localhost:3000"]
        return [origin.strip() for origin in self.cors_origins.split(',') if origin.strip()]
    
    class Config:
        env_prefix = "IB_"
        case_sensitive = False
        env_file = ".env"
        env_file_encoding = "utf-8"


def get_config() -> IBServiceConfig:
    """Get configuration instance with proper environment variable loading"""
    # Force reload of environment variables
    import os
    
    # Get environment variables directly
    ib_host = os.environ.get('IB_HOST', 'localhost')
    ib_port = int(os.environ.get('IB_PORT', '4002'))
    ib_client_id = int(os.environ.get('IB_CLIENT_ID', '1'))
    ib_timeout = int(os.environ.get('IB_TIMEOUT', '60'))  # Increased timeout to 60 seconds
    max_connections = int(os.environ.get('IB_MAX_CONNECTIONS', '5'))
    data_cache_ttl = int(os.environ.get('IB_DATA_CACHE_TTL', '300'))
    rate_limit = int(os.environ.get('IB_RATE_LIMIT_REQUESTS_PER_MINUTE', '100'))
    
    # Create config with explicit values
    return IBServiceConfig(
        ib_host=ib_host,
        ib_port=ib_port,
        ib_client_id=ib_client_id,
        ib_timeout=ib_timeout,
        max_connections=max_connections,
        data_cache_ttl=data_cache_ttl,
        rate_limit_requests_per_minute=rate_limit,
        _env_file=".env",
        _env_file_encoding="utf-8",
        _env_prefix="IB_",
        _case_sensitive=False
    )


# No global instance - each module should call get_config() when needed 