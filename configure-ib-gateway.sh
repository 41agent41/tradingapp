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

# Function to read environment variable from .env file
read_env_var() {
    local var_name=$1
    local default_value=$2
    
    if [ -f .env ]; then
        local value=$(grep "^${var_name}=" .env | cut -d'=' -f2- 2>/dev/null || echo "")
        if [ -n "$value" ]; then
            echo "$value"
        else
            echo "$default_value"
        fi
    else
        echo "$default_value"
    fi
}

# Function to write environment variable to .env file
write_env_var() {
    local var_name=$1
    local value=$2
    
    if [ -f .env ]; then
        if grep -q "^${var_name}=" .env; then
            # Update existing line
            sed -i "s/^${var_name}=.*/${var_name}=${value}/" .env
        else
            # Add new line
            echo "${var_name}=${value}" >> .env
        fi
    else
        # Create .env file with the variable
        echo "${var_name}=${value}" > .env
    fi
}

# Function to display current configuration
show_config() {
    echo ""
    print_info "Current Configuration:"
    echo "========================"
    echo "IB Gateway IP: $(read_env_var 'IB_HOST' 'Not set')"
    echo "IB Gateway Port: $(read_env_var 'IB_PORT' '4002')"
    echo "Client ID: $(read_env_var 'IB_CLIENT_ID' '1')"
    echo ""
}

# Function to test connectivity
test_connectivity() {
    local host=$(read_env_var 'IB_HOST' '')
    local port=$(read_env_var 'IB_PORT' '4002')
    
    if [ -z "$host" ]; then
        print_error "IB_HOST is not configured"
        return 1
    fi
    
    print_info "Testing connectivity to IB Gateway at $host:$port..."
    
    # Test ping
    if ping -c 1 -W 3 "$host" > /dev/null 2>&1; then
        print_status "✅ Host is reachable"
    else
        print_warning "⚠️  Host is not reachable"
    fi
    
    # Test port connectivity (if nc is available)
    if command -v nc > /dev/null 2>&1; then
        if nc -z -w 3 "$host" "$port" 2>/dev/null; then
            print_status "✅ Port $port is accessible"
        else
            print_warning "⚠️  Port $port is not accessible"
        fi
    else
        print_info "Note: netcat not available, skipping port test"
    fi
}

echo "🔧 IB Gateway Configuration Helper"
echo "=================================="
echo ""

# Check if .env file exists, create if not
if [ ! -f .env ]; then
    print_info "Creating .env file..."
    touch .env
fi

# Ensure required variables exist with defaults
if [ -z "$(read_env_var 'IB_PORT' '')" ]; then
    write_env_var 'IB_PORT' '4002'
    print_info "Set IB_PORT=4002"
fi

if [ -z "$(read_env_var 'IB_CLIENT_ID' '')" ]; then
    write_env_var 'IB_CLIENT_ID' '1'
    print_info "Set IB_CLIENT_ID=1"
fi

# Show current configuration
show_config

# Get current IB_HOST value
CURRENT_IB_HOST=$(read_env_var 'IB_HOST' '')

# Check if IB_HOST needs configuration
if [ -z "$CURRENT_IB_HOST" ]; then
    print_warning "IB_HOST is not configured"
    echo ""
    
    echo "Please provide your remote IB Gateway configuration:"
    read -p "IB Gateway IP: " IB_GATEWAY_IP
    
    if [ -z "$IB_GATEWAY_IP" ]; then
        print_error "No IP address provided. Exiting."
        exit 1
    fi
    
    read -p "IB Gateway Port [4002]: " IB_GATEWAY_PORT
    IB_GATEWAY_PORT=${IB_GATEWAY_PORT:-4002}
    
    read -p "Client ID [1]: " IB_CLIENT_ID
    IB_CLIENT_ID=${IB_CLIENT_ID:-1}
    
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
    write_env_var 'IB_HOST' "$IB_GATEWAY_IP"
    write_env_var 'IB_PORT' "$IB_GATEWAY_PORT"
    write_env_var 'IB_CLIENT_ID' "$IB_CLIENT_ID"
    
    print_status "Configuration updated successfully!"
    
    # Show updated configuration
    show_config
    
    # Test connectivity
    test_connectivity
    
else
    print_status "IB_HOST is already configured"
    echo ""
    
    echo "Options:"
    echo "1. Test current connection"
    echo "2. Update IB Gateway configuration"
    echo "3. Exit"
    echo ""
    read -p "Choose an option (1-3): " -n 1 -r
    echo
    
    case $REPLY in
        1)
            test_connectivity
            ;;
        2)
            echo "Please provide the new IB Gateway configuration:"
            read -p "IB Gateway IP [$CURRENT_IB_HOST]: " IB_GATEWAY_IP
            IB_GATEWAY_IP=${IB_GATEWAY_IP:-$CURRENT_IB_HOST}
            
            CURRENT_IB_PORT=$(read_env_var 'IB_PORT' '4002')
            read -p "IB Gateway Port [$CURRENT_IB_PORT]: " IB_GATEWAY_PORT
            IB_GATEWAY_PORT=${IB_GATEWAY_PORT:-$CURRENT_IB_PORT}
            
            CURRENT_IB_CLIENT_ID=$(read_env_var 'IB_CLIENT_ID' '1')
            read -p "Client ID [$CURRENT_IB_CLIENT_ID]: " IB_CLIENT_ID
            IB_CLIENT_ID=${IB_CLIENT_ID:-$CURRENT_IB_CLIENT_ID}
            
            if [ -z "$IB_GATEWAY_IP" ]; then
                print_error "No IP address provided. Exiting."
                exit 1
            fi
            
            # Update the .env file
            print_info "Updating .env file..."
            write_env_var 'IB_HOST' "$IB_GATEWAY_IP"
            write_env_var 'IB_PORT' "$IB_GATEWAY_PORT"
            write_env_var 'IB_CLIENT_ID' "$IB_CLIENT_ID"
            
            print_status "Configuration updated successfully!"
            
            # Show updated configuration
            show_config
            
            # Test connectivity
            test_connectivity
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
print_info "Next steps:"
echo "1. Ensure your IB Gateway is running on the remote host"
echo "2. Make sure port $(read_env_var 'IB_PORT' '4002') is accessible from this server"
echo "3. Run './deploy-tradingapp.sh deploy' to deploy with new configuration"
echo "4. Run './deploy-tradingapp.sh test' to test all connections" 