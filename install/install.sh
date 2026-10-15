#!/usr/bin/env bash
# TradingApp unattended installer.
#
# Installs the Docker stack on one Ubuntu/Debian host (a Proxmox LXC, a VM or
# bare metal) in PAPER mode, from an answers file, and verifies it. Every
# phase is idempotent: re-running it checks what is already in place and only
# does what is missing, so it is also how an install is upgraded or repaired.
#
# Written to be driven by an agent following AGENT_INSTALL_RUNBOOK.md. It never
# invents an operator credential, and it never turns live trading on.
#
#   install.sh [--answers FILE] PHASE...
#
# Phases, in the order `all` runs them:
#   preflight  OS, root, packages, network, address-space checks
#   docker     install Docker (fuse-overlayfs first on ZFS), hello-world gate
#   user       create the unprivileged deploy user
#   repo       clone or fast-forward the repository
#   env        write .env: fill placeholders, apply answers, generate secrets
#   schema     apply the canonical schema (idempotent) and check its keys
#   deploy     build and start the stack, wait until healthy
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
WORK_FILE=''
# A half-written .env copy holds secrets; never leave it behind.
trap '[[ -n $WORK_FILE ]] && rm -f "$WORK_FILE"' EXIT

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

# ---------------------------------------------------------------------------
# .env helpers (same merge semantics as tradingapp.sh: one key, one line)
# ---------------------------------------------------------------------------
# Value as written, surrounding quotes removed. Last definition wins, as in
# Docker Compose.
env_get() {
    local v
    v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2-) || true
    if [[ $v =~ ^\'(.*)\'$ ]] || [[ $v =~ ^\"(.*)\"$ ]]; then v=${BASH_REMATCH[1]}; fi
    printf '%s' "$v"
}

# Upsert KEY=value. Plain values are written bare; anything else in single
# quotes, which both Compose and `source` read literally.
env_set() {
    local key=$1 value=$2 line tmp
    if [[ $value == *"'"* ]]; then
        fail 2 "$key: values containing a single quote are not supported"
    fi
    if [[ $value =~ ^[A-Za-z0-9_./:,@+=-]*$ ]]; then
        line="$key=$value"
    else
        line="$key='$value'"
    fi
    tmp=$(mktemp "$ENV_FILE.XXXXXX")
    awk -v k="$key" -v l="$line" '
        index($0, k"=") == 1 { if (!done) print l; done=1; next }
        { print }
        END { if (!done) print l }
    ' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}

gen_hex() { openssl rand -hex 32; }

is_placeholder() {
    local v=$1
    [[ -z $v || $v == CHANGE_ME || $v == *YOUR_* ]]
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------------------
# Safety: nothing in the answers may enable live trading
# ---------------------------------------------------------------------------
check_answers_safe() {
    local v
    v=$(lower "$(ans LIVE_TRADING_ENABLED false)")
    [[ $v == false ]] || fail 3 "LIVE_TRADING_ENABLED must be false: this installer only installs paper. Live is a human decision (DEPLOYMENT.md § Enabling live trading)."
    v=$(lower "$(ans SYSTEMATIC_EXECUTION_ENABLED false)")
    [[ $v == false ]] || fail 3 "SYSTEMATIC_EXECUTION_ENABLED must be false at install; it is turned on later, on paper, by PAPER_DEPLOYMENT_RUNBOOK.md step 20."
    v=$(lower "$(ans ALPACA_PAPER true)")
    [[ $v == true ]] || fail 3 "ALPACA_PAPER must be true."
    v=$(lower "$(ans OANDA_ENVIRONMENT practice)")
    [[ $v == practice ]] || fail 3 "OANDA_ENVIRONMENT must be practice."
    v=$(ans IB_PORT 4002)
    if [[ $v == 4001 || $v == 7496 ]]; then
        fail 3 "IB_PORT=$v is IB's live socket. Use the paper socket (4002 Gateway, 7497 TWS)."
    fi
    v=$(lower "$(ans KILL_SWITCH_ACTION notify)")
    case $v in notify | halt | flatten) ;; *) fail 2 "KILL_SWITCH_ACTION must be notify, halt or flatten" ;; esac
    if [[ -n $(ans BROKER_CONNECTIONS) && -n $(ans MT5_BRIDGE_URL) ]]; then
        fail 2 "Set BROKER_CONNECTIONS or MT5_BRIDGE_URL, not both (the app refuses that combination)."
    fi
    [[ -z $(ans INSTALL_ALLOW_EXISTING_LIVE) ]] || [[ $(ans INSTALL_ALLOW_EXISTING_LIVE) == yes ]] ||
        fail 2 "INSTALL_ALLOW_EXISTING_LIVE must be yes or absent"
}

# Prints "conn <id> <platform> <account_mode> <url>" and
# "ref <id> <field> <ENV_NAME>" per connection. Fails on invalid JSON.
manifest_lines() {
    MANIFEST=$1 python3 - <<'PY'
import json, os, sys
try:
    data = json.loads(os.environ["MANIFEST"])
except ValueError as exc:
    sys.exit(f"BROKER_CONNECTIONS is not valid JSON: {exc}")
if not isinstance(data, list) or not all(isinstance(c, dict) for c in data):
    sys.exit("BROKER_CONNECTIONS must be a JSON list of objects")
for c in data:
    cid = str(c.get("id", "")) or "?"
    print("conn", cid, c.get("platform", "?"), c.get("account_mode", "?"), c.get("url", "-"))
    for field in ("secret_env", "key_env", "secret_key_env", "token_env", "account_env"):
        if c.get(field):
            print("ref", cid, field, c[field])
PY
}

check_manifest_safe() {
    local manifest=$1 kind id platform mode _url
    [[ -n $manifest ]] || return 0
    local lines
    lines=$(manifest_lines "$manifest") || fail 2 "BROKER_CONNECTIONS could not be parsed"
    while read -r kind id platform mode _url; do
        [[ $kind == conn ]] || continue
        [[ $mode == paper ]] || fail 3 "connection $id ($platform) has account_mode=$mode; every connection must be paper at install."
    done <<<"$lines"
}

# ---------------------------------------------------------------------------
# Running things as the deploy user, and Compose
# ---------------------------------------------------------------------------
as_user() { (cd "$DIR" && runuser -u "$APP_USER" -- "$@"); }

compose_files() {
    COMPOSE=(docker compose -f docker-compose.yml)
    [[ $DB_MODE == bundled ]] && COMPOSE+=(-f docker-compose.db.yml)
    return 0
}

compose() {
    compose_files
    as_user "${COMPOSE[@]}" "$@"
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
            warn "clock not reported as NTP-synchronised; in an LXC the host's chrony is what matters (PROXMOX_DEPLOYMENT.md §3.3)"
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
        docker info >/dev/null 2>&1 || fail 1 "Docker is installed but the daemon is not answering (in an LXC: check nesting=1,keyctl=1; PROXMOX_DEPLOYMENT.md §15)"
    fi
    docker compose version >/dev/null 2>&1 || fail 1 "the docker compose plugin is missing"
    local driver
    driver=$(docker info --format '{{.Driver}}')
    [[ $driver != vfs ]] || fail 1 "Docker is using the vfs storage driver, which is unusably slow (PROXMOX_DEPLOYMENT.md §4.2)"
    docker run --rm hello-world >/dev/null || fail 1 "docker run hello-world failed (PROXMOX_DEPLOYMENT.md §15, Docker-in-LXC)"
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
        # The deployment guides `chmod +x tradingapp.sh`, which git would
        # otherwise count as a local change.
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
    [[ -f $DIR/.env.example ]] || fail 1 "$DIR/.env.example missing; run the repo phase first"
    check_answers_safe
    check_manifest_safe "$(ans BROKER_CONNECTIONS)"

    # Work on a copy and put it in place only once every step has passed, so
    # a run that stops on a missing input leaves .env exactly as it was.
    local real=$ENV_FILE work=$DIR/.env.install-work
    WORK_FILE=$work
    if [[ -f $real ]]; then
        install -m 600 "$real" "$work"
    else
        log "env: creating .env from .env.example"
        install -m 600 "$DIR/.env.example" "$work"
    fi
    ENV_FILE=$work

    # An install a human has since moved to live is theirs; do not touch it
    # unless the operator said so in the answers.
    if [[ $(lower "$(env_get LIVE_TRADING_ENABLED)") == true && $(ans INSTALL_ALLOW_EXISTING_LIVE) != yes ]]; then
        fail 3 ".env already has LIVE_TRADING_ENABLED=true. A human enabled live trading here; the operator must set INSTALL_ALLOW_EXISTING_LIVE=yes in the answers before this installer touches it."
    fi

    # 1. Address-derived keys. Filled when still a placeholder, or when they
    #    still hold the value derived from the previous SERVER_IP (so a new
    #    SERVER_IP carries them along). A hand-set value (an https URL behind
    #    nginx) is left alone.
    local old_ip new_ip key cur
    old_ip=$(env_get SERVER_IP)
    new_ip=$(ans SERVER_IP)
    if [[ -z $new_ip ]]; then
        if is_placeholder "$old_ip"; then new_ip=$(server_ip_detect); else new_ip=$old_ip; fi
    fi
    [[ -n $new_ip ]] || fail 2 "could not determine SERVER_IP; set it in the answers"
    env_set SERVER_IP "$new_ip"
    declare -A derived=(
        [IB_CORS_ORIGINS]="http://%s:3000"
    )
    for key in "${!derived[@]}"; do
        [[ -n $(ans "$key") ]] && continue
        cur=$(env_get "$key")
        # shellcheck disable=SC2059
        if is_placeholder "$cur" || [[ $cur == "$(printf "${derived[$key]}" "$old_ip")" ]]; then
            # shellcheck disable=SC2059
            env_set "$key" "$(printf "${derived[$key]}" "$new_ip")"
        fi
    done

    # 2. Database.
    if [[ $DB_MODE == bundled ]]; then
        # docker-compose.db.yml points the backend at the bundled database;
        # write the same values so .env tells the truth.
        env_set POSTGRES_HOST 172.20.0.20
        env_set POSTGRES_PORT 5432
        env_set POSTGRES_SSL false
    else
        for key in POSTGRES_HOST POSTGRES_PASSWORD; do
            if [[ -z $(ans "$key") ]] && is_placeholder "$(env_get "$key")"; then
                fail 2 "INSTALL_DB_MODE=external needs $key in the answers"
            fi
        done
    fi
    if [[ -f $DIR/.tradingapp.with-db && $DB_MODE == external ]]; then
        fail 1 "this host runs the bundled database (.tradingapp.with-db). Moving to an external one is a data migration; do it by hand (PROXMOX_DEPLOYMENT.md §5)."
    fi

    # 3. Every app key from the answers, verbatim.
    for key in "${!ANS[@]}"; do
        [[ $key == INSTALL_* ]] && continue
        env_set "$key" "${ANS[$key]}"
    done

    # 4. IB host: a placeholder left in place is a misleading value. Without
    #    IB in the answers, leave it empty: IB is optional, and the broker
    #    service registers it only when IB_HOST names a gateway.
    if is_placeholder "$(env_get IB_HOST)"; then
        env_set IB_HOST ""
    fi

    # 5. Internal secrets: generated once, never rotated by a re-run. The
    #    login password, API token and session key are not generated: the
    #    operator sets the password on the app's first-run screen, and the
    #    rest is kept in the app (Settings > Security). A template value left
    #    for one of those is emptied; a real one (from the answers, or a
    #    previous install) keeps working and wins over the app.
    local generated=()
    for key in BROKER_SERVICE_TOKEN REDIS_PASSWORD SETTINGS_ENCRYPTION_KEY; do
        if is_placeholder "$(env_get "$key")"; then
            env_set "$key" "$(gen_hex)"
            generated+=("$key")
        fi
    done
    if [[ $DB_MODE == bundled ]] && is_placeholder "$(env_get POSTGRES_PASSWORD)"; then
        env_set POSTGRES_PASSWORD "$(gen_hex)"
        generated+=(POSTGRES_PASSWORD)
    fi
    for key in APP_PASSWORD SESSION_SECRET API_TOKEN; do
        if [[ -n $(env_get "$key") ]] && is_placeholder "$(env_get "$key")"; then
            env_set "$key" ""
        fi
    done

    # 6. Broker credentials referenced by the manifest. A sidecar secret is
    #    internal (the same value goes on the sidecar), so it is generated.
    #    A cloud broker's keys are the operator's and must be supplied.
    local manifest kind id field name missing=()
    manifest=$(env_get BROKER_CONNECTIONS)
    if [[ -n $manifest ]]; then
        check_manifest_safe "$manifest"
        while read -r kind id field name; do
            [[ $kind == ref ]] || continue
            [[ -n $(env_get "$name") ]] && continue
            if [[ $field == secret_env ]]; then
                env_set "$name" "$(gen_hex)"
                generated+=("$name")
            else
                missing+=("$name (for connection $id)")
            fi
        done < <(manifest_lines "$manifest")
    fi
    if [[ -n $(env_get MT5_BRIDGE_URL) ]] && [[ -z $(env_get MT5_BRIDGE_SECRET) ]]; then
        env_set MT5_BRIDGE_SECRET "$(gen_hex)"
        generated+=(MT5_BRIDGE_SECRET)
    fi
    ((${#missing[@]} == 0)) || fail 2 "broker credentials missing from the answers: ${missing[*]}"

    # 7. Nothing may still be a template value.
    local leftovers
    leftovers=$(grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_FILE" | grep -E "=(['\"]?)(CHANGE_ME|.*YOUR_[A-Z_]+)" | cut -d= -f1 | sort -u | tr '\n' ' ') || true
    [[ -z $leftovers ]] || fail 2 "still template values in .env: $leftovers"

    ENV_FILE=$real
    [[ -f $real ]] || install -m 600 /dev/null "$real"
    cat "$work" >"$real"
    rm -f "$work"
    chmod 600 "$real"
    chown "$APP_USER:$APP_USER" "$real"
    if ((${#generated[@]})); then
        log "env: generated ${generated[*]}"
    fi
    if [[ -n $(env_get APP_PASSWORD) ]]; then
        log "env: the browser login password is APP_PASSWORD in $ENV_FILE (not printed here)"
    else
        log "env: no login password in .env; the operator chooses one on the app's first-run screen"
    fi
    log "env: ok (mode $(env_get LIVE_TRADING_ENABLED | tr '[:upper:]' '[:lower:]' | sed 's/^true$/LIVE/; s/^false$/paper/; s/^$/paper/'))"
}

wait_postgres_healthy() {
    local cid state i
    for ((i = 0; i < 60; i++)); do
        cid=$(compose ps -q postgres)
        state=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)
        # The image's first-run init serves the socket only; TCP answers once
        # the init scripts (which apply the schema) have finished.
        if [[ $state == healthy ]] && compose exec -T postgres pg_isready -q -h 127.0.0.1 >/dev/null 2>&1; then
            return 0
        fi
        sleep 5
    done
    fail 1 "the bundled database did not become healthy (docker compose logs postgres)"
}

# psql with the schema on stdin, against the configured database.
run_psql() {
    local user db
    user=$(env_get POSTGRES_USER)
    db=$(env_get POSTGRES_DB)
    if [[ $DB_MODE == bundled ]]; then
        compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "${user:-tradingapp}" -d "${db:-tradingapp}" "$@"
    else
        local sslmode=disable
        [[ $(lower "$(env_get POSTGRES_SSL)") == true ]] && sslmode=require
        docker run --rm -i --network host -e PGPASSWORD="$(env_get POSTGRES_PASSWORD)" postgres:17-alpine \
            psql -X -q -v ON_ERROR_STOP=1 \
            "host=$(env_get POSTGRES_HOST) port=$(env_get POSTGRES_PORT) user=${user:-tradingapp} dbname=${db:-tradingapp} sslmode=$sslmode" "$@"
    fi
}

phase_schema() {
    local schema=$DIR/backend/src/database/timescaledb-schema.sql
    [[ -f $schema ]] || fail 1 "$schema missing"
    if [[ $DB_MODE == bundled ]]; then
        touch "$DIR/.tradingapp.with-db"
        chown "$APP_USER:$APP_USER" "$DIR/.tradingapp.with-db"
        log "schema: starting the bundled database"
        compose up -d postgres
        wait_postgres_healthy
    fi
    log "schema: applying timescaledb-schema.sql (idempotent)"
    run_psql <"$schema" >/dev/null || fail 1 "applying the schema failed (output above)"
    local constraint
    constraint=$(run_psql -t -A -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'order_executions'::regclass AND contype = 'u';" </dev/null)
    [[ $constraint == *"UNIQUE (broker, broker_account, exec_id)"* ]] ||
        fail 1 "order_executions lacks UNIQUE (broker, broker_account, exec_id); got: ${constraint:-nothing}"
    log "schema: ok"
}

backend_port() { local p; p=$(env_get BACKEND_PORT); printf '%s' "${p:-4000}"; }
frontend_port() { local p; p=$(env_get FRONTEND_PORT); printf '%s' "${p:-3000}"; }

phase_deploy() {
    log "deploy: building and starting the stack (the first build takes several minutes)"
    compose up -d --build --remove-orphans
    log "deploy: waiting for the backend to report healthy (up to ${HEALTH_TIMEOUT}s)"
    local deadline=$((SECONDS + HEALTH_TIMEOUT)) code
    while ((SECONDS < deadline)); do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$(backend_port)/api/health" || true)
        if [[ $code == 200 ]]; then
            log "deploy: backend healthy"
            return 0
        fi
        if compose logs --no-color --tail 200 backend 2>/dev/null | grep -q 'refusing to start'; then
            compose logs --no-color --tail 200 backend | grep 'refusing to start' | sort -u >&2
            fail 1 "the backend refused its configuration (lines above name the key)"
        fi
        sleep 10
    done
    compose ps >&2 || true
    compose logs --no-color --tail 60 backend >&2 || true
    fail 1 "the backend was not healthy after ${HEALTH_TIMEOUT}s"
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

phase_verify() {
    mkdir -p "$LOG_DIR"
    : >"$REPORT_FILE"
    {
        echo "# TradingApp install report"
        echo "date: $(date -u +%FT%TZ)"
        echo "host: $(hostname) ($(env_get SERVER_IP))"
        echo "commit: $(as_user git rev-parse --short HEAD)"
        echo "db_mode: $DB_MODE"
    } >>"$REPORT_FILE"
    local bp fp api_token bst running svc code body
    bp=$(backend_port)
    fp=$(frontend_port)
    api_token=$(env_get API_TOKEN)
    bst=$(env_get BROKER_SERVICE_TOKEN)

    # V1 containers
    running=$(compose ps --status running --services 2>/dev/null | sort | tr '\n' ' ')
    local want=(backend broker_service frontend redis) missing=()
    [[ $DB_MODE == bundled ]] && want+=(postgres)
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
    code=$(http_code "http://127.0.0.1:$(env_get BROKER_SERVICE_PORT | sed 's/^$/8000/')/health")
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

    # V7 the broker service refuses calls without its shared secret
    local bsp
    bsp=$(env_get BROKER_SERVICE_PORT)
    bsp=${bsp:-8000}
    noauth=$(http_code "http://127.0.0.1:$bsp/providers")
    withauth=$(http_code -H "X-Broker-Service-Token: $bst" "http://127.0.0.1:$bsp/providers")
    if [[ $noauth == 401 && $withauth == 200 ]]; then
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

    # V9 schema
    local constraint
    constraint=$(run_psql -t -A -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'order_executions'::regclass AND contype = 'u';" </dev/null 2>/dev/null || true)
    [[ $constraint == *"UNIQUE (broker, broker_account, exec_id)"* ]] &&
        check V9 PASS "order_executions keyed on (broker, broker_account, exec_id)" ||
        check V9 FAIL "order_executions unique key: ${constraint:-unreadable}"

    # V10 startup log clean
    local refusals
    refusals=$(compose logs --no-color backend 2>/dev/null | grep -c 'refusing to start' || true)
    ((refusals == 0)) && check V10 PASS "no startup refusals in the backend log" || check V10 FAIL "$refusals startup refusals in the backend log"

    # V11 paper mode and safety rails
    local live sysexec ks
    live=$(lower "$(env_get LIVE_TRADING_ENABLED)")
    sysexec=$(lower "$(env_get SYSTEMATIC_EXECUTION_ENABLED)")
    ks=$(lower "$(env_get KILL_SWITCH_ACTION)")
    if [[ $live != true ]]; then
        check V11 PASS "paper: LIVE_TRADING_ENABLED=${live:-false}, SYSTEMATIC_EXECUTION_ENABLED=${sysexec:-false}, KILL_SWITCH_ACTION=${ks:-notify}"
    else
        check V11 FAIL "LIVE_TRADING_ENABLED=true on this host"
    fi

    # V12 .env locked down
    local mode owner
    mode=$(stat -c '%a' "$ENV_FILE")
    owner=$(stat -c '%U' "$ENV_FILE")
    [[ $mode == 600 && $owner == "$APP_USER" ]] && check V12 PASS ".env mode 600, owner $owner" || check V12 FAIL ".env mode $mode owner $owner"

    # V13 broker connections the app sees (only when some are configured)
    local providers
    providers=$(curl -s --max-time 20 -H "X-Broker-Service-Token: $bst" "http://127.0.0.1:$bsp/providers" || true)
    if [[ -n $(env_get BROKER_CONNECTIONS) ]]; then
        local perr
        perr=$(jq -r '.error // empty' <<<"$providers" 2>/dev/null || echo "no answer from /providers")
        local absent=() kind id plat _m _u
        while read -r kind id plat _m _u; do
            [[ $kind == conn ]] || continue
            jq -e --arg l "$plat:$id" '.connections[$l].account_mode == "paper"' <<<"$providers" >/dev/null 2>&1 ||
                absent+=("$plat:$id")
        done < <(manifest_lines "$(env_get BROKER_CONNECTIONS)")
        if [[ -n $perr ]]; then
            check V13 FAIL "manifest error: $perr"
        elif ((${#absent[@]})); then
            check V13 FAIL "not registered as paper by the broker service: ${absent[*]}"
        else
            check V13 PASS "connections: $(jq -c '.connections | to_entries | map({id: .key, mode: .value.account_mode, broker: .value.broker, data: .value.market_data})' <<<"$providers" 2>/dev/null)"
        fi
    else
        check V13 SKIP "no BROKER_CONNECTIONS configured"
    fi

    # V14 MT5 sidecars reachable from this host and refusing the unauthenticated
    local manifest kind id _p _m url secret_name secret
    manifest=$(env_get BROKER_CONNECTIONS)
    if [[ -n $manifest ]] && grep -q '"mt5"' <<<"$manifest"; then
        declare -A sec=()
        while read -r kind id field name; do
            [[ $kind == ref && $field == secret_env ]] && sec[$id]=$name
        done < <(manifest_lines "$manifest")
        while read -r kind id _p _m url; do
            [[ $kind == conn && $_p == mt5 ]] || continue
            secret_name=${sec[$id]:-}
            secret=$(env_get "$secret_name")
            body=$(curl -s --max-time 15 -H "X-MT5-Bridge-Secret: $secret" "$url/health" || true)
            noauth=$(http_code "$url/health")
            local st
            st=$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)
            if [[ $st == ok && $noauth == 401 && $(jq -r '.account_type' <<<"$body") == demo ]]; then
                check V14 PASS "mt5 $id: ok, demo account $(jq -r '.login' <<<"$body"), unauthenticated 401"
            elif [[ $st == trading_disabled ]]; then
                check V14 FAIL "mt5 $id: Algo Trading is off in the terminal (operator: turn it on)"
            elif [[ $st == ok ]]; then
                check V14 FAIL "mt5 $id: account_type $(jq -r '.account_type' <<<"$body") / unauthenticated $noauth (want demo / 401)"
            else
                check V14 FAIL "mt5 $id at $url: ${body:-no answer}"
            fi
        done < <(manifest_lines "$manifest")
    else
        check V14 SKIP "no MT5 connections"
    fi

    # V15 IB Gateway socket reachable, when IB is configured
    local ibh ibp
    ibh=$(env_get IB_HOST)
    ibp=$(env_get IB_PORT)
    if [[ -n $ibh && $ibh != host.docker.internal ]]; then
        if timeout 5 bash -c "echo >/dev/tcp/$ibh/${ibp:-4002}" 2>/dev/null; then
            check V15 PASS "IB Gateway $ibh:${ibp:-4002} accepts connections"
        else
            check V15 FAIL "IB Gateway $ibh:${ibp:-4002} not reachable"
        fi
    else
        check V15 SKIP "IB Gateway not configured"
    fi

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
# exists (PROXMOX_DEPLOYMENT.md §13).
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
