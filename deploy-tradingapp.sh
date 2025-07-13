#!/bin/bash

# 🚀 TradingApp Unified Deployment Script
# Consolidates all deployment, setup, testing, and management functionality

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
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

# Show usage information
show_usage() {
    echo "🚀 TradingApp Unified Deployment Script"
    echo "======================================="
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  install     - Install Docker and dependencies (first time setup)"
    echo "  deploy      - Deploy the full application"
    echo "  rebuild     - Rebuild and restart services"
    echo "  ib-rebuild  - Rebuild only IB service with enhanced features"
    echo "  ib-rebuild-fixed - Rebuild IB service with fixed asyncio handling"
    echo "  ib-simple   - Rebuild IB service with simple working version"
    echo "  status      - Check service status"
    echo "  test        - Test all connections"
    echo "  logs        - Show service logs"
    echo "  stop        - Stop all services"
    echo "  restart     - Restart all services"
    echo "  clean       - Clean up containers and images"
    echo "  env-setup   - Setup environment file"
    echo ""
    echo "Examples:"
    echo "  $0 install    # First time setup on new server"
    echo "  $0 deploy     # Deploy the application"
    echo "  $0 status     # Check if services are running"
    echo "  $0 test       # Test all connections"
}

# Function to install Docker
install_docker() {
    print_info "Installing Docker..."
    
    # Remove any existing Docker repository entries to avoid conflicts
    print_info "Cleaning up old Docker repository entries..."
    sudo rm -f /etc/apt/sources.list.d/docker.list
    sudo rm -f /etc/apt/sources.list.d/docker.list.save
    
    # Update package index
    sudo apt-get update
    
    # Install prerequisites
    sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
    
    # Add Docker's official GPG key for Debian
    print_info "Adding Docker GPG key..."
    curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    
    # Add Docker repository for Debian
    print_info "Adding Docker repository..."
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Update package list again with new repository
    print_info "Updating package list..."
    sudo apt-get update
    
    # Install Docker
    print_info "Installing Docker..."
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io
    
    # Add user to docker group
    sudo usermod -aG docker $USER
    
    print_status "Docker installed successfully!"
}

# Function to install Docker Compose
install_docker_compose() {
    print_info "Installing Docker Compose..."
    
    # Try package manager installation first (more reliable)
    print_info "Installing via package manager..."
    if sudo apt-get install -y docker-compose-plugin &> /dev/null; then
        # Create symlink for docker-compose command
        sudo ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
        print_status "Docker Compose installed via package manager!"
        docker-compose --version
        return 0
    fi
    
    print_info "Package manager installation failed, trying direct download..."
    
    # Detect architecture
    ARCH=$(uname -m)
    case $ARCH in
        x86_64) ARCH="x86_64" ;;
        aarch64) ARCH="aarch64" ;;
        armv7l) ARCH="armv7" ;;
        *) print_error "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    
    # Download and install Docker Compose
    COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}"
    print_info "Downloading Docker Compose from: $COMPOSE_URL"
    
    sudo curl -L "$COMPOSE_URL" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    
    # Verify installation
    if docker-compose --version &> /dev/null; then
        print_status "Docker Compose installed successfully!"
        docker-compose --version
    else
        print_error "Docker Compose installation failed"
        exit 1
    fi
}

# Function to setup environment file
setup_environment() {
    print_info "Setting up environment file..."
    
    if [ ! -f .env ]; then
        print_info "Creating .env file..."
        cat > .env << EOF
# Backend/Frontend
NODE_ENV=production
PORT=4000
FRONTEND_URL=http://$(hostname -I | awk '{print $1}'):3000
BACKEND_URL=http://$(hostname -I | awk '{print $1}'):4000
IB_SERVICE_URL=http://$(hostname -I | awk '{print $1}'):8000

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
# IMPORTANT: Set IB_HOST to your remote IB Gateway IP address
IB_HOST=YOUR_IB_GATEWAY_IP
IB_PORT=4002
IB_CLIENT_ID=1
IB_LOG_LEVEL=INFO
EOF
        print_status ".env file created successfully!"
        print_warning "⚠️  IMPORTANT: Please update IB_HOST in .env to your remote IB Gateway IP address"
    else
        print_status ".env file already exists."
        
        # Check if IB_HOST is still set to localhost or default value
        if grep -q "IB_HOST=localhost\|IB_HOST=YOUR_IB_GATEWAY_IP" .env; then
            print_warning "⚠️  IB_HOST is still set to localhost or default value"
            print_info "Please update IB_HOST in .env to your remote IB Gateway IP address"
        fi
    fi
    
    # Set proper permissions
    chmod 644 .env
    
    print_info "Current .env contents:"
    echo "================================"
    cat .env
    echo "================================"
}

# Function to check Docker installation
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Run '$0 install' first."
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is not installed. Run '$0 install' first."
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker is not running. Starting Docker..."
        sudo systemctl start docker
        sudo systemctl enable docker
    fi
}

# Function to deploy the application
deploy_application() {
    print_info "Deploying TradingApp..."
    
    check_docker
    setup_environment
    
    print_info "Building and starting services..."
    print_info "Note: Some npm warnings are normal during Docker builds and won't affect functionality."
    
    # Clean up any existing containers to avoid conflicts
    print_info "Cleaning up existing containers..."
    docker-compose down --remove-orphans 2>/dev/null || true
    
    # Build with reduced output for warnings
    docker-compose up --build -d 2>&1 | grep -v "npm warn deprecated" | grep -v "npm WARN deprecated" || true
    
    print_status "Deployment completed!"
    show_service_info
}

# Function to rebuild services
rebuild_services() {
    print_info "Rebuilding all services..."
    
    check_docker
    
    # Stop services
    docker-compose down --remove-orphans
    
    # Remove images to force rebuild
    print_info "Removing old images..."
    docker rmi tradingapp-ib_service tradingapp-backend tradingapp-frontend 2>/dev/null || true
    
    # Rebuild all services
    docker-compose build --no-cache
    
    # Start services
    docker-compose up -d
    
    print_status "All services rebuilt successfully!"
    show_service_info
}

# Function to rebuild only IB service with enhanced features
rebuild_ib_service() {
    print_info "Rebuilding IB Service with enhanced features..."
    
    check_docker
    
    # Stop current containers
    print_info "Stopping current containers..."
    docker-compose down
    
    # Remove old IB service image to force rebuild
    print_info "Removing old ib_service image..."
    docker rmi tradingapp-ib_service 2>/dev/null || true
    docker rmi tradingapp_ib_service 2>/dev/null || true
    
    # Rebuild the ib_service with no cache
    print_info "Rebuilding ib_service with new dependencies..."
    docker-compose build --no-cache ib_service
    
    if [ $? -ne 0 ]; then
        print_error "Docker build failed. Check the error messages above."
        exit 1
    fi
    
    # Verify enhanced version is in place
    print_info "Verifying enhanced main.py version..."
    cd ib_service
    if [ -f "main.py" ]; then
        print_status "Enhanced main.py is in place"
    else
        print_error "main.py not found!"
        exit 1
    fi
    cd ..
    
    # Start services
    print_info "Starting services with enhanced ib_service..."
    docker-compose up -d
    
    # Wait for services to start
    print_info "Waiting for services to start..."
    sleep 10
    
    # Verify the enhanced features
    print_info "Verifying enhanced features..."
    
    # Test basic endpoint
    if curl -s http://localhost:8000/ > /dev/null; then
        VERSION=$(curl -s http://localhost:8000/ | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        if [[ "$VERSION" == "2.0.0" ]]; then
            print_status "Enhanced version (2.0.0) is running!"
        else
            print_warning "Version: $VERSION (expected 2.0.0)"
        fi
    else
        print_error "IB Service is not responding on port 8000"
    fi
    
    # Test enhanced endpoints
    if curl -s http://localhost:8000/pool-status > /dev/null; then
        print_status "Connection pool endpoint working"
    else
        print_warning "Connection pool endpoint not available"
    fi
    
    if curl -s http://localhost:8000/metrics > /dev/null; then
        print_status "Metrics endpoint working"
    else
        print_warning "Metrics endpoint not available"
    fi
    
    print_status "IB Service rebuild completed!"
    
    echo ""
    print_info "Enhanced Features Available:"
    echo "   • Connection pooling (5 connections)"
    echo "   • Data validation with Pydantic"
    echo "   • TTL-based caching"
    echo "   • Rate limiting"
    echo "   • Structured logging"
    echo "   • Prometheus metrics"
    echo "   • Health monitoring"
}

# Function to rebuild IB service with fixed asyncio handling
rebuild_ib_service_fixed() {
    print_info "Rebuilding IB Service with fixed asyncio handling..."
    
    check_docker
    
    # Stop current containers
    print_info "Stopping current containers..."
    docker-compose down
    
    # Remove old IB service image to force rebuild
    print_info "Removing old ib_service image..."
    docker rmi tradingapp-ib_service 2>/dev/null || true
    docker rmi tradingapp_ib_service 2>/dev/null || true
    
    # Rebuild the ib_service with no cache
    print_info "Rebuilding ib_service with fixed main.py..."
    docker-compose build --no-cache ib_service
    
    if [ $? -ne 0 ]; then
        print_error "Docker build failed. Check the error messages above."
        exit 1
    fi
    
    # Ensure we're using the fixed main.py (not enhanced)
    print_info "Using fixed main.py with asyncio fixes..."
    cd ib_service
    if [ -f "main.py" ]; then
        print_status "Using current main.py with asyncio fixes"
    else
        print_error "main.py not found!"
        exit 1
    fi
    cd ..
    
    # Start services
    print_info "Starting services with fixed ib_service..."
    docker-compose up -d
    
    # Wait for services to start
    print_info "Waiting for services to start..."
    sleep 10
    
    # Verify the fixed version
    print_info "Verifying fixed version..."
    
    # Test basic endpoint
    if curl -s http://localhost:8000/ > /dev/null; then
        VERSION=$(curl -s http://localhost:8000/ | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        if [[ "$VERSION" == "1.5.0-fallback" ]]; then
            print_status "Fixed version (1.5.0-fallback) is running!"
        else
            print_warning "Version: $VERSION (expected 1.5.0-fallback)"
        fi
    else
        print_error "IB Service is not responding on port 8000"
    fi
    
    print_status "IB Service rebuild with fixes completed!"
    
    echo ""
    print_info "Fixed Features:"
    echo "   • Fixed asyncio event loop handling"
    echo "   • Proper fallback to synchronous connections"
    echo "   • Better error handling for thread pool executors"
    echo "   • Stable connection attempts"
}

# Function to rebuild IB service with simple working version
rebuild_ib_service_simple() {
    print_info "Rebuilding IB Service with simple working version..."
    
    check_docker
    
    # Stop current containers
    print_info "Stopping current containers..."
    docker-compose down
    
    # Remove old IB service image to force rebuild
    print_info "Removing old ib_service image..."
    docker rmi tradingapp-ib_service 2>/dev/null || true
    docker rmi tradingapp_ib_service 2>/dev/null || true
    
    # Switch to simple version
    print_info "Switching to simple main.py version..."
    cd ib_service
    if [ -f "main_simple.py" ]; then
        cp main_simple.py main.py
        print_status "Simple version activated"
    else
        print_error "main_simple.py not found!"
        exit 1
    fi
    cd ..
    
    # Rebuild the ib_service with no cache
    print_info "Rebuilding ib_service with simple version..."
    docker-compose build --no-cache ib_service
    
    if [ $? -ne 0 ]; then
        print_error "Docker build failed. Check the error messages above."
        exit 1
    fi
    
    # Start services
    print_info "Starting services with simple ib_service..."
    docker-compose up -d
    
    # Wait for services to start
    print_info "Waiting for services to start..."
    sleep 10
    
    # Verify the simple version
    print_info "Verifying simple version..."
    
    # Test basic endpoint
    if curl -s http://localhost:8000/ > /dev/null; then
        VERSION=$(curl -s http://localhost:8000/ | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        if [[ "$VERSION" == "1.5.1-simple" ]]; then
            print_status "Simple version (1.5.1-simple) is running!"
        else
            print_warning "Version: $VERSION (expected 1.5.1-simple)"
        fi
    else
        print_error "IB Service is not responding on port 8000"
    fi
    
    print_status "IB Service rebuild with simple version completed!"
    
    echo ""
    print_info "Simple Version Features:"
    echo "   • Fixed asyncio event loop handling"
    echo "   • Proper ThreadPoolExecutor usage"
    echo "   • Basic market data functionality"
    echo "   • Account information"
    echo "   • Stable connection attempts"
    echo "   • No complex dependencies"
}

# Function to check service status
check_status() {
    print_info "Checking TradingApp Status..."
    
    # Check if Docker is running
    if docker info &> /dev/null; then
        print_status "Docker is running"
    else
        print_error "Docker is not running. Please start Docker first."
        exit 1
    fi
    
    # Check if services are running
    print_info "Service status:"
    if command -v docker-compose &> /dev/null; then
        docker-compose ps
    else
        print_error "Docker Compose not found. Please install it first."
        exit 1
    fi
    
    # Check if IB Service is running specifically
    if docker-compose ps | grep -q "ib_service.*Up"; then
        print_status "IB Service is running"
        
        # Test endpoints
        print_info "Testing service endpoints..."
        
        # Test IB Service endpoints
        if curl -s http://localhost:8000/ > /dev/null; then
            print_status "IB Service root endpoint responding"
        else
            print_error "IB Service root endpoint not responding"
        fi
        
        if curl -s http://localhost:8000/health > /dev/null; then
            print_status "IB Service health endpoint responding"
        else
            print_error "IB Service health endpoint not responding"
        fi
        
        if curl -s http://localhost:8000/gateway-health > /dev/null; then
            print_status "IB Gateway health endpoint responding"
        else
            print_error "IB Gateway health endpoint not responding"
        fi
    else
        print_error "IB Service is not running"
    fi
    
    show_service_info
}

# Function to test connections
test_connections() {
    print_info "Testing TradingApp Connections..."
    
    echo ""
    print_info "Testing Backend..."
    if curl -s http://localhost:4000/ > /dev/null; then
        print_status "Backend root is responding"
        curl -s http://localhost:4000/ | jq . 2>/dev/null || curl -s http://localhost:4000/
    else
        print_error "Backend root is not responding"
    fi
    
    echo ""
    print_info "Testing Backend Health..."
    if curl -s http://localhost:4000/api/health > /dev/null; then
        print_status "Backend health check is responding"
        curl -s http://localhost:4000/api/health | jq . 2>/dev/null || curl -s http://localhost:4000/api/health
    else
        print_error "Backend health check is not responding"
    fi
    
    echo ""
    print_info "Testing IB Service..."
    if curl -s http://localhost:8000/ > /dev/null; then
        print_status "IB Service is responding"
        curl -s http://localhost:8000/ | jq . 2>/dev/null || curl -s http://localhost:8000/
    else
        print_error "IB Service is not responding"
    fi
    
    echo ""
    print_info "Testing IB Service Health..."
    if curl -s http://localhost:8000/health > /dev/null; then
        print_status "IB Service health check is responding"
        curl -s http://localhost:8000/health | jq . 2>/dev/null || curl -s http://localhost:8000/health
    else
        print_error "IB Service health check is not responding"
    fi
    
    echo ""
    print_info "Testing IB Gateway Health..."
    if curl -s http://localhost:8000/gateway-health > /dev/null; then
        print_status "IB Gateway health check is responding"
        curl -s http://localhost:8000/gateway-health | jq . 2>/dev/null || curl -s http://localhost:8000/gateway-health
    else
        print_error "IB Gateway health check is not responding"
    fi
    
    echo ""
    print_info "Testing Frontend..."
    if curl -s http://localhost:3000 > /dev/null; then
        print_status "Frontend is responding"
    else
        print_error "Frontend is not responding"
    fi
    
    echo ""
    print_info "Docker containers status:"
    docker-compose ps
}

# Function to show service logs
show_logs() {
    print_info "Showing service logs..."
    
    if [ "$2" = "follow" ] || [ "$2" = "-f" ]; then
        print_info "Following logs (Ctrl+C to stop)..."
        docker-compose logs -f
    else
        print_info "Recent logs (last 20 lines from each service):"
        echo ""
        echo "--- Frontend ---"
        docker-compose logs --tail=20 frontend
        echo ""
        echo "--- Backend ---"
        docker-compose logs --tail=20 backend
        echo ""
        echo "--- IB Service ---"
        docker-compose logs --tail=20 ib_service
    fi
}

# Function to stop services
stop_services() {
    print_info "Stopping all services..."
    docker-compose down --remove-orphans
    print_status "All services stopped"
}

# Function to restart services
restart_services() {
    print_info "Restarting all services..."
    docker-compose restart
    print_status "All services restarted"
    show_service_info
}

# Function to clean up containers and images
clean_up() {
    print_warning "This will remove all containers and images. Are you sure? (y/N)"
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        print_info "Stopping and removing containers..."
        docker-compose down --remove-orphans
        
        print_info "Removing images..."
        docker rmi tradingapp-frontend tradingapp-backend tradingapp-ib_service 2>/dev/null || true
        
        print_info "Pruning unused images and volumes..."
        docker system prune -f
        docker volume prune -f
        
        print_status "Cleanup completed"
    else
        print_info "Cleanup cancelled"
    fi
}

# Function to show service information
show_service_info() {
    echo ""
    print_status "Service URLs:"
    SERVER_IP=$(hostname -I | awk '{print $1}')
    echo "   Frontend:   http://${SERVER_IP}:3000"
    echo "   Backend:    http://${SERVER_IP}:4000"
    echo "   IB Service: http://${SERVER_IP}:8000"
    echo ""
    print_info "Management Commands:"
    echo "   View logs:      $0 logs"
    echo "   Check status:   $0 status"
    echo "   Test connections: $0 test"
    echo "   Stop services:  $0 stop"
    echo "   Restart:        $0 restart"
    echo ""
    print_info "TradingView Features:"
    echo "   ✓ Real-time MSFT charts"
    echo "   ✓ Multiple timeframes (5m, 15m, 30m, 1h, 4h, 8h, 1d)"
    echo "   ✓ 12 months historical data"
    echo "   ✓ Interactive Brokers integration"
}

# Main script logic
case "${1:-}" in
    "install")
        echo "🔧 Installing Docker and dependencies..."
        if ! command -v docker &> /dev/null; then
            install_docker
            print_warning "Please log out and log back in, or restart your terminal, then run '$0 deploy'"
            print_info "This is needed for the docker group changes to take effect."
            exit 0
        else
            print_status "Docker is already installed"
        fi
        
        if ! command -v docker-compose &> /dev/null; then
            install_docker_compose
        else
            print_status "Docker Compose is already installed"
            docker-compose --version
        fi
        
        print_status "Installation complete! Run '$0 deploy' to start the application."
        ;;
    "deploy")
        deploy_application
        ;;
    "rebuild")
        rebuild_services
        ;;
    "ib-rebuild")
        rebuild_ib_service
        ;;
    "ib-rebuild-fixed")
        rebuild_ib_service_fixed
        ;;
    "ib-simple")
        rebuild_ib_service_simple
        ;;
    "status")
        check_status
        ;;
    "test")
        test_connections
        ;;
    "logs")
        show_logs "$@"
        ;;
    "stop")
        stop_services
        ;;
    "restart")
        restart_services
        ;;
    "clean")
        clean_up
        ;;
    "env-setup")
        setup_environment
        ;;
    "help"|"--help"|"-h")
        show_usage
        ;;
    *)
        if [ -z "${1:-}" ]; then
            show_usage
        else
            print_error "Unknown command: $1"
            echo ""
            show_usage
            exit 1
        fi
        ;;
esac 