# TradingApp - Streamlined Trading Platform

A simplified trading application with TradingView lightweight charts and reliable Interactive Brokers integration, featuring a unified management system and streamlined architecture.

## 🚀 **Quick Start - One Script Does Everything**

### **Single Command Setup**
```bash
# Clone repository
git clone https://github.com/your-username/tradingapp.git
cd tradingapp

# Make script executable (Linux/Mac)
chmod +x tradingapp.sh

# First time setup
./tradingapp.sh setup

# Deploy application
./tradingapp.sh deploy

# Test everything
./tradingapp.sh test
```

### **Access Your Application**
- **Frontend**: `http://your-server-ip:3000` - Market data and charts
- **Backend**: `http://your-server-ip:4000` - API endpoints  
- **IB Service**: `http://your-server-ip:8000` - Interactive Brokers integration

## 📋 **Unified Management Commands**

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `./tradingapp.sh setup` | Install Docker, configure environment | First time setup |
| `./tradingapp.sh deploy` | Deploy complete application | Initial deployment |
| `./tradingapp.sh redeploy` | Clean redeploy (recommended) | After code changes |
| `./tradingapp.sh config` | Configure IB Gateway connection | Change IB settings |
| `./tradingapp.sh test` | Test all connections | Troubleshooting |
| `./tradingapp.sh diagnose` | Run comprehensive diagnostics | Debug issues |
| `./tradingapp.sh fix` | Auto-fix common issues | Connection problems |
| `./tradingapp.sh logs` | View service logs | Monitor operations |
| `./tradingapp.sh status` | Check service status | Quick health check |
| `./tradingapp.sh clean` | Clean up and reset | Start fresh |

## 🎯 **Key Features**

### **Market Data & Charts**
- **TradingView Integration**: Professional lightweight charts
- **Real-time Data**: Live MSFT data from Interactive Brokers
- **Multiple Timeframes**: 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
- **12 Months History**: Complete historical data access
- **Responsive Design**: Works on desktop and mobile

### **Interactive Brokers Integration**
- **Simplified Connection**: Reliable synchronous IB Gateway connection
- **Market Data**: Real-time quotes and historical data
- **Contract Search**: Find stocks, options, futures, forex
- **Error Handling**: Robust error recovery and reconnection

### **Streamlined Architecture**
- **Single Script Management**: One script handles everything
- **Simplified Services**: Reduced complexity, improved reliability
- **Fast Deployment**: Clean redeploy in under 2 minutes
- **Easy Troubleshooting**: Built-in diagnostics and auto-fix

## 🔧 **Configuration**

### **Environment Setup**
The unified script handles all configuration automatically:

```bash
# Configure IB Gateway connection
./tradingapp.sh config

# This will prompt for:
# - IB Gateway IP address
# - Server IP (auto-detected)
# - Creates optimized .env file
```

### **Manual Configuration**
If needed, you can manually edit the `.env` file:

```bash
# Core Configuration
SERVER_IP=10.7.3.20
IB_HOST=10.7.3.21
IB_PORT=4002
IB_CLIENT_ID=1

# Service Ports
FRONTEND_PORT=3000
BACKEND_PORT=4000
IB_SERVICE_PORT=8000
```

## 🏗️ **Simplified Architecture**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│                 │    │                 │    │                 │
│   Frontend      │    │   Backend       │    │   IB Service    │
│   (Next.js)     │◄──►│   (Express)     │◄──►│   (FastAPI)     │
│                 │    │                 │    │                 │
│ • TradingView   │    │ • API Routes    │    │ • Simple Sync   │
│ • Real-time UI  │    │ • WebSocket     │    │ • Direct IB     │
│ • Charts        │    │ • Proxy         │    │ • No Pooling    │
│                 │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🔍 **Troubleshooting**

### **Common Issues**
```bash
# Service won't start
./tradingapp.sh diagnose
./tradingapp.sh fix

# IB Gateway connection failed
./tradingapp.sh config    # Reconfigure IB settings
./tradingapp.sh test      # Test connection

# Charts not loading
./tradingapp.sh logs      # Check for errors
./tradingapp.sh redeploy  # Clean redeploy
```

### **Connection Problems**
```bash
# Test IB Gateway connectivity
./tradingapp.sh test

# View detailed diagnostics
./tradingapp.sh diagnose

# Auto-fix common issues
./tradingapp.sh fix
```

## 📊 **Supported Assets**

| Asset Class | Symbol Examples | Timeframes |
|-------------|----------------|------------|
| **Stocks** | MSFT, AAPL, GOOGL | 5min to 1day |
| **Options** | MSFT Call/Put options | 5min to 1day |
| **Futures** | ES, NQ, YM | 5min to 1day |
| **Forex** | EUR.USD, GBP.USD | 5min to 1day |

## 🚀 **Development**

### **Local Development**
```bash
# Backend development
cd backend && npm run dev

# Frontend development  
cd frontend && npm run dev

# IB Service development
cd ib_service && python main.py
```

### **Docker Development**
```bash
# Build and run specific service
docker-compose up --build ib_service

# View logs for specific service
docker-compose logs -f ib_service
```

## 📈 **Performance Improvements**

- **80% reduction** in deployment scripts (from 45KB to 9KB)
- **60% fewer files** to maintain
- **Simplified architecture** with synchronous connections
- **Faster troubleshooting** with unified diagnostics
- **Reliable connections** without complex pooling

## 🎉 **What's Changed**

### **Removed Complexity**
- ❌ 5 separate deployment scripts → ✅ 1 unified script
- ❌ Complex async connection pooling → ✅ Simple synchronous connections
- ❌ Multi-layered caching → ✅ Direct data retrieval
- ❌ Complex configuration management → ✅ Simple environment variables
- ❌ Multiple troubleshooting scripts → ✅ Built-in diagnostics

### **Added Reliability**
- ✅ Unified management system
- ✅ Automatic error recovery
- ✅ Simplified deployment process
- ✅ Built-in connection testing
- ✅ One-command troubleshooting

## 📞 **Support**

For issues or questions:
1. Run `./tradingapp.sh diagnose` for detailed diagnostics
2. Check `./tradingapp.sh logs` for recent errors
3. Try `./tradingapp.sh fix` for auto-resolution
4. Use `./tradingapp.sh clean` for complete reset

---

**🚀 Your streamlined TradingApp is ready for reliable market data exploration!** 