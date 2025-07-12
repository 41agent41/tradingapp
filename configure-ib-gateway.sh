#!/bin/bash

# 🔧 IB Gateway Configuration Helper
# This script helps configure the connection to your remote IB Gateway

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

echo "🔧 IB Gateway Configuration Helper"
echo "=================================="
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    print_error ".env file not found. Please run './deploy-tradingapp.sh deploy' first to create it."
    exit 1
fi

# Function to ensure required environment variables exist
ensure_env_vars() {
    local missing_vars=()
    
    # Check for required variables
    if ! grep -q "^IB_PORT=" .env; then
        missing_vars+=("IB_PORT")
    fi
    
    if ! grep -q "^IB_CLIENT_ID=" .env; then
        missing_vars+=("IB_CLIENT_ID")
    fi
    
    # Add missing variables with defaults
    for var in "${missing_vars[@]}"; do
        case $var in
            "IB_PORT")
                echo "IB_PORT=4002" >> .env
                print_info "Added IB_PORT=4002"
                ;;
            "IB_CLIENT_ID")
                echo "IB_CLIENT_ID=1" >> .env
                print_info "Added IB_CLIENT_ID=1"
                ;;
        esac
    done
}

# Ensure all required variables exist
ensure_env_vars

# Get current IB_HOST value (handle empty or missing values)
CURRENT_IB_HOST=$(grep "^IB_HOST=" .env | cut -d'=' -f2 2>/dev/null || echo "")

print_info "Current IB_HOST configuration: $CURRENT_IB_HOST"
echo ""

# Check if it's still the default value or empty
if [[ -z "$CURRENT_IB_HOST" || "$CURRENT_IB_HOST" == "localhost" || "$CURRENT_IB_HOST" == "YOUR_IB_GATEWAY_IP" ]]; then
    print_warning "IB_HOST is still set to default value"
    echo ""
    
    echo "Please provide your remote IB Gateway IP address:"
    read -p "IB Gateway IP: " IB_GATEWAY_IP
    
    if [ -z "$IB_GATEWAY_IP" ]; then
        print_error "No IP address provided. Exiting."
        exit 1
    fi
    
    # Validate IP address format (basic validation)
    if [[ ! $IB_GATEWAY_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        print_warning "Warning: The provided value doesn't look like a valid IP address"
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
    
    # Update the .env file
    print_info "Updating .env file..."
    if grep -q "^IB_HOST=" .env; then
        # Update existing line
        sed -i "s/^IB_HOST=.*/IB_HOST=$IB_GATEWAY_IP/" .env
    else
        # Add new line
        echo "IB_HOST=$IB_GATEWAY_IP" >> .env
    fi
    
    print_status "IB_HOST updated to: $IB_GATEWAY_IP"
    echo ""
    
    # Test connectivity
    print_info "Testing connectivity to IB Gateway..."
    if ping -c 1 -W 3 "$IB_GATEWAY_IP" > /dev/null 2>&1; then
        print_status "✅ IB Gateway is reachable"
    else
        print_warning "⚠️  Could not reach IB Gateway at $IB_GATEWAY_IP"
        print_info "This might be normal if the gateway is not running or behind a firewall"
    fi
    
else
    print_status "IB_HOST is already configured: $CURRENT_IB_HOST"
    echo ""
    
    echo "Options:"
    echo "1. Test current connection"
    echo "2. Update IB Gateway IP"
    echo "3. Exit"
    echo ""
    read -p "Choose an option (1-3): " -n 1 -r
    echo
    
    case $REPLY in
        1)
            print_info "Testing connectivity to IB Gateway..."
            if ping -c 1 -W 3 "$CURRENT_IB_HOST" > /dev/null 2>&1; then
                print_status "✅ IB Gateway is reachable"
            else
                print_warning "⚠️  Could not reach IB Gateway at $CURRENT_IB_HOST"
            fi
            ;;
        2)
            echo "Please provide the new IB Gateway IP address:"
            read -p "IB Gateway IP: " IB_GATEWAY_IP
            
            if [ -z "$IB_GATEWAY_IP" ]; then
                print_error "No IP address provided. Exiting."
                exit 1
            fi
            
            if grep -q "^IB_HOST=" .env; then
                # Update existing line
                sed -i "s/^IB_HOST=.*/IB_HOST=$IB_GATEWAY_IP/" .env
            else
                # Add new line
                echo "IB_HOST=$IB_GATEWAY_IP" >> .env
            fi
            print_status "IB_HOST updated to: $IB_GATEWAY_IP"
            ;;
        3)
            print_info "Exiting..."
            exit 0
            ;;
        *)
            print_error "Invalid option"
            exit 1
            ;;
    esac
fi

echo ""
print_info "Configuration Summary:"
echo "=========================="
echo "IB Gateway IP: $(grep "^IB_HOST=" .env | cut -d'=' -f2 2>/dev/null || echo "Not set")"
echo "IB Gateway Port: $(grep "^IB_PORT=" .env | cut -d'=' -f2 2>/dev/null || echo "Not set")"
echo "Client ID: $(grep "^IB_CLIENT_ID=" .env | cut -d'=' -f2 2>/dev/null || echo "Not set")"
echo ""

print_info "Next steps:"
echo "1. Ensure your IB Gateway is running on the remote host"
echo "2. Make sure port 4002 is accessible from this server"
echo "3. Run './deploy-tradingapp.sh deploy' to deploy with new configuration"
echo "4. Run './deploy-tradingapp.sh test' to test all connections" 