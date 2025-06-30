# TradingView Lightweight Charts Integration

This document explains the TradingView lightweight charts implementation for real-time MSFT stock data visualization.

## 🎯 Features

### Chart Capabilities
- **Real-time MSFT stock data** from Interactive Brokers Gateway
- **Multiple timeframes**: 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
- **12 months of historical data** for each timeframe
- **Live price updates** via WebSocket connections
- **Professional candlestick charts** with volume indicators
- **Responsive design** that works on all screen sizes

### Technical Stack
- **Frontend**: Next.js 14 + TradingView Lightweight Charts
- **Backend**: Express.js + Socket.io for real-time data
- **Data Source**: Interactive Brokers Gateway via FastAPI service
- **Real-time**: WebSocket connections for live price updates

## 🚀 Quick Start

### 1. Deploy the Application
```bash
# Make the deployment script executable
chmod +x deploy-tradingview.sh

# Run the deployment
./deploy-tradingview.sh
```

### 2. Access the Application
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000
- **IB Service**: http://localhost:8000

### 3. View MSFT Charts
1. Open http://localhost:3000 in your browser
2. The MSFT chart will be displayed prominently on the main page
3. Use the timeframe buttons to switch between different periods
4. Real-time price updates will appear automatically when connected to IB Gateway

## 📊 Chart Features

### Timeframe Selection
Click any of the timeframe buttons to change the chart view:
- **5m**: 5-minute bars for intraday trading
- **15m**: 15-minute bars for short-term analysis
- **30m**: 30-minute bars for swing trading
- **1h**: 1-hour bars for trend analysis
- **4h**: 4-hour bars for position trading
- **8h**: 8-hour bars for long-term views
- **1d**: Daily bars for fundamental analysis

### Real-time Updates
- **Live prices** update every second when connected
- **Connection status** indicator shows Socket.io connection state
- **Price display** shows current MSFT price in the chart header
- **Chart updates** automatically append new price data

### Chart Interactions
- **Zoom**: Mouse wheel or pinch gestures
- **Pan**: Click and drag to move around the chart
- **Crosshair**: Hover to see exact OHLCV values
- **Auto-fit**: Chart automatically fits content when changing timeframes

## 🔧 API Endpoints

### Market Data Endpoints

#### Get Historical Data
```
GET /api/market-data/history?symbol=MSFT&timeframe=1hour&period=12M
```

Response:
```json
{
  "symbol": "MSFT",
  "timeframe": "1hour",
  "period": "12M",
  "bars": [
    {
      "time": 1640995200,
      "open": 335.50,
      "high": 337.89,
      "low": 334.21,
      "close": 336.32,
      "volume": 1234567
    }
  ],
  "count": 2000,
  "source": "Interactive Brokers"
}
```

#### Get Real-time Data
```
GET /api/market-data/realtime?symbol=MSFT
```

Response:
```json
{
  "symbol": "MSFT",
  "bid": 335.45,
  "ask": 335.55,
  "last": 335.50,
  "volume": 1234567,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### WebSocket Events

#### Subscribe to Real-time Updates
```javascript
socket.emit('subscribe-market-data', {
  symbol: 'MSFT',
  timeframe: '1hour'
});
```

#### Receive Market Data Updates
```javascript
socket.on('market-data-update', (data) => {
  console.log('Real-time price:', data.data.last);
});
```

## 🔌 Interactive Brokers Setup

### Prerequisites
1. **IB Gateway or TWS** must be running
2. **API connections** must be enabled in IB Gateway/TWS
3. **Market data subscriptions** for MSFT required

### Connection Configuration
- **Host**: 10.7.3.21 (or your IB Gateway IP)
- **Port**: 4002 (IB Gateway socket port)
- **Client ID**: 1

### Market Data Permissions
Ensure you have the following permissions:
- **US Equity market data** for NASDAQ (MSFT)
- **Real-time data** subscriptions
- **Historical data** access

## 🛠️ Development

### Frontend Development
```bash
cd frontend
npm install  # Install new TradingView charts dependency
npm run dev  # Start development server
```

### Backend Development
```bash
cd backend
npm install  # Dependencies already included
npm run dev  # Start development server
```

### IB Service Development
```bash
cd ib_service
pip install -r requirements.txt  # Install pandas and other dependencies
python main.py  # Start development server
```

## 📁 File Structure

```
tradingapp/
├── frontend/
│   ├── app/
│   │   ├── components/
│   │   │   └── TradingChart.tsx     # TradingView chart component
│   │   └── page.tsx                # Main page with chart
│   └── package.json                # Added lightweight-charts
├── backend/
│   └── src/
│       ├── routes/
│       │   └── marketData.ts       # Market data API routes
│       └── index.ts                # Socket.io real-time updates
├── ib_service/
│   ├── main.py                     # Added market data endpoints
│   └── requirements.txt            # Added pandas dependency
└── deploy-tradingview.sh           # Deployment script
```

## 🔍 Troubleshooting

### Chart Not Loading
1. Check browser console for JavaScript errors
2. Verify backend is running: `curl http://localhost:4000/health`
3. Check if TradingView charts library loaded correctly

### No Historical Data
1. Verify IB Gateway connection: `curl http://localhost:8000/connection`
2. Check IB Gateway API settings
3. Ensure MSFT market data permissions

### Real-time Updates Not Working
1. Check WebSocket connection in browser dev tools
2. Verify Socket.io connection: Look for "Connected" status in chart header
3. Check backend logs: `docker-compose logs backend`

### IB Gateway Connection Issues
1. Ensure IB Gateway is running on 10.7.3.21:4002
2. Check API settings in IB Gateway
3. Verify network connectivity: `ping 10.7.3.21`

## 📚 Additional Resources

- **TradingView Lightweight Charts**: https://tradingview.github.io/lightweight-charts/
- **Interactive Brokers API**: https://interactivebrokers.github.io/tws-api/
- **Socket.io Documentation**: https://socket.io/docs/

## 🔄 Updates and Maintenance

### Adding New Symbols
1. Update symbol validation in `backend/src/routes/marketData.ts`
2. Update symbol validation in `ib_service/main.py`
3. Add new chart components in frontend if needed

### Adding New Timeframes
1. Update `timeframes` array in `TradingChart.tsx`
2. Update `timeframe_map` in IB service market data endpoints
3. Test with different bar sizes

### Performance Optimization
- Consider implementing data caching for historical data
- Implement connection pooling for IB Gateway
- Add data compression for large historical datasets

---

## 🎉 Conclusion

The TradingView charts integration provides professional-grade charting capabilities with real-time MSFT data from Interactive Brokers. The system supports multiple timeframes, 12 months of historical data, and live price updates via WebSocket connections.

For issues or enhancements, check the application logs and ensure all services are properly connected to the Interactive Brokers Gateway. 