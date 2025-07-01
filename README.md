# TradingApp

A comprehensive trading platform with real-time MSFT stock data visualization using TradingView lightweight charts and Interactive Brokers integration.

## Features
- Real-time MSFT stock data visualization  
- Multiple timeframes: 5min, 15m, 30m, 1hour, 4hr, 8hr, 1day
- 12 months of historical data
- TradingView lightweight charts integration
- Interactive Brokers Gateway integration
- WebSocket real-time updates
- Enhanced IB service with connection pooling
- Fully containerized for remote deployment

## Project Structure
- `frontend/` — Next.js 14 + TypeScript + Tailwind CSS + TradingView Charts
- `backend/` — Node.js + Express + TypeScript
- `ib_service/` — Python FastAPI microservice (ib_insync)
- `docker-compose.yml` — Orchestrates all services

## 🚀 Remote Server Deployment

### Prerequisites
- Docker and Docker Compose (auto-installed by script)
- Server with at least 2GB RAM and 10GB storage
- Ports 3000, 4000, 8000, 5432, 6379 available

### ✅ Fixed: IB Service Build Error
**Issue resolved:** `ib_insync==0.20.0` package version error  
**Solution:** Updated to correct version `ib_insync==0.9.86`

### 🎯 Single Command Deployment
**All scripts consolidated into one!**

1. **Clone the repository on your server:**
```sh
git clone <your-repo-url>
cd tradingapp
```

2. **One-command deployment:**
```sh
# Install Docker and deploy everything
./deploy-tradingapp.sh install   # First time only
./deploy-tradingapp.sh deploy    # Deploy application
```

3. **Verify deployment:**
```sh
./deploy-tradingapp.sh status    # Check services
./deploy-tradingapp.sh test      # Test connections
```

## 🔧 Available Commands

| Command | Description | Use Case |
|---------|-------------|----------|
| `./deploy-tradingapp.sh install` | Install Docker & dependencies | First time server setup |
| `./deploy-tradingapp.sh deploy` | Deploy full application | Initial deployment |
| `./deploy-tradingapp.sh ib-rebuild` | Rebuild IB service with enhanced features | IB-specific fixes |
| `./deploy-tradingapp.sh status` | Check service health | Monitoring |
| `./deploy-tradingapp.sh test` | Test all connections | Troubleshooting |
| `./deploy-tradingapp.sh logs` | Show service logs | Debugging |
| `./deploy-tradingapp.sh stop` | Stop all services | Maintenance |
| `./deploy-tradingapp.sh restart` | Restart services | Quick restart |

## 🌐 Service Access URLs

After successful deployment:
- **Frontend (TradingView Charts)**: `http://your-server-ip:3000`
- **Backend API**: `http://your-server-ip:4000`
- **IB Service**: `http://your-server-ip:8000`

## ⚙️ Environment Configuration

The script automatically creates `.env` with your server's IP:
```sh
# View current configuration
cat .env

# Manually setup if needed
./deploy-tradingapp.sh env-setup
```

## Development Setup

### Local Development
```sh
# Backend
cd backend
npm install
npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

### Docker Development
```sh
docker-compose up --build
```

## 🔍 Troubleshooting

### Quick Fixes
```bash
# Clean rebuild everything
./deploy-tradingapp.sh clean
./deploy-tradingapp.sh rebuild

# IB service issues
./deploy-tradingapp.sh ib-rebuild

# Check service status
./deploy-tradingapp.sh status

# Test all connections
./deploy-tradingapp.sh test

# View detailed logs
./deploy-tradingapp.sh logs
```

### Common Issues
- **Docker build fails**: Run `./deploy-tradingapp.sh clean` then `./deploy-tradingapp.sh rebuild`
- **IB service not responding**: Use `./deploy-tradingapp.sh ib-rebuild` for enhanced version
- **Port conflicts**: Modify ports in `docker-compose.yml` if needed
- **Connection issues**: Verify firewall allows ports 3000, 4000, 8000

## 📖 Documentation

- **[Complete Deployment Guide](REMOTE_DEPLOYMENT_COMPLETE.md)** - Comprehensive remote server setup
- **[Enhanced IB Features](REMOTE_DEPLOYMENT_COMPLETE.md#enhanced-ib-service-features)** - Advanced capabilities  
- **[Troubleshooting Guide](REMOTE_DEPLOYMENT_COMPLETE.md#troubleshooting)** - Detailed solutions

## 🎯 TradingView Integration
- **Real-time MSFT data** from Interactive Brokers Gateway
- **Multiple timeframes** (5m, 15m, 30m, 1h, 4h, 8h, 1d)
- **12 months historical data** support
- **WebSocket real-time updates**
- **Interactive charts** with TradingView lightweight charts

## License
MIT 