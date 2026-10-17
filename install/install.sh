#!/usr/bin/env bash
# TradingApp unattended installer.
#
# Installs the Docker stack on one Ubuntu/Debian host (a Proxmox LXC, a VM or
# bare metal) in PAPER mode, from an answers file, and verifies it. Every
# phase is idempotent: re-running it checks what is already in place and only
# does what is missing, so it is also how an install is upgraded or repaired.
#
# This script does what needs root (packages, Docker, the deploy user, the
# checkout, the boot unit). Everything about the app itself is done by
# `tradingapp.sh install`, run as the deploy user, so an unattended install
# and a hand install end up the same. Brokers are not in the answers: they are
# added in the app (Settings > Connections), which checks each one.
#
# Written to be driven by an agent following docs/INSTALL.md Appendix A. It never
# invents an operator credential, and it never turns live trading on.
#
#   install.sh [--answers FILE] PHASE...
#
# Phases, in the order `all` runs them:
#   preflight  OS, root, packages, network, address-space checks
#   docker     install Docker (fuse-overlayfs first on ZFS), hello-world gate
#   user       create the unprivileged deploy user
#   repo       clone or fast-forward the repository
#   env        write .env (the database and the encryption key, nothing else)
#   schema     nothing to do: the backend migrates its database at startup
#   deploy     build and start the stack, wait until ready, store settings
#   verify     run every acceptance check, write the report
#   service    install the systemd unit that starts the stack on boot
#   all        every phase above
#
# Exit codes: 0 done, 1 a step failed, 2 an operator input is missing or
# invalid, 3 refused for safety (something would enable live trading).

# Phases run indirectly ("phase_$p"); check() always returns 0, so A && B || C is safe.
# shellcheck disable=SC2329,SC2015
set -Eeuo pipefail
trap 'printf "[install] ERROR: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2; exit 1' ERR

ANSWERS_FILE=/etc/tradingapp/install.answers
LOG_DIR=/var/log/tradingapp-install
REPORT_FILE=$LOG_DIR/report.txt

declare -A ANS=()
ANSWERS_COPY=''
# The deploy user's copy of the answers holds secrets; never leave it behind.
trap '[[ -n $ANSWERS_COPY ]] && rm -f "$ANSWERS_COPY"' EXIT

# Broker keys. tradingapp.sh refuses them too; checked here first so the
# message comes before anything is installed.
BROKER_KEYS=(BROKER_CONNECTIONS BROKER_CONNECTIONS_FILE IB_HOST IB_PORT IB_CLIENT_ID
    MT5_BRIDGE_URL MT5_BRIDGE_SECRET MT5_ACCOUNT_INFO_SOURCE ALPACA_API_KEY ALPACA_API_SECRET
    ALPACA_PAPER OANDA_API_TOKEN OANDA_ACCOUNT_ID OANDA_ENVIRONMENT)

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
fail() {
    # fail EXIT_CODE MESSAGE
    local code=$1
    shift
    printf '[install] ERROR: %s\n' "$*" >&2
    exit "$code"
}

# ---------------------------------------------------------------------------
# Answers file
# ---------------------------------------------------------------------------
# KEY=VALUE lines, `#` comments, optional surrounding quotes. Parsed, never
# sourced, so a value is data and cannot run anything.
load_answers() {
    local file=$1 line key val perms
    [[ -f $file ]] || fail 2 "answers file $file not found (copy install/install.answers.example)"
    perms=$(stat -c '%a' "$file")
    if (((8#$perms & 8#077) != 0)); then
        fail 2 "$file is readable by other users (mode $perms); run: chmod 600 $file"
    fi
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
        if [[ ! $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
            fail 2 "answers file: cannot read line: ${line%%=*}=..."
        fi
        key=${BASH_REMATCH[1]}
        val=${BASH_REMATCH[2]}
        if [[ $val =~ ^\'(.*)\'$ ]] || [[ $val =~ ^\"(.*)\"$ ]]; then
            val=${BASH_REMATCH[1]}
        fi
        ANS[$key]=$val
    done <"$file"
}

ans() { printf '%s' "${ANS[$1]:-${2:-}}"; }

# Installer settings, with defaults.
settings() {
    DIR=$(ans INSTALL_DIR /opt/tradingapp)
    APP_USER=$(ans INSTALL_USER tradingapp)
    REPO_URL=$(ans INSTALL_REPO_URL https://github.com/41agent41/tradingapp.git)
    REF=$(ans INSTALL_REF master)
    DB_MODE=$(ans INSTALL_DB_MODE bundled)
    HEALTH_TIMEOUT=$(ans INSTALL_HEALTH_TIMEOUT 900)
    case $DB_MODE in bundled | external) ;; *) fail 2 "INSTALL_DB_MODE must be bundled or external" ;; esac
    [[ $APP_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 2 "INSTALL_USER is not a valid user name"
    [[ $HEALTH_TIMEOUT =~ ^[0-9]+$ ]] || fail 2 "INSTALL_HEALTH_TIMEOUT must be a number of seconds"
    ENV_FILE=$DIR/.env
}

# Value in .env as written, surrounding quotes removed. Last definition wins,
# as in Docker Compose.
env_get() {
    local v
    v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2-) || true
    if [[ $v =~ ^\'(.*)\'$ ]] || [[ $v =~ ^\"(.*)\"$ ]]; then v=${BASH_REMATCH[1]}; fi
    printf '%s' "$v"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------------------
# Safety: nothing in the answers may enable live trading
# ---------------------------------------------------------------------------
check_answers_safe() {
    local v k brokers=()
    v=$(lower "$(ans LIVE_TRADING_ENABLED false)")
    [[ $v == false ]] || fail 3 "LIVE_TRADING_ENABLED must be false: this installer only installs paper. Live is a human decision (docs/OPERATIONS.md § Going live)."
    v=$(lower "$(ans SYSTEMATIC_EXECUTION_ENABLED false)")
    [[ $v == false ]] || fail 3 "SYSTEMATIC_EXECUTION_ENABLED must be false at install; it is turned on later, on paper, by docs/PAPER_TRADING.md step 20."
    v=$(lower "$(ans KILL_SWITCH_ACTION notify)")
    case $v in notify | halt | flatten) ;; *) fail 2 "KILL_SWITCH_ACTION must be notify, halt or flatten" ;; esac
    for k in "${BROKER_KEYS[@]}"; do [[ -n ${ANS[$k]+x} ]] && brokers+=("$k"); done
    ((${#brokers[@]} == 0)) || fail 2 "the answers set broker keys (${brokers[*]}). Brokers are added in the app (Settings > Connections), where each is tested as it is saved; remove these lines."
    [[ -z $(ans INSTALL_ALLOW_EXISTING_LIVE) ]] || [[ $(ans INSTALL_ALLOW_EXISTING_LIVE) == yes ]] ||
        fail 2 "INSTALL_ALLOW_EXISTING_LIVE must be yes or absent"
}

# ---------------------------------------------------------------------------
# Running things as the deploy user
# ---------------------------------------------------------------------------
as_user() { (cd "$DIR" && runuser -u "$APP_USER" -- "$@"); }

# tradingapp.sh as the deploy user, with a copy of the answers it can read.
# INSTALL_* lines are this script's own and stay out of the copy, apart from
# INSTALL_DB_MODE.
tradingapp() {
    if [[ -z $ANSWERS_COPY ]]; then
        ANSWERS_COPY=$(mktemp /tmp/tradingapp-answers.XXXXXX)
        local key
        for key in "${!ANS[@]}"; do
            [[ $key == INSTALL_* && $key != INSTALL_DB_MODE ]] && continue
            printf '%s=%s\n' "$key" "${ANS[$key]}"
        done >"$ANSWERS_COPY"
        chmod 600 "$ANSWERS_COPY"
        chown "$APP_USER" "$ANSWERS_COPY"
    fi
    local db_flag=()
    [[ $DB_MODE == external ]] && db_flag=(--external-db)
    as_user env INSTALL_TIMEOUT="$HEALTH_TIMEOUT" bash ./tradingapp.sh \
        --non-interactive --answers "$ANSWERS_COPY" "${db_flag[@]}" "$@"
}

# Compose as the deploy user, with the bundled database's file layered in
# when this host runs it (as tradingapp.sh does).
compose() {
    local files=(-f docker-compose.yml)
    [[ -f $DIR/.tradingapp.with-db ]] && files+=(-f docker-compose.db.yml)
    as_user docker compose "${files[@]}" "$@"
}

server_ip_detect() {
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit}}') || true
    [[ -n $ip ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    printf '%s' "$ip"
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------
phase_preflight() {
    log "preflight: checking the host"
    [[ $EUID -eq 0 ]] || fail 2 "run as root (the installer creates the deploy user and runs the stack as it)"
    [[ -r /etc/os-release ]] || fail 1 "no /etc/os-release; Ubuntu 22.04+/Debian 12+ expected"
    # shellcheck disable=SC1091
    . /etc/os-release
    case ${ID:-} in ubuntu | debian) ;; *) fail 1 "unsupported OS ${ID:-unknown}; Ubuntu or Debian expected" ;; esac
    command -v apt-get >/dev/null || fail 1 "apt-get not found"

    local need=() p
    for p in git curl ca-certificates openssl python3 iproute2 jq; do
        dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
    done
    if ((${#need[@]})); then
        log "preflight: installing ${need[*]}"
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null
    fi

    local arch
    arch=$(dpkg --print-architecture)
    [[ $arch == amd64 || $arch == arm64 ]] || fail 1 "architecture $arch is not supported"

    local mem_kb disk_kb
    mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    ((mem_kb >= 3500000)) || warn "under 4 GB of memory; the frontend build may fail"
    disk_kb=$(df -Pk / | awk 'NR==2 {print $4}')
    ((disk_kb >= 15000000)) || fail 1 "under 15 GB free on /; the images need more"

    timeout 30 git ls-remote --exit-code "$REPO_URL" "$REF" >/dev/null ||
        fail 1 "cannot read $REF from $REPO_URL (network, proxy or INSTALL_REF)"

    local ip
    ip=$(ans SERVER_IP "$(server_ip_detect)")
    [[ -n $ip ]] || fail 2 "could not detect this host's IP; set SERVER_IP in the answers"
    # The stack's Docker network is fixed at 172.20.0.0/16 (docker-compose.yml).
    if [[ $ip == 172.20.* ]]; then
        fail 1 "this host's address $ip overlaps the stack's Docker network 172.20.0.0/16"
    fi
    if ip -4 route 2>/dev/null | grep -qE '^172\.20\.' && ! docker network inspect tradingapp_tradingapp-network >/dev/null 2>&1; then
        fail 1 "a route to 172.20.0.0/16 already exists; the stack's Docker network would collide"
    fi

    if [[ ! -d /run/systemd/system ]]; then
        warn "systemd is not running; the service phase will be skipped"
    fi
    if command -v timedatectl >/dev/null 2>&1; then
        timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes ||
            warn "clock not reported as NTP-synchronised; in an LXC the host's chrony is what matters (docs/PROXMOX.md §3.3)"
    fi
    log "preflight: ok (server address $ip)"
}

phase_docker() {
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        log "docker: already installed ($(docker --version))"
    else
        if ! command -v docker >/dev/null 2>&1; then
            # On a ZFS-backed rootfs overlay2 does not work, and Docker caches
            # its driver choice on first start, so decide before installing.
            if [[ $(stat -f -c %T /) == zfs ]]; then
                log "docker: ZFS root detected, configuring fuse-overlayfs first"
                [[ -e /dev/fuse ]] || fail 1 "ZFS root but no /dev/fuse: on the Proxmox host run 'pct set <ctid> --features nesting=1,keyctl=1,fuse=1' and restart the container"
                DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fuse-overlayfs
                mkdir -p /etc/docker
                [[ -f /etc/docker/daemon.json ]] || echo '{ "storage-driver": "fuse-overlayfs" }' >/etc/docker/daemon.json
            fi
            log "docker: installing from get.docker.com"
            curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
            sh /tmp/get-docker.sh
            rm -f /tmp/get-docker.sh
        fi
        if [[ -d /run/systemd/system ]]; then
            systemctl enable --now docker
        fi
        docker info >/dev/null 2>&1 || fail 1 "Docker is installed but the daemon is not answering (in an LXC: check nesting=1,keyctl=1; docs/PROXMOX.md §12)"
    fi
    docker compose version >/dev/null 2>&1 || fail 1 "the docker compose plugin is missing"
    local driver
    driver=$(docker info --format '{{.Driver}}')
    [[ $driver != vfs ]] || fail 1 "Docker is using the vfs storage driver, which is unusably slow (docs/PROXMOX.md §5.2)"
    docker run --rm hello-world >/dev/null || fail 1 "docker run hello-world failed (docs/PROXMOX.md §12, Docker-in-LXC)"
    log "docker: ok (storage driver $driver)"
}

phase_user() {
    if id "$APP_USER" >/dev/null 2>&1; then
        log "user: $APP_USER exists"
    else
        log "user: creating $APP_USER"
        useradd --create-home --shell /bin/bash "$APP_USER"
    fi
    if ! id -nG "$APP_USER" | tr ' ' '\n' | grep -qx docker; then
        usermod -aG docker "$APP_USER"
        log "user: added $APP_USER to the docker group"
    fi
    runuser -u "$APP_USER" -- docker ps >/dev/null || fail 1 "$APP_USER cannot use Docker"
    log "user: ok"
}

phase_repo() {
    if [[ -d $DIR/.git ]]; then
        local remote
        remote=$(as_user git remote get-url origin)
        [[ $remote == "$REPO_URL" ]] || fail 1 "$DIR is a checkout of $remote, not $REPO_URL"
        # A checkout made with older guides has `chmod +x tradingapp.sh`,
        # which git would otherwise count as a local change.
        as_user git config core.fileMode false
        if [[ -n $(as_user git status --porcelain --untracked-files=no) ]]; then
            fail 1 "$DIR has local changes to tracked files; commit or discard them by hand first (git -C $DIR status)"
        fi
        log "repo: fetching $REF"
        as_user git fetch --quiet origin "$REF"
        as_user git checkout --quiet "$REF" 2>/dev/null || as_user git checkout --quiet -b "$REF" "origin/$REF"
        as_user git merge --quiet --ff-only "origin/$REF" ||
            fail 1 "$DIR cannot fast-forward to origin/$REF; it has diverged"
    else
        if [[ -e $DIR ]] && [[ -n $(ls -A "$DIR" 2>/dev/null) ]]; then
            fail 1 "$DIR exists, is not empty and is not a git checkout"
        fi
        log "repo: cloning $REPO_URL ($REF) into $DIR"
        mkdir -p "$DIR"
        chown "$APP_USER:$APP_USER" "$DIR"
        runuser -u "$APP_USER" -- git clone --quiet --branch "$REF" "$REPO_URL" "$DIR"
        as_user git config core.fileMode false
    fi
    log "repo: ok at $(as_user git rev-parse --short HEAD)"
}

phase_env() {
    [[ -f $DIR/tradingapp.sh ]] || fail 1 "$DIR/tradingapp.sh missing; run the repo phase first"

    # An install a human has since moved to live is theirs; do not touch it
    # unless the operator said so in the answers.
    if [[ $(lower "$(env_get LIVE_TRADING_ENABLED)") == true && $(ans INSTALL_ALLOW_EXISTING_LIVE) != yes ]]; then
        fail 3 ".env already has LIVE_TRADING_ENABLED=true. A human enabled live trading here; the operator must set INSTALL_ALLOW_EXISTING_LIVE=yes in the answers before this installer touches it."
    fi
    if [[ -f $DIR/.tradingapp.with-db && $DB_MODE == external ]]; then
        fail 1 "this host runs the bundled database (.tradingapp.with-db). Moving to an external one is a data migration; do it by hand (docs/OPERATIONS.md, Move from the bundled to an external database)."
    fi

    tradingapp install --env-only || fail 1 "tradingapp.sh install --env-only failed (output above)"
    [[ -f $ENV_FILE ]] || fail 1 "$ENV_FILE was not written"
    chmod 600 "$ENV_FILE"
    chown "$APP_USER:$APP_USER" "$ENV_FILE"
    log "env: ok ($DB_MODE database)"
}

phase_schema() {
    log "schema: nothing to do; the backend applies its migrations when it starts (deploy waits for that)"
}

backend_port() { local p; p=$(env_get BACKEND_PORT); printf '%s' "${p:-4000}"; }
frontend_port() { local p; p=$(env_get FRONTEND_PORT); printf '%s' "${p:-3000}"; }
broker_service_port() { local p; p=$(env_get BROKER_SERVICE_PORT); printf '%s' "${p:-8000}"; }

phase_deploy() {
    log "deploy: building and starting the stack (the first build takes several minutes; up to ${HEALTH_TIMEOUT}s)"
    # The same command as a hand install. On a host that already has .env it
    # only adds what is missing, then builds, starts, waits until the backend
    # is ready, and stores any app settings from the answers in the app.
    tradingapp install || {
        compose ps >&2 || true
        compose logs --no-color --tail 60 backend >&2 || true
        fail 1 "deploy failed (output above)"
    }
    log "deploy: ok"
}

# ---------------------------------------------------------------------------
# Verification: each check prints one line, CHECK <id> PASS|FAIL|SKIP <detail>
# ---------------------------------------------------------------------------
FAILS=0
check() {
    local id=$1 status=$2 detail=$3
    printf 'CHECK %-4s %-4s %s\n' "$id" "$status" "$detail" | tee -a "$REPORT_FILE"
    [[ $status == FAIL ]] && FAILS=$((FAILS + 1))
    return 0
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || true; }

# One value from the database the backend uses: the bundled container, or
# the external database through a throwaway psql container.
db_value() {
    if [[ -f $DIR/.tradingapp.with-db ]]; then
        compose exec -T postgres psql -X -q -t -A -U "$(env_get POSTGRES_USER)" -d "$(env_get POSTGRES_DB)" \
            -c "$1" </dev/null 2>/dev/null || true
        return 0
    fi
    local sslmode=disable
    [[ $(lower "$(env_get POSTGRES_SSL)") == true ]] && sslmode=require
    docker run --rm --network host -e PGPASSWORD="$(env_get POSTGRES_PASSWORD)" postgres:17-alpine \
        psql -X -q -t -A -c "$1" \
        "host=$(env_get POSTGRES_HOST) port=$(env_get POSTGRES_PORT) user=$(env_get POSTGRES_USER) dbname=$(env_get POSTGRES_DB) sslmode=$sslmode" \
        </dev/null 2>/dev/null || true
}

# The broker service token: in .env on an older install, otherwise in the
# internal secrets volume.
broker_service_token() {
    local t
    t=$(env_get BROKER_SERVICE_TOKEN)
    [[ -n $t ]] || t=$(compose exec -T backend cat /run/tradingapp/broker_service_token 2>/dev/null || true)
    printf '%s' "$t"
}

phase_verify() {
    mkdir -p "$LOG_DIR"
    : >"$REPORT_FILE"
    {
        echo "# TradingApp install report"
        echo "date: $(date -u +%FT%TZ)"
        echo "host: $(hostname) ($(ans SERVER_IP "$(server_ip_detect)"))"
        echo "commit: $(as_user git rev-parse --short HEAD)"
        echo "db_mode: $DB_MODE"
    } >>"$REPORT_FILE"
    local bp fp bsp api_token bst running svc code body
    bp=$(backend_port)
    fp=$(frontend_port)
    bsp=$(broker_service_port)
    api_token=$(env_get API_TOKEN)
    bst=$(broker_service_token)

    # V1 containers
    running=$(compose ps --status running --services 2>/dev/null | sort | tr '\n' ' ')
    local want=(backend broker_service frontend redis) missing=()
    [[ -f $DIR/.tradingapp.with-db ]] && want+=(postgres)
    for svc in "${want[@]}"; do [[ " $running " == *" $svc "* ]] || missing+=("$svc"); done
    if ((${#missing[@]})); then check V1 FAIL "not running: ${missing[*]}"; else check V1 PASS "running: $running"; fi

    # V2 backend health, database and cache connected
    body=$(curl -s --max-time 15 "http://127.0.0.1:$bp/api/health" || true)
    if [[ $(jq -r '.status' <<<"$body" 2>/dev/null) == healthy ]]; then
        check V2 PASS "/api/health healthy, cache $(jq -r '.services.cache.status' <<<"$body")"
    else
        check V2 FAIL "/api/health: $(jq -c '{status, db: .services.database.status, broker: .services.broker_service.status}' <<<"$body" 2>/dev/null || echo "no answer")"
    fi

    # V3 database
    code=$(http_code "http://127.0.0.1:$bp/api/database/health")
    [[ $code == 200 ]] && check V3 PASS "/api/database/health 200" || check V3 FAIL "/api/database/health $code"

    # V4 broker service, loopback only
    code=$(http_code "http://127.0.0.1:$bsp/health")
    [[ $code == 200 ]] && check V4 PASS "broker service /health 200" || check V4 FAIL "broker service /health $code"

    # V5 frontend
    code=$(http_code "http://127.0.0.1:$fp/")
    [[ $code =~ ^(200|307|308)$ ]] && check V5 PASS "frontend $code" || check V5 FAIL "frontend $code"

    # V6 authentication: refused without a credential, and accepted with
    # API_TOKEN when .env has one. Without one, tokens live in the app and
    # there is nothing here to sign in with.
    local noauth withauth setup
    noauth=$(http_code "http://127.0.0.1:$bp/api/orders/config")
    if [[ -n $api_token ]]; then
        withauth=$(http_code -H "Authorization: Bearer $api_token" "http://127.0.0.1:$bp/api/orders/config")
        if [[ $noauth == 401 && $withauth == 200 ]]; then
            check V6 PASS "no credential 401, API_TOKEN 200"
        else
            check V6 FAIL "no credential $noauth (want 401), API_TOKEN $withauth (want 200)"
        fi
    elif [[ $noauth == 401 ]]; then
        check V6 PASS "no credential 401 (no API_TOKEN in .env; tokens are made in the app)"
    else
        check V6 FAIL "no credential $noauth (want 401)"
    fi
    setup=$(curl -s --max-time 15 "http://127.0.0.1:$bp/api/auth/session" | jq -r '.setup_required // false' 2>/dev/null || true)
    if [[ $setup == true ]]; then
        log "verify: no login password yet. The first visit asks for a setup code: ./tradingapp.sh setup-code (as $APP_USER, in $DIR)"
    fi

    # V7 the broker service refuses calls without its token
    noauth=$(http_code "http://127.0.0.1:$bsp/providers")
    withauth=$(http_code -H "X-Broker-Service-Token: $bst" "http://127.0.0.1:$bsp/providers")
    if [[ -z $bst ]]; then
        check V7 FAIL "broker service token not found (internal secrets volume or .env)"
    elif [[ $noauth == 401 && $withauth == 200 ]]; then
        check V7 PASS "broker service: no token 401, token 200"
    else
        check V7 FAIL "broker service: no token $noauth (want 401), token $withauth (want 200)"
    fi

    # V8 nothing internal is published on the LAN
    local exposed
    exposed=$(compose port broker_service 8000 2>/dev/null || true)
    if [[ $exposed == 127.0.0.1:* ]]; then
        check V8 PASS "broker service bound to $exposed only"
    else
        check V8 FAIL "broker service published as '${exposed:-?}', expected 127.0.0.1"
    fi

    # V9 database migrated and opened by the encryption key
    body=$(curl -s --max-time 15 "http://127.0.0.1:$bp/api/health/ready" || true)
    if [[ $(jq -r '.ready // false' <<<"$body" 2>/dev/null) == true ]]; then
        check V9 PASS "ready: schema up to date, encryption key matches"
    elif [[ -z $body ]]; then
        check V9 FAIL "no answer from /api/health/ready"
    else
        check V9 FAIL "not ready: $(jq -r '"\(.state // "?"): \(.detail // "")"' <<<"$body" 2>/dev/null || echo "no answer")"
    fi

    # V10 startup log clean
    local refusals
    refusals=$(compose logs --no-color backend 2>/dev/null | grep -c 'refusing to start' || true)
    ((refusals == 0)) && check V10 PASS "no startup refusals in the backend log" || check V10 FAIL "$refusals startup refusals in the backend log"

    # V11 paper mode: neither .env nor the app's settings turn live trading on
    local live app_live
    live=$(lower "$(env_get LIVE_TRADING_ENABLED)")
    app_live=$(lower "$(db_value "SELECT value FROM app_settings WHERE key = 'LIVE_TRADING_ENABLED'")")
    if [[ $live == true ]]; then
        check V11 FAIL "LIVE_TRADING_ENABLED=true in .env on this host"
    elif [[ $app_live == true && -z $live ]]; then
        check V11 FAIL "live trading is turned on in the app's settings"
    else
        check V11 PASS "paper (live trading off in .env and the app)"
    fi

    # V12 .env locked down
    local mode owner
    mode=$(stat -c '%a' "$ENV_FILE")
    owner=$(stat -c '%U' "$ENV_FILE")
    [[ $mode == 600 && $owner == "$APP_USER" ]] && check V12 PASS ".env mode 600, owner $owner" || check V12 FAIL ".env mode $mode owner $owner"

    # V13 broker connections: added in the app, which checks each one. A
    # fresh install has none; any that exist must be paper.
    local providers count live_conns
    providers=$(curl -s --max-time 20 -H "X-Broker-Service-Token: $bst" "http://127.0.0.1:$bsp/providers" || true)
    count=$(jq -r '.connections // {} | length' <<<"$providers" 2>/dev/null || echo "")
    if [[ -z $count ]]; then
        check V13 FAIL "broker service /providers did not answer"
    elif ((count == 0)); then
        check V13 SKIP "no broker connections yet (add them under Settings > Connections)"
    else
        live_conns=$(jq -r '.connections | to_entries | map(select(.value.account_mode != "paper")) | map(.key) | join(" ")' <<<"$providers")
        if [[ -n $live_conns ]]; then
            check V13 FAIL "connections not in paper mode: $live_conns"
        else
            check V13 PASS "connections (paper): $(jq -r '.connections | keys | join(" ")' <<<"$providers")"
        fi
    fi
    # V14 and V15 (MT5 sidecars, IB Gateway reachability) are gone: the app
    # checks every connection itself and shows its state on Settings >
    # Connections, and a broker that is down is not an install failure.

    # V16 dead-man's switch
    local hb hbon health
    health=$(curl -s --max-time 15 "http://127.0.0.1:$bp/api/health" || true)
    hb=$(jq -r '.services.heartbeat.last_result // empty' <<<"$health" 2>/dev/null || true)
    # Set in .env or on the Settings page; the backend reports either.
    hbon=$(jq -r '.services.heartbeat.enabled // empty' <<<"$health" 2>/dev/null || true)
    if [[ -n $(env_get HEARTBEAT_URL) || $hbon == true ]]; then
        [[ $hb == ok ]] && check V16 PASS "heartbeat last_result ok" || check V16 FAIL "heartbeat last_result ${hb:-none yet} (it pings every HEARTBEAT_INTERVAL_SECONDS; re-run verify after a minute)"
    else
        check V16 SKIP "HEARTBEAT_URL not set (needed before any unattended execution)"
    fi

    echo "result: $([[ $FAILS -eq 0 ]] && echo PASS || echo "FAIL ($FAILS)")" | tee -a "$REPORT_FILE"
    log "verify: report written to $REPORT_FILE"
    ((FAILS == 0)) || exit 1
}

phase_service() {
    if [[ ! -d /run/systemd/system ]]; then
        warn "service: systemd not running, skipped"
        return 0
    fi
    local unit=/etc/systemd/system/tradingapp.service tmp
    tmp=$(mktemp)
    cat >"$tmp" <<EOF
# Installed by install/install.sh. Starts the stack on boot through
# tradingapp.sh, which layers docker-compose.db.yml when .tradingapp.with-db
# exists (docs/PROXMOX.md §11).
[Unit]
Description=TradingApp
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DIR
ExecStart=/bin/bash $DIR/tradingapp.sh start
ExecStop=/bin/bash $DIR/tradingapp.sh stop
User=$APP_USER

[Install]
WantedBy=multi-user.target
EOF
    if ! cmp -s "$tmp" "$unit" 2>/dev/null; then
        install -m 644 "$tmp" "$unit"
        systemctl daemon-reload
        log "service: installed $unit"
    fi
    rm -f "$tmp"
    systemctl enable tradingapp.service >/dev/null 2>&1
    systemctl is-enabled --quiet tradingapp.service || fail 1 "tradingapp.service is not enabled"
    log "service: ok (enabled; the stack starts on boot)"
}

main() {
    local phases=()
    while (($#)); do
        case $1 in
            --answers)
                ANSWERS_FILE=${2:?--answers needs a file}
                shift 2
                ;;
            -h | --help)
                sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
                return 0
                ;;
            all) phases+=(preflight docker user repo env schema deploy verify service) && shift ;;
            preflight | docker | user | repo | env | schema | deploy | verify | service) phases+=("$1") && shift ;;
            *) fail 2 "unknown argument: $1 (see --help)" ;;
        esac
    done
    ((${#phases[@]})) || fail 2 "name a phase, or all (see --help)"

    mkdir -p "$LOG_DIR"
    chmod 700 "$LOG_DIR"
    exec > >(tee -a "$LOG_DIR/install.log") 2>&1
    log "---- $(date -u +%FT%TZ) phases: ${phases[*]}"

    load_answers "$ANSWERS_FILE"
    settings
    check_answers_safe

    local p
    for p in "${phases[@]}"; do
        "phase_$p"
    done
    log "done: ${phases[*]}"
}

main "$@"
exit $?
