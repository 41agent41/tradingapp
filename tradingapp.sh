#!/bin/bash

# 🚀 TradingApp Unified Management Script
# Consolidates all deployment, configuration, and troubleshooting functionality

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

# Configuration
DEFAULT_IB_HOST="10.7.3.21"
DEFAULT_SERVER_IP="10.7.3.20"
DEFAULT_IB_PORT="4002"
DEFAULT_CLIENT_ID="1"

show_usage() {
    echo "🚀 TradingApp Unified Management Script"
    echo "======================================"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Setup & Deployment:"
    echo "  setup       - Install Docker, setup environment, configure IB"
    echo "  deploy      - Deploy the complete application"
    echo "  redeploy    - Clean redeploy (recommended for changes)"
    echo ""
    echo "Configuration:"
    echo "  config      - Configure IB Gateway connection"
    echo "  env         - Setup/update environment variables"
    echo ""
    echo "Management:"
    echo "  start       - Start all services"
    echo "  stop        - Stop all services"
    echo "  restart     - Restart all services"
    echo "  status      - Check service status"
    echo "  logs        - View service logs"
    echo ""
    echo "Troubleshooting:"
    echo "  test        - Test all connections"
    echo "  diagnose    - Run comprehensive diagnostics"
    echo "  fix         - Auto-fix common issues"
    echo "  clean       - Clean up and reset"
    echo ""
    echo "Examples:"
    echo "  $0 setup     # First time setup"
    echo "  $0 deploy    # Deploy application"
    echo "  $0 test      # Test connections"
    echo "  $0 fix       # Fix connection issues"
}

check_requirements() {
    print_info "Checking system requirements..."
    
    # Check if running as root
    if [[ $EUID -eq 0 ]]; then
        print_error "Don't run this script as root. Use a user with sudo privileges."
        exit 1
    fi
    
    # Check for sudo
    if ! sudo -n true 2>/dev/null; then
        print_warning "This script requires sudo privileges. You may be prompted for password."
    fi
    
    print_status "System requirements check passed"
}

install_docker() {
    print_info "Installing Docker..."
    
    if command -v docker &> /dev/null; then
        print_status "Docker already installed: $(docker --version)"
        return 0
    fi
    
    # Update system
    sudo apt update
    
    # Install Docker
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    
    # Add user to docker group
    sudo usermod -aG docker $USER
    
    # Install Docker Compose
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    
    print_status "Docker installed successfully"
    print_warning "Please log out and log back in for docker group changes to take effect"
}

setup_environment() {
    print_info "Setting up environment configuration..."
    
    # Get server IP
    if [[ -z "$SERVER_IP" ]]; then
        SERVER_IP=$(hostname -I | awk '{print $1}' | head -1)
        if [[ -z "$SERVER_IP" ]]; then
            SERVER_IP="$DEFAULT_SERVER_IP"
        fi
    fi
    
    # Get IB Gateway IP
    if [[ -z "$IB_HOST" ]]; then
        echo ""
        print_info "Please enter your IB Gateway IP address:"
        read -p "IB Gateway IP [$DEFAULT_IB_HOST]: " IB_HOST
        IB_HOST=${IB_HOST:-$DEFAULT_IB_HOST}
    fi
    
    # Create streamlined .env file
    cat > .env << EOF
# TradingApp Configuration
NODE_ENV=production
SERVER_IP=$SERVER_IP

# Frontend
FRONTEND_PORT=3000
NEXT_PUBLIC_API_URL=http://$SERVER_IP:4000

# Backend
BACKEND_PORT=4000
CORS_ORIGINS=http://$SERVER_IP:3000

# IB Service
IB_SERVICE_PORT=8000
IB_HOST=$IB_HOST
IB_PORT=$DEFAULT_IB_PORT
IB_CLIENT_ID=$DEFAULT_CLIENT_ID
IB_TIMEOUT=30

# Database
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=tradingapp123
POSTGRES_DB=tradingapp

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
EOF
    
    print_status "Environment configured:"
    print_info "  Server IP: $SERVER_IP"
    print_info "  IB Gateway: $IB_HOST:$DEFAULT_IB_PORT"
    print_info "  Client ID: $DEFAULT_CLIENT_ID"
}

test_ib_connection() {
    print_info "Testing IB Gateway connection..."
    
    if [[ -f .env ]]; then
        source .env
        
        # Test TCP connection
        if timeout 5 bash -c "echo >/dev/tcp/$IB_HOST/$IB_PORT" 2>/dev/null; then
            print_status "IB Gateway is reachable at $IB_HOST:$IB_PORT"
            return 0
        else
            print_error "Cannot reach IB Gateway at $IB_HOST:$IB_PORT"
            return 1
        fi
    else
        print_error "No .env file found. Run: $0 env"
        return 1
    fi
}

deploy_application() {
    print_info "Deploying TradingApp..."
    
    # Ensure Docker is running
    if ! docker info &> /dev/null; then
        print_error "Docker is not running. Please start Docker first."
        exit 1
    fi
    
    # Clean deployment for reliability
    print_info "Cleaning previous deployment..."
    docker-compose down --remove-orphans 2>/dev/null || true
    
    # Build and start services
    print_info "Building and starting services..."
    docker-compose up --build -d
    
    # Wait for services to be ready
    print_info "Waiting for services to start..."
    sleep 10
    
    # Test deployment
    test_deployment
}

test_deployment() {
    print_info "Testing deployment..."
    
    local success=true
    
    # Test frontend
    if curl -s -f http://localhost:3000 > /dev/null; then
        print_status "Frontend is responding"
    else
        print_error "Frontend is not responding"
        success=false
    fi
    
    # Test backend
    if curl -s -f http://localhost:4000 > /dev/null; then
        print_status "Backend is responding"
    else
        print_error "Backend is not responding"
        success=false
    fi
    
    # Test IB service
    if curl -s -f http://localhost:8000/health > /dev/null; then
        print_status "IB Service is responding"
    else
        print_error "IB Service is not responding"
        success=false
    fi
    
    # Test IB connection
    if test_ib_connection; then
        print_status "IB Gateway connection test passed"
    else
        print_warning "IB Gateway connection test failed"
        success=false
    fi
    
    if $success; then
        print_status "All tests passed!"
        show_access_info
    else
        print_error "Some tests failed. Check logs with: $0 logs"
        return 1
    fi
}

show_access_info() {
    local server_ip=$(grep SERVER_IP .env | cut -d'=' -f2)
    echo ""
    print_status "🚀 TradingApp is running!"
    echo ""
    echo "Access URLs:"
    echo "  Frontend:   http://$server_ip:3000"
    echo "  Backend:    http://$server_ip:4000"
    echo "  IB Service: http://$server_ip:8000"
    echo ""
    echo "Management:"
    echo "  Check status: $0 status"
    echo "  View logs:    $0 logs"
    echo "  Test system:  $0 test"
}

run_diagnostics() {
    print_info "Running comprehensive diagnostics..."
    
    echo ""
    echo "=== System Status ==="
    docker --version 2>/dev/null || echo "Docker not installed"
    docker-compose --version 2>/dev/null || echo "Docker Compose not installed"
    
    echo ""
    echo "=== Docker Status ==="
    if docker info &> /dev/null; then
        print_status "Docker daemon is running"
    else
        print_error "Docker daemon is not running"
        return 1
    fi
    
    echo ""
    echo "=== Container Status ==="
    docker-compose ps 2>/dev/null || echo "No containers running"
    
    echo ""
    echo "=== Environment ==="
    if [[ -f .env ]]; then
        print_status ".env file exists"
        echo "Configuration:"
        grep -E "^(SERVER_IP|IB_HOST|IB_PORT|IB_CLIENT_ID)=" .env | sed 's/^/  /'
    else
        print_error ".env file missing"
    fi
    
    echo ""
    echo "=== Network Tests ==="
    test_ib_connection
    
    echo ""
    echo "=== Service Tests ==="
    test_deployment
}

fix_issues() {
    print_info "Auto-fixing common issues..."
    
    # Fix 1: Ensure .env exists
    if [[ ! -f .env ]]; then
        print_info "Creating missing .env file..."
        setup_environment
    fi
    
    # Fix 2: Restart services
    print_info "Restarting services..."
    docker-compose down --remove-orphans 2>/dev/null || true
    docker-compose up --build -d
    
    # Fix 3: Wait and test
    print_info "Waiting for services to stabilize..."
    sleep 15
    
    # Fix 4: Test everything
    test_deployment
    
    print_status "Auto-fix completed!"
}

show_logs() {
    print_info "Showing service logs..."
    
    if [[ "$1" == "follow" ]] || [[ "$1" == "-f" ]]; then
        docker-compose logs -f
    else
        echo "=== Recent logs (last 20 lines per service) ==="
        echo ""
        echo "--- Frontend ---"
        docker-compose logs --tail=20 frontend 2>/dev/null || echo "Frontend not running"
        echo ""
        echo "--- Backend ---"
        docker-compose logs --tail=20 backend 2>/dev/null || echo "Backend not running"
        echo ""
        echo "--- IB Service ---"
        docker-compose logs --tail=20 ib_service 2>/dev/null || echo "IB Service not running"
    fi
}

# Main command handling
case "${1:-}" in
    "setup")
        check_requirements
        install_docker
        setup_environment
        print_status "Setup complete! Run '$0 deploy' to start the application."
        ;;
    "deploy")
        deploy_application
        ;;
    "redeploy")
        print_info "Clean redeployment (recommended for changes)..."
        docker-compose down --remove-orphans
        docker system prune -f
        deploy_application
        ;;
    "config")
        setup_environment
        print_status "Configuration updated. Run '$0 redeploy' to apply changes."
        ;;
    "env")
        setup_environment
        ;;
    "start")
        docker-compose up -d
        print_status "Services started"
        ;;
    "stop")
        docker-compose down --remove-orphans
        print_status "Services stopped"
        ;;
    "restart")
        docker-compose restart
        print_status "Services restarted"
        ;;
    "status")
        docker-compose ps
        ;;
    "logs")
        show_logs "$2"
        ;;
    "test")
        test_deployment
        ;;
    "diagnose")
        run_diagnostics
        ;;
    "fix")
        fix_issues
        ;;
    "clean")
        print_warning "This will remove all containers and data. Continue? (y/N)"
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            docker-compose down --remove-orphans
            docker system prune -f
            docker volume prune -f
            print_status "Cleanup completed"
        fi
        ;;
    "help"|"--help"|"-h")
        show_usage
        ;;
    *)
        if [[ -z "${1:-}" ]]; then
            show_usage
        else
            print_error "Unknown command: $1"
            show_usage
            exit 1
        fi
        ;;
esac 