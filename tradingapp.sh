#!/bin/bash

# 🚀 TradingApp management script
#
# `./tradingapp.sh install` commissions a host: Docker, a minimal .env, the
# database, and the stack, waiting until the backend reports its database
# reachable, up to date and opened by the encryption key. Everything else
# (brokers, risk limits, alerts, what data to collect) is set in the app.

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

# Remembers that this host runs the bundled TimescaleDB
# (docker-compose.db.yml). Every compose call layers the override while it
# exists. `install` creates it unless an external database is configured.
WITH_DB_STATE_FILE=".tradingapp.with-db"

# The bundled database's address on the stack's network (docker-compose.db.yml).
BUNDLED_DB_HOST="172.20.0.20"

# What .env holds after `install`: how to reach the database, and the key
# that opens the secrets stored in it. Nothing else is needed.
ENV_KEYS=(POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_SSL SETTINGS_ENCRYPTION_KEY)

# Lines older versions wrote that nothing needs any more: fixed by compose,
# generated into the internal secrets volume, detected at run time, or
# constants. `install` removes them (after a backup).
OBSOLETE_KEYS=(SERVER_IP NODE_ENV REDIS_HOST REDIS_PORT BROKER_SERVICE_TOKEN REDIS_PASSWORD
    IB_CORS_ORIGINS IB_TIMEOUT IB_CLIENT_POOL_SIZE IB_TIMEZONE DATA_TIMEZONE
    EXPECTED_TIMESTAMP_FORMAT IB_FORMAT_DATE TZ NEXT_PUBLIC_API_URL)

# Broker keys. Brokers are added in the app (Settings > Connections), where
# they are checked when saved; install never writes these.
BROKER_KEYS=(BROKER_CONNECTIONS BROKER_CONNECTIONS_FILE IB_HOST IB_PORT IB_CLIENT_ID
    MT5_BRIDGE_URL MT5_BRIDGE_SECRET MT5_ACCOUNT_INFO_SOURCE ALPACA_API_KEY ALPACA_API_SECRET
    ALPACA_PAPER OANDA_API_TOKEN OANDA_ACCOUNT_ID OANDA_ENVIRONMENT)

# Build the `docker compose` invocation, layering the database override
# when --with-db is requested or the state file is present.
compose_cmd() {
    local -a files=(-f docker-compose.yml)
    if bundled_db; then
        files+=(-f docker-compose.db.yml)
    fi
    docker compose "${files[@]}" "$@"
}

bundled_db() { [[ "${WITH_DB:-0}" == "1" ]] || [[ -f "$WITH_DB_STATE_FILE" ]]; }

# Global flags, taken out of argv so the dispatch below sees the command and
# its own arguments.
parse_global_flags() {
    local -a remaining=()
    while (($#)); do
        case "$1" in
            --with-db) WITH_DB=1 ;;
            --no-db)
                WITH_DB=0
                rm -f "$WITH_DB_STATE_FILE"
                ;;
            --external-db) EXTERNAL_DB=1 ;;
            --non-interactive) NON_INTERACTIVE=1 ;;
            --env-only) ENV_ONLY=1 ;;
            --include-database) INCLUDE_DATABASE=1 ;;
            --answers)
                ANSWERS_FILE="${2:?--answers needs a file}"
                shift
                ;;
            *) remaining+=("$1") ;;
        esac
        shift
    done
    GLOBAL_ARGS=("${remaining[@]}")
}

# The global flags in effect, so a re-run under `sg docker` keeps them.
global_flag_args() {
    [[ "${WITH_DB:-0}" == "1" ]] && printf '%s\n' --with-db
    [[ "${EXTERNAL_DB:-0}" == "1" ]] && printf '%s\n' --external-db
    [[ "${NON_INTERACTIVE:-0}" == "1" ]] && printf '%s\n' --non-interactive
    [[ "${ENV_ONLY:-0}" == "1" ]] && printf '%s\n' --env-only
    [[ "${INCLUDE_DATABASE:-0}" == "1" ]] && printf '%s\n' --include-database
    [[ -n "${ANSWERS_FILE:-}" ]] && printf '%s\n' --answers "$ANSWERS_FILE"
    return 0
}

interactive() { [[ "${NON_INTERACTIVE:-0}" != "1" && -t 0 ]]; }

# ---------------------------------------------------------------------------
# .env helpers: one key, one line; every other line is left as it is
# ---------------------------------------------------------------------------
env_get() {
    local v
    v=$(grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d'=' -f2-) || true
    if [[ $v =~ ^\'(.*)\'$ ]] || [[ $v =~ ^\"(.*)\"$ ]]; then v=${BASH_REMATCH[1]}; fi
    printf '%s' "$v"
}

env_set() {
    local key="$1" value="$2" tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" '
        index($0, k"=") == 1 { if (!done) print k"="v; done=1; next }
        { print }
        END { if (!done) print k"="v }
    ' .env >"$tmp"
    cat "$tmp" >.env
    rm -f "$tmp"
}

env_unset() {
    local key="$1" tmp
    tmp=$(mktemp)
    grep -vE "^${key}=" .env >"$tmp" || true
    cat "$tmp" >.env
    rm -f "$tmp"
}

is_placeholder() {
    local v="$1"
    [[ -z $v || $v == CHANGE_ME || $v == *YOUR_* ]]
}

gen_secret() {
    openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# This host's address, for the URLs printed. Not stored anywhere.
host_ip() {
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit}}') || true
    [[ -n $ip ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    printf '%s' "${ip:-localhost}"
}

frontend_port() { local p; p=$(env_get FRONTEND_PORT); printf '%s' "${p:-3000}"; }
backend_port() { local p; p=$(env_get BACKEND_PORT); printf '%s' "${p:-4000}"; }
broker_service_port() { local p; p=$(env_get BROKER_SERVICE_PORT); printf '%s' "${p:-8000}"; }

# ---------------------------------------------------------------------------
# Answers file (unattended installs): KEY=VALUE lines, parsed, never sourced
# ---------------------------------------------------------------------------
declare -A ANS=()

load_answers() {
    local file="$1" line key val
    [[ -f $file ]] || { print_error "Answers file $file not found."; exit 2; }
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
        if [[ ! $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
            print_error "Answers file: cannot read line: ${line%%=*}=..."
            exit 2
        fi
        key=${BASH_REMATCH[1]}
        val=${BASH_REMATCH[2]}
        if [[ $val =~ ^\'(.*)\'$ ]] || [[ $val =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; fi
        ANS[$key]=$val
    done <"$file"
    local k bad=()
    for k in "${BROKER_KEYS[@]}"; do [[ -n ${ANS[$k]+x} ]] && bad+=("$k"); done
    if ((${#bad[@]})); then
        print_error "The answers set broker keys (${bad[*]})."
        echo "  Brokers are added in the app, under Settings > Connections, where each is checked"
        echo "  as it is saved. Remove these lines from the answers and add the brokers there."
        exit 2
    fi
    if [[ -n ${ANS[INSTALL_DB_MODE]:-} ]]; then
        case ${ANS[INSTALL_DB_MODE]} in
            bundled) ;;
            external) EXTERNAL_DB=1 ;;
            *)
                print_error "INSTALL_DB_MODE must be bundled or external"
                exit 2
                ;;
        esac
    fi
}

# ---------------------------------------------------------------------------
# Host: user, Docker
# ---------------------------------------------------------------------------
check_requirements() {
    if [[ $EUID -eq 0 ]]; then
        print_error "Don't run this script as root. Use a user with sudo privileges."
        echo "  Create one and clone as that user (README, 'Install'):"
        echo "    apt update && apt install -y sudo git"
        echo "    adduser tradingapp && usermod -aG sudo tradingapp"
        echo "    su - tradingapp"
        echo "    git clone https://github.com/41agent41/tradingapp.git ~/tradingapp"
        echo "    cd ~/tradingapp && ./tradingapp.sh install"
        exit 1
    fi
    local tool
    for tool in curl openssl; do
        command -v "$tool" &>/dev/null || {
            print_error "$tool is not installed (sudo apt install -y $tool)"
            exit 1
        }
    done
}

install_docker() {
    if command -v docker &>/dev/null && docker compose version &>/dev/null; then
        print_status "Docker present: $(docker --version)"
        return 0
    fi
    print_info "Installing Docker and its compose plugin..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
    sudo usermod -aG docker "$USER"
    if ! docker compose version &>/dev/null && ! sudo docker compose version &>/dev/null; then
        print_error "Docker installed but its compose plugin is missing (sudo apt install -y docker-compose-plugin)"
        exit 1
    fi
    print_status "Docker installed"
}

# Make sure this shell can talk to the Docker daemon. Straight after Docker is
# installed the user's new `docker` group is not active in this shell, so
# re-run this script under `sg docker` (no logout needed).
ensure_docker_access() {
    if docker info &>/dev/null; then
        return 0
    fi
    if ! command -v docker &>/dev/null; then
        print_error "Docker is not installed. Run: $0 install"
        exit 1
    fi
    if [[ ! -S /var/run/docker.sock ]]; then
        print_error "Docker is installed but not running. Start it with: sudo systemctl start docker"
        exit 1
    fi
    if id -nG "${USER:-$(id -un)}" 2>/dev/null | tr ' ' '\n' | grep -qx docker &&
        ! id -nG | tr ' ' '\n' | grep -qx docker; then
        if [[ -z "${TRADINGAPP_SG_REEXEC:-}" ]] && command -v sg &>/dev/null; then
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

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------

# Which database this host uses. Bundled unless told otherwise, or unless an
# existing .env already points at another host.
choose_database() {
    if [[ "${EXTERNAL_DB:-0}" == "1" ]]; then
        if [[ -f "$WITH_DB_STATE_FILE" ]]; then
            print_error "This host runs the bundled database, and its data stays there."
            echo "  Moving to an external database is a data migration (pg_dump, then restore"
            echo "  there). Once it is done, switch with: $0 --no-db install --external-db"
            exit 2
        fi
        DB_MODE=external
    elif [[ -f "$WITH_DB_STATE_FILE" || "${WITH_DB:-0}" == "1" ]]; then
        DB_MODE=bundled
    else
        local host
        host=$(env_get POSTGRES_HOST)
        if [[ -n ${ANS[POSTGRES_HOST]:-} ]]; then host=${ANS[POSTGRES_HOST]}; fi
        if [[ -n $host && $host != "$BUNDLED_DB_HOST" ]] && ! is_placeholder "$host"; then
            DB_MODE=external
        else
            DB_MODE=bundled
        fi
    fi
}

# ask VAR "question" [secret]
ask() {
    local __var="$1" __q="$2" __secret="${3:-}" __a
    if [[ -n $__secret ]]; then
        read -r -s -p "$__q: " __a
        echo
    else
        read -r -p "$__q: " __a
    fi
    printf -v "$__var" '%s' "$__a"
}

# Removes the lines nothing reads any more, after a backup. A broker line is
# kept (it still defines a connection) but reported.
tidy_env() {
    local key removed=() brokers=() v
    for key in "${OBSOLETE_KEYS[@]}"; do
        grep -qE "^${key}=" .env && removed+=("$key")
    done
    # A port at its default, or a login secret left empty, says nothing.
    for key in FRONTEND_PORT BACKEND_PORT BROKER_SERVICE_PORT; do
        v=$(env_get "$key")
        case "$key=$v" in FRONTEND_PORT=3000 | BACKEND_PORT=4000 | BROKER_SERVICE_PORT=8000) removed+=("$key") ;; esac
    done
    for key in APP_PASSWORD SESSION_SECRET API_TOKEN TRADING_TOKENS ORDER_MFA_SECRET CORS_ORIGINS; do
        if grep -qE "^${key}=" .env && is_placeholder "$(env_get "$key")"; then removed+=("$key"); fi
    done
    for key in "${BROKER_KEYS[@]}"; do
        grep -qE "^${key}=.+" .env && brokers+=("$key")
    done
    if ((${#removed[@]})); then
        local backup
        backup=".env.bak.$(date +%Y%m%d%H%M%S)"
        cp -p .env "$backup"
        chmod 600 "$backup"
        for key in "${removed[@]}"; do env_unset "$key"; done
        print_info "Removed from .env, no longer needed: ${removed[*]} (backup: $backup)"
    fi
    if ((${#brokers[@]})); then
        print_warning "  .env still defines brokers (${brokers[*]}); it wins over the app for those brokers."
        print_warning "  Add them under Settings > Connections and delete these lines when you are ready."
    fi
    return 0
}

# Writes or completes .env. On a host that already has one, only what is
# missing is added: the database password and the encryption key are never
# replaced, since the data depends on them.
write_env() {
    local created=0 generated=() key value
    if [[ ! -f .env ]]; then
        (
            umask 077
            cat >.env <<'HEADER'
# TradingApp: what the app needs before it can reach its database. Everything
# else is set in the app (Settings). Written by ./tradingapp.sh install.
HEADER
        )
        created=1
    fi
    chmod 600 .env

    choose_database

    # Answers win over what .env holds, key by key, except the encryption key.
    for key in "${!ANS[@]}"; do
        [[ $key == INSTALL_* || $key == SERVER_IP ]] && continue
        if [[ $key == SETTINGS_ENCRYPTION_KEY ]] && ! is_placeholder "$(env_get "$key")" &&
            [[ "$(env_get "$key")" != "${ANS[$key]}" ]]; then
            print_error "The answers give a SETTINGS_ENCRYPTION_KEY different from the one in .env."
            echo "  Changing it makes every stored secret unreadable. Remove one of the two."
            exit 2
        fi
        env_set "$key" "${ANS[$key]}"
    done

    if [[ $DB_MODE == bundled ]]; then
        touch "$WITH_DB_STATE_FILE"
        env_set POSTGRES_HOST "$BUNDLED_DB_HOST"
        if is_placeholder "$(env_get POSTGRES_PORT)"; then env_set POSTGRES_PORT 5432; fi
        env_set POSTGRES_SSL false
        if is_placeholder "$(env_get POSTGRES_PASSWORD)"; then
            env_set POSTGRES_PASSWORD "$(gen_secret)"
            generated+=(POSTGRES_PASSWORD)
        fi
    else
        rm -f "$WITH_DB_STATE_FILE"
        for key in POSTGRES_HOST POSTGRES_PASSWORD; do
            if is_placeholder "$(env_get "$key")" || [[ $(env_get "$key") == "$BUNDLED_DB_HOST" ]]; then
                if interactive; then
                    if [[ $key == POSTGRES_PASSWORD ]]; then
                        ask value "Database password" secret
                    else
                        ask value "Database host (address of your PostgreSQL + TimescaleDB)"
                    fi
                    [[ -n $value ]] && env_set "$key" "$value"
                fi
                if is_placeholder "$(env_get "$key")" || [[ $(env_get "$key") == "$BUNDLED_DB_HOST" ]]; then
                    print_error "An external database needs $key (in .env, the answers, or typed here)."
                    exit 2
                fi
            fi
        done
        if is_placeholder "$(env_get POSTGRES_PORT)"; then env_set POSTGRES_PORT 5432; fi
        if is_placeholder "$(env_get POSTGRES_SSL)"; then env_set POSTGRES_SSL false; fi
    fi
    if is_placeholder "$(env_get POSTGRES_USER)"; then env_set POSTGRES_USER tradingapp; fi
    if is_placeholder "$(env_get POSTGRES_DB)"; then env_set POSTGRES_DB tradingapp; fi

    # An existing external database was set up with a key; a new one would
    # not open its secrets (the backend stops on that), so ask for it.
    if [[ $DB_MODE == external ]] && is_placeholder "$(env_get SETTINGS_ENCRYPTION_KEY)" && interactive; then
        echo "  If this database was used by an earlier install, paste the encryption key"
        echo "  from that install ($0 backup-key printed it). Leave empty for a new database."
        ask value "Encryption key" secret
        if [[ -n $value ]]; then
            if [[ ! $value =~ ^[0-9a-fA-F]{64}$ && ! $value =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
                print_error "That is not an encryption key (64 hex characters, or base64 of 32 bytes)."
                exit 2
            fi
            env_set SETTINGS_ENCRYPTION_KEY "$value"
        fi
    fi
    if is_placeholder "$(env_get SETTINGS_ENCRYPTION_KEY)"; then
        env_set SETTINGS_ENCRYPTION_KEY "$(gen_secret)"
        generated+=(SETTINGS_ENCRYPTION_KEY)
        NEW_KEY=1
    fi

    if ((created == 0)); then
        tidy_env
    fi

    if ((${#generated[@]})); then
        print_status ".env ready ($DB_MODE database; generated ${generated[*]})"
    else
        print_status ".env ready ($DB_MODE database)"
    fi
    if [[ ${NEW_KEY:-0} == 1 ]]; then
        print_warning "  A new encryption key was generated. Keep a copy off this host: $0 backup-key"
        print_warning "  A rebuild that keeps the database needs it to read the secrets stored there."
    fi
}

# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------

# The backend's readiness (database reachable, migrated, key checked), as
# "<http code> <state> <detail>" from /api/health/ready on this host.
backend_readiness() {
    local body code
    body=$(curl -s --max-time 5 -w '\n%{http_code}' "http://127.0.0.1:$(backend_port)/api/health/ready" 2>/dev/null) || true
    code=$(echo "$body" | tail -n1)
    body=$(echo "$body" | sed '$d')
    if command -v python3 &>/dev/null && [[ -n "$body" ]]; then
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
            migration_failed | key_mismatch)
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
    if [[ $last == waiting_for_database ]]; then
        print_info "Check the database is running and POSTGRES_* in .env point at it."
    fi
    print_info "Check: $0 logs"
    return 1
}

# ---------------------------------------------------------------------------
# Deploy, test
# ---------------------------------------------------------------------------
deploy_application() {
    print_info "Building and starting the stack (the first build takes several minutes)..."
    if [[ "${WITH_DB:-0}" == "1" ]]; then
        touch "$WITH_DB_STATE_FILE"
    fi
    if ! compose_cmd up --build -d --remove-orphans; then
        print_error "The stack did not build or start (output above)."
        return 1
    fi
    # The backend waits for the database and migrates it before it is ready.
    wait_for_backend_ready "${1:-600}" || return 1
    test_deployment
}

test_deployment() {
    local success=true code ready
    print_info "Checking the services..."

    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$(frontend_port)/" || true)
    if [[ $code =~ ^(200|307|308)$ ]]; then
        print_status "Frontend is responding"
    else
        print_error "Frontend is not responding ($code)"
        success=false
    fi

    if curl -s -f --max-time 10 "http://127.0.0.1:$(backend_port)/api/health" >/dev/null; then
        print_status "Backend is responding"
    else
        print_error "Backend is not responding"
        success=false
    fi

    # The container, not any broker behind it.
    if curl -s -f --max-time 10 "http://127.0.0.1:$(broker_service_port)/health" >/dev/null; then
        print_status "Broker service is responding"
    else
        print_error "Broker service is not responding"
        success=false
    fi

    ready=$(backend_readiness)
    if [[ "${ready%% *}" == "200" ]]; then
        print_status "Database is connected and up to date"
    else
        print_error "Backend not ready: $(echo "$ready" | cut -d' ' -f2-)"
        print_info "  ($0 doctor shows the database and key state)"
        success=false
    fi

    # Brokers are deliberately not tested here: the app checks its own broker
    # connections, and a broker that is down must not fail a deploy.
    show_broker_summary

    if $success; then
        print_status "All checks passed"
        show_access_info
    else
        print_error "Some checks failed. See: $0 logs"
        return 1
    fi
}

# Information only: the connections the broker service has, with the app's
# last check of each. Never fails, and never contacts a broker itself.
show_broker_summary() {
    local summary
    command -v python3 &>/dev/null || return 0
    summary=$(curl -s --max-time 5 "http://127.0.0.1:$(broker_service_port)/health" 2>/dev/null |
        python3 -c '
import json, sys
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
        print_info "Broker connections: $summary (see Settings > Connections)"
    else
        print_info "No broker connections yet; add one in the app under Settings > Connections"
    fi
}

setup_code() {
    compose_cmd logs --no-color backend 2>/dev/null | grep -o 'SETUP CODE: [A-Z0-9-]*' | tail -1 | sed 's/SETUP CODE: //'
}

show_access_info() {
    local ip code
    ip=$(host_ip)
    echo ""
    print_status "🚀 TradingApp is running: http://$ip:$(frontend_port)"
    echo ""
    code=$(setup_code)
    if [[ -n $code ]]; then
        echo "First sign-in: open the address above, enter the setup code $code and choose"
        echo "the login password. Then add a broker under Settings > Connections."
    else
        echo "Sign in and open Settings to add brokers and choose what data to collect."
    fi
    echo ""
    echo "  $0 status | logs | doctor"
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
install_app() {
    check_requirements
    if [[ -n "${ANSWERS_FILE:-}" ]]; then load_answers "$ANSWERS_FILE"; fi
    install_docker
    write_env
    if [[ "${ENV_ONLY:-0}" == "1" ]]; then
        return 0
    fi
    mapfile -t _flags < <(global_flag_args)
    ensure_docker_access install "${_flags[@]}"
    deploy_application "${INSTALL_TIMEOUT:-900}" || exit 1

    # Settings given in the answers (alerts, schedules) go into the app, and
    # out of .env again.
    local key
    for key in "${!ANS[@]}"; do
        [[ $key == INSTALL_* || $key == SERVER_IP ]] && continue
        [[ " ${ENV_KEYS[*]} " == *" $key "* ]] && continue
        NON_INTERACTIVE=1 settings_import || true
        break
    done
}

# ---------------------------------------------------------------------------
# settings-import
# ---------------------------------------------------------------------------
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
    print_status "Stored in the app: $(echo "$imported" | tr '\n' ' ')"
    if interactive; then
        read -r -p "Delete these lines from .env (a backup is kept)? [y/N] " answer
        if [[ ! "$answer" =~ ^[Yy] ]]; then
            print_info "Left .env as it is. Values in .env keep winning over the app until removed."
            return 0
        fi
    fi
    local backup key
    backup=".env.bak.$(date +%Y%m%d%H%M%S)"
    cp -p .env "$backup"
    chmod 600 "$backup"
    for key in $imported; do env_unset "$key"; done
    print_status "Removed them from .env (backup: $backup; it holds secrets, delete it once you are happy)."
    print_info "Restarting the backend so the app's values apply..."
    compose_cmd up -d --force-recreate backend >/dev/null
    wait_for_backend_ready 300 || true
}

# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------
doctor() {
    echo "=== Host ==="
    docker --version 2>/dev/null || print_error "Docker not installed"
    docker compose version 2>/dev/null || print_error "Docker compose plugin missing"
    if docker info &>/dev/null; then print_status "Docker daemon running"; else print_error "Docker daemon not reachable"; fi
    echo "Address: $(host_ip)"

    echo ""
    echo "=== Configuration ==="
    if [[ -f .env ]]; then
        local mode keys extra=() key
        mode=$(stat -c '%a' .env 2>/dev/null || echo '?')
        if [[ $mode == 600 ]]; then print_status ".env present (mode 600)"; else print_warning ".env mode $mode; run: chmod 600 .env"; fi
        keys=$(grep -oE '^[A-Z][A-Z0-9_]*=' .env | tr -d '=' | sort -u)
        for key in $keys; do
            [[ " ${ENV_KEYS[*]} " == *" $key "* ]] || extra+=("$key")
        done
        for key in "${ENV_KEYS[@]}"; do
            grep -qE "^${key}=.+" .env || print_warning "  $key is not set"
        done
        if ((${#extra[@]})); then
            print_info "  Also in .env (each wins over the app): ${extra[*]}"
            print_info "  '$0 install' removes obsolete lines; '$0 settings-import' moves settings into the app."
        fi
    else
        print_error ".env missing; run: $0 install"
    fi
    if bundled_db; then
        print_info "Database: bundled (TimescaleDB container on this host)"
    else
        print_info "Database: external, $(env_get POSTGRES_HOST):$(env_get POSTGRES_PORT)/$(env_get POSTGRES_DB)"
    fi

    echo ""
    echo "=== Containers ==="
    compose_cmd ps 2>/dev/null || echo "No containers"

    echo ""
    echo "=== Database, schema and key (as the backend sees them) ==="
    local body
    body=$(curl -s --max-time 5 "http://127.0.0.1:$(backend_port)/api/health/ready" 2>/dev/null || true)
    if [[ -n $body ]] && command -v python3 &>/dev/null; then
        echo "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  state:", d.get("state"), ("- " + d["detail"]) if d.get("detail") else "")
print("  database:", d.get("database"))
m = d.get("migrations") or {}
if m:
    print("  migrations:", ", ".join(m.get("current") or []) or "none")
    if m.get("applied"):
        print("  applied at this start:", ", ".join(m["applied"]))
'
    else
        print_error "The backend is not answering on port $(backend_port)"
    fi

    echo ""
    echo "=== Brokers (checked inside the app) ==="
    show_broker_summary
}

# ---------------------------------------------------------------------------
# clean, keys
# ---------------------------------------------------------------------------
clean_up() {
    local answer=""
    if [[ "${INCLUDE_DATABASE:-0}" == "1" ]]; then
        print_warning "This removes the containers, images AND the bundled database with every"
        print_warning "setting, connection and stored bar in it, and the internal secrets. It cannot be undone."
        if interactive; then read -r -p "Type DELETE to continue: " answer; fi
        if [[ $answer != DELETE ]]; then
            print_info "Nothing removed."
            return 0
        fi
    else
        print_info "Removes the containers, the app's images and the build cache. The database and"
        print_info "the internal secrets are kept (add --include-database to remove them too)."
        if interactive; then
            read -r -p "Continue? [y/N] " answer
            if [[ ! $answer =~ ^[Yy] ]]; then
                print_info "Nothing removed."
                return 0
            fi
        fi
    fi
    if [[ "${INCLUDE_DATABASE:-0}" == "1" ]]; then
        compose_cmd down --remove-orphans --volumes --rmi local
        rm -f "$WITH_DB_STATE_FILE"
    else
        compose_cmd down --remove-orphans --rmi local
    fi
    docker builder prune -f >/dev/null
    print_status "Cleaned. Run '$0 deploy' to build and start again."
}

backup_key() {
    local key
    key=$(env_get SETTINGS_ENCRYPTION_KEY)
    if is_placeholder "$key"; then
        print_error "No SETTINGS_ENCRYPTION_KEY in .env."
        return 1
    fi
    echo "SETTINGS_ENCRYPTION_KEY=$key"
    echo ""
    print_warning "Store this off this host (a password manager). It opens the broker credentials"
    print_warning "and other secrets in the database; a rebuild that keeps the database needs it."
}

rotate_internal_secrets() {
    print_info "Replacing the broker service token and the Redis password..."
    ROTATE_INTERNAL_SECRETS=1 compose_cmd run --rm secrets
    compose_cmd up -d --force-recreate redis broker_service backend
    wait_for_backend_ready 300
    local key
    for key in BROKER_SERVICE_TOKEN REDIS_PASSWORD; do
        if grep -qE "^${key}=.+" .env; then
            print_warning "$key is still set in .env and wins; '$0 install' removes it."
        fi
    done
    return 0
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
show_usage() {
    cat <<EOF
🚀 TradingApp

Usage: $0 COMMAND [flags]

Commission:
  install             Docker, .env, the database and the stack, in one step. Safe
                      to re-run: it only adds what is missing.
      --external-db   use an existing PostgreSQL + TimescaleDB instead of the
                      bundled one (asks for its host and password)
      --answers FILE  take answers from FILE (KEY=VALUE lines) instead of asking
      --non-interactive  never prompt

Run:
  deploy              Build and start, then wait until ready
  redeploy            Rebuild from scratch, then deploy (the database is kept)
  start | stop | restart | status
  logs [follow]       Recent logs, or follow them
  setup-code          The code the first-run screen asks for

Maintain:
  doctor              Database, schema, key and broker state, and what .env holds
  test                Check the services answer
  migrate             Bring the database schema up to date now
  settings-import     Move settings from .env into the app
  backup-key          Print the encryption key, to store off this host
  rotate-internal-secrets  Replace the broker service token and Redis password
  forget-secrets      Clear secrets sealed with a lost encryption key
  fix                 Restart everything and check it
  clean [--include-database]  Remove containers and images (and the database)

Brokers, risk limits, alerts and what data to collect are set in the app.
EOF
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
parse_global_flags "$@"
set -- "${GLOBAL_ARGS[@]}"

# Old names.
case "${1:-}" in
    setup) set -- install "${@:2}" ;;
    diagnose) set -- doctor "${@:2}" ;;
    config | env)
        print_info "'$1' is now part of install, which only adds what is missing."
        ENV_ONLY=1
        set -- install "${@:2}"
        ;;
    ib-help | verify-timestamps)
        print_info "'$1' is gone: add IB under Settings > Connections, where the Test button checks it."
        print_info "Running '$0 doctor' instead."
        set -- doctor "${@:2}"
        ;;
esac

# Commands that talk to Docker first make sure this shell can.
case "${1:-}" in
    deploy | redeploy | start | stop | restart | status | logs | setup-code | settings-import | migrate | \
        forget-secrets | fix | clean | rotate-internal-secrets)
        mapfile -t _flags < <(global_flag_args)
        ensure_docker_access "$@" "${_flags[@]}"
        ;;
esac

case "${1:-}" in
    install)
        install_app
        ;;
    deploy)
        deploy_application
        ;;
    redeploy)
        print_info "Rebuilding from scratch (the database is kept)..."
        compose_cmd down --remove-orphans
        compose_cmd build --no-cache
        deploy_application
        ;;
    start)
        compose_cmd up -d
        print_status "Services started"
        ;;
    stop)
        compose_cmd down --remove-orphans
        print_status "Services stopped"
        ;;
    restart)
        compose_cmd restart
        print_status "Services restarted"
        ;;
    status)
        compose_cmd ps
        ;;
    logs)
        if [[ "${2:-}" == "follow" || "${2:-}" == "-f" ]]; then
            compose_cmd logs -f
        else
            compose_cmd logs --tail=30
        fi
        ;;
    setup-code)
        # With no login password set (in the app or as APP_PASSWORD in .env),
        # the backend prints a one-time code at startup; the setup screen asks
        # for it before letting anyone choose the password.
        code=$(setup_code)
        if [[ -n "$code" ]]; then
            echo "$code"
        else
            print_info "No setup code in the backend log: the login password is already set."
            print_info "Locked out? Set APP_PASSWORD in .env and run '$0 restart'; it takes precedence."
        fi
        ;;
    settings-import)
        settings_import
        ;;
    migrate)
        # The backend does this itself at startup; this shows the state and
        # applies anything pending without a restart.
        if [[ -z "$(compose_cmd ps -q backend 2>/dev/null)" ]]; then
            print_error "The backend is not running. Start it first: $0 start"
            exit 1
        fi
        compose_cmd exec -T backend node dist/cli/migrate.js
        ;;
    forget-secrets)
        print_warning "Use this only when SETTINGS_ENCRYPTION_KEY is lost. It clears every secret"
        print_warning "sealed with it: broker connection credentials, secret settings, the MFA secret"
        print_warning "and the session key. Connections and settings stay; enter the secrets again."
        answer="n"
        if interactive; then
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
    test)
        test_deployment
        ;;
    doctor)
        doctor
        ;;
    fix)
        if [[ ! -f .env ]]; then
            print_error "No .env; run: $0 install"
            exit 1
        fi
        compose_cmd down --remove-orphans 2>/dev/null || true
        deploy_application
        ;;
    clean)
        clean_up
        ;;
    backup-key)
        backup_key
        ;;
    rotate-internal-secrets)
        rotate_internal_secrets
        ;;
    help | --help | -h | "")
        show_usage
        ;;
    *)
        print_error "Unknown command: $1"
        show_usage
        exit 1
        ;;
esac
