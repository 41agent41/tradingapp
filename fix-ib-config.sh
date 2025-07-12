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

# Get current values
CURRENT_IB_HOST=$(grep "^IB_HOST=" .env 2>/dev/null | cut -d'=' -f2 || echo "")
CURRENT_IB_PORT=$(grep "^IB_PORT=" .env 2>/dev/null | cut -d'=' -f2 || echo "4002")
CURRENT_IB_CLIENT_ID=$(grep "^IB_CLIENT_ID=" .env 2>/dev/null | cut -d'=' -f2 || echo "1")

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

# Update .env file
echo -e "${BLUE}Updating .env file...${NC}"

# Remove existing lines if they exist
sed -i '/^IB_HOST=/d' .env 2>/dev/null || true
sed -i '/^IB_PORT=/d' .env 2>/dev/null || true
sed -i '/^IB_CLIENT_ID=/d' .env 2>/dev/null || true

# Add new lines
echo "IB_HOST=$IB_GATEWAY_IP" >> .env
echo "IB_PORT=$IB_GATEWAY_PORT" >> .env
echo "IB_CLIENT_ID=$IB_CLIENT_ID" >> .env

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