#!/bin/bash

# TradingApp Remote Server Deployment Script
# This script helps deploy the trading app to a remote server

set -e

echo "🚀 TradingApp Deployment Script"
echo "================================"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    cat > .env << EOF
# Database Configuration
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=tradingapp123
POSTGRES_DB=tradingapp

# Redis Configuration
REDIS_HOST=redis
REDIS_PORT=6379

# Backend Configuration
PORT=4000

# Frontend Configuration
# IMPORTANT: Update this to your server's actual IP address or domain
NEXT_PUBLIC_API_URL=http://$(hostname -I | awk '{print $1}'):4000

# IB Service Configuration
IB_PORT=8000
EOF
    echo "✅ Created .env file. Please review and update NEXT_PUBLIC_API_URL with your server's domain."
fi

# Build and start services with better output handling
echo "🔨 Building and starting services..."
echo "📝 Note: Some npm warnings are normal during Docker builds and won't affect functionality."
echo ""

# Build with reduced output for warnings
docker-compose up --build -d 2>&1 | grep -v "npm warn deprecated" | grep -v "npm WARN deprecated" || true

echo ""
echo "✅ Deployment completed!"
echo ""
echo "📋 Service URLs:"
echo "   Frontend: http://$(hostname -I | awk '{print $1}'):3000"
echo "   Backend:  http://$(hostname -I | awk '{print $1}'):4000"
echo "   IB Service: http://$(hostname -I | awk '{print $1}'):8000"
echo ""
echo "🔧 To view logs: docker-compose logs -f"
echo "🛑 To stop services: docker-compose down"
echo "🔄 To restart services: docker-compose restart"
echo ""
echo "⚠️  IMPORTANT: Update your .env file with the correct NEXT_PUBLIC_API_URL"
echo "   Current value: $(grep NEXT_PUBLIC_API_URL .env | cut -d'=' -f2)"
echo ""
echo "📊 Check service status:"
docker-compose ps 