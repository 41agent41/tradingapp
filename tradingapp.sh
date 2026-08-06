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

# State file that remembers whether the last deploy opted into the
# bundled TimescaleDB (`--with-db`). The presence of this file makes all
# subsequent compose calls (`start`, `stop`, `restart`, `logs`, `status`)
# pick up the override automatically.
WITH_DB_STATE_FILE=".tradingapp.with-db"

# Build the `docker compose` invocation, layering the database override
# when --with-db is requested or the state file is present.
compose_cmd() {
    local -a files=(-f docker-compose.yml)
    if [[ "${WITH_DB:-0}" == "1" ]] || [[ -f "$WITH_DB_STATE_FILE" ]]; then
        if [[ -f docker-compose.db.yml ]]; then
            files+=(-f docker-compose.db.yml)
        else
            print_warning "WITH_DB requested but docker-compose.db.yml is missing"
        fi
    fi
    if command -v "docker-compose" >/dev/null 2>&1; then
        docker-compose "${files[@]}" "$@"
    else
        docker compose "${files[@]}" "$@"
    fi
}

# Parse `--with-db` / `--non-interactive` out of the remaining argv so the
# subcommand dispatch below sees a clean list.
parse_global_flags() {
    local -a remaining=()
    for arg in "$@"; do
        case "$arg" in
            --with-db)
                WITH_DB=1
                ;;
            --no-db)
                WITH_DB=0
                rm -f "$WITH_DB_STATE_FILE"
                ;;
            --non-interactive)
                NON_INTERACTIVE=1
                ;;
            *)
                remaining+=("$arg")
                ;;
        esac
    done
    GLOBAL_ARGS=("${remaining[@]}")
}

# Upsert `KEY=value` into an env file: replaces the line if `KEY=` already
# starts a line, otherwise appends it. Every other line — including keys
# this script has never heard of (POSTGRES_HOST, API_TOKEN,
# BACKFILL_ENABLED, LIVE_TRADING_ENABLED, ...) — is left untouched, so a
# hand-edited `.env` survives a re-run of `config`/`env`.
env_set() {
    local file="$1" key="$2" value="$3"
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" '
        index($0, k"=") == 1 { print k"="v; done=1; next }
        { print }
        END { if (!done) print k"="v }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
}

# Same as env_set, but only writes the key if it is not already present —
# for defaults the user may have hand-tuned (ports, Postgres/Redis
# credentials) that `config`/`env` shouldn't silently reset.
env_set_default() {
    local file="$1" key="$2" value="$3"
    if ! grep -qE "^${key}=" "$file" 2>/dev/null; then
        echo "${key}=${value}" >> "$file"
    fi
}


show_usage() {
    echo "🚀 TradingApp Unified Management Script"
    echo "======================================"
    echo ""
    echo "Usage: $0 [COMMAND] [--with-db | --no-db] [--non-interactive]"
    echo ""
    echo "Setup & Deployment:"
    echo "  setup       - Install Docker, setup environment, configure IB"
    echo "  deploy      - Deploy the complete application"
    echo "  redeploy    - Clean redeploy (recommended for changes)"
    echo ""
    echo "Global flags:"
    echo "  --with-db          - Also bring up a local TimescaleDB via"
    echo "                       docker-compose.db.yml (development / self-hosted)"
    echo "  --no-db            - Stop using the local TimescaleDB override"
    echo "  --non-interactive  - Never prompt (setup/config/env use"
    echo "                       DEFAULT_IB_HOST unless IB_HOST is already"
    echo "                       exported); for CI / scripted installs"
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
echo "  ib-help     - IB Gateway setup instructions"
echo "  verify-timestamps - Check IB timestamp handling end-to-end"
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
        if [[ "${NON_INTERACTIVE:-0}" == "1" ]]; then
            IB_HOST="$DEFAULT_IB_HOST"
            print_info "Non-interactive mode: using default IB Gateway IP ($IB_HOST)"
        else
            echo ""
            print_info "Please enter your IB Gateway IP address:"
            read -p "IB Gateway IP [$DEFAULT_IB_HOST]: " IB_HOST
            IB_HOST=${IB_HOST:-$DEFAULT_IB_HOST}
        fi
    fi

    # Merge into .env rather than truncating it: SERVER_IP/IB_HOST (and the
    # URLs derived from SERVER_IP) are what this command is explicitly
    # asked to change, so those are force-set; everything else is only
    # filled in if missing, so hand-edited values (a real POSTGRES_PASSWORD,
    # POSTGRES_HOST, API_TOKEN, BACKFILL_ENABLED, ...) survive a re-run of
    # `config`/`env`.
    if [[ ! -f .env ]]; then
        print_info "No .env found — creating one."
        cat > .env << 'HEADER'
# TradingApp Configuration
# Generated by tradingapp.sh. Re-running `config`/`env` updates SERVER_IP,
# IB_HOST and the URLs derived from SERVER_IP; every other key here is
# left alone once set, so it is safe to hand-edit the rest of this file.
HEADER
    fi

    env_set .env SERVER_IP "$SERVER_IP"
    env_set .env NEXT_PUBLIC_API_URL "http://$SERVER_IP:4000"
    env_set .env CORS_ORIGINS "http://$SERVER_IP:3000"
    env_set .env IB_HOST "$IB_HOST"

    env_set_default .env NODE_ENV "production"
    env_set_default .env FRONTEND_PORT "3000"
    env_set_default .env BACKEND_PORT "4000"
    env_set_default .env BROKER_SERVICE_PORT "8000"
    env_set_default .env IB_PORT "$DEFAULT_IB_PORT"
    env_set_default .env IB_CLIENT_ID "$DEFAULT_CLIENT_ID"
    env_set_default .env IB_TIMEOUT "30"
    env_set_default .env POSTGRES_USER "tradingapp"
    env_set_default .env POSTGRES_PASSWORD "tradingapp123"
    env_set_default .env POSTGRES_DB "tradingapp"
    env_set_default .env REDIS_HOST "redis"
    env_set_default .env REDIS_PORT "6379"

    print_status "Environment configured:"
    print_info "  Server IP: $SERVER_IP"
    print_info "  IB Gateway: $IB_HOST:$(grep -E '^IB_PORT=' .env | cut -d'=' -f2)"
    print_info "  Client ID: $(grep -E '^IB_CLIENT_ID=' .env | cut -d'=' -f2)"
}

test_ib_connection() {
    print_info "Testing IB Gateway connection..."
    
    if [[ -f .env ]]; then
        source .env
        
        # Test basic network connectivity first
        print_info "Testing network connectivity to $IB_HOST..."
        if ping -c 1 -W 3 "$IB_HOST" > /dev/null 2>&1; then
            print_status "Host $IB_HOST is reachable"
        else
            print_error "Host $IB_HOST is not reachable via ping"
            print_warning "Check network connectivity and firewall settings"
            return 1
        fi
        
        # Test TCP connection to IB Gateway port
        print_info "Testing IB Gateway port $IB_HOST:$IB_PORT..."
        if timeout 5 bash -c "echo >/dev/tcp/$IB_HOST/$IB_PORT" 2>/dev/null; then
            print_status "IB Gateway is reachable at $IB_HOST:$IB_PORT"
            return 0
        else
            print_error "Cannot reach IB Gateway at $IB_HOST:$IB_PORT"
            print_warning "IB Gateway troubleshooting needed:"
            echo "  1. Ensure IB Gateway/TWS is running on $IB_HOST"
            echo "  2. Check API settings: File → Global Configuration → API → Settings"
            echo "  3. Verify 'Enable ActiveX and Socket Clients' is checked"
            echo "  4. Confirm socket port is set to $IB_PORT"
            echo "  5. Add $SERVER_IP to trusted IPs list"
            echo "  6. Restart IB Gateway after configuration changes"
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

    # Persist the --with-db choice across subsequent invocations
    if [[ "${WITH_DB:-0}" == "1" ]]; then
        touch "$WITH_DB_STATE_FILE"
        print_info "TimescaleDB override enabled (--with-db)"
    fi

    # Clean deployment for reliability
    print_info "Cleaning previous deployment..."
    compose_cmd down --remove-orphans 2>/dev/null || true

    # Build and start services
    print_info "Building and starting services..."
    compose_cmd up --build -d

    # Wait for services to be ready
    print_info "Waiting for services to start..."
    sleep 10

    # Verify TWS API installation
    print_info "Verifying TWS API installation..."
    if compose_cmd exec -T broker_service python -c "import ibapi; print('TWS API installed successfully')" 2>/dev/null; then
        print_status "TWS API (ibapi) is properly installed"
    else
        print_error "TWS API installation verification failed"
        print_info "This may indicate a Docker cache issue. Try: $0 clean && $0 deploy"
        return 1
    fi

    # Test deployment
    test_deployment
}

test_deployment() {
    print_info "Testing deployment..."
    
    local success=true
    
    # Test frontend
    if curl -s -f http://${SERVER_IP:-localhost}:3000 > /dev/null; then
        print_status "Frontend is responding"
    else
        print_error "Frontend is not responding"
        success=false
    fi
    
    # Test backend
    if curl -s -f http://${SERVER_IP:-localhost}:4000 > /dev/null; then
        print_status "Backend is responding"
    else
        print_error "Backend is not responding"
        success=false
    fi
    
    # Test IB service
    if curl -s -f http://${SERVER_IP:-localhost}:8000/health > /dev/null; then
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
    compose_cmd ps 2>/dev/null || echo "No containers running"
    
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

    echo ""
    print_info "For timestamp/timezone-specific issues, run: $0 verify-timestamps"
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
    compose_cmd down --remove-orphans 2>/dev/null || true
    compose_cmd up --build -d
    
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
        compose_cmd logs -f
    else
        echo "=== Recent logs (last 20 lines per service) ==="
        echo ""
        echo "--- Frontend ---"
        compose_cmd logs --tail=20 frontend 2>/dev/null || echo "Frontend not running"
        echo ""
        echo "--- Backend ---"
        compose_cmd logs --tail=20 backend 2>/dev/null || echo "Backend not running"
        echo ""
        echo "--- IB Service ---"
        compose_cmd logs --tail=20 broker_service 2>/dev/null || echo "Broker Service not running"
        if [[ "${WITH_DB:-0}" == "1" ]] || [[ -f "$WITH_DB_STATE_FILE" ]]; then
            echo ""
            echo "--- Postgres (TimescaleDB) ---"
            compose_cmd logs --tail=20 postgres 2>/dev/null || echo "Postgres not running"
        fi
    fi
}

show_ib_help() {
    echo ""
    print_info "🔧 IB Gateway Setup Instructions"
    echo "=================================="
    echo ""
    
    if [[ -f .env ]]; then
        source .env
        echo "Current Configuration:"
        echo "  IB Gateway IP: $IB_HOST"
        echo "  IB Gateway Port: $IB_PORT"
        echo "  Trading Server IP: $SERVER_IP"
        echo "  Client ID: $IB_CLIENT_ID"
        echo ""
    fi
    
    echo "📋 IB Gateway Setup Checklist:"
    echo ""
    echo "1. 🖥️  Start IB Gateway or TWS:"
    echo "   - Launch IB Gateway or Trader Workstation"
    echo "   - Log in with your Interactive Brokers account"
    echo "   - Ensure it's connected (not offline mode)"
    echo ""
    
    echo "2. ⚙️  Configure API Settings:"
    echo "   - Go to: File → Global Configuration → API → Settings"
    echo "   - ✅ Check 'Enable ActiveX and Socket Clients'"
    echo "   - ✅ Set Socket port to: $IB_PORT"
    echo "   - ✅ Set Master API client ID to: $IB_CLIENT_ID"
    echo "   - ✅ Uncheck 'Read-Only API' (if you want to place orders)"
    echo ""
    
    echo "3. 🌐 Configure Trusted IPs:"
    echo "   - In the same API Settings window"
    echo "   - Add trusted IP: $SERVER_IP"
    echo "   - Add trusted IP: 127.0.0.1 (localhost)"
    echo "   - Format: one IP per line"
    echo ""
    
    echo "4. 💾 Apply and Restart:"
    echo "   - Click 'Apply' then 'OK'"
    echo "   - Close and restart IB Gateway/TWS"
    echo "   - Wait for it to fully connect to IB servers"
    echo ""
    
    echo "5. 🧪 Test Connection:"
    echo "   - Run: ./tradingapp.sh test"
    echo "   - Look for: ✅ IB Gateway connection test passed"
    echo ""
    
    echo "📞 Common Issues:"
    echo ""
    echo "❌ 'Connection refused' → IB Gateway not running or wrong port"
    echo "❌ 'Timeout' → Firewall blocking or wrong IP address"
    echo "❌ 'Host unreachable' → Network connectivity issue"
    echo "❌ 'Client ID conflict' → Try different client ID (1, 2, 3...)"
    echo ""
    
    echo "🔧 Quick Tests:"
    echo "   ping $IB_HOST                    # Test basic connectivity"
    echo "   nc -zv $IB_HOST $IB_PORT        # Test port accessibility"
    echo "   ./tradingapp.sh config           # Reconfigure IB settings"
    echo ""
    
    print_status "After configuring IB Gateway, run: ./tradingapp.sh test"
}

# Strip the global flags (--with-db / --no-db) from $@ so the case
# dispatch below only sees the subcommand and its positional arguments.
parse_global_flags "$@"
set -- "${GLOBAL_ARGS[@]}"

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
        compose_cmd down --remove-orphans

        # Remove project images to ensure fresh build
        docker rmi $(docker images -q tradingapp_broker_service) 2>/dev/null || echo "No broker_service images to remove"
        docker rmi $(docker images -q tradingapp_backend) 2>/dev/null || echo "No backend images to remove"
        docker rmi $(docker images -q tradingapp_frontend) 2>/dev/null || echo "No frontend images to remove"

        # Clear build cache
        docker system prune -f
        docker builder prune -f

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
        compose_cmd up -d
        print_status "Services started"
        ;;
    "stop")
        compose_cmd down --remove-orphans
        print_status "Services stopped"
        ;;
    "restart")
        compose_cmd restart
        print_status "Services restarted"
        ;;
    "status")
        compose_cmd ps
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
    "ib-help")
        show_ib_help
        ;;
    "verify-timestamps")
        if [[ -f verify_timestamp_config.sh ]]; then
            [[ -f .env ]] && source .env
            bash verify_timestamp_config.sh
        else
            print_error "verify_timestamp_config.sh not found in $(pwd)"
            exit 1
        fi
        ;;
    "clean")
        print_warning "This will remove all containers, images, and data. Continue? (y/N)"
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            print_info "Performing complete cleanup..."
            
            # Stop and remove containers
            compose_cmd down --remove-orphans
            rm -f "$WITH_DB_STATE_FILE"
            
            # Remove all project images
            docker rmi $(docker images -q tradingapp_broker_service) 2>/dev/null || echo "No broker_service images to remove"
            docker rmi $(docker images -q tradingapp_backend) 2>/dev/null || echo "No backend images to remove"
            docker rmi $(docker images -q tradingapp_frontend) 2>/dev/null || echo "No frontend images to remove"
            
            # Clear all Docker cache and unused resources
            docker system prune -af
            docker volume prune -f
            docker builder prune -f
            
            print_status "Complete cleanup finished. Run '$0 deploy' to rebuild from scratch."
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