#!/bin/bash

# 🔧 IB Gateway Configuration Script
# Helps configure the IB Gateway IP address for remote deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

echo "🔧 IB Gateway Configuration Script"
echo "=================================="
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    print_error ".env file not found!"
    print_info "Please run './deploy-tradingapp.sh env-setup' first to create the .env file."
    exit 1
fi

# Get current IB_HOST value
CURRENT_IB_HOST=$(grep "^IB_HOST=" .env | cut -d'=' -f2)
print_info "Current IB_HOST: $CURRENT_IB_HOST"

echo ""
print_info "Please provide the IP address of your IB Gateway:"
echo "   - This should be the IP address where IB Gateway is running"
echo "   - It can be a local IP (e.g., 192.168.1.100) or remote IP"
echo "   - Make sure IB Gateway is configured to accept connections on port 4002"
echo ""

read -p "Enter IB Gateway IP address: " IB_GATEWAY_IP

if [ -z "$IB_GATEWAY_IP" ]; then
    print_error "No IP address provided. Exiting."
    exit 1
fi

# Validate IP address format (basic validation)
if [[ ! $IB_GATEWAY_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    print_warning "Warning: The provided value doesn't look like a valid IP address."
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Configuration cancelled."
        exit 0
    fi
fi

# Update .env file
print_info "Updating .env file..."
sed -i "s/^IB_HOST=.*/IB_HOST=$IB_GATEWAY_IP/" .env

# Verify the change
NEW_IB_HOST=$(grep "^IB_HOST=" .env | cut -d'=' -f2)
if [ "$NEW_IB_HOST" = "$IB_GATEWAY_IP" ]; then
    print_status "IB_HOST updated successfully to: $IB_GATEWAY_IP"
else
    print_error "Failed to update IB_HOST"
    exit 1
fi

echo ""
print_info "Configuration Summary:"
echo "   IB Gateway IP: $IB_GATEWAY_IP"
echo "   IB Gateway Port: 4002"
echo "   IB Client ID: 1"
echo ""

print_info "Next steps:"
echo "   1. Ensure IB Gateway is running on $IB_GATEWAY_IP:4002"
echo "   2. Verify IB Gateway is configured to accept API connections"
echo "   3. Run './deploy-tradingapp.sh ib-rebuild-fixed' to apply changes"
echo ""

print_warning "Important: Make sure IB Gateway is configured to:"
echo "   - Accept connections from this server's IP"
echo "   - Allow API connections on port 4002"
echo "   - Have the correct client ID (1) available"
echo ""

read -p "Would you like to test the connection now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Testing connection to IB Gateway..."
    if nc -z -w5 $IB_GATEWAY_IP 4002; then
        print_status "Connection test successful! Port 4002 is accessible."
    else
        print_error "Connection test failed! Cannot reach $IB_GATEWAY_IP:4002"
        print_warning "Please check:"
        echo "   - IB Gateway is running"
        echo "   - Port 4002 is open"
        echo "   - Firewall allows connections"
        echo "   - Network connectivity"
    fi
fi

print_status "Configuration complete!" 