#!/bin/bash

echo "🔍 Testing TradingApp Connections"
echo "================================"

# Test backend root
echo "📡 Testing Backend Root (10.7.3.20:4000/)..."
if curl -s http://10.7.3.20:4000/ > /dev/null; then
    echo "✅ Backend root is responding"
    echo "📋 API Information:"
    curl -s http://10.7.3.20:4000/ | jq . 2>/dev/null || curl -s http://10.7.3.20:4000/
else
    echo "❌ Backend root is not responding"
fi

echo ""

# Test backend health
echo "📡 Testing Backend Health (10.7.3.20:4000/health)..."
if curl -s http://10.7.3.20:4000/health > /dev/null; then
    echo "✅ Backend health check is responding"
    curl -s http://10.7.3.20:4000/health | jq . 2>/dev/null || curl -s http://10.7.3.20:4000/health
else
    echo "❌ Backend health check is not responding"
fi

echo ""

# Test settings endpoint
echo "📡 Testing Settings API (10.7.3.20:4000/api/settings)..."
if curl -s http://10.7.3.20:4000/api/settings > /dev/null; then
    echo "✅ Settings API is responding"
    curl -s http://10.7.3.20:4000/api/settings | jq . 2>/dev/null || curl -s http://10.7.3.20:4000/api/settings
else
    echo "❌ Settings API is not responding"
fi

echo ""

# Test IB service
echo "📡 Testing IB Service (10.7.3.20:8000/)..."
if curl -s http://10.7.3.20:8000/ > /dev/null; then
    echo "✅ IB Service is responding"
    echo "📋 IB Service Information:"
    curl -s http://10.7.3.20:8000/ | jq . 2>/dev/null || curl -s http://10.7.3.20:8000/
else
    echo "❌ IB Service is not responding"
fi

echo ""

# Test IB service health
echo "📡 Testing IB Service Health (10.7.3.20:8000/health)..."
if curl -s http://10.7.3.20:8000/health > /dev/null; then
    echo "✅ IB Service health check is responding"
    curl -s http://10.7.3.20:8000/health | jq . 2>/dev/null || curl -s http://10.7.3.20:8000/health
else
    echo "❌ IB Service health check is not responding"
fi

echo ""

# Test IB Gateway health check
echo "📡 Testing IB Gateway Health (10.7.3.20:8000/gateway-health)..."
if curl -s http://10.7.3.20:8000/gateway-health > /dev/null; then
    echo "✅ IB Gateway health check is responding"
    curl -s http://10.7.3.20:8000/gateway-health | jq . 2>/dev/null || curl -s http://10.7.3.20:8000/gateway-health
else
    echo "❌ IB Gateway health check is not responding"
fi

echo ""

# Test IB connection status
echo "📡 Testing IB Connection Status (10.7.3.20:8000/connection)..."
if curl -s http://10.7.3.20:8000/connection > /dev/null; then
    echo "✅ IB Connection status is responding"
    curl -s http://10.7.3.20:8000/connection | jq . 2>/dev/null || curl -s http://10.7.3.20:8000/connection
else
    echo "❌ IB Connection status is not responding"
fi

echo ""

# Test frontend
echo "📡 Testing Frontend (10.7.3.20:3000)..."
if curl -s http://10.7.3.20:3000 > /dev/null; then
    echo "✅ Frontend is responding"
else
    echo "❌ Frontend is not responding"
fi

echo ""

# Check Docker containers
echo "🐳 Checking Docker containers..."
docker-compose ps

echo ""

# Check container logs
echo "📋 Recent backend logs:"
docker-compose logs --tail=10 backend

echo ""
echo "📋 Recent frontend logs:"
docker-compose logs --tail=10 frontend

echo ""
echo "📋 Recent IB service logs:"
docker-compose logs --tail=10 ib_service

echo ""
echo "🌐 Access URLs:"
echo "   Frontend: http://10.7.3.20:3000"
echo "   Backend API: http://10.7.3.20:4000"
echo "   IB Service: http://10.7.3.20:8000"
echo "   Settings Page: http://10.7.3.20:3000/settings"
echo ""
echo "🔗 IB Gateway Connection Info:"
echo "   Gateway: 10.7.3.21:4002"
echo "   Client ID: 1"
echo "   Type: IB Gateway (Socket)" 