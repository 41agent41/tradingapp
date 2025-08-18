import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

// Redis client configuration
const redisConfig = {
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  password: process.env.REDIS_PASSWORD || undefined,
  database: parseInt(process.env.REDIS_DB || '0'),
  retry_strategy: (options: any) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      // End reconnecting on a specific error and flush all commands with a individual error
      return new Error('The server refused the connection');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      // End reconnecting after a specific timeout and flush all commands with a individual error
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      // End reconnecting with built in error
      return undefined;
    }
    // Reconnect after
    return Math.min(options.attempt * 100, 3000);
  }
};

// Create Redis client
export const redisClient: RedisClientType = createClient(redisConfig);

// Cache configuration
export const CACHE_CONFIG = {
  TTL_HISTORICAL: parseInt(process.env.CACHE_TTL_HISTORICAL || '3600'), // 1 hour
  TTL_REALTIME: parseInt(process.env.CACHE_TTL_REALTIME || '60'), // 1 minute
  TTL_SYMBOLS: parseInt(process.env.CACHE_TTL_SYMBOLS || '1800'), // 30 minutes
  MAX_SIZE: parseInt(process.env.CACHE_MAX_SIZE || '10000'),
};

// Cache statistics
let cacheStats = {
  historical: { hits: 0, misses: 0, size: 0 },
  realtime: { hits: 0, misses: 0, size: 0 },
  symbols: { hits: 0, misses: 0, size: 0 },
};

// Initialize Redis connection
export async function initializeRedis(): Promise<void> {
  try {
    await redisClient.connect();
    console.log('✅ Redis connection established');
    
    // Test connection
    await redisClient.ping();
    console.log('✅ Redis ping successful');
  } catch (error) {
    console.error('❌ Redis connection failed:', error);
    throw error;
  }
}

// Test Redis connection
export async function testRedisConnection(): Promise<boolean> {
  try {
    await redisClient.ping();
    console.log('✅ Redis connection test successful');
    return true;
  } catch (error) {
    console.error('❌ Redis connection test failed:', error);
    return false;
  }
}

// Generate cache keys
export function generateCacheKey(type: string, ...parts: string[]): string {
  return `tradingapp:${type}:${parts.join(':')}`;
}

// Cache historical data
export async function cacheHistoricalData(
  symbol: string,
  timeframe: string,
  data: any[],
  ttl: number = CACHE_CONFIG.TTL_HISTORICAL
): Promise<void> {
  try {
    const key = generateCacheKey('historical', symbol, timeframe);
    await redisClient.setEx(key, ttl, JSON.stringify(data));
    
    // Update cache statistics
    cacheStats.historical.size = await redisClient.dbSize();
    console.log(`✅ Cached historical data for ${symbol} ${timeframe}`);
  } catch (error) {
    console.error('❌ Failed to cache historical data:', error);
  }
}

// Get cached historical data
export async function getCachedHistoricalData(
  symbol: string,
  timeframe: string
): Promise<any[] | null> {
  try {
    const key = generateCacheKey('historical', symbol, timeframe);
    const cached = await redisClient.get(key);
    
    if (cached) {
      cacheStats.historical.hits++;
      console.log(`✅ Cache hit for historical data: ${symbol} ${timeframe}`);
      return JSON.parse(cached);
    } else {
      cacheStats.historical.misses++;
      console.log(`❌ Cache miss for historical data: ${symbol} ${timeframe}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to get cached historical data:', error);
    cacheStats.historical.misses++;
    return null;
  }
}

// Cache real-time data
export async function cacheRealtimeData(
  symbol: string,
  data: any,
  ttl: number = CACHE_CONFIG.TTL_REALTIME
): Promise<void> {
  try {
    const key = generateCacheKey('realtime', symbol);
    await redisClient.setEx(key, ttl, JSON.stringify(data));
    
    // Update cache statistics
    cacheStats.realtime.size = await redisClient.dbSize();
  } catch (error) {
    console.error('❌ Failed to cache real-time data:', error);
  }
}

// Get cached real-time data
export async function getCachedRealtimeData(symbol: string): Promise<any | null> {
  try {
    const key = generateCacheKey('realtime', symbol);
    const cached = await redisClient.get(key);
    
    if (cached) {
      cacheStats.realtime.hits++;
      return JSON.parse(cached);
    } else {
      cacheStats.realtime.misses++;
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to get cached real-time data:', error);
    cacheStats.realtime.misses++;
    return null;
  }
}

// Cache symbol search results
export async function cacheSymbolSearch(
  searchKey: string,
  results: any[],
  ttl: number = CACHE_CONFIG.TTL_SYMBOLS
): Promise<void> {
  try {
    const key = generateCacheKey('symbols', searchKey);
    await redisClient.setEx(key, ttl, JSON.stringify(results));
    
    // Update cache statistics
    cacheStats.symbols.size = await redisClient.dbSize();
  } catch (error) {
    console.error('❌ Failed to cache symbol search:', error);
  }
}

// Get cached symbol search results
export async function getCachedSymbolSearch(searchKey: string): Promise<any[] | null> {
  try {
    const key = generateCacheKey('symbols', searchKey);
    const cached = await redisClient.get(key);
    
    if (cached) {
      cacheStats.symbols.hits++;
      return JSON.parse(cached);
    } else {
      cacheStats.symbols.misses++;
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to get cached symbol search:', error);
    cacheStats.symbols.misses++;
    return null;
  }
}

// Clear cache by pattern
export async function clearCache(pattern: string): Promise<number> {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`✅ Cleared ${keys.length} cache entries matching pattern: ${pattern}`);
      return keys.length;
    }
    return 0;
  } catch (error) {
    console.error('❌ Failed to clear cache:', error);
    return 0;
  }
}

// Clear all cache
export async function clearAllCache(): Promise<number> {
  try {
    const keys = await redisClient.keys('tradingapp:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`✅ Cleared all cache: ${keys.length} entries`);
      
      // Reset cache statistics
      cacheStats = {
        historical: { hits: 0, misses: 0, size: 0 },
        realtime: { hits: 0, misses: 0, size: 0 },
        symbols: { hits: 0, misses: 0, size: 0 },
      };
      
      return keys.length;
    }
    return 0;
  } catch (error) {
    console.error('❌ Failed to clear all cache:', error);
    return 0;
  }
}

// Get cache statistics
export async function getCacheStats(): Promise<{
  historical: { hits: number; misses: number; size: number };
  realtime: { hits: number; misses: number; size: number };
  symbols: { hits: number; misses: number; size: number };
  total_size: number;
  hit_rate: number;
}> {
  try {
    const totalSize = await redisClient.dbSize();
    
    // Calculate hit rates
    const historicalHitRate = cacheStats.historical.hits + cacheStats.historical.misses > 0 
      ? cacheStats.historical.hits / (cacheStats.historical.hits + cacheStats.historical.misses) 
      : 0;
    
    const realtimeHitRate = cacheStats.realtime.hits + cacheStats.realtime.misses > 0 
      ? cacheStats.realtime.hits / (cacheStats.realtime.hits + cacheStats.realtime.misses) 
      : 0;
    
    const symbolsHitRate = cacheStats.symbols.hits + cacheStats.symbols.misses > 0 
      ? cacheStats.symbols.hits / (cacheStats.symbols.hits + cacheStats.symbols.misses) 
      : 0;
    
    const totalHits = cacheStats.historical.hits + cacheStats.realtime.hits + cacheStats.symbols.hits;
    const totalMisses = cacheStats.historical.misses + cacheStats.realtime.misses + cacheStats.symbols.misses;
    const overallHitRate = totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0;
    
    return {
      historical: { ...cacheStats.historical, size: totalSize },
      realtime: { ...cacheStats.realtime, size: totalSize },
      symbols: { ...cacheStats.symbols, size: totalSize },
      total_size: totalSize,
      hit_rate: overallHitRate,
    };
  } catch (error) {
    console.error('❌ Failed to get cache statistics:', error);
    return {
      historical: { hits: 0, misses: 0, size: 0 },
      realtime: { hits: 0, misses: 0, size: 0 },
      symbols: { hits: 0, misses: 0, size: 0 },
      total_size: 0,
      hit_rate: 0,
    };
  }
}

// Cache management utilities
export async function getCacheKeys(pattern: string = 'tradingapp:*'): Promise<string[]> {
  try {
    return await redisClient.keys(pattern);
  } catch (error) {
    console.error('❌ Failed to get cache keys:', error);
    return [];
  }
}

export async function getCacheSize(): Promise<number> {
  try {
    return await redisClient.dbSize();
  } catch (error) {
    console.error('❌ Failed to get cache size:', error);
    return 0;
  }
}

// Graceful shutdown
export async function closeRedisConnection(): Promise<void> {
  try {
    await redisClient.quit();
    console.log('✅ Redis connection closed');
  } catch (error) {
    console.error('❌ Error closing Redis connection:', error);
  }
}

// Event handlers for Redis client
redisClient.on('error', (err) => {
  console.error('❌ Redis client error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Redis client connected');
});

redisClient.on('ready', () => {
  console.log('✅ Redis client ready');
});

redisClient.on('end', () => {
  console.log('ℹ️ Redis client connection ended');
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis client reconnecting...');
});