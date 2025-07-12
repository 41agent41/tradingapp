# TradingApp - Professional Market Data Explorer

A comprehensive trading platform with advanced market data filtering, real-time visualization, and professional charting capabilities using TradingView lightweight charts and Interactive Brokers integration.

## 🚀 Latest Features

### Market Data Filtering Interface
- **Comprehensive Search**: Symbol search and company name-based filtering
- **Security Types**: Support for all major asset classes (STK, OPT, FUT, CASH, BOND, CFD, CMDTY, CRYPTO, etc.)
- **Exchange Selection**: All major exchanges (NYSE, NASDAQ, AMEX, LSE, TSE, EUREX, CME, etc.)
- **Currency Support**: Multi-currency filtering (USD, EUR, GBP, JPY, CAD, AUD, CHF, HKD)
- **Timeframe Selection**: Multiple timeframes (5min, 15min, 30min, 1hour, 4hour, 8hour, 1day)
- **Real-time Market Data**: Live bid/ask/last/volume data display

### Professional TradingView Charts
- **Multiple Timeframes**: 5min to 1day with seamless switching
- **Historical Periods**: 1 Day to 1 Year of historical data
- **Professional UI**: Candlestick charts with volume overlay
- **Real-time Updates**: Live price updates via WebSocket
- **Responsive Design**: Works on all screen sizes
- **Interactive Features**: Full TradingView lightweight charts functionality

### Enhanced Backend API
- **Advanced Search**: `/api/market-data/search` with comprehensive filtering
- **Contract Resolution**: Smart contract search with fallback options
- **Data Validation**: Comprehensive input validation and error handling
- **Health Monitoring**: Built-in health checks and status monitoring

## 📊 Supported Asset Classes

| Asset Class | Security Type | Examples |
|-------------|---------------|----------|
| **Stocks** | STK | AAPL, MSFT, GOOGL, TSLA |
| **Options** | OPT | AAPL230120C00150000 |
| **Futures** | FUT | ES, NQ, CL, GC |
| **Forex** | CASH | EUR.USD, GBP.USD, USD.JPY |
| **Bonds** | BOND | Government & Corporate bonds |
| **CFDs** | CFD | Stock & Index CFDs |
| **Commodities** | CMDTY | Gold, Silver, Oil, Gas |
| **Cryptocurrencies** | CRYPTO | BTC, ETH, crypto futures |
| **Mutual Funds** | FUND | Open-end funds |
| **Indices** | IND | SPX, NDX, DJX |

## 🎯 Key Features

### Market Data Exploration
- **Symbol Search**: Find contracts by ticker symbol or company name
- **Advanced Filtering**: Filter by security type, exchange, currency, timeframe
- **Real-time Data**: Live market data with bid/ask spreads and volume
- **Professional Display**: Organized contract information with key metrics
- **Chart Integration**: Seamless transition from search to chart visualization

### Professional Charting
- **TradingView Integration**: Industry-standard lightweight charts
- **Multiple Timeframes**: 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
- **Historical Data**: Up to 12 months of historical data
- **Real-time Updates**: Live price feeds via WebSocket connections
- **Volume Analysis**: Volume bars overlay for trade analysis
- **Responsive Design**: Optimized for desktop and mobile

### Interactive Brokers Integration
- **Full API Access**: Complete IB Gateway integration
- **Contract Search**: Advanced contract details resolution
- **Market Data**: Real-time and historical market data
- **Connection Management**: Robust connection handling with failover
- **Data Validation**: Comprehensive data quality checks

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│                 │    │                 │    │                 │
│   Frontend      │    │   Backend       │    │   IB Service    │
│   (Next.js)     │◄──►│   (Express)     │◄──►│   (FastAPI)     │
│                 │    │                 │    │                 │
│ • Market Filter │    │ • Search API    │    │ • Contract      │
│ • TradingView   │    │ • WebSocket     │    │   Search        │
│ • Real-time UI  │    │ • Data Proxy    │    │ • Market Data   │
│                 │    │                 │    │ • IB Gateway    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🚀 Quick Start

### Single Command Deployment
```bash
# Clone repository
git clone https://github.com/your-username/tradingapp.git
cd tradingapp

# Deploy everything with one command
./deploy-tradingapp.sh install   # First time only
./deploy-tradingapp.sh deploy    # Deploy application
./deploy-tradingapp.sh status    # Verify deployment
```

### Access the Application
- **Frontend**: `http://your-server-ip:3000` - Market data filtering and charts
- **Backend API**: `http://your-server-ip:4000` - REST API endpoints
- **IB Service**: `http://your-server-ip:8000` - Interactive Brokers integration

## 💡 Usage Examples

### Search for Stocks
1. Open the application at `http://your-server-ip:3000`
2. Enter a symbol (e.g., "AAPL") or company name
3. Select security type "Stock" and exchange "NASDAQ"
4. Click "Search Contracts" to find matches
5. Select a contract to view real-time data
6. Click "View Chart" for professional TradingView analysis

### Explore Options
1. Set security type to "Option"
2. Enter underlying symbol (e.g., "SPY")
3. Choose exchange and currency
4. Browse available option contracts
5. Analyze option chains with real-time Greeks

### Analyze Futures
1. Select security type "Future"
2. Choose exchange (e.g., "CME" for ES futures)
3. Browse available contracts
4. View continuous contract data
5. Analyze with professional charting tools

## 🔧 Development Setup

### Prerequisites
- Docker and Docker Compose
- Node.js 18+ (for local development)
- Python 3.8+ (for IB service development)
- Interactive Brokers Gateway or TWS

### Local Development
```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev

# IB Service
cd ib_service
pip install -r requirements.txt
python main.py
```

### Docker Development
```bash
# Build and run all services
docker-compose up --build

# Rebuild specific service
docker-compose build --no-cache ib_service
docker-compose up -d ib_service
```

## 🔍 API Documentation

### Market Data Search
```bash
# Search for contracts
curl -X POST "http://localhost:4000/api/market-data/search" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "AAPL",
    "secType": "STK",
    "exchange": "NASDAQ",
    "currency": "USD"
  }'
```

### IB Service Endpoints
```bash
# Contract search
curl -X POST "http://localhost:8000/contract/search" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "AAPL",
    "secType": "STK",
    "exchange": "SMART"
  }'

# Health check
curl "http://localhost:8000/health"
```

## 📋 Available Commands

| Command | Description |
|---------|-------------|
| `./deploy-tradingapp.sh install` | Install Docker & dependencies |
| `./deploy-tradingapp.sh deploy` | Deploy full application |
| `./deploy-tradingapp.sh status` | Check service health |
| `./deploy-tradingapp.sh test` | Test all connections |
| `./deploy-tradingapp.sh logs` | Show service logs |
| `./deploy-tradingapp.sh restart` | Restart services |
| `./deploy-tradingapp.sh stop` | Stop all services |
| `./deploy-tradingapp.sh clean` | Clean up containers |

## 🔒 Security Features

- **Input Validation**: Comprehensive validation for all user inputs
- **CORS Protection**: Configurable cross-origin resource sharing
- **Environment Configuration**: Secure environment variable management
- **Container Isolation**: All services run in isolated Docker containers
- **API Rate Limiting**: Protection against API abuse

## 🎯 Performance Features

- **Connection Pooling**: Efficient IB Gateway connection management
- **Data Caching**: TTL-based caching for improved performance
- **Async Processing**: Non-blocking operations throughout
- **WebSocket Updates**: Real-time data streaming
- **Optimized Charts**: Lightweight TradingView charts implementation

## 📖 Documentation

- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Comprehensive deployment guide
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Complete troubleshooting guide
- **[FEATURES.md](FEATURES.md)** - Detailed features documentation
- **[API.md](API.md)** - API reference documentation

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

MIT License - See LICENSE file for details

## 🆘 Support

For support and troubleshooting:
1. Check the troubleshooting guide
2. Review service logs: `./deploy-tradingapp.sh logs`
3. Verify IB Gateway connection
4. Check firewall and network settings

---

**🚀 Ready to explore professional market data with TradingApp!** 