#!/bin/bash

# Simple IB Gateway Configuration Fix
# This script will properly configure your IB Gateway connection

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔧 Simple IB Gateway Configuration Fix${NC}"
echo "=============================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}Creating .env file...${NC}"
    touch .env
fi

# Show current .env contents
echo -e "${BLUE}Current .env contents:${NC}"
echo "========================"
if [ -s .env ]; then
    cat .env
else
    echo "File is empty"
fi
echo ""

# Get current values (handle cases where variables are joined together)
CURRENT_IB_HOST=$(grep -o "IB_HOST=[^[:space:]]*" .env 2>/dev/null | head -1 | cut -d'=' -f2 || echo "")
CURRENT_IB_PORT=$(grep -o "IB_PORT=[^[:space:]]*" .env 2>/dev/null | head -1 | cut -d'=' -f2 || echo "4002")
CURRENT_IB_CLIENT_ID=$(grep -o "IB_CLIENT_ID=[^[:space:]]*" .env 2>/dev/null | head -1 | cut -d'=' -f2 || echo "1")

# Handle the case where IB_HOST is joined to another variable
if [ -z "$CURRENT_IB_HOST" ]; then
    # Look for patterns like REDIS_PORT=6379IB_HOST=10.7.3.21
    JOINED_LINE=$(grep "IB_HOST=" .env 2>/dev/null | head -1 || echo "")
    if [[ "$JOINED_LINE" =~ IB_HOST=([^[:space:]]*) ]]; then
        CURRENT_IB_HOST="${BASH_REMATCH[1]}"
    fi
fi

echo -e "${BLUE}Current Configuration:${NC}"
echo "IB Gateway IP: ${CURRENT_IB_HOST:-Not set}"
echo "IB Gateway Port: $CURRENT_IB_PORT"
echo "Client ID: $CURRENT_IB_CLIENT_ID"
echo ""

# Prompt for new values
echo "Please provide your IB Gateway configuration:"
read -p "IB Gateway IP [${CURRENT_IB_HOST:-10.7.3.21}]: " IB_GATEWAY_IP
IB_GATEWAY_IP=${IB_GATEWAY_IP:-${CURRENT_IB_HOST:-10.7.3.21}}

read -p "IB Gateway Port [$CURRENT_IB_PORT]: " IB_GATEWAY_PORT
IB_GATEWAY_PORT=${IB_GATEWAY_PORT:-$CURRENT_IB_PORT}

read -p "Client ID [$CURRENT_IB_CLIENT_ID]: " IB_CLIENT_ID
IB_CLIENT_ID=${IB_CLIENT_ID:-$CURRENT_IB_CLIENT_ID}

# Update .env file with proper formatting
echo -e "${BLUE}Reformatting .env file...${NC}"

# Create a properly formatted .env file
cat > .env.new << EOF
# Backend/Frontend
NODE_ENV=production
PORT=4000
FRONTEND_URL=http://10.7.3.20:3000
BACKEND_URL=http://10.7.3.20:4000
IB_SERVICE_URL=http://10.7.3.20:8000

# PostgreSQL
POSTGRES_USER=tradinguser
POSTGRES_PASSWORD=tradingpass
POSTGRES_DB=tradingdb
POSTGRES_HOST=postgres
POSTGRES_PORT=5432

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Interactive Brokers Configuration
IB_HOST=$IB_GATEWAY_IP
IB_PORT=$IB_GATEWAY_PORT
IB_CLIENT_ID=$IB_CLIENT_ID
EOF

# Replace the old .env file with the new one
mv .env.new .env

echo -e "${GREEN}✅ Configuration updated successfully!${NC}"
echo ""

# Show updated configuration
echo -e "${BLUE}Updated Configuration:${NC}"
echo "========================"
echo "IB Gateway IP: $IB_GATEWAY_IP"
echo "IB Gateway Port: $IB_GATEWAY_PORT"
echo "Client ID: $IB_CLIENT_ID"
echo ""

# Test connectivity
echo -e "${BLUE}Testing connectivity...${NC}"
if ping -c 1 -W 3 "$IB_GATEWAY_IP" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Host is reachable${NC}"
else
    echo -e "${YELLOW}⚠️  Host is not reachable${NC}"
fi

echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "1. Run './deploy-tradingapp.sh deploy' to deploy with new configuration"
echo "2. Run './deploy-tradingapp.sh test' to test all connections" 