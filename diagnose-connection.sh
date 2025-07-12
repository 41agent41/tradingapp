#!/bin/bash

# 🔍 TradingApp Connection Diagnostics Script
# Helps diagnose IB service connection issues on remote servers

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

print_header() {
    echo ""
    echo "=================================="
    echo "$1"
    echo "=================================="
}

print_header "🔍 TradingApp Connection Diagnostics"

# 1. Check Docker Status
print_header "1. Docker Service Status"
if command -v docker &> /dev/null; then
    print_status "Docker is installed"
    docker --version
    
    if docker info &> /dev/null; then
        print_status "Docker daemon is running"
    else
        print_error "Docker daemon is not running"
        echo "Try: sudo systemctl start docker"
    fi
else
    print_error "Docker is not installed"
    echo "Run: ./deploy-tradingapp.sh install"
fi

# 2. Check Container Status
print_header "2. Container Status"
if command -v docker &> /dev/null && docker info &> /dev/null; then
    echo "Running containers:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    
    echo ""
    echo "All containers (including stopped):"
    docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    
    # Check specific services
    echo ""
    for service in "tradingapp-backend-1" "tradingapp-ib_service-1" "tradingapp-frontend-1"; do
        if docker ps --filter "name=$service" --format "{{.Names}}" | grep -q "$service"; then
            print_status "$service is running"
        else
            print_error "$service is not running"
        fi
    done
else
    print_warning "Skipping container checks - Docker not available"
fi

# 3. Check Network Connectivity
print_header "3. Network Connectivity Tests"
if command -v docker &> /dev/null && docker info &> /dev/null; then
    # Test internal Docker network connectivity
    if docker ps --filter "name=tradingapp-backend-1" --format "{{.Names}}" | grep -q "tradingapp-backend-1"; then
        print_info "Testing internal network connectivity from backend to IB service..."
        
        # Test if backend can reach IB service internally
        if docker exec tradingapp-backend-1 curl -f -s http://ib_service:8000/health &> /dev/null; then
            print_status "Backend can reach IB service internally"
        else
            print_error "Backend cannot reach IB service internally"
            print_info "Testing basic network connectivity..."
            docker exec tradingapp-backend-1 ping -c 3 ib_service || print_warning "Ping failed"
        fi
    else
        print_warning "Backend container not running - cannot test internal connectivity"
    fi
    
    # Test external connectivity
    echo ""
    print_info "Testing external connectivity to services..."
    
    for port in 3000 4000 8000; do
        if curl -f -s http://localhost:$port/health &> /dev/null || curl -f -s http://localhost:$port &> /dev/null; then
            print_status "Port $port is accessible externally"
        else
            print_error "Port $port is not accessible externally"
        fi
    done
else
    print_warning "Skipping network tests - Docker not available"
fi

# 4. Check IB Service Logs
print_header "4. IB Service Logs (Last 20 lines)"
if command -v docker &> /dev/null && docker info &> /dev/null; then
    if docker ps --filter "name=tradingapp-ib_service-1" --format "{{.Names}}" | grep -q "tradingapp-ib_service-1"; then
        print_info "Recent IB service logs:"
        docker logs tradingapp-ib_service-1 --tail 20
    else
        print_error "IB service container not found"
        print_info "Available containers:"
        docker ps -a --format "table {{.Names}}\t{{.Status}}"
    fi
else
    print_warning "Skipping log checks - Docker not available"
fi

# 5. Check Environment Configuration
print_header "5. Environment Configuration"
if [ -f .env ]; then
    print_status ".env file exists"
    print_info "Key configuration values:"
    echo "IB_HOST: $(grep IB_HOST .env | cut -d'=' -f2 || echo 'not set')"
    echo "IB_PORT: $(grep IB_PORT .env | cut -d'=' -f2 || echo 'not set')"
    echo "IB_SERVICE_PORT: $(grep IB_SERVICE_PORT .env | cut -d'=' -f2 || echo 'not set')"
    echo "CORS_ORIGINS: $(grep CORS_ORIGINS .env | cut -d'=' -f2 || echo 'not set')"
else
    print_error ".env file not found"
    print_info "Create it with: ./deploy-tradingapp.sh env-setup"
fi

# 6. Test IB Service Endpoints
print_header "6. IB Service Endpoint Tests"
if command -v curl &> /dev/null; then
    for endpoint in "/health" "/connection" "/" "/market-data/history?symbol=MSFT&timeframe=1day&period=1M"; do
        print_info "Testing: http://localhost:8000$endpoint"
        
        response=$(curl -s -w "%{http_code}" http://localhost:8000$endpoint 2>/dev/null | tail -1)
        if [ "$response" = "200" ]; then
            print_status "✓ Endpoint $endpoint returned 200"
        else
            print_error "✗ Endpoint $endpoint returned $response"
        fi
    done
else
    print_warning "curl not available - cannot test endpoints"
fi

# 7. Check IB Gateway Connection
print_header "7. IB Gateway Connection Test"
if [ -f .env ]; then
    IB_HOST=$(grep IB_HOST .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    IB_PORT=$(grep IB_PORT .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    
    if [ -n "$IB_HOST" ] && [ -n "$IB_PORT" ]; then
        print_info "Testing connection to IB Gateway at $IB_HOST:$IB_PORT"
        
        if command -v telnet &> /dev/null; then
            if timeout 5 telnet $IB_HOST $IB_PORT &> /dev/null; then
                print_status "IB Gateway is reachable at $IB_HOST:$IB_PORT"
            else
                print_error "Cannot reach IB Gateway at $IB_HOST:$IB_PORT"
                print_info "Make sure IB Gateway is running and API is enabled"
            fi
        else
            print_warning "telnet not available - cannot test IB Gateway connection"
        fi
    else
        print_warning "IB_HOST or IB_PORT not configured"
    fi
else
    print_warning "Cannot test IB Gateway - .env file not found"
fi

# 8. Provide Recommendations
print_header "8. Troubleshooting Recommendations"

echo "Based on the diagnostics above, try these solutions:"
echo ""

print_info "🔧 Common Solutions:"
echo "1. Restart all services: ./deploy-tradingapp.sh restart"
echo "2. Rebuild services: ./deploy-tradingapp.sh rebuild" 
echo "3. Check logs: ./deploy-tradingapp.sh logs"
echo "4. Test connectivity: curl http://localhost:8000/health"
echo ""

print_info "🔧 If IB Service is not responding:"
echo "1. Rebuild IB service: ./deploy-tradingapp.sh ib-rebuild"
echo "2. Check IB Gateway is running and API is enabled"
echo "3. Verify IB_HOST and IB_PORT in .env file"
echo "4. Try connecting manually: docker exec -it tradingapp-ib_service-1 python -c \"from ib_insync import IB; ib = IB(); ib.connect('localhost', 4002, clientId=1); print('Connected:', ib.isConnected())\""
echo ""

print_info "🔧 If Network Issues:"
echo "1. Check firewall: sudo ufw status"
echo "2. Verify ports are open: netstat -tlnp | grep -E ':(3000|4000|8000)'"
echo "3. Check Docker network: docker network ls"
echo "4. Restart Docker: sudo systemctl restart docker"
echo ""

print_info "🔧 If Environment Issues:"
echo "1. Setup environment: ./deploy-tradingapp.sh env-setup"
echo "2. Update server IP in .env file"
echo "3. Verify IB Gateway configuration"
echo ""

print_header "Diagnostics Complete"
print_info "Run this script again after applying fixes to verify the solution" 