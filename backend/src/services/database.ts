import { Pool, PoolClient, QueryResult } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Database configuration from environment variables
const dbConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'tradingapp',
  password: process.env.POSTGRES_PASSWORD || 'tradingapp123',
  database: process.env.POSTGRES_DB || 'tradingapp',
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
};

// Create connection pool
const pool = new Pool(dbConfig);

// Test database connection
pool.on('connect', (client: PoolClient) => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err: Error, client: PoolClient) => {
  console.error('Unexpected error on idle client', err);
});

// Database service class
export class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = pool;
  }

  // Test database connection
  async testConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW()');
      client.release();
      console.log('Database connection test successful:', result.rows[0]);
      return true;
    } catch (error) {
      console.error('Database connection test failed:', error);
      return false;
    }
  }

  // Get a client from the pool
  async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  // Execute a query
  async query(text: string, params?: any[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(text, params);
      return result;
    } finally {
      client.release();
    }
  }

  // Execute a transaction
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Close the pool
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Export singleton instance
export const dbService = new DatabaseService();

export default dbService;
