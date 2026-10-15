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
# Brokers (IB, MT5, OANDA, Alpaca) and their credentials are added in the app,
# under Settings > Connections, and checked there when saved. Setup never asks
# for them and never writes them to .env.
DEFAULT_SERVER_IP="10.7.3.20"

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

# Empties a key still holding the CHANGE_ME placeholder. For secrets that
# have moved into the app: an empty value means "managed on the page".
env_clear_placeholder() {
    local file="$1" key="$2" current
    current=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d'=' -f2-)
    if [[ "$current" == "CHANGE_ME" ]]; then
        env_set "$file" "$key" ""
    fi
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

# Random hex secret (64 chars). openssl when present, else /dev/urandom.
gen_secret() {
    openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Fill a secret with a random value when it is missing, empty, or still the
# CHANGE_ME placeholder from .env.example. A real value is never touched.
# Prints the key name when it generated one.
env_set_secret() {
    local file="$1" key="$2" current
    current=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d'=' -f2-)
    if [[ -z "$current" || "$current" == "CHANGE_ME" ]]; then
        env_set "$file" "$key" "$(gen_secret)"
        echo "$key"
    fi
}


show_usage() {
    echo "🚀 TradingApp Unified Management Script"
    echo "======================================"
    echo ""
    echo "Usage: $0 [COMMAND] [--with-db | --no-db] [--non-interactive]"
    echo ""
    echo "Setup & Deployment:"
    echo "  setup       - Install Docker and generate the environment"
    echo "  deploy      - Deploy the complete application"
    echo "  redeploy    - Clean redeploy (recommended for changes)"
    echo ""
    echo "Global flags:"
    echo "  --with-db          - Also bring up a local TimescaleDB via"
    echo "                       docker-compose.db.yml (development / self-hosted)"
    echo "  --no-db            - Stop using the local TimescaleDB override"
    echo "  --non-interactive  - Never prompt; for CI / scripted installs"
    echo ""
    echo "Configuration:"
    echo "  config      - Refresh SERVER_IP and fill in missing settings"
    echo "  env         - Same as config"
    echo "  (Brokers are added in the app: Settings > Connections)"
    echo ""
    echo "Management:"
    echo "  start       - Start all services"
    echo "  stop        - Stop all services"
    echo "  restart     - Restart all services"
    echo "  status      - Check service status"
    echo "  logs        - View service logs"
    echo "  setup-code  - Show the code for the first-run setup screen"
    echo "  migrate     - Bring the database schema up to date and check the key"
    echo "  forget-secrets - Clear secrets sealed with a lost encryption key"
    echo "  settings-import - Move settings and logins from .env into the app"
    echo ""
    echo "Troubleshooting:"
echo "  test        - Check the app's services are up"
echo "  diagnose    - Run comprehensive diagnostics"
echo "  fix         - Auto-fix common issues"
echo "  ib-help     - IB Gateway setup instructions (only if you use IB)"
echo "  verify-timestamps - Check IB timestamp handling end-to-end"
echo "  clean       - Clean up and reset"
    echo ""
    echo "Examples:"
echo "  $0 setup     # First time setup"
echo "  $0 deploy    # Deploy application"
echo "  $0 test      # Check services"
echo "  $0 fix       # Fix connection issues"
}

check_requirements() {
    print_info "Checking system requirements..."
    
    # Check if running as root
    if [[ $EUID -eq 0 ]]; then
        print_error "Don't run this script as root. Use a user with sudo privileges."
        echo "  Create one and re-clone as that user (see DEPLOYMENT.md, 'User account'):"
        echo "    apt update && apt install -y sudo git"
        echo "    adduser tradingapp && usermod -aG sudo tradingapp"
        echo "    su - tradingapp"
        echo "    git clone https://github.com/41agent41/tradingapp.git ~/tradingapp"
        echo "    cd ~/tradingapp && chmod +x tradingapp.sh && ./tradingapp.sh setup"
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
    print_info "You were added to the docker group. '$0 deploy' applies it for you; other docker commands need a fresh login."
}

# Make sure this shell can talk to the Docker daemon before a command that
# needs it. Setup adds the user to the `docker` group, but a shell keeps the
# groups it logged in with, so straight after setup `docker info` is refused
# even though the daemon is running. In that case re-run this script under
# `sg docker` (the group applied, no logout needed) with the given arguments.
ensure_docker_access() {
    if docker info &> /dev/null; then
        return 0
    fi

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Run: $0 setup"
        exit 1
    fi

    if [[ ! -S /var/run/docker.sock ]]; then
        print_error "Docker is installed but not running. Start it with: sudo systemctl start docker"
        exit 1
    fi

    # Member of `docker` in the group database, but not in this process.
    if id -nG "${USER:-$(id -un)}" 2>/dev/null | tr ' ' '\n' | grep -qx docker \
        && ! id -nG | tr ' ' '\n' | grep -qx docker; then
        if [[ -z "${TRADINGAPP_SG_REEXEC:-}" ]] && command -v sg &> /dev/null; then
            print_info "Your docker group membership is not active in this shell yet; continuing with it applied."
            export TRADINGAPP_SG_REEXEC=1
            exec sg docker -c "$(printf '%q ' bash "$(readlink -f "$0")" "$@")"
        fi
        print_error "Your docker group membership is not active in this shell yet."
        echo "  Log out and back in (or run: newgrp docker), then re-run: $0 $*"
        exit 1
    fi

    print_error "Cannot talk to the Docker daemon:"
    docker info 2>&1 | tail -n 3 | sed 's/^/  /'
    exit 1
}

# The global flags currently in effect, so a re-run under `sg docker` keeps them.
global_flag_args() {
    [[ "${WITH_DB:-0}" == "1" ]] && printf '%s\n' --with-db
    [[ "${NON_INTERACTIVE:-0}" == "1" ]] && printf '%s\n' --non-interactive
    return 0
}

# True when IB_HOST names a gateway rather than being empty or the
# .env.example placeholder. Mirrors `ib_configured` in broker_service/connections.py.
ib_configured() {
    local host="$1"
    [[ -n "$host" && "$host" != YOUR_* ]]
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

    # No broker questions and no broker keys: brokers are added in the app
    # (Settings > Connections) and checked there when saved.
    #
    # Merge into .env rather than truncating it: SERVER_IP (and the URLs
    # derived from it) are what this command is explicitly asked to change,
    # so those are force-set; everything else is only filled in if missing,
    # so hand-edited values (a real POSTGRES_PASSWORD, POSTGRES_HOST,
    # API_TOKEN, BACKFILL_ENABLED, ...) survive a re-run of `config`/`env`.
    if [[ ! -f .env ]]; then
        print_info "No .env found — creating one."
        cat > .env << 'HEADER'
# TradingApp Configuration
# Generated by tradingapp.sh. Re-running `config`/`env` updates SERVER_IP
# and the URLs derived from it; every other key here is left alone once
# set, so it is safe to hand-edit the rest of this file.
HEADER
    fi

    env_set .env SERVER_IP "$SERVER_IP"
    env_set .env CORS_ORIGINS "http://$SERVER_IP:3000"

    env_set_default .env NODE_ENV "production"
    env_set_default .env FRONTEND_PORT "3000"
    env_set_default .env BACKEND_PORT "4000"
    env_set_default .env BROKER_SERVICE_PORT "8000"
    env_set_default .env IB_TIMEOUT "30"
    env_set_default .env POSTGRES_USER "tradingapp"
    env_set_default .env POSTGRES_DB "tradingapp"
    env_set_default .env REDIS_HOST "redis"
    env_set_default .env REDIS_PORT "6379"

    # Secrets the services need before anyone can sign in. Generated once and
    # then left alone. The login password, API tokens and the session key are
    # not among them: they are set in the app (first-run screen, then
    # Settings > Security). A value already in .env keeps working and wins.
    local generated
    generated=$(
        env_set_secret .env POSTGRES_PASSWORD
        env_set_secret .env REDIS_PASSWORD
        env_set_secret .env BROKER_SERVICE_TOKEN
        env_set_secret .env SETTINGS_ENCRYPTION_KEY
    )
    if [[ -n "$generated" ]]; then
        print_info "Generated new secrets in .env: $(echo $generated | tr '\n' ' ')"
    fi
    env_clear_placeholder .env APP_PASSWORD
    env_clear_placeholder .env SESSION_SECRET
    env_clear_placeholder .env API_TOKEN

    print_status "Environment configured:"
    print_info "  Server IP: $SERVER_IP"
    local ib_host
    ib_host=$(grep -E '^IB_HOST=' .env | tail -n1 | cut -d'=' -f2-)
    if ib_configured "$ib_host"; then
        print_warning "  IB Gateway is set in .env ($ib_host), which overrides any IB connection added in the app."
    fi
    print_info "  Brokers: once deployed, sign in at http://$SERVER_IP:${FRONTEND_PORT:-3000}/settings and add"
    print_info "  OANDA, MT5, IB or Alpaca under Connections. Each is checked as soon as you save it."
}

# The backend's readiness (database reachable, migrated, key checked), as
# "<http code> <state> <detail>" from /api/health/ready on this host.
backend_readiness() {
    local port body code
    port=$(grep -E '^BACKEND_PORT=' .env 2>/dev/null | tail -n1 | cut -d'=' -f2-)
    body=$(curl -s --max-time 5 -w '\n%{http_code}' "http://127.0.0.1:${port:-4000}/api/health/ready" 2>/dev/null) || true
    code=$(echo "$body" | tail -n1)
    body=$(echo "$body" | sed '$d')
    if command -v python3 &> /dev/null && [[ -n "$body" ]]; then
        echo "$code $(echo "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin); print(d.get("state", "?"), d.get("detail") or "")
except Exception:
    print("?")' 2>/dev/null)"
    else
        echo "${code:-000} ?"
    fi
}

# Waits until the backend reports ready, printing what it is waiting for.
# Returns 1 on a state that will not clear by itself, or after the timeout.
wait_for_backend_ready() {
    local timeout="${1:-300}" deadline last="" line code state detail
    deadline=$((SECONDS + timeout))
    while ((SECONDS < deadline)); do
        line=$(backend_readiness)
        code=${line%% *}
        state=$(echo "$line" | awk '{print $2}')
        detail=$(echo "$line" | cut -d' ' -f3-)
        if [[ "$code" == "200" ]]; then
            print_status "Backend ready (database reachable and up to date)"
            return 0
        fi
        case "$state" in
            migration_failed|key_mismatch)
                print_error "The backend will not start: $detail"
                return 1
                ;;
        esac
        if [[ "$state" != "$last" ]]; then
            case "$state" in
                waiting_for_database) print_info "Waiting for the database: $detail" ;;
                migrating) print_info "Updating the database schema..." ;;
                *) print_info "Waiting for the backend to start..." ;;
            esac
            last="$state"
        fi
        sleep 3
    done
    print_error "The backend was not ready after ${timeout}s (last state: ${last:-no answer})."
    print_info "Check: $0 logs"
    return 1
}

deploy_application() {
    print_info "Deploying TradingApp..."

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

    # The backend waits for the database and migrates it before it is ready.
    wait_for_backend_ready 300 || return 1

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

    # Test broker service (the container, not any broker behind it)
    if curl -s -f http://127.0.0.1:${BROKER_SERVICE_PORT:-8000}/health > /dev/null; then
        print_status "Broker service is responding"
    else
        print_error "Broker service is not responding"
        success=false
    fi

    # The database, as the backend sees it: reachable, migrated and opened by
    # the encryption key. The app does not start without it.
    local ready
    ready=$(backend_readiness)
    if [[ "${ready%% *}" == "200" ]]; then
        print_status "Database is connected and up to date"
    else
        print_error "Backend not ready: $(echo "$ready" | cut -d' ' -f2-)"
        print_info "  (check POSTGRES_* in .env, or deploy --with-db; '$0 migrate' shows the schema state)"
        success=false
    fi

    # Brokers are deliberately not tested here: the app checks its own
    # broker connections once it is running, and a broker that is down
    # must not fail a deploy.
    show_broker_summary

    if $success; then
        print_status "All tests passed!"
        show_access_info
    else
        print_error "Some tests failed. Check logs with: $0 logs"
        return 1
    fi
}

# Information only: the broker connections the running broker service has
# registered, with the app's last check of each. Never fails, and never
# contacts a broker itself.
show_broker_summary() {
    local summary
    if ! command -v python3 &> /dev/null; then
        print_info "Broker connection status is shown in the app"
        return 0
    fi
    summary=$(curl -s --max-time 5 http://127.0.0.1:${BROKER_SERVICE_PORT:-8000}/health 2>/dev/null \
        | python3 -c '
import json, os, sys
try:
    conns = json.load(sys.stdin).get("providers", {}).get("connections", {})
except Exception:
    sys.exit(0)
def state(c):
    check = (conns[c] or {}).get("check") or {}
    return check.get("status") or "not checked yet"
print(", ".join(f"{c} ({state(c)})" for c in sorted(conns)))
' 2>/dev/null) || true
    if [[ -n "$summary" ]]; then
        print_info "Broker connections: $summary (checked in the app; see Settings > Connections)"
    else
        print_info "No broker connections yet; add one in the app under Settings > Connections"
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
    echo "  Broker service: loopback only (http://127.0.0.1:8000 on this host)"
    echo ""
    if ! grep -qE '^APP_PASSWORD=.+' .env 2>/dev/null; then
        echo "First sign-in:"
        echo "  Open the frontend. If it asks for a setup code, run: $0 setup-code"
        echo ""
    fi
    echo "Management:"
    echo "  Check status: $0 status"
    echo "  View logs:    $0 logs"
    echo "  Test system:  $0 test"
}

# Moves what .env sets into the app (the backend stores it), then deletes
# those lines from .env after a backup, so the Settings page manages them.
# Keys the app still needs from .env (database, ports, the encryption key,
# brokers) are never touched.
settings_import() {
    if [[ ! -f .env ]]; then
        print_error "No .env here."
        return 1
    fi
    if [[ -z "$(compose_cmd ps -q backend 2>/dev/null)" ]]; then
        print_error "The backend is not running. Start it first: $0 start"
        return 1
    fi
    local keys output imported
    keys=$(grep -oE '^[A-Z][A-Z0-9_]*=' .env | tr -d '=' | sort -u | tr '\n' ' ')
    # shellcheck disable=SC2086
    output=$(compose_cmd exec -T backend node dist/cli/importSettings.js $keys 2>/dev/null) || true
    if ! echo "$output" | grep -qE '^(IMPORTED|KEPT) '; then
        print_error "The import did not run: $(echo "$output" | grep -E '^ERROR ' | sed 's/^ERROR //' | tail -1)"
        print_info "Check the backend is up to date ($0 redeploy) and can reach the database."
        return 1
    fi
    echo "$output" | grep -E '^KEPT ' | while read -r _ key reason; do
        print_warning "  $key stays in .env: $reason"
    done
    imported=$(echo "$output" | grep -E '^IMPORTED ' | awk '{print $2}')
    if [[ -z "$imported" ]]; then
        print_info "Nothing to move: .env holds nothing the app manages."
        return 0
    fi
    print_status "Stored in the app: $(echo $imported | tr '\n' ' ')"
    if [[ "${NON_INTERACTIVE:-0}" != "1" ]]; then
        read -r -p "Delete these lines from .env (a backup is kept)? [y/N] " answer
        if [[ ! "$answer" =~ ^[Yy] ]]; then
            print_info "Left .env as it is. Values in .env keep winning over the app until removed."
            return 0
        fi
    fi
    local backup tmp pattern
    backup=".env.bak.$(date +%Y%m%d%H%M%S)"
    cp -p .env "$backup"
    chmod 600 "$backup"
    pattern="^($(echo $imported | tr ' ' '|'))="
    tmp=$(mktemp)
    grep -vE "$pattern" .env > "$tmp" || true
    cat "$tmp" > .env
    rm -f "$tmp"
    print_status "Removed them from .env (backup: $backup; it holds secrets, delete it once you are happy)."
    print_info "Apply with: $0 redeploy. They are then managed in Settings."
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
        grep -E "^(SERVER_IP|FRONTEND_PORT|BACKEND_PORT)=" .env | sed 's/^/  /'
    else
        print_error ".env file missing"
    fi
    
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
    wait_for_backend_ready 300 || true
    
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
        echo "--- Broker Service ---"
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
    fi
    # The values to enter in IB Gateway; the same port and client id go into
    # the IB connection in the app (Settings > Connections).
    IB_PORT="${IB_PORT:-4002}"
    IB_CLIENT_ID="${IB_CLIENT_ID:-1}"
    echo "Trading Server IP: ${SERVER_IP:-<this server>}"
    echo ""
    
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
    
    echo "5. 🧪 Point the app at it:"
    echo "   - Sign in, open Settings > Connections and add Interactive Brokers"
    echo "   - Enter the gateway's IP, port $IB_PORT and client ID $IB_CLIENT_ID, then save"
    echo "   - The app checks the connection as soon as it is saved"
    echo ""
    
    echo "📞 Common Issues:"
    echo ""
    echo "❌ 'Connection refused' → IB Gateway not running or wrong port"
    echo "❌ 'Timeout' → Firewall blocking or wrong IP address"
    echo "❌ 'Host unreachable' → Network connectivity issue"
    echo "❌ 'Client ID conflict' → Try different client ID (1, 2, 3...)"
    echo ""
    
    echo "🔧 Quick Tests:"
    echo "   ping <gateway ip>                # Test basic connectivity"
    echo "   nc -zv <gateway ip> $IB_PORT     # Test port accessibility"
    echo ""
    
    print_status "After configuring IB Gateway, add it in the app under Settings > Connections"
}

# Strip the global flags (--with-db / --no-db) from $@ so the case
# dispatch below only sees the subcommand and its positional arguments.
parse_global_flags "$@"
set -- "${GLOBAL_ARGS[@]}"

# Commands that talk to Docker first make sure this shell can (re-running
# under `sg docker` straight after setup, when the new group is not active).
case "${1:-}" in
    deploy|redeploy|start|stop|restart|status|logs|setup-code|settings-import|migrate|forget-secrets|fix|clean)
        mapfile -t _flags < <(global_flag_args)
        ensure_docker_access "$@" "${_flags[@]}"
        ;;
esac

# Main command handling
case "${1:-}" in
    "setup")
        check_requirements
        install_docker
        setup_environment
        print_status "Setup complete!"
        deploy_now="n"
        if [[ "${NON_INTERACTIVE:-0}" != "1" ]]; then
            read -r -p "Deploy now? [Y/n]: " deploy_now
            deploy_now=${deploy_now:-y}
        fi
        if [[ "$deploy_now" =~ ^[yY] ]]; then
            mapfile -t _flags < <(global_flag_args)
            ensure_docker_access deploy "${_flags[@]}"
            deploy_application
        else
            print_info "Run '$0 deploy' to start the application."
        fi
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
    "setup-code")
        # With no login password set (in the app or as APP_PASSWORD in .env),
        # the backend prints a one-time code at startup; the setup screen asks
        # for it before letting anyone choose the password.
        code=$(compose_cmd logs --no-color backend 2>/dev/null | grep -o 'SETUP CODE: [A-Z0-9-]*' | tail -1 | sed 's/SETUP CODE: //')
        if [[ -n "$code" ]]; then
            echo "$code"
        else
            print_info "No setup code in the backend log: the login password is already set."
            print_info "Locked out? Set APP_PASSWORD in .env and run '$0 redeploy'; it takes precedence."
        fi
        ;;
    "settings-import")
        settings_import
        ;;
    "migrate")
        # The backend does this itself at startup; this shows the state and
        # applies anything pending without a restart.
        if [[ -z "$(compose_cmd ps -q backend 2>/dev/null)" ]]; then
            print_error "The backend is not running. Start it first: $0 start"
            exit 1
        fi
        compose_cmd exec -T backend node dist/cli/migrate.js
        ;;
    "forget-secrets")
        print_warning "Use this only when SETTINGS_ENCRYPTION_KEY is lost. It clears every secret"
        print_warning "sealed with it: broker connection credentials, secret settings, the MFA secret"
        print_warning "and the session key. Connections and settings stay; enter the secrets again."
        answer="n"
        if [[ "${NON_INTERACTIVE:-0}" != "1" ]]; then
            read -r -p "Type FORGET to continue: " answer
        fi
        if [[ "$answer" != "FORGET" ]]; then
            print_info "Nothing changed."
            exit 0
        fi
        if [[ -z "$(compose_cmd ps -q backend 2>/dev/null)" ]]; then
            print_error "The backend is not running. Start it first: $0 start"
            exit 1
        fi
        compose_cmd exec -T backend node dist/cli/forgetSecrets.js
        compose_cmd restart backend
        wait_for_backend_ready 300
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