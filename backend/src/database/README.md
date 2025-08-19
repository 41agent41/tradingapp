# TradingApp Database Setup Guide

This guide explains how to set up and use the external PostgreSQL database for storing historical market data from Interactive Brokers.

## 📋 Overview

The TradingApp database schema is designed to efficiently store and retrieve:
- **Contract Information**: Symbol details, exchange, currency, etc.
- **Historical Data**: OHLCV candlestick data for multiple timeframes
- **Technical Indicators**: Calculated indicators (SMA, EMA, RSI, MACD, etc.)
- **Data Quality Metrics**: Monitoring data integrity and completeness
- **Collection Sessions**: Tracking data collection processes

## 🗄️ Database Schema

### Core Tables

1. **`contracts`** - Contract information from Interactive Brokers
2. **`candlestick_data`** - OHLCV historical data
3. **`tick_data`** - Real-time tick data (high-frequency)
4. **`technical_indicators`** - Calculated technical indicators
5. **`data_collection_sessions`** - Data collection tracking
6. **`data_quality_metrics`** - Data quality monitoring
7. **`data_collection_config`** - Collection configuration

### Views

- **`latest_candlestick_data`** - Latest data with indicators for easy access

## 🚀 Setup Instructions

### 1. External Database Setup

#### Option A: Cloud Database (Recommended)
- **AWS RDS**: PostgreSQL instance
- **Google Cloud SQL**: PostgreSQL instance
- **Azure Database**: PostgreSQL instance
- **DigitalOcean**: Managed PostgreSQL database

#### Option B: Self-Hosted Database
- **Docker**: `docker run --name tradingapp-db -e POSTGRES_PASSWORD=your_password -d postgres:15`
- **Local Installation**: Install PostgreSQL 15+ on your server

### 2. Database Initialization

```bash
# Connect to your PostgreSQL database
psql -h YOUR_DB_HOST -U YOUR_USERNAME -d tradingapp

# Run the initialization script
\i backend/src/database/init.sql
```

Or run the script directly:
```bash
psql -h YOUR_DB_HOST -U YOUR_USERNAME -d tradingapp -f backend/src/database/init.sql
```

### 3. Environment Configuration

Update your `.env` file with external database settings:

```bash
# External Database Configuration
POSTGRES_HOST=your-db-server.com
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=tradingapp
POSTGRES_SSL=true
```

### 4. Verify Setup

Test the database connection:
```bash
curl http://your-server:4000/api/database/health
```

Expected response:
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 📊 Data Flow

### 1. Contract Search
```
Frontend → Backend → IB Service → Database Storage
```

When searching for contracts:
- IB Service returns contract details
- Backend stores contracts in database
- Future searches can use cached contract data

### 2. Historical Data Collection
```
IB Service → Backend → Database Storage → Frontend
```

When requesting historical data:
- Backend checks database first
- If not found, requests from IB Service
- Stores new data in database
- Returns data to frontend

### 3. Technical Indicators
```
Database → Backend → Frontend
```

Technical indicators are:
- Calculated when data is stored
- Cached in database
- Retrieved directly from database

## 🔧 Database Operations

### Manual Data Operations

#### Check Data Statistics
```bash
curl "http://your-server:4000/api/market-data/database/stats?symbol=MSFT"
```

#### Clean Old Data
```bash
curl -X POST http://your-server:4000/api/market-data/database/clean
```

#### Direct Database Queries

```sql
-- Get latest data for MSFT
SELECT * FROM latest_candlestick_data 
WHERE symbol = 'MSFT' 
ORDER BY timestamp DESC 
LIMIT 100;

-- Check data quality
SELECT * FROM data_quality_metrics 
WHERE contract_id = (SELECT id FROM contracts WHERE symbol = 'MSFT')
ORDER BY date DESC;

-- Get collection sessions
SELECT * FROM data_collection_sessions 
WHERE contract_id = (SELECT id FROM contracts WHERE symbol = 'MSFT')
ORDER BY start_time DESC;
```

## 📈 Performance Optimization

### Indexes
The schema includes optimized indexes for:
- Symbol lookups
- Time-based queries
- Contract-timeframe combinations
- Technical indicator searches

### Partitioning (Optional)
For high-volume data, consider partitioning:

```sql
-- Partition candlestick_data by date
CREATE TABLE candlestick_data_2024 PARTITION OF candlestick_data
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

### Maintenance
Regular maintenance tasks:

```sql
-- Update table statistics
ANALYZE candlestick_data;
ANALYZE technical_indicators;

-- Clean old data (automated)
SELECT clean_old_data();

-- Vacuum tables
VACUUM ANALYZE candlestick_data;
```

## 🔍 Monitoring

### Database Health
```bash
# Check database connection
curl http://your-server:4000/api/database/health

# Check overall system health
curl http://your-server:4000/api/health
```

### Data Quality Monitoring
```sql
-- Check data quality scores
SELECT 
    c.symbol,
    dqm.timeframe,
    dqm.date,
    dqm.data_quality_score,
    dqm.total_bars,
    dqm.missing_bars
FROM data_quality_metrics dqm
JOIN contracts c ON dqm.contract_id = c.id
WHERE dqm.date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY dqm.date DESC, c.symbol;
```

### Collection Session Monitoring
```sql
-- Check recent collection sessions
SELECT 
    c.symbol,
    dcs.timeframe,
    dcs.status,
    dcs.records_collected,
    dcs.start_time,
    dcs.end_time
FROM data_collection_sessions dcs
JOIN contracts c ON dcs.contract_id = c.id
WHERE dcs.start_time >= CURRENT_DATE - INTERVAL '1 day'
ORDER BY dcs.start_time DESC;
```

## 🛠️ Troubleshooting

### Common Issues

#### 1. Connection Refused
```bash
# Check if database is accessible
telnet YOUR_DB_HOST 5432

# Verify credentials
psql -h YOUR_DB_HOST -U YOUR_USERNAME -d tradingapp -c "SELECT 1;"
```

#### 2. SSL Connection Issues
```bash
# For self-signed certificates, set in .env:
POSTGRES_SSL=true

# Or disable SSL for local development:
POSTGRES_SSL=false
```

#### 3. Permission Denied
```sql
-- Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE tradingapp TO tradingapp;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO tradingapp;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO tradingapp;
```

#### 4. Schema Not Found
```bash
# Re-run initialization script
psql -h YOUR_DB_HOST -U YOUR_USERNAME -d tradingapp -f backend/src/database/init.sql
```

## 📚 API Endpoints

### Database-Specific Endpoints

- `GET /api/database/health` - Database connection status
- `GET /api/market-data/database/stats` - Data collection statistics
- `POST /api/market-data/database/clean` - Clean old data

### Enhanced Market Data Endpoints

All market data endpoints now support database integration:
- `GET /api/market-data/history?use_database=true` - Use database first
- `GET /api/market-data/indicators?use_database=true` - Get cached indicators

## 🔐 Security Considerations

1. **Use SSL**: Always enable SSL for external database connections
2. **Strong Passwords**: Use complex passwords for database access
3. **Network Security**: Restrict database access to application servers
4. **Regular Backups**: Implement automated database backups
5. **Access Logging**: Monitor database access and queries

## 📊 Backup and Recovery

### Automated Backups
```bash
#!/bin/bash
# backup-db.sh
BACKUP_DIR="/backups/tradingapp"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

pg_dump -h YOUR_DB_HOST -U YOUR_USERNAME tradingapp > $BACKUP_DIR/tradingapp_backup_$DATE.sql

# Keep only last 7 days
find $BACKUP_DIR -name "tradingapp_backup_*.sql" -mtime +7 -delete
```

### Restore from Backup
```bash
psql -h YOUR_DB_HOST -U YOUR_USERNAME -d tradingapp < backup_file.sql
```

## 🎯 Next Steps

1. **Set up external database** using the provided schema
2. **Configure environment variables** for database connection
3. **Test database connectivity** using health check endpoints
4. **Monitor data collection** and quality metrics
5. **Implement automated backups** for data protection

The database integration provides a robust foundation for storing and retrieving historical market data, enabling faster queries and better data management for your trading application.
