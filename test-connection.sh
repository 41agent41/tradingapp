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
echo "🌐 Access URLs:"
echo "   Frontend: http://10.7.3.20:3000"
echo "   Backend API: http://10.7.3.20:4000"
echo "   Settings Page: http://10.7.3.20:3000/settings" 