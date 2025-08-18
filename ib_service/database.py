"""
Database connection and operations for IB Service
Handles PostgreSQL timeseries database and Redis caching
"""

import os
import json
import logging
import asyncio
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime, timezone
import psycopg2
from psycopg2.extras import RealDictCursor
import redis.asyncio as redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

# Database configuration
POSTGRES_CONFIG = {
    'host': os.getenv('POSTGRES_HOST'),
    'port': int(os.getenv('POSTGRES_PORT', '5432')),
    'user': os.getenv('POSTGRES_USER'),
    'password': os.getenv('POSTGRES_PASSWORD'),
    'database': os.getenv('POSTGRES_DB'),
    'sslmode': os.getenv('POSTGRES_SSL_MODE', 'require'),
}

REDIS_CONFIG = {
    'host': os.getenv('REDIS_HOST'),
    'port': int(os.getenv('REDIS_PORT', '6379')),
    'password': os.getenv('REDIS_PASSWORD'),
    'db': int(os.getenv('REDIS_DB', '0')),
    'ssl': os.getenv('REDIS_SSL_ENABLED', 'false').lower() == 'true',
}

CACHE_CONFIG = {
    'TTL_HISTORICAL': int(os.getenv('CACHE_TTL_HISTORICAL', '3600')),
    'TTL_REALTIME': int(os.getenv('CACHE_TTL_REALTIME', '60')),
    'TTL_SYMBOLS': int(os.getenv('CACHE_TTL_SYMBOLS', '1800')),
    'MAX_SIZE': int(os.getenv('CACHE_MAX_SIZE', '10000')),
}

class DatabaseManager:
    """Manages PostgreSQL and Redis connections"""
    
    def __init__(self):
        self.postgres_pool = None
        self.redis_client = None
        self.cache_stats = {
            'historical': {'hits': 0, 'misses': 0, 'size': 0},
            'realtime': {'hits': 0, 'misses': 0, 'size': 0},
            'symbols': {'hits': 0, 'misses': 0, 'size': 0},
        }
    
    async def initialize(self) -> bool:
        """Initialize database connections"""
        try:
            logger.info("🔄 Initializing database connections...")
            
            # Initialize PostgreSQL
            postgres_success = await self._init_postgres()
            if postgres_success:
                logger.info("✅ PostgreSQL connection established")
            else:
                logger.warning("⚠️ PostgreSQL connection failed - continuing without database")
            
            # Initialize Redis
            redis_success = await self._init_redis()
            if redis_success:
                logger.info("✅ Redis connection established")
            else:
                logger.warning("⚠️ Redis connection failed - continuing without cache")
            
            return postgres_success or redis_success
            
        except Exception as e:
            logger.error(f"❌ Database initialization failed: {e}")
            return False
    
    async def _init_postgres(self) -> bool:
        """Initialize PostgreSQL connection"""
        try:
            if not all([POSTGRES_CONFIG['host'], POSTGRES_CONFIG['user'], POSTGRES_CONFIG['password']]):
                logger.warning("⚠️ PostgreSQL configuration incomplete")
                return False
            
            # Test connection
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            conn.close()
            
            # Initialize tables
            await self._init_postgres_tables()
            return True
            
        except Exception as e:
            logger.error(f"❌ PostgreSQL initialization failed: {e}")
            return False
    
    async def _init_postgres_tables(self):
        """Initialize PostgreSQL tables"""
        try:
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            cursor = conn.cursor()
            
            # Create historical data table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS historical_data (
                    id SERIAL PRIMARY KEY,
                    symbol VARCHAR(20) NOT NULL,
                    timeframe VARCHAR(10) NOT NULL,
                    timestamp BIGINT NOT NULL,
                    open DECIMAL(15,6) NOT NULL,
                    high DECIMAL(15,6) NOT NULL,
                    low DECIMAL(15,6) NOT NULL,
                    close DECIMAL(15,6) NOT NULL,
                    volume BIGINT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(symbol, timeframe, timestamp)
                )
            """)
            
            # Create index
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_historical_data_symbol_timeframe 
                ON historical_data(symbol, timeframe, timestamp)
            """)
            
            # Create symbol metadata table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS symbol_metadata (
                    id SERIAL PRIMARY KEY,
                    symbol VARCHAR(20) NOT NULL UNIQUE,
                    sec_type VARCHAR(10) NOT NULL,
                    exchange VARCHAR(20),
                    currency VARCHAR(10),
                    description TEXT,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            conn.commit()
            cursor.close()
            conn.close()
            
            logger.info("✅ PostgreSQL tables initialized")
            
        except Exception as e:
            logger.error(f"❌ PostgreSQL table initialization failed: {e}")
    
    async def _init_redis(self) -> bool:
        """Initialize Redis connection"""
        try:
            if not REDIS_CONFIG['host']:
                logger.warning("⚠️ Redis configuration incomplete")
                return False
            
            self.redis_client = redis.Redis(
                host=REDIS_CONFIG['host'],
                port=REDIS_CONFIG['port'],
                password=REDIS_CONFIG['password'],
                db=REDIS_CONFIG['db'],
                ssl=REDIS_CONFIG['ssl'],
                decode_responses=True,
                retry_on_timeout=True,
                health_check_interval=30
            )
            
            # Test connection
            await self.redis_client.ping()
            return True
            
        except Exception as e:
            logger.error(f"❌ Redis initialization failed: {e}")
            return False
    
    async def test_connections(self) -> Dict[str, bool]:
        """Test database connections"""
        results = {}
        
        # Test PostgreSQL
        try:
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            conn.close()
            results['postgres'] = True
        except Exception as e:
            logger.error(f"❌ PostgreSQL connection test failed: {e}")
            results['postgres'] = False
        
        # Test Redis
        try:
            if self.redis_client:
                await self.redis_client.ping()
                results['redis'] = True
            else:
                results['redis'] = False
        except Exception as e:
            logger.error(f"❌ Redis connection test failed: {e}")
            results['redis'] = False
        
        return results
    
    # PostgreSQL Operations
    async def store_historical_data(
        self, 
        symbol: str, 
        timeframe: str, 
        data: List[Dict[str, Any]]
    ) -> bool:
        """Store historical data in PostgreSQL"""
        try:
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            cursor = conn.cursor()
            
            for bar in data:
                cursor.execute("""
                    INSERT INTO historical_data (symbol, timeframe, timestamp, open, high, low, close, volume)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (symbol, timeframe, timestamp) 
                    DO UPDATE SET 
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        volume = EXCLUDED.volume,
                        created_at = CURRENT_TIMESTAMP
                """, (
                    symbol, timeframe, bar['timestamp'], 
                    bar['open'], bar['high'], bar['low'], 
                    bar['close'], bar['volume']
                ))
            
            conn.commit()
            cursor.close()
            conn.close()
            
            logger.info(f"✅ Stored {len(data)} historical data points for {symbol} {timeframe}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to store historical data: {e}")
            return False
    
    async def get_historical_data(
        self, 
        symbol: str, 
        timeframe: str, 
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Retrieve historical data from PostgreSQL"""
        try:
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            cursor = conn.cursor(cursor_factory=RealDictCursor)
            
            query = """
                SELECT timestamp, open, high, low, close, volume
                FROM historical_data
                WHERE symbol = %s AND timeframe = %s
            """
            params = [symbol, timeframe]
            
            if start_time:
                query += " AND timestamp >= %s"
                params.append(start_time)
            
            if end_time:
                query += " AND timestamp <= %s"
                params.append(end_time)
            
            query += " ORDER BY timestamp DESC"
            
            if limit:
                query += " LIMIT %s"
                params.append(limit)
            
            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            cursor.close()
            conn.close()
            
            return [dict(row) for row in rows]
            
        except Exception as e:
            logger.error(f"❌ Failed to retrieve historical data: {e}")
            return []
    
    async def store_symbol_metadata(
        self, 
        symbol: str, 
        sec_type: str, 
        exchange: Optional[str] = None,
        currency: Optional[str] = None,
        description: Optional[str] = None
    ) -> bool:
        """Store symbol metadata in PostgreSQL"""
        try:
            conn = psycopg2.connect(**POSTGRES_CONFIG)
            cursor = conn.cursor()
            
            cursor.execute("""
                INSERT INTO symbol_metadata (symbol, sec_type, exchange, currency, description)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (symbol) 
                DO UPDATE SET 
                    sec_type = EXCLUDED.sec_type,
                    exchange = EXCLUDED.exchange,
                    currency = EXCLUDED.currency,
                    description = EXCLUDED.description,
                    last_updated = CURRENT_TIMESTAMP
            """, (symbol, sec_type, exchange, currency, description))
            
            conn.commit()
            cursor.close()
            conn.close()
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to store symbol metadata: {e}")
            return False
    
    # Redis Operations
    def _generate_cache_key(self, cache_type: str, *parts: str) -> str:
        """Generate cache key"""
        return f"tradingapp:{cache_type}:{':'.join(parts)}"
    
    async def cache_historical_data(
        self, 
        symbol: str, 
        timeframe: str, 
        data: List[Dict[str, Any]],
        ttl: int = CACHE_CONFIG['TTL_HISTORICAL']
    ) -> bool:
        """Cache historical data in Redis"""
        try:
            if not self.redis_client:
                return False
            
            key = self._generate_cache_key('historical', symbol, timeframe)
            await self.redis_client.setex(key, ttl, json.dumps(data))
            
            self.cache_stats['historical']['size'] = await self.redis_client.dbsize()
            logger.info(f"✅ Cached historical data for {symbol} {timeframe}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to cache historical data: {e}")
            return False
    
    async def get_cached_historical_data(
        self, 
        symbol: str, 
        timeframe: str
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached historical data from Redis"""
        try:
            if not self.redis_client:
                return None
            
            key = self._generate_cache_key('historical', symbol, timeframe)
            cached = await self.redis_client.get(key)
            
            if cached:
                self.cache_stats['historical']['hits'] += 1
                logger.info(f"✅ Cache hit for historical data: {symbol} {timeframe}")
                return json.loads(cached)
            else:
                self.cache_stats['historical']['misses'] += 1
                logger.info(f"❌ Cache miss for historical data: {symbol} {timeframe}")
                return None
                
        except Exception as e:
            logger.error(f"❌ Failed to get cached historical data: {e}")
            self.cache_stats['historical']['misses'] += 1
            return None
    
    async def cache_realtime_data(
        self, 
        symbol: str, 
        data: Dict[str, Any],
        ttl: int = CACHE_CONFIG['TTL_REALTIME']
    ) -> bool:
        """Cache real-time data in Redis"""
        try:
            if not self.redis_client:
                return False
            
            key = self._generate_cache_key('realtime', symbol)
            await self.redis_client.setex(key, ttl, json.dumps(data))
            
            self.cache_stats['realtime']['size'] = await self.redis_client.dbsize()
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to cache real-time data: {e}")
            return False
    
    async def get_cached_realtime_data(self, symbol: str) -> Optional[Dict[str, Any]]:
        """Get cached real-time data from Redis"""
        try:
            if not self.redis_client:
                return None
            
            key = self._generate_cache_key('realtime', symbol)
            cached = await self.redis_client.get(key)
            
            if cached:
                self.cache_stats['realtime']['hits'] += 1
                return json.loads(cached)
            else:
                self.cache_stats['realtime']['misses'] += 1
                return None
                
        except Exception as e:
            logger.error(f"❌ Failed to get cached real-time data: {e}")
            self.cache_stats['realtime']['misses'] += 1
            return None
    
    async def cache_symbol_search(
        self, 
        search_key: str, 
        results: List[Dict[str, Any]],
        ttl: int = CACHE_CONFIG['TTL_SYMBOLS']
    ) -> bool:
        """Cache symbol search results in Redis"""
        try:
            if not self.redis_client:
                return False
            
            key = self._generate_cache_key('symbols', search_key)
            await self.redis_client.setex(key, ttl, json.dumps(results))
            
            self.cache_stats['symbols']['size'] = await self.redis_client.dbsize()
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to cache symbol search: {e}")
            return False
    
    async def get_cached_symbol_search(self, search_key: str) -> Optional[List[Dict[str, Any]]]:
        """Get cached symbol search results from Redis"""
        try:
            if not self.redis_client:
                return None
            
            key = self._generate_cache_key('symbols', search_key)
            cached = await self.redis_client.get(key)
            
            if cached:
                self.cache_stats['symbols']['hits'] += 1
                return json.loads(cached)
            else:
                self.cache_stats['symbols']['misses'] += 1
                return None
                
        except Exception as e:
            logger.error(f"❌ Failed to get cached symbol search: {e}")
            self.cache_stats['symbols']['misses'] += 1
            return None
    
    async def clear_cache(self, pattern: str = "tradingapp:*") -> int:
        """Clear cache by pattern"""
        try:
            if not self.redis_client:
                return 0
            
            keys = await self.redis_client.keys(pattern)
            if keys:
                await self.redis_client.delete(*keys)
                logger.info(f"✅ Cleared {len(keys)} cache entries matching pattern: {pattern}")
                return len(keys)
            return 0
            
        except Exception as e:
            logger.error(f"❌ Failed to clear cache: {e}")
            return 0
    
    async def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        try:
            if not self.redis_client:
                return {
                    'historical': {'hits': 0, 'misses': 0, 'size': 0},
                    'realtime': {'hits': 0, 'misses': 0, 'size': 0},
                    'symbols': {'hits': 0, 'misses': 0, 'size': 0},
                    'total_size': 0,
                    'hit_rate': 0,
                }
            
            total_size = await self.redis_client.dbsize()
            
            # Calculate hit rates
            total_hits = sum(stats['hits'] for stats in self.cache_stats.values())
            total_misses = sum(stats['misses'] for stats in self.cache_stats.values())
            overall_hit_rate = total_hits / (total_hits + total_misses) if (total_hits + total_misses) > 0 else 0
            
            return {
                'historical': {**self.cache_stats['historical'], 'size': total_size},
                'realtime': {**self.cache_stats['realtime'], 'size': total_size},
                'symbols': {**self.cache_stats['symbols'], 'size': total_size},
                'total_size': total_size,
                'hit_rate': overall_hit_rate,
            }
            
        except Exception as e:
            logger.error(f"❌ Failed to get cache statistics: {e}")
            return {
                'historical': {'hits': 0, 'misses': 0, 'size': 0},
                'realtime': {'hits': 0, 'misses': 0, 'size': 0},
                'symbols': {'hits': 0, 'misses': 0, 'size': 0},
                'total_size': 0,
                'hit_rate': 0,
            }
    
    async def close(self):
        """Close database connections"""
        try:
            if self.redis_client:
                await self.redis_client.close()
                logger.info("✅ Redis connection closed")
        except Exception as e:
            logger.error(f"❌ Error closing Redis connection: {e}")

# Global database manager instance
db_manager = DatabaseManager()