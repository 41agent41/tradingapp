import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL connection configuration
const postgresConfig: PoolConfig = {
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSL_MODE === 'require' ? {
    rejectUnauthorized: false,
    ca: process.env.POSTGRES_SSL_CA,
    cert: process.env.POSTGRES_SSL_CERT,
    key: process.env.POSTGRES_SSL_KEY,
  } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
};

// Create connection pool
export const postgresPool = new Pool(postgresConfig);

// Test database connection
export async function testPostgresConnection(): Promise<boolean> {
  try {
    const client = await postgresPool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    client.release();
    console.log('✅ PostgreSQL connection successful:', result.rows[0]);
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    return false;
  }
}

// Initialize database tables
export async function initializeDatabase(): Promise<void> {
  try {
    const client = await postgresPool.connect();
    
    // Create timeseries table for historical data
    await client.query(`
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
    `);

    // Create index for efficient queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_historical_data_symbol_timeframe 
      ON historical_data(symbol, timeframe, timestamp)
    `);

    // Create table for symbol metadata
    await client.query(`
      CREATE TABLE IF NOT EXISTS symbol_metadata (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL UNIQUE,
        sec_type VARCHAR(10) NOT NULL,
        exchange VARCHAR(20),
        currency VARCHAR(10),
        description TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create table for cache statistics
    await client.query(`
      CREATE TABLE IF NOT EXISTS cache_stats (
        id SERIAL PRIMARY KEY,
        cache_type VARCHAR(50) NOT NULL,
        hits BIGINT DEFAULT 0,
        misses BIGINT DEFAULT 0,
        size BIGINT DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    client.release();
    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// Store historical data
export async function storeHistoricalData(
  symbol: string,
  timeframe: string,
  data: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>
): Promise<void> {
  const client = await postgresPool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const bar of data) {
      await client.query(`
        INSERT INTO historical_data (symbol, timeframe, timestamp, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (symbol, timeframe, timestamp) 
        DO UPDATE SET 
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          created_at = CURRENT_TIMESTAMP
      `, [symbol, timeframe, bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume]);
    }
    
    await client.query('COMMIT');
    console.log(`✅ Stored ${data.length} historical data points for ${symbol} ${timeframe}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to store historical data:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Retrieve historical data
export async function getHistoricalData(
  symbol: string,
  timeframe: string,
  startTime?: number,
  endTime?: number,
  limit?: number
): Promise<Array<{
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>> {
  const client = await postgresPool.connect();
  
  try {
    let query = `
      SELECT timestamp, open, high, low, close, volume
      FROM historical_data
      WHERE symbol = $1 AND timeframe = $2
    `;
    
    const params: any[] = [symbol, timeframe];
    let paramIndex = 3;
    
    if (startTime) {
      query += ` AND timestamp >= $${paramIndex}`;
      params.push(startTime);
      paramIndex++;
    }
    
    if (endTime) {
      query += ` AND timestamp <= $${paramIndex}`;
      params.push(endTime);
      paramIndex++;
    }
    
    query += ` ORDER BY timestamp DESC`;
    
    if (limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(limit);
    }
    
    const result = await client.query(query, params);
    
    return result.rows.map(row => ({
      timestamp: parseInt(row.timestamp),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume)
    }));
  } catch (error) {
    console.error('❌ Failed to retrieve historical data:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Store symbol metadata
export async function storeSymbolMetadata(
  symbol: string,
  secType: string,
  exchange?: string,
  currency?: string,
  description?: string
): Promise<void> {
  const client = await postgresPool.connect();
  
  try {
    await client.query(`
      INSERT INTO symbol_metadata (symbol, sec_type, exchange, currency, description)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (symbol) 
      DO UPDATE SET 
        sec_type = EXCLUDED.sec_type,
        exchange = EXCLUDED.exchange,
        currency = EXCLUDED.currency,
        description = EXCLUDED.description,
        last_updated = CURRENT_TIMESTAMP
    `, [symbol, secType, exchange, currency, description]);
  } catch (error) {
    console.error('❌ Failed to store symbol metadata:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get symbol metadata
export async function getSymbolMetadata(symbol: string): Promise<{
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
  description?: string;
} | null> {
  const client = await postgresPool.connect();
  
  try {
    const result = await client.query(`
      SELECT symbol, sec_type, exchange, currency, description
      FROM symbol_metadata
      WHERE symbol = $1
    `, [symbol]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      symbol: row.symbol,
      secType: row.sec_type,
      exchange: row.exchange,
      currency: row.currency,
      description: row.description
    };
  } catch (error) {
    console.error('❌ Failed to get symbol metadata:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Update cache statistics
export async function updateCacheStats(
  cacheType: string,
  hits: number,
  misses: number,
  size: number
): Promise<void> {
  const client = await postgresPool.connect();
  
  try {
    await client.query(`
      INSERT INTO cache_stats (cache_type, hits, misses, size)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cache_type) 
      DO UPDATE SET 
        hits = cache_stats.hits + $2,
        misses = cache_stats.misses + $3,
        size = $4,
        last_updated = CURRENT_TIMESTAMP
    `, [cacheType, hits, misses, size]);
  } catch (error) {
    console.error('❌ Failed to update cache stats:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Graceful shutdown
export async function closePostgresConnection(): Promise<void> {
  await postgresPool.end();
  console.log('✅ PostgreSQL connection pool closed');
}