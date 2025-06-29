#!/bin/bash

# Setup environment file for TradingApp
echo "🔧 Setting up environment file..."

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
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

# Interactive Brokers Configuration
IB_HOST=10.7.3.21
IB_PORT_GATEWAY=4002
IB_CLIENT_ID=1
EOF
    echo "✅ .env file created successfully!"
else
    echo "✅ .env file already exists."
fi

# Set proper permissions
chmod 644 .env

echo "🎯 Environment setup complete!"
echo "📋 Current .env contents:"
echo "================================"
cat .env
echo "================================" 