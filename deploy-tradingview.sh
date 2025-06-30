#!/bin/bash

# TradingApp Deployment Script with TradingView Lightweight Charts
# This script builds and runs the complete trading application with real-time MSFT charts

set -e  # Exit on any error

echo "=============================================="
echo "TradingApp with TradingView Charts Deployment"
echo "=============================================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running. Please start Docker first."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Stop and remove existing containers
echo "🛑 Stopping existing containers..."
docker-compose down --remove-orphans
echo ""

# Remove old images (optional, uncomment if you want to force rebuild)
echo "🗑️  Removing old images..."
docker image prune -f
echo ""

# Build all services
echo "🔨 Building all containers..."
echo ""

echo "📦 Building IB Service (with market data support)..."
docker-compose build ib_service

echo "🖥️  Building Backend (with TradingView data endpoints)..."
docker-compose build backend

echo "🌐 Building Frontend (with TradingView charts)..."
docker-compose build frontend

echo ""
echo "✅ All containers built successfully!"
echo ""

# Start all services
echo "🚀 Starting all services..."
docker-compose up -d

echo ""
echo "⏳ Waiting for services to start..."
sleep 10

# Check service health
echo ""
echo "🔍 Checking service health..."
echo ""

# Check Frontend
echo "Frontend (Next.js with TradingView):"
if curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo "  ✅ Frontend is running at http://localhost:3000"
else
    echo "  ❌ Frontend is not responding"
fi

# Check Backend
echo "Backend (Express.js with market data APIs):"
if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    echo "  ✅ Backend is running at http://localhost:4000"
    echo "  📊 Market data API: http://localhost:4000/api/market-data/history"
else
    echo "  ❌ Backend is not responding"
fi

# Check IB Service
echo "IB Service (FastAPI with market data endpoints):"
if curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "  ✅ IB Service is running at http://localhost:8000"
    echo "  📈 Historical data: http://localhost:8000/market-data/history"
else
    echo "  ❌ IB Service is not responding"
fi

echo ""
echo "=============================================="
echo "🎯 TradingApp Deployment Summary"
echo "=============================================="
echo ""
echo "📱 Frontend: http://localhost:3000"
echo "   - TradingView lightweight charts for MSFT"
echo "   - Multiple timeframes: 5m, 15m, 30m, 1h, 4h, 8h, 1d"
echo "   - Real-time price updates via WebSocket"
echo "   - 12 months of historical data"
echo ""
echo "🔗 Backend API: http://localhost:4000"
echo "   - Market data endpoints: /api/market-data/*"
echo "   - Account data: /api/account"
echo "   - Real-time WebSocket connections"
echo ""
echo "🔌 IB Service: http://localhost:8000"
echo "   - Interactive Brokers Gateway connection"
echo "   - Historical data: /market-data/history"
echo "   - Real-time data: /market-data/realtime"
echo ""
echo "📊 Features:"
echo "   ✓ TradingView lightweight charts"
echo "   ✓ Real-time MSFT price data"
echo "   ✓ Multiple timeframe support"
echo "   ✓ 12 months historical data"
echo "   ✓ WebSocket real-time updates"
echo "   ✓ Interactive Brokers integration"
echo ""
echo "🚀 Ready to trade! Access the app at: http://localhost:3000"
echo ""

# Show logs (optional)
echo "📝 To view real-time logs:"
echo "   docker-compose logs -f"
echo ""
echo "🛑 To stop all services:"
echo "   docker-compose down"
echo ""

# Optional: Show live logs for a few seconds
echo "📋 Recent logs (last 10 lines from each service):"
echo ""
echo "--- Frontend ---"
docker-compose logs --tail=5 frontend
echo ""
echo "--- Backend ---"
docker-compose logs --tail=5 backend
echo ""
echo "--- IB Service ---"
docker-compose logs --tail=5 ib_service
echo ""

echo "✨ Deployment complete! The TradingView charts should now be visible in the frontend."
echo "🔍 Check the browser console and network tab for any issues." 