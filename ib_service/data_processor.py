"""
Data processing pipeline with quality checks, transformation, and caching
"""

import asyncio
import pandas as pd
from typing import List, Dict, Optional, Tuple, Any
from datetime import datetime, timedelta
import structlog
from asyncio_throttle import Throttler
import hashlib
import pickle
from concurrent.futures import ThreadPoolExecutor
from ib_insync import BarData, Contract, Stock

from models import (
    CandlestickBar, HistoricalDataResponse, RealTimeQuote, 
    DataQualityMetrics, MarketDataRequest, safe_float, safe_int, 
    validate_price_data
)
from config import config


logger = structlog.get_logger(__name__)


class DataCache:
    """In-memory cache for market data with TTL"""
    
    def __init__(self):
        self.cache: Dict[str, Dict] = {}
        self.cleanup_task: Optional[asyncio.Task] = None
    
    def _generate_key(self, symbol: str, timeframe: str, period: str) -> str:
        """Generate cache key for market data request"""
        key_string = f"{symbol}:{timeframe}:{period}"
        return hashlib.md5(key_string.encode()).hexdigest()
    
    async def get(self, symbol: str, timeframe: str, period: str) -> Optional[HistoricalDataResponse]:
        """Get cached data if valid"""
        key = self._generate_key(symbol, timeframe, period)
        
        if key in self.cache:
            entry = self.cache[key]
            
            # Check TTL
            if datetime.utcnow() < entry['expires_at']:
                logger.debug("Cache hit", symbol=symbol, timeframe=timeframe, period=period)
                return entry['data']
            else:
                # Expired, remove from cache
                del self.cache[key]
                logger.debug("Cache expired", symbol=symbol, timeframe=timeframe, period=period)
        
        return None
    
    async def set(self, symbol: str, timeframe: str, period: str, data: HistoricalDataResponse):
        """Cache data with TTL"""
        key = self._generate_key(symbol, timeframe, period)
        expires_at = datetime.utcnow() + timedelta(seconds=config.data_cache_ttl)
        
        self.cache[key] = {
            'data': data,
            'expires_at': expires_at,
            'created_at': datetime.utcnow()
        }
        
        logger.debug("Data cached", symbol=symbol, timeframe=timeframe, period=period)
    
    async def invalidate(self, symbol: str, timeframe: Optional[str] = None, period: Optional[str] = None):
        """Invalidate cache entries for symbol"""
        to_remove = []
        
        for key, entry in self.cache.items():
            if symbol in key:
                if timeframe is None or timeframe in key:
                    if period is None or period in key:
                        to_remove.append(key)
        
        for key in to_remove:
            del self.cache[key]
        
        logger.debug("Cache invalidated", symbol=symbol, removed_entries=len(to_remove))
    
    async def cleanup_expired(self):
        """Remove expired entries from cache"""
        now = datetime.utcnow()
        to_remove = [
            key for key, entry in self.cache.items()
            if now >= entry['expires_at']
        ]
        
        for key in to_remove:
            del self.cache[key]
        
        if to_remove:
            logger.debug("Removed expired cache entries", count=len(to_remove))
    
    async def start_cleanup_task(self):
        """Start background cleanup task"""
        async def cleanup_loop():
            while True:
                try:
                    await asyncio.sleep(300)  # Cleanup every 5 minutes
                    await self.cleanup_expired()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error("Error in cache cleanup", error=str(e))
        
        self.cleanup_task = asyncio.create_task(cleanup_loop())
    
    async def stop_cleanup_task(self):
        """Stop background cleanup task"""
        if self.cleanup_task:
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass


class DataQualityChecker:
    """Data quality validation and metrics"""
    
    @staticmethod
    def validate_bar(bar_data: Any) -> Tuple[bool, Optional[CandlestickBar]]:
        """Validate a single candlestick bar"""
        try:
            # Extract data safely
            if hasattr(bar_data, 'date'):
                timestamp = int(bar_data.date.timestamp())
            else:
                timestamp = safe_int(getattr(bar_data, 'time', 0))
            
            open_price = safe_float(getattr(bar_data, 'open', 0))
            high = safe_float(getattr(bar_data, 'high', 0))
            low = safe_float(getattr(bar_data, 'low', 0))
            close = safe_float(getattr(bar_data, 'close', 0))
            volume = safe_int(getattr(bar_data, 'volume', 0))
            
            # Validate price relationships
            if not validate_price_data(open_price, high, low, close):
                return False, None
            
            # Create validated bar
            validated_bar = CandlestickBar(
                time=timestamp,
                open=open_price,
                high=high,
                low=low,
                close=close,
                volume=volume
            )
            
            return True, validated_bar
            
        except Exception as e:
            logger.warning("Bar validation failed", error=str(e), bar_data=str(bar_data))
            return False, None
    
    @staticmethod
    def analyze_data_quality(bars: List[CandlestickBar], symbol: str) -> DataQualityMetrics:
        """Analyze data quality and generate metrics"""
        total_bars = len(bars)
        valid_bars = 0
        invalid_bars = 0
        
        if total_bars == 0:
            return DataQualityMetrics(
                symbol=symbol,
                total_bars=0,
                valid_bars=0,
                invalid_bars=0,
                missing_data_percentage=100.0,
                data_quality_score=0.0
            )
        
        # Check for missing data (gaps in time series)
        missing_data_count = 0
        if len(bars) > 1:
            # Sort bars by time
            sorted_bars = sorted(bars, key=lambda x: x.time)
            
            for i in range(1, len(sorted_bars)):
                time_diff = sorted_bars[i].time - sorted_bars[i-1].time
                # Expected time difference based on timeframe would go here
                # For now, just check for large gaps (> 1 day)
                if time_diff > 86400:  # More than 1 day gap
                    missing_data_count += 1
        
        # Count valid bars (already validated if they're in the list)
        valid_bars = total_bars
        
        # Calculate quality metrics
        missing_data_percentage = (missing_data_count / total_bars) * 100 if total_bars > 0 else 0
        data_quality_score = max(0, 100 - missing_data_percentage)
        
        return DataQualityMetrics(
            symbol=symbol,
            total_bars=total_bars,
            valid_bars=valid_bars,
            invalid_bars=invalid_bars,
            missing_data_percentage=missing_data_percentage,
            data_quality_score=data_quality_score
        )


class DataTransformer:
    """Transform and normalize market data"""
    
    @staticmethod
    def ib_bars_to_candlesticks(ib_bars: List[BarData], symbol: str) -> List[CandlestickBar]:
        """Transform IB bar data to validated candlestick format"""
        validated_bars = []
        
        for bar in ib_bars:
            is_valid, validated_bar = DataQualityChecker.validate_bar(bar)
            if is_valid and validated_bar:
                validated_bars.append(validated_bar)
        
        logger.info("Transformed IB bars to candlesticks", 
                   symbol=symbol,
                   original_count=len(ib_bars),
                   validated_count=len(validated_bars))
        
        return validated_bars
    
    @staticmethod
    def apply_data_corrections(bars: List[CandlestickBar]) -> List[CandlestickBar]:
        """Apply data corrections and smoothing"""
        if len(bars) < 2:
            return bars
        
        corrected_bars = []
        
        for i, bar in enumerate(bars):
            corrected_bar = bar.copy()
            
            # Check for obvious data errors
            if i > 0:
                prev_bar = bars[i-1]
                
                # Check for unrealistic price jumps (>20%)
                price_change = abs(bar.close - prev_bar.close) / prev_bar.close
                if price_change > 0.2:
                    logger.warning("Large price jump detected", 
                                 previous_close=prev_bar.close,
                                 current_close=bar.close,
                                 change_percent=price_change * 100)
                    # Could apply smoothing here if needed
            
            corrected_bars.append(corrected_bar)
        
        return corrected_bars
    
    @staticmethod
    def resample_timeframe(bars: List[CandlestickBar], target_timeframe: str) -> List[CandlestickBar]:
        """Resample bars to different timeframe (if needed)"""
        # This would implement timeframe conversion logic
        # For now, return as-is
        return bars


class MarketDataProcessor:
    """Main data processing pipeline"""
    
    def __init__(self):
        self.cache = DataCache()
        self.throttler = Throttler(rate_limit=config.rate_limit_requests_per_minute, period=60)
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.quality_checker = DataQualityChecker()
        self.transformer = DataTransformer()
    
    async def initialize(self):
        """Initialize the data processor"""
        await self.cache.start_cleanup_task()
        logger.info("Data processor initialized")
    
    async def shutdown(self):
        """Shutdown the data processor"""
        await self.cache.stop_cleanup_task()
        self.executor.shutdown(wait=True)
        logger.info("Data processor shutdown complete")
    
    async def process_historical_data(
        self, 
        ib_bars: List[BarData], 
        request: MarketDataRequest
    ) -> HistoricalDataResponse:
        """Process historical data through the full pipeline"""
        
        # Apply rate limiting
        async with self.throttler:
            # Transform data
            candlestick_bars = await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.transformer.ib_bars_to_candlesticks,
                ib_bars,
                request.symbol
            )
            
            # Apply corrections
            corrected_bars = await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.transformer.apply_data_corrections,
                candlestick_bars
            )
            
            # Limit number of bars
            if len(corrected_bars) > config.max_historical_bars:
                corrected_bars = corrected_bars[-config.max_historical_bars:]
                logger.info("Limited historical bars", 
                           symbol=request.symbol,
                           original_count=len(candlestick_bars),
                           limited_count=len(corrected_bars))
            
            # Generate quality metrics
            quality_metrics = await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.quality_checker.analyze_data_quality,
                corrected_bars,
                request.symbol
            )
            
            # Create response
            response = HistoricalDataResponse(
                symbol=request.symbol,
                timeframe=request.timeframe,
                period=request.period,
                bars=corrected_bars,
                count=len(corrected_bars),
                source="Interactive Brokers"
            )
            
            # Cache the response
            period = request.period or "1Y"  # Default period if None
            await self.cache.set(request.symbol, request.timeframe, period, response)
            
            logger.info("Historical data processed",
                       symbol=request.symbol,
                       timeframe=request.timeframe,
                       period=request.period,
                       bars_count=len(corrected_bars),
                       quality_score=quality_metrics.data_quality_score)
            
            return response
    
    async def get_cached_data(self, request: MarketDataRequest) -> Optional[HistoricalDataResponse]:
        """Get cached historical data if available"""
        period = request.period or "1Y"  # Default period if None
        return await self.cache.get(request.symbol, request.timeframe, period)
    
    async def process_realtime_quote(self, ticker_data: Any, symbol: str) -> Optional[RealTimeQuote]:
        """Process real-time quote data"""
        try:
            quote = RealTimeQuote(
                symbol=symbol,
                bid=safe_float(getattr(ticker_data, 'bid', None)),
                ask=safe_float(getattr(ticker_data, 'ask', None)),
                last=safe_float(getattr(ticker_data, 'last', None)),
                bid_size=safe_int(getattr(ticker_data, 'bidSize', None)),
                ask_size=safe_int(getattr(ticker_data, 'askSize', None)),
                volume=safe_int(getattr(ticker_data, 'volume', None))
            )
            
            return quote
            
        except Exception as e:
            logger.error("Failed to process real-time quote", 
                        symbol=symbol, 
                        error=str(e))
            return None
    
    async def invalidate_cache(self, symbol: str, timeframe: Optional[str] = None):
        """Invalidate cache for symbol/timeframe"""
        await self.cache.invalidate(symbol, timeframe)


# Global data processor instance
data_processor = MarketDataProcessor() 