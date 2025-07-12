#!/bin/bash

# 🔧 TradingApp IB Connection Fix Script
# Automatically fixes common IB service connection issues

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

print_header "🔧 TradingApp IB Connection Fix"

# Function to check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Run: ./deploy-tradingapp.sh install"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker daemon is not running. Starting Docker..."
        sudo systemctl start docker
        sudo systemctl enable docker
        sleep 5
    fi
}

# Function to create environment file if missing
setup_environment() {
    if [ ! -f .env ]; then
        print_warning ".env file not found. Creating default configuration..."
        
        # Get server IP
        SERVER_IP=$(hostname -I | awk '{print $1}' | head -1)
        
        cat > .env << EOF
# ==============================================
# TradingApp Environment Configuration
# ==============================================

# ===== DEPLOYMENT CONFIGURATION =====
NODE_ENV=production
DEPLOYMENT_TYPE=remote
SERVER_HOST=0.0.0.0

# ===== FRONTEND CONFIGURATION =====
NEXT_PUBLIC_API_URL=http://${SERVER_IP}:4000
FRONTEND_PORT=3000

# ===== BACKEND CONFIGURATION =====
BACKEND_PORT=4000
CORS_ORIGINS=http://${SERVER_IP}:3000

# ===== IB SERVICE CONFIGURATION =====
IB_SERVICE_PORT=8000
IB_HOST=localhost
IB_PORT=4002
IB_CLIENT_ID=1
IB_LOG_LEVEL=INFO

# ===== DATABASE CONFIGURATION =====
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=tradingapp_secure_password_2024
POSTGRES_DB=tradingapp

# ===== REDIS CONFIGURATION =====
REDIS_HOST=redis
REDIS_PORT=6379

# ===== SECURITY CONFIGURATION =====
JWT_SECRET=your_jwt_secret_key_here_$(date +%s)
SESSION_SECRET=your_session_secret_key_here_$(date +%s)

# ===== DOCKER CONFIGURATION =====
COMPOSE_PROJECT_NAME=tradingapp
DOCKER_BUILDKIT=1
EOF
        
        print_status ".env file created with server IP: $SERVER_IP"
        print_info "Please verify IB_HOST setting if your IB Gateway is on a different machine"
    else
        print_status ".env file exists"
    fi
}

# Function to fix IB service issues
fix_ib_service() {
    print_header "Step 1: Fixing IB Service Issues"
    
    # Stop the IB service container
    print_info "Stopping IB service..."
    docker-compose stop ib_service 2>/dev/null || true
    
    # Remove the container to force rebuild
    print_info "Removing IB service container..."
    docker-compose rm -f ib_service 2>/dev/null || true
    
    # Remove the image to force rebuild
    print_info "Removing IB service image..."
    docker rmi tradingapp-ib_service 2>/dev/null || true
    
    # Rebuild the IB service
    print_info "Rebuilding IB service..."
    docker-compose build --no-cache ib_service
    
    # Start the IB service
    print_info "Starting IB service..."
    docker-compose up -d ib_service
    
    # Wait for service to start
    print_info "Waiting for IB service to start..."
    sleep 10
    
    # Test if service is responding
    for i in {1..30}; do
        if curl -f -s http://localhost:8000/health &> /dev/null; then
            print_status "IB service is now responding!"
            break
        fi
        
        if [ $i -eq 30 ]; then
            print_error "IB service still not responding after 30 attempts"
            print_info "Check logs: docker logs tradingapp-ib_service-1"
        else
            echo -n "."
            sleep 2
        fi
    done
}

# Function to fix network connectivity
fix_network() {
    print_header "Step 2: Fixing Network Connectivity"
    
    # Restart Docker network
    print_info "Recreating Docker network..."
    docker-compose down --remove-orphans 2>/dev/null || true
    docker network prune -f 2>/dev/null || true
    
    # Start all services
    print_info "Starting all services..."
    docker-compose up -d
    
    # Wait for services
    print_info "Waiting for all services to start..."
    sleep 15
    
    # Test connectivity
    print_info "Testing service connectivity..."
    for port in 3000 4000 8000; do
        if curl -f -s http://localhost:$port/health &> /dev/null || curl -f -s http://localhost:$port &> /dev/null; then
            print_status "Port $port is accessible"
        else
            print_warning "Port $port is not accessible"
        fi
    done
}

# Function to test IB Gateway connection
test_ib_gateway() {
    print_header "Step 3: Testing IB Gateway Connection"
    
    if [ -f .env ]; then
        IB_HOST=$(grep IB_HOST .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" | xargs)
        IB_PORT=$(grep IB_PORT .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" | xargs)
        
        if [ -n "$IB_HOST" ] && [ -n "$IB_PORT" ]; then
            print_info "Testing connection to IB Gateway at $IB_HOST:$IB_PORT"
            
            if timeout 5 bash -c "echo >/dev/tcp/$IB_HOST/$IB_PORT" 2>/dev/null; then
                print_status "IB Gateway is reachable at $IB_HOST:$IB_PORT"
                
                # Try to connect via IB service
                print_info "Testing IB connection via service..."
                response=$(curl -s -X POST http://localhost:8000/connect 2>/dev/null || echo "failed")
                if echo "$response" | grep -q "Successfully connected"; then
                    print_status "IB service successfully connected to IB Gateway"
                else
                    print_warning "IB service connection attempt returned: $response"
                fi
            else
                print_error "Cannot reach IB Gateway at $IB_HOST:$IB_PORT"
                print_info "Please verify:"
                print_info "1. IB Gateway/TWS is running"
                print_info "2. API access is enabled in IB Gateway/TWS"
                print_info "3. Correct host and port in .env file"
                print_info "4. Firewall allows connection on port $IB_PORT"
            fi
        else
            print_warning "IB_HOST or IB_PORT not configured in .env"
        fi
    fi
}

# Function to update backend configuration
fix_backend() {
    print_header "Step 4: Fixing Backend Configuration"
    
    # Restart backend to ensure it picks up the IB service
    print_info "Restarting backend service..."
    docker-compose restart backend
    
    # Wait for backend
    sleep 10
    
    # Test backend connectivity to IB service
    if docker ps --filter "name=tradingapp-backend-1" --format "{{.Names}}" | grep -q "tradingapp-backend-1"; then
        print_info "Testing backend to IB service connectivity..."
        
        if docker exec tradingapp-backend-1 curl -f -s http://ib_service:8000/health &> /dev/null; then
            print_status "Backend can now reach IB service"
        else
            print_warning "Backend still cannot reach IB service"
            print_info "Checking backend logs..."
            docker logs tradingapp-backend-1 --tail 10
        fi
    fi
}

# Function to verify the fix
verify_fix() {
    print_header "Step 5: Verification"
    
    print_info "Testing all endpoints..."
    
    # Test frontend
    if curl -f -s http://localhost:3000 &> /dev/null; then
        print_status "✓ Frontend is accessible"
    else
        print_warning "✗ Frontend is not accessible"
    fi
    
    # Test backend
    if curl -f -s http://localhost:4000/api/ib-status &> /dev/null; then
        print_status "✓ Backend is accessible"
    else
        print_warning "✗ Backend is not accessible"
    fi
    
    # Test IB service
    if curl -f -s http://localhost:8000/health &> /dev/null; then
        print_status "✓ IB service is accessible"
    else
        print_warning "✗ IB service is not accessible"
    fi
    
    # Test IB connection status
    print_info "Checking IB connection status..."
    ib_status=$(curl -s http://localhost:8000/connection 2>/dev/null || echo "failed")
    if echo "$ib_status" | grep -q '"connected": *true'; then
        print_status "✓ IB service is connected to IB Gateway"
    else
        print_warning "✗ IB service is not connected to IB Gateway"
        print_info "Response: $ib_status"
    fi
}

# Main execution
main() {
    check_docker
    setup_environment
    fix_ib_service
    fix_network
    test_ib_gateway
    fix_backend
    verify_fix
    
    print_header "🎉 Fix Complete!"
    
    print_info "Summary of actions taken:"
    echo "1. ✅ Verified Docker is running"
    echo "2. ✅ Created/verified .env configuration"
    echo "3. ✅ Rebuilt IB service from scratch"
    echo "4. ✅ Fixed network connectivity"
    echo "5. ✅ Tested IB Gateway connection"
    echo "6. ✅ Restarted backend service"
    echo "7. ✅ Verified all endpoints"
    echo ""
    
    print_info "🌐 Your services should now be accessible at:"
    if [ -f .env ]; then
        SERVER_IP=$(grep NEXT_PUBLIC_API_URL .env | cut -d'=' -f2 | sed 's|http://||' | cut -d':' -f1)
        echo "Frontend: http://$SERVER_IP:3000"
        echo "Backend:  http://$SERVER_IP:4000"
        echo "IB Service: http://$SERVER_IP:8000"
    else
        echo "Frontend: http://localhost:3000"
        echo "Backend:  http://localhost:4000"
        echo "IB Service: http://localhost:8000"
    fi
    echo ""
    
    print_info "🔍 If issues persist:"
    echo "1. Run diagnostics: ./diagnose-connection.sh"
    echo "2. Check logs: ./deploy-tradingapp.sh logs"
    echo "3. Verify IB Gateway is running with API enabled"
    echo "4. Check firewall settings on your server"
}

# Show usage if help requested
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "🔧 TradingApp IB Connection Fix Script"
    echo "======================================"
    echo ""
    echo "This script automatically fixes common IB service connection issues:"
    echo "• Creates missing .env configuration"
    echo "• Rebuilds IB service container"
    echo "• Fixes network connectivity"
    echo "• Tests IB Gateway connection"
    echo "• Restarts backend service"
    echo "• Verifies all endpoints"
    echo ""
    echo "Usage: ./fix-ib-connection.sh"
    echo ""
    echo "No arguments required - the script will automatically detect and fix issues."
    exit 0
fi

# Run the main function
main 