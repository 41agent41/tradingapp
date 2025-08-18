#!/bin/bash

# 🔧 TradingApp Database Configuration Script
# Configures external PostgreSQL and Redis connections

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

# Default values
DEFAULT_POSTGRES_HOST="localhost"
DEFAULT_POSTGRES_PORT="5432"
DEFAULT_POSTGRES_USER="tradingapp"
DEFAULT_POSTGRES_DB="trading_timeseries"
DEFAULT_REDIS_HOST="localhost"
DEFAULT_REDIS_PORT="6379"

show_usage() {
    echo "🔧 TradingApp Database Configuration Script"
    echo "=========================================="
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --postgres-host HOST     PostgreSQL host (default: localhost)"
    echo "  --postgres-port PORT     PostgreSQL port (default: 5432)"
    echo "  --postgres-user USER     PostgreSQL username (default: tradingapp)"
    echo "  --postgres-password PASS PostgreSQL password"
    echo "  --postgres-db DB         PostgreSQL database (default: trading_timeseries)"
    echo "  --redis-host HOST        Redis host (default: localhost)"
    echo "  --redis-port PORT        Redis port (default: 6379)"
    echo "  --redis-password PASS    Redis password (optional)"
    echo "  --ssl                    Enable SSL for PostgreSQL"
    echo "  --redis-ssl              Enable SSL for Redis"
    echo "  --test                   Test connections after configuration"
    echo "  --help                   Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --postgres-host db.company.com --postgres-password mypass"
    echo "  $0 --redis-host cache.company.com --redis-password redispass"
    echo "  $0 --test"
}

# Parse command line arguments
POSTGRES_HOST=""
POSTGRES_PORT=""
POSTGRES_USER=""
POSTGRES_PASSWORD=""
POSTGRES_DB=""
REDIS_HOST=""
REDIS_PORT=""
REDIS_PASSWORD=""
ENABLE_SSL=false
ENABLE_REDIS_SSL=false
TEST_CONNECTIONS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --postgres-host)
            POSTGRES_HOST="$2"
            shift 2
            ;;
        --postgres-port)
            POSTGRES_PORT="$2"
            shift 2
            ;;
        --postgres-user)
            POSTGRES_USER="$2"
            shift 2
            ;;
        --postgres-password)
            POSTGRES_PASSWORD="$2"
            shift 2
            ;;
        --postgres-db)
            POSTGRES_DB="$2"
            shift 2
            ;;
        --redis-host)
            REDIS_HOST="$2"
            shift 2
            ;;
        --redis-port)
            REDIS_PORT="$2"
            shift 2
            ;;
        --redis-password)
            REDIS_PASSWORD="$2"
            shift 2
            ;;
        --ssl)
            ENABLE_SSL=true
            shift
            ;;
        --redis-ssl)
            ENABLE_REDIS_SSL=true
            shift
            ;;
        --test)
            TEST_CONNECTIONS=true
            shift
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Interactive configuration if no arguments provided
if [[ -z "$POSTGRES_HOST" && -z "$REDIS_HOST" ]]; then
    print_info "Interactive database configuration mode"
    echo ""
    
    # PostgreSQL Configuration
    print_info "PostgreSQL Configuration:"
    read -p "PostgreSQL Host [$DEFAULT_POSTGRES_HOST]: " input
    POSTGRES_HOST=${input:-$DEFAULT_POSTGRES_HOST}
    
    read -p "PostgreSQL Port [$DEFAULT_POSTGRES_PORT]: " input
    POSTGRES_PORT=${input:-$DEFAULT_POSTGRES_PORT}
    
    read -p "PostgreSQL Username [$DEFAULT_POSTGRES_USER]: " input
    POSTGRES_USER=${input:-$DEFAULT_POSTGRES_USER}
    
    read -s -p "PostgreSQL Password: " POSTGRES_PASSWORD
    echo ""
    
    read -p "PostgreSQL Database [$DEFAULT_POSTGRES_DB]: " input
    POSTGRES_DB=${input:-$DEFAULT_POSTGRES_DB}
    
    read -p "Enable SSL for PostgreSQL? (y/N): " ssl_input
    if [[ "$ssl_input" =~ ^[Yy]$ ]]; then
        ENABLE_SSL=true
    fi
    
    echo ""
    
    # Redis Configuration
    print_info "Redis Configuration:"
    read -p "Redis Host [$DEFAULT_REDIS_HOST]: " input
    REDIS_HOST=${input:-$DEFAULT_REDIS_HOST}
    
    read -p "Redis Port [$DEFAULT_REDIS_PORT]: " input
    REDIS_PORT=${input:-$DEFAULT_REDIS_PORT}
    
    read -s -p "Redis Password (optional): " REDIS_PASSWORD
    echo ""
    
    read -p "Enable SSL for Redis? (y/N): " redis_ssl_input
    if [[ "$redis_ssl_input" =~ ^[Yy]$ ]]; then
        ENABLE_REDIS_SSL=true
    fi
    
    echo ""
    
    read -p "Test connections after configuration? (Y/n): " test_input
    if [[ "$test_input" =~ ^[Nn]$ ]]; then
        TEST_CONNECTIONS=false
    else
        TEST_CONNECTIONS=true
    fi
fi

# Validate required parameters
if [[ -z "$POSTGRES_HOST" || -z "$POSTGRES_USER" || -z "$POSTGRES_PASSWORD" ]]; then
    print_error "PostgreSQL host, username, and password are required"
    exit 1
fi

if [[ -z "$REDIS_HOST" ]]; then
    print_error "Redis host is required"
    exit 1
fi

# Backup existing .env file
if [[ -f ".env" ]]; then
    cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
    print_info "Backed up existing .env file"
fi

# Update .env file
print_info "Updating .env file with database configuration..."

# Read existing .env file
if [[ -f ".env" ]]; then
    env_content=$(cat .env)
else
    env_content=""
fi

# Function to update or add environment variable
update_env_var() {
    local var_name="$1"
    local var_value="$2"
    
    if echo "$env_content" | grep -q "^${var_name}="; then
        # Variable exists, update it
        env_content=$(echo "$env_content" | sed "s/^${var_name}=.*/${var_name}=${var_value}/")
    else
        # Variable doesn't exist, add it
        env_content="${env_content}\n${var_name}=${var_value}"
    fi
}

# Update PostgreSQL configuration
update_env_var "POSTGRES_HOST" "$POSTGRES_HOST"
update_env_var "POSTGRES_PORT" "$POSTGRES_PORT"
update_env_var "POSTGRES_USER" "$POSTGRES_USER"
update_env_var "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
update_env_var "POSTGRES_DB" "$POSTGRES_DB"

if [[ "$ENABLE_SSL" == "true" ]]; then
    update_env_var "POSTGRES_SSL_MODE" "require"
else
    update_env_var "POSTGRES_SSL_MODE" "disable"
fi

# Update Redis configuration
update_env_var "REDIS_HOST" "$REDIS_HOST"
update_env_var "REDIS_PORT" "$REDIS_PORT"

if [[ -n "$REDIS_PASSWORD" ]]; then
    update_env_var "REDIS_PASSWORD" "$REDIS_PASSWORD"
fi

if [[ "$ENABLE_REDIS_SSL" == "true" ]]; then
    update_env_var "REDIS_SSL_ENABLED" "true"
else
    update_env_var "REDIS_SSL_ENABLED" "false"
fi

# Write updated .env file
echo -e "$env_content" > .env

print_status "Database configuration updated in .env file"

# Test connections if requested
if [[ "$TEST_CONNECTIONS" == "true" ]]; then
    echo ""
    print_info "Testing database connections..."
    
    # Test PostgreSQL connection
    print_info "Testing PostgreSQL connection..."
    if command -v psql &> /dev/null; then
        export PGPASSWORD="$POSTGRES_PASSWORD"
        if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version();" &> /dev/null; then
            print_status "PostgreSQL connection successful"
        else
            print_error "PostgreSQL connection failed"
        fi
        unset PGPASSWORD
    else
        print_warning "psql not found, skipping PostgreSQL connection test"
    fi
    
    # Test Redis connection
    print_info "Testing Redis connection..."
    if command -v redis-cli &> /dev/null; then
        if [[ -n "$REDIS_PASSWORD" ]]; then
            if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" ping &> /dev/null; then
                print_status "Redis connection successful"
            else
                print_error "Redis connection failed"
            fi
        else
            if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping &> /dev/null; then
                print_status "Redis connection successful"
            else
                print_error "Redis connection failed"
            fi
        fi
    else
        print_warning "redis-cli not found, skipping Redis connection test"
    fi
fi

echo ""
print_status "Database configuration completed!"
print_info "You can now deploy the application with: ./tradingapp.sh deploy"