"""
Pydantic models for data validation and schemas
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Union
from datetime import datetime
from decimal import Decimal
import math


class MarketDataRequest(BaseModel):
    """Request model for market data"""
    symbol: str = Field(..., min_length=1, max_length=10, description="Stock symbol")
    timeframe: str = Field(..., description="Timeframe for data")
    period: Optional[str] = Field(default="1Y", description="Period for historical data")
    
    @validator('symbol')
    def validate_symbol(cls, v):
        return v.upper().strip()
    
    @validator('timeframe')
    def validate_timeframe(cls, v):
        valid_timeframes = ['tick', '5min', '15min', '30min', '1hour', '4hour', '8hour', '1day', '1week', '1month']
        if v not in valid_timeframes:
            raise ValueError(f'Timeframe must be one of: {valid_timeframes}')
        return v


class CandlestickBar(BaseModel):
    """Validated candlestick bar data"""
    time: int = Field(..., description="Unix timestamp")
    open: float = Field(..., gt=0, description="Opening price")
    high: float = Field(..., gt=0, description="High price")
    low: float = Field(..., gt=0, description="Low price")
    close: float = Field(..., gt=0, description="Closing price")
    volume: int = Field(default=0, ge=0, description="Volume")
    
    @validator('high')
    def validate_high(cls, v, values):
        if 'low' in values and v < values['low']:
            raise ValueError('High price must be >= low price')
        return v
    
    @validator('open', 'close')
    def validate_prices(cls, v, values):
        if 'high' in values and v > values['high']:
            raise ValueError('Open/Close prices must be <= high price')
        if 'low' in values and v < values['low']:
            raise ValueError('Open/Close prices must be >= low price')
        return v


class RealTimeQuote(BaseModel):
    """Real-time market quote data"""
    symbol: str = Field(..., description="Stock symbol")
    bid: Optional[float] = Field(default=None, gt=0, description="Bid price")
    ask: Optional[float] = Field(default=None, gt=0, description="Ask price")
    last: Optional[float] = Field(default=None, gt=0, description="Last traded price")
    bid_size: Optional[int] = Field(default=None, ge=0, description="Bid size")
    ask_size: Optional[int] = Field(default=None, ge=0, description="Ask size")
    volume: Optional[int] = Field(default=None, ge=0, description="Total volume")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Quote timestamp")
    
    @validator('ask')
    def validate_ask(cls, v, values):
        if v is not None and 'bid' in values and values['bid'] is not None and v < values['bid']:
            raise ValueError('Ask price must be >= bid price')
        return v


class AccountSummary(BaseModel):
    """Account summary information"""
    account_id: str = Field(..., description="Account identifier")
    net_liquidation: float = Field(default=0.0, description="Net liquidation value")
    total_cash: float = Field(default=0.0, description="Total cash value")
    settled_cash: float = Field(default=0.0, description="Settled cash")
    accrued_cash: float = Field(default=0.0, description="Accrued cash")
    buying_power: float = Field(default=0.0, description="Buying power")
    equity_with_loan: float = Field(default=0.0, description="Equity with loan value")
    previous_day_equity: float = Field(default=0.0, description="Previous day equity")
    gross_position_value: float = Field(default=0.0, description="Gross position value")
    currency: str = Field(default="USD", description="Account currency")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Data timestamp")


class Position(BaseModel):
    """Position information"""
    symbol: str = Field(..., description="Position symbol")
    position: float = Field(..., description="Position size")
    market_price: float = Field(default=0.0, description="Current market price")
    market_value: float = Field(default=0.0, description="Current market value")
    average_cost: float = Field(default=0.0, description="Average cost")
    unrealized_pnl: float = Field(default=0.0, description="Unrealized P&L")
    realized_pnl: float = Field(default=0.0, description="Realized P&L")
    currency: str = Field(default="USD", description="Position currency")
    
    @validator('market_value')
    def calculate_market_value(cls, v, values):
        if 'position' in values and 'market_price' in values:
            return values['position'] * values['market_price']
        return v


class Order(BaseModel):
    """Order information"""
    order_id: int = Field(..., description="Order ID")
    symbol: str = Field(..., description="Order symbol")
    action: str = Field(..., description="Order action (BUY/SELL)")
    quantity: float = Field(..., gt=0, description="Order quantity")
    order_type: str = Field(..., description="Order type")
    limit_price: Optional[float] = Field(default=None, description="Limit price")
    stop_price: Optional[float] = Field(default=None, description="Stop price")
    status: str = Field(..., description="Order status")
    filled: float = Field(default=0.0, ge=0, description="Filled quantity")
    remaining: float = Field(default=0.0, ge=0, description="Remaining quantity")
    avg_fill_price: Optional[float] = Field(default=None, description="Average fill price")
    
    @validator('action')
    def validate_action(cls, v):
        valid_actions = ['BUY', 'SELL']
        if v.upper() not in valid_actions:
            raise ValueError(f'Action must be one of: {valid_actions}')
        return v.upper()


class HistoricalDataResponse(BaseModel):
    """Response model for historical data"""
    symbol: str = Field(..., description="Requested symbol")
    timeframe: str = Field(..., description="Requested timeframe")
    period: str = Field(..., description="Requested period")
    bars: List[CandlestickBar] = Field(default=[], description="Historical bars")
    count: int = Field(..., ge=0, description="Number of bars returned")
    source: str = Field(default="Interactive Brokers", description="Data source")
    last_updated: datetime = Field(default_factory=datetime.utcnow, description="Last update time")
    
    @validator('count')
    def validate_count(cls, v, values):
        if 'bars' in values and v != len(values['bars']):
            return len(values['bars'])
        return v


class ConnectionStatus(BaseModel):
    """IB Gateway connection status"""
    connected: bool = Field(..., description="Connection status")
    host: str = Field(..., description="IB Gateway host")
    port: int = Field(..., description="IB Gateway port")
    client_id: int = Field(..., description="Client ID")
    last_error: Optional[str] = Field(default=None, description="Last error message")
    connection_time: Optional[datetime] = Field(default=None, description="Connection timestamp")
    last_heartbeat: Optional[datetime] = Field(default=None, description="Last heartbeat timestamp")


class HealthStatus(BaseModel):
    """Service health status"""
    status: str = Field(..., description="Overall health status")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Health check time")
    services: Dict[str, Any] = Field(default={}, description="Individual service statuses")
    uptime_seconds: float = Field(..., ge=0, description="Service uptime in seconds")
    version: str = Field(default="1.0.0", description="Service version")


class ErrorResponse(BaseModel):
    """Standardized error response"""
    error: str = Field(..., description="Error message")
    detail: Optional[str] = Field(default=None, description="Detailed error information")
    error_code: Optional[str] = Field(default=None, description="Error code")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Error timestamp")
    request_id: Optional[str] = Field(default=None, description="Request correlation ID")


class SubscriptionRequest(BaseModel):
    """Market data subscription request"""
    symbol: str = Field(..., min_length=1, max_length=10, description="Symbol to subscribe to")
    timeframe: str = Field(default="tick", description="Data timeframe")
    
    @validator('symbol')
    def validate_symbol(cls, v):
        return v.upper().strip()


class DataQualityMetrics(BaseModel):
    """Data quality metrics for monitoring"""
    symbol: str = Field(..., description="Symbol")
    total_bars: int = Field(..., ge=0, description="Total number of bars")
    valid_bars: int = Field(..., ge=0, description="Number of valid bars")
    invalid_bars: int = Field(..., ge=0, description="Number of invalid bars")
    missing_data_percentage: float = Field(..., ge=0, le=100, description="Percentage of missing data")
    data_quality_score: float = Field(..., ge=0, le=100, description="Overall data quality score")
    last_check: datetime = Field(default_factory=datetime.utcnow, description="Last quality check")
    
    @validator('data_quality_score')
    def calculate_quality_score(cls, v, values):
        if 'total_bars' in values and 'valid_bars' in values and values['total_bars'] > 0:
            return (values['valid_bars'] / values['total_bars']) * 100
        return 0.0


def safe_float(value: Any, default: float = 0.0) -> float:
    """Safely convert value to float with validation"""
    if value is None or value == '' or str(value).lower() in ['nan', 'none', 'null']:
        return default
    
    try:
        result = float(value)
        if math.isnan(result) or math.isinf(result):
            return default
        return result
    except (ValueError, TypeError, OverflowError):
        return default


def safe_int(value: Any, default: int = 0) -> int:
    """Safely convert value to integer with validation"""
    if value is None or value == '':
        return default
    
    try:
        return int(float(value))
    except (ValueError, TypeError, OverflowError):
        return default


def validate_price_data(open_price: float, high: float, low: float, close: float) -> bool:
    """Validate OHLC price data relationships"""
    try:
        # Check for valid positive prices
        if any(price <= 0 for price in [open_price, high, low, close]):
            return False
        
        # Check high is highest
        if high < max(open_price, close, low):
            return False
        
        # Check low is lowest
        if low > min(open_price, close, high):
            return False
        
        # Check reasonable price relationships (no single bar with >50% price change)
        max_price = max(open_price, high, low, close)
        min_price = min(open_price, high, low, close)
        if (max_price - min_price) / min_price > 0.5:  # 50% change threshold
            return False
        
        return True
    except (ValueError, TypeError, ZeroDivisionError):
        return False 