# TimescaleDB Setup Guide for TradingApp

This guide provides step-by-step instructions for setting up a remote PostgreSQL database with TimescaleDB extension for streaming historical market data.

## 🎯 Overview

TimescaleDB is a time-series database built on PostgreSQL that provides:
- **Automatic partitioning** of time-series data into chunks
- **Continuous aggregates** for pre-computed analytics
- **Automated data retention** policies
- **High-performance queries** on large datasets
- **Full SQL compatibility** with PostgreSQL

## 🏗️ Architecture Benefits

### For Trading Data Streaming:
- **Hypertables**: Automatic partitioning by time for optimal performance
- **Continuous Aggregates**: Pre-computed daily/hourly summaries
- **Retention Policies**: Automated cleanup of old data
- **Time-zone Support**: TIMESTAMPTZ for global trading data
- **Compression**: Automatic compression of older data chunks

## 🚀 Deployment Options

### Option 1: TimescaleDB Cloud (Recommended)
```bash
# Sign up at https://cloud.timescale.com/
# Create a new service with:
# - PostgreSQL 15+
# - TimescaleDB extension enabled
# - Appropriate instance size for your data volume
```

### Option 2: Self-Hosted TimescaleDB
```bash
# Using Docker
docker run -d \
  --name timescaledb \
  -e POSTGRES_PASSWORD=your_password \
  -e POSTGRES_DB=tradingapp \
  -p 5432:5432 \
  timescale/timescaledb:latest-pg15

# Or using TimescaleDB Docker image
docker run -d \
  --name timescaledb \
  -e POSTGRES_PASSWORD=your_password \
  -e POSTGRES_DB=tradingapp \
  -p 5432:5432 \
  timescale/timescaledb-ha:pg15-latest
```

### Option 3: Managed Services
- **AWS RDS**: Use PostgreSQL with TimescaleDB extension
- **Google Cloud SQL**: PostgreSQL with TimescaleDB
- **Azure Database**: PostgreSQL with TimescaleDB
- **DigitalOcean**: Managed TimescaleDB

## 📋 Prerequisites

### System Requirements
- **PostgreSQL**: 13+ (15+ recommended)
- **TimescaleDB**: 2.8+ (latest recommended)
- **Memory**: 4GB+ RAM (8GB+ for production)
- **Storage**: SSD recommended for time-series data
- **Network**: Low latency connection for real-time data

### Database User Permissions
```sql
-- Create dedicated user for TradingApp
CREATE USER tradingapp WITH PASSWORD 'your_secure_password';
CREATE DATABASE tradingapp OWNER tradingapp;
GRANT ALL PRIVILEGES ON DATABASE tradingapp TO tradingapp;
```

## 🔧 Installation Steps

### Step 1: Database Setup
```bash
# Connect to your PostgreSQL instance
psql -h YOUR_DB_HOST -U postgres -d tradingapp

# Or if using TimescaleDB Cloud, use the provided connection string
psql "postgresql://tradingapp:password@host:port/tradingapp?sslmode=require"
```

### Step 2: Run TimescaleDB Schema
```bash
# Execute the TimescaleDB-optimized schema
psql -h YOUR_DB_HOST -U tradingapp -d tradingapp -f backend/src/database/timescaledb-schema.sql
```

### Step 3: Verify Installation
```sql
-- Check TimescaleDB extension
SELECT * FROM pg_extension WHERE extname = 'timescaledb';

-- Verify hypertables
SELECT * FROM timescaledb_information.hypertables;

-- Check continuous aggregates
SELECT * FROM timescaledb_information.continuous_aggregates;

-- Verify retention policies
SELECT * FROM timescaledb_information.policies;
```

## ⚙️ Configuration

### Environment Variables
Update your `.env` file with TimescaleDB connection details:

```bash
# TimescaleDB Configuration
POSTGRES_HOST=your-timescaledb-host.com
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=tradingapp
POSTGRES_SSL=true

# For TimescaleDB Cloud, use the full connection string
# POSTGRES_URL=postgresql://tradingapp:password@host:port/tradingapp?sslmode=require
```

### Docker Compose Update
```yaml
# Add to your docker-compose.yml
services:
  backend:
    environment:
      - POSTGRES_HOST=${POSTGRES_HOST}
      - POSTGRES_PORT=${POSTGRES_PORT}
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=${POSTGRES_DB}
      - POSTGRES_SSL=${POSTGRES_SSL}
```

## 📊 Schema Features

### Hypertables
- **candlestick_data**: 1-day chunks for OHLCV data
- **tick_data**: 1-hour chunks for high-frequency data
- **technical_indicators**: 1-day chunks for calculated indicators

### Continuous Aggregates
- **daily_candlestick_data**: Pre-computed daily summaries
- **hourly_candlestick_data**: Pre-computed hourly summaries

### Retention Policies
- **Candlestick data**: 2 years retention
- **Tick data**: 30 days retention
- **Technical indicators**: 2 years retention

### Optimized Indexes
- Time-based indexes for fast queries
- Composite indexes for multi-column filters
- TimescaleDB-specific index optimizations

## 🔍 Performance Monitoring

### Query Performance
```sql
-- Check query performance
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM candlestick_data 
WHERE contract_id = 1 
AND timestamp >= NOW() - INTERVAL '1 day'
ORDER BY timestamp DESC;
```

### Chunk Information
```sql
-- View chunk information
SELECT * FROM timescaledb_information.chunks 
WHERE hypertable_name = 'candlestick_data'
ORDER BY range_start DESC;
```

### Continuous Aggregate Status
```sql
-- Check continuous aggregate status
SELECT * FROM timescaledb_information.continuous_aggregates;
```

## 🚀 Data Streaming Setup

### High-Frequency Data Ingestion
```sql
-- Example: Insert candlestick data
INSERT INTO candlestick_data (
    contract_id, timestamp, timeframe, 
    open, high, low, close, volume, wap, count
) VALUES (
    1, NOW(), '1min',
    150.25, 150.50, 150.20, 150.45, 1000, 150.35, 50
);
```

### Batch Data Loading
```sql
-- Example: Bulk insert from CSV
COPY candlestick_data (contract_id, timestamp, timeframe, open, high, low, close, volume)
FROM '/path/to/data.csv' 
WITH (FORMAT csv, HEADER true);
```

## 📈 Query Examples

### Latest Data
```sql
-- Get latest candlestick data with indicators
SELECT * FROM latest_candlestick_data 
WHERE symbol = 'MSFT' 
ORDER BY timestamp DESC 
LIMIT 100;
```

### Time Range Queries
```sql
-- Get data for specific time range
SELECT * FROM candlestick_data 
WHERE contract_id = (SELECT id FROM contracts WHERE symbol = 'MSFT')
AND timestamp BETWEEN '2024-01-01' AND '2024-01-31'
AND timeframe = '1day'
ORDER BY timestamp;
```

### Aggregated Data
```sql
-- Get daily summaries
SELECT * FROM daily_trading_summary 
WHERE symbol = 'MSFT' 
AND day >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY day DESC;
```

### Technical Analysis
```sql
-- Get data with technical indicators
SELECT 
    timestamp, close, volume,
    sma_20, sma_50, rsi_14, macd
FROM latest_candlestick_data 
WHERE symbol = 'MSFT' 
AND timeframe = '1day'
ORDER BY timestamp DESC;
```

## 🔧 Maintenance

### Regular Maintenance Tasks
```sql
-- Update table statistics
ANALYZE candlestick_data;
ANALYZE technical_indicators;

-- Refresh continuous aggregates manually
CALL refresh_continuous_aggregate('daily_candlestick_data', NULL, NULL);

-- Check data quality
SELECT * FROM data_quality_metrics 
WHERE date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY date DESC;
```

### Monitoring Queries
```sql
-- Check database size
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check chunk sizes
SELECT 
    hypertable_name,
    chunk_name,
    range_start,
    range_end,
    pg_size_pretty(chunk_size) as size
FROM timescaledb_information.chunks
ORDER BY chunk_size DESC;
```

## 🛠️ Troubleshooting

### Common Issues

#### 1. TimescaleDB Extension Not Found
```sql
-- Install TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

#### 2. Hypertable Creation Fails
```sql
-- Check if table exists and has proper structure
\d candlestick_data

-- Ensure timestamp column is TIMESTAMPTZ
ALTER TABLE candlestick_data ALTER COLUMN timestamp TYPE TIMESTAMPTZ;
```

#### 3. Continuous Aggregate Refresh Issues
```sql
-- Check continuous aggregate status
SELECT * FROM timescaledb_information.continuous_aggregates;

-- Manually refresh if needed
CALL refresh_continuous_aggregate('daily_candlestick_data', NULL, NULL);
```

#### 4. Performance Issues
```sql
-- Check for missing indexes
SELECT * FROM timescaledb_information.hypertables;

-- Analyze query performance
EXPLAIN (ANALYZE, BUFFERS) [your_query];
```

## 🔐 Security Best Practices

### Database Security
1. **Use SSL**: Always enable SSL for remote connections
2. **Strong Passwords**: Use complex passwords for database access
3. **Network Security**: Restrict access to application servers only
4. **Regular Updates**: Keep TimescaleDB and PostgreSQL updated
5. **Backup Strategy**: Implement automated backups

### Connection Security
```bash
# Use SSL connection string
postgresql://user:password@host:port/database?sslmode=require

# Or set SSL parameters
POSTGRES_SSL=true
POSTGRES_SSL_REJECT_UNAUTHORIZED=false  # Only for self-signed certificates
```

## 📊 Backup and Recovery

### Automated Backups
```bash
#!/bin/bash
# backup-timescaledb.sh
BACKUP_DIR="/backups/tradingapp"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Full database backup
pg_dump -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB \
  --format=custom --compress=9 \
  > $BACKUP_DIR/tradingapp_backup_$DATE.dump

# Keep only last 7 days
find $BACKUP_DIR -name "tradingapp_backup_*.dump" -mtime +7 -delete
```

### Restore from Backup
```bash
# Restore from custom format backup
pg_restore -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB \
  --clean --if-exists \
  tradingapp_backup_20240101_120000.dump
```

## 🎯 Next Steps

1. **Set up TimescaleDB instance** using one of the deployment options
2. **Run the TimescaleDB schema** to create optimized tables
3. **Configure environment variables** for database connection
4. **Test data streaming** with sample market data
5. **Monitor performance** and adjust chunk sizes if needed
6. **Set up automated backups** for data protection
7. **Implement monitoring** for continuous aggregates and retention policies

## 📚 Additional Resources

- [TimescaleDB Documentation](https://docs.timescale.com/)
- [TimescaleDB Best Practices](https://docs.timescale.com/timescaledb/latest/how-to-guides/query-data/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [TimescaleDB Cloud](https://cloud.timescale.com/)

The TimescaleDB setup provides a robust, scalable foundation for streaming and analyzing historical market data with optimal performance for time-series queries.
