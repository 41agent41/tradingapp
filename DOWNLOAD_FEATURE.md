# Download Historical Data Feature

## Overview

The Download Historical Data feature allows users to fetch historical market data from Interactive Brokers API and load it directly into the PostgreSQL database for analysis and storage.

## Features

- **Market & Symbol Selection**: Choose from various exchanges, security types, and symbols
- **Time Period Configuration**: Select predefined periods or custom date ranges
- **Multiple Timeframes**: Support for tick data, minutes, hours, and daily data
- **Real-time Data Preview**: View downloaded data in a pandas-style dataframe viewer
- **Database Integration**: Direct upload to PostgreSQL database with conflict resolution
- **Progress Tracking**: Real-time status updates for download and upload operations

## How to Use

### 1. Access the Download Page

Navigate to the main page and click on the "Download Data" card, or go directly to `/download`.

### 2. Configure Data Source

#### Market & Symbol Section
- **Region**: Choose between US and Australian markets
- **Exchange**: Select from available exchanges (NASDAQ, NYSE, ASX, etc.)
- **Security Type**: Choose from stocks, options, futures, ETFs, etc.
- **Symbol**: Enter the trading symbol (e.g., MSFT, AAPL, SPY)
- **Currency**: Select the currency for the instrument

#### Time Period Section
- **Period**: Choose from predefined periods (1D, 1W, 1M, 3M, 6M, 1Y)
- **Custom Date Range**: Toggle to use specific start and end dates
- **Start Date**: Select the beginning of your data range
- **End Date**: Select the end of your data range

#### Download Settings
- **Timeframe**: Choose the data granularity (tick, 1min, 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day)

### 3. Download Data

1. Click the "Download from IB API" button
2. Wait for the download to complete
3. Review the downloaded data in the dataframe viewer
4. Check the data summary for record count and source information

### 4. Load to Database

1. Click the "Load to PostgreSQL" button
2. Monitor the upload progress
3. Review the upload results showing inserted/updated records

## Data Structure

The downloaded data includes the following fields:

- **timestamp**: Unix timestamp of the data point
- **open**: Opening price
- **high**: Highest price during the period
- **low**: Lowest price during the period
- **close**: Closing price
- **volume**: Trading volume
- **wap**: Volume Weighted Average Price (if available)
- **count**: Number of trades (if available)

## Database Schema

Data is stored in the following PostgreSQL tables:

### contracts
- Stores contract information (symbol, security type, exchange, etc.)
- Unique constraint prevents duplicate contracts

### candlestick_data
- Stores OHLCV candlestick data
- Links to contracts via contract_id
- Includes timeframe and timestamp information
- Unique constraint prevents duplicate data points

## API Endpoints

### Download Data
```
GET /api/market-data/history
```

Parameters:
- `symbol`: Trading symbol
- `timeframe`: Data granularity
- `period`: Time period or 'CUSTOM'
- `start_date`: Custom start date (if using custom range)
- `end_date`: Custom end date (if using custom range)
- `account_mode`: Paper or live trading mode
- `secType`: Security type
- `exchange`: Exchange
- `currency`: Currency

### Upload Data
```
POST /api/market-data/upload
```

Body:
```json
{
  "symbol": "MSFT",
  "timeframe": "1hour",
  "bars": [...],
  "account_mode": "paper",
  "secType": "STK",
  "exchange": "NASDAQ",
  "currency": "USD"
}
```

## Error Handling

The feature includes comprehensive error handling for:

- **Connection Issues**: IB Gateway connection problems
- **Data Validation**: Invalid symbols or parameters
- **Database Errors**: PostgreSQL connection and constraint violations
- **Timeout Issues**: Long-running operations
- **Permission Issues**: Data access restrictions

## Data Quality

- **Duplicate Prevention**: Automatic handling of duplicate data points
- **Data Validation**: Validation of OHLCV data integrity
- **Conflict Resolution**: Upsert operations for existing data
- **Error Tracking**: Detailed error reporting for failed operations

## Performance Considerations

- **Batch Processing**: Efficient handling of large datasets
- **Connection Pooling**: Optimized database connections
- **Timeout Management**: Configurable timeouts for long operations
- **Memory Management**: Efficient data processing and storage

## Troubleshooting

### Common Issues

1. **"IB Gateway timeout"**
   - Check IB Gateway connection
   - Verify market data subscriptions
   - Try smaller time periods

2. **"No data received"**
   - Verify symbol exists on selected exchange
   - Check market hours for the instrument
   - Ensure sufficient market data permissions

3. **"Database connection refused"**
   - Verify PostgreSQL service is running
   - Check database connection settings
   - Ensure proper database permissions

4. **"Duplicate key violation"**
   - Normal behavior for existing data
   - Data will be updated rather than inserted
   - Check upload results for actual changes

### Debug Information

The application provides detailed logging for:
- Download progress and timing
- Data validation results
- Database operation statistics
- Error details and stack traces

## Future Enhancements

- **Bulk Download**: Download multiple symbols simultaneously
- **Scheduled Downloads**: Automated data collection
- **Data Compression**: Efficient storage of large datasets
- **Advanced Filtering**: More granular data selection options
- **Export Formats**: Additional export options (Excel, Parquet, etc.)
