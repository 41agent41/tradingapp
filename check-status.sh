#!/bin/bash

echo "🔍 TradingApp Status Check"
echo "========================="

# Check if Docker is running
echo "🐳 Checking Docker status..."
if docker info &> /dev/null; then
    echo "✅ Docker is running"
else
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Check if services are running
echo ""
echo "📊 Checking service status..."
if command -v docker-compose &> /dev/null; then
    docker-compose ps
else
    echo "❌ Docker Compose not found. Please install it first."
    exit 1
fi

# Check if IB Service is running
echo ""
echo "🔍 Checking IB Service specifically..."
if docker-compose ps | grep -q "ib_service.*Up"; then
    echo "✅ IB Service is running"
    
    # Check IB Service logs
    echo ""
    echo "📋 Recent IB Service logs:"
    docker-compose logs --tail=20 ib_service
    
    # Test IB Service endpoints
    echo ""
    echo "🧪 Testing IB Service endpoints..."
    
    # Test root endpoint
    if curl -s http://localhost:8000/ > /dev/null; then
        echo "✅ IB Service root endpoint responding"
    else
        echo "❌ IB Service root endpoint not responding"
    fi
    
    # Test health endpoint
    if curl -s http://localhost:8000/health > /dev/null; then
        echo "✅ IB Service health endpoint responding"
    else
        echo "❌ IB Service health endpoint not responding"
    fi
    
    # Test gateway health endpoint
    if curl -s http://localhost:8000/gateway-health > /dev/null; then
        echo "✅ IB Gateway health endpoint responding"
    else
        echo "❌ IB Gateway health endpoint not responding"
    fi
    
else
    echo "❌ IB Service is not running"
    echo ""
    echo "🔧 To start services, run:"
    echo "   docker-compose up -d"
    echo ""
    echo "📋 To see startup logs:"
    echo "   docker-compose logs ib_service"
fi

echo ""
echo "🌐 Service URLs (if running):"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:4000"
echo "   IB Service: http://localhost:8000"
echo ""
echo "🔗 IB Gateway Configuration:"
echo "   Host: 10.7.3.21"
echo "   Port: 4002"
echo "   Client ID: 1" 