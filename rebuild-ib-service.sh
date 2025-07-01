#!/bin/bash

# 🐳 Auto-Rebuild IB Service with Enhanced Features
# This script fixes the missing dependencies error and enables all improvements

echo "🚀 Starting IB Service Rebuild Process..."

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not available. Please install Docker Desktop."
    exit 1
fi

# Step 1: Stop current containers
echo "⏹️  Stopping current containers..."
if command -v docker-compose &> /dev/null; then
    docker-compose down
elif command -v docker &> /dev/null; then
    docker compose down
else
    echo "❌ Neither docker-compose nor docker compose found."
    exit 1
fi

# Step 2: Remove old image to force rebuild
echo "🗑️  Removing old ib_service image..."
docker rmi tradingapp-ib_service 2>/dev/null || true
docker rmi tradingapp_ib_service 2>/dev/null || true

# Step 3: Rebuild the ib_service with no cache
echo "🔨 Rebuilding ib_service with new dependencies..."
if command -v docker-compose &> /dev/null; then
    docker-compose build --no-cache ib_service
else
    docker compose build --no-cache ib_service
fi

if [ $? -ne 0 ]; then
    echo "❌ Docker build failed. Check the error messages above."
    exit 1
fi

# Step 4: Restore enhanced version
echo "⚡ Restoring enhanced main.py version..."
cd ib_service
if [ -f "main_enhanced.py" ]; then
    cp main_enhanced.py main.py
    echo "✅ Enhanced version restored"
else
    echo "⚠️  main_enhanced.py not found. Enhanced features may not be available."
fi
cd ..

# Step 5: Start services
echo "🚀 Starting services with enhanced ib_service..."
if command -v docker-compose &> /dev/null; then
    docker-compose up -d
else
    docker compose up -d
fi

# Step 6: Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 10

# Step 7: Verify the fix
echo "🔍 Verifying the enhanced features..."

# Test basic endpoint
echo "Testing basic endpoint..."
if curl -s http://localhost:8000/ > /dev/null; then
    VERSION=$(curl -s http://localhost:8000/ | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    if [[ "$VERSION" == "2.0.0" ]]; then
        echo "✅ Enhanced version (2.0.0) is running!"
    else
        echo "⚠️  Version: $VERSION (expected 2.0.0)"
    fi
else
    echo "❌ IB Service is not responding on port 8000"
fi

# Test enhanced endpoints
echo "Testing enhanced endpoints..."
if curl -s http://localhost:8000/pool-status > /dev/null; then
    echo "✅ Connection pool endpoint working"
else
    echo "⚠️  Connection pool endpoint not available"
fi

if curl -s http://localhost:8000/metrics > /dev/null; then
    echo "✅ Metrics endpoint working"
else
    echo "⚠️  Metrics endpoint not available"
fi

echo ""
echo "🎉 Rebuild process completed!"
echo ""
echo "📊 Service Status:"
echo "   Frontend:  http://localhost:3000"
echo "   Backend:   http://localhost:4000" 
echo "   IB Service: http://localhost:8000"
echo ""
echo "🔧 Enhanced Features Available:"
echo "   • Connection pooling (5 connections)"
echo "   • Data validation with Pydantic"
echo "   • TTL-based caching"
echo "   • Rate limiting"
echo "   • Structured logging"
echo "   • Prometheus metrics"
echo "   • Health monitoring"
echo ""
echo "📋 Test Commands:"
echo "   curl http://localhost:8000/health"
echo "   curl http://localhost:8000/pool-status"  
echo "   curl http://localhost:8000/metrics"
echo ""
echo "📖 For troubleshooting, see: ib_service/DOCKER_REBUILD_INSTRUCTIONS.md" 