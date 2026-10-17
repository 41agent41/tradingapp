#!/usr/bin/env bash
# Install one MT5 terminal + sidecar under Wine on Linux, headless.
#
# This is option 2 of docs/INSTALL.md § 5.2 (MetaTrader 5) as an
# idempotent script: one Wine prefix, env file and systemd unit per account.
# Run as root on the host that will run the terminal (a VM, or a privileged
# LXC; see docs/PROXMOX.md §1.2).
#
#   mt5-sidecar-wine.sh install --instance NAME [--port 9100]
#                               [--server-tz Europe/Athens]
#                               [--installer-url URL]
#   mt5-sidecar-wine.sh check   --instance NAME
#   mt5-sidecar-wine.sh vnc     --instance NAME
#
# Secrets come from the environment, never from arguments (which other users
# can read in the process list):
#   MT5_BRIDGE_SECRET   required on first install: a random value (openssl
#                       rand -hex 32). The same value goes in the app, as the
#                       connection's Bridge secret (Settings > Connections).
#   MT5_LOGIN, MT5_PASSWORD, MT5_SERVER
#                       optional: the DEMO account the operator gives you. With
#                       them the sidecar logs the terminal in on start.
#
# `check` exits 0 when /health says ok on a demo account and refuses a request
# without the secret. `vnc` serves the instance's virtual screen on
# localhost:5900 (one session) so the operator can log in once and turn Algo
# Trading on; reach it through an SSH tunnel.
#
# Exit codes: 0 done, 1 a step failed, 2 bad arguments or missing input,
# 4 needs the operator (terminal not logged in, or Algo Trading off).

set -Eeuo pipefail
trap 'printf "[mt5] ERROR: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2; exit 1' ERR

log() { printf '[mt5] %s\n' "$*"; }
fail() {
    local code=$1
    shift
    printf '[mt5] ERROR: %s\n' "$*" >&2
    exit "$code"
}

CMD=${1:-}
[[ -n $CMD ]] && shift
INSTANCE='' PORT=9100 SERVER_TZ=Europe/Athens
# The systemd unit (mt5_sidecar/deploy) runs the sidecar from here.
REPO_DIR=/opt/tradingapp
INSTALLER_URL=https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
PYTHON_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe
REPO_URL=https://github.com/41agent41/tradingapp.git

while (($#)); do
    case $1 in
        --instance) INSTANCE=$2 && shift 2 ;;
        --port) PORT=$2 && shift 2 ;;
        --server-tz) SERVER_TZ=$2 && shift 2 ;;
        --installer-url) INSTALLER_URL=$2 && shift 2 ;;
        *) fail 2 "unknown argument $1" ;;
    esac
done

[[ $CMD =~ ^(install|check|vnc)$ ]] || fail 2 "usage: $0 install|check|vnc --instance NAME (see the header)"
[[ $INSTANCE =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 2 "--instance is required: lower-case letters, digits, - and _"
[[ $PORT =~ ^[0-9]+$ ]] || fail 2 "--port must be a number"
[[ $EUID -eq 0 ]] || fail 2 "run as root"

MT5_USER=mt5
MT5_HOME=/var/lib/mt5
PREFIX=$MT5_HOME/$INSTANCE
ENV_DIR=/etc/mt5-sidecar
ENV_FILE=$ENV_DIR/$INSTANCE.env
UNIT=mt5-sidecar@$INSTANCE
TERMINAL_WIN='C:\Program Files\MetaTrader 5\terminal64.exe'
TERMINAL_UNIX="$PREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe"

# WINEDLLOVERRIDES skips the Mono and Gecko install prompts, which would
# otherwise wait forever on a screen nobody sees.
as_mt5() {
    runuser -u "$MT5_USER" -- env HOME="$MT5_HOME" WINEPREFIX="$PREFIX" WINEDEBUG=-all \
        WINEDLLOVERRIDES='mscoree,mshtml=' "$@"
}

env_get() {
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2- | sed "s/^['\"]//; s/['\"]$//" || true
}

env_set() {
    local key=$1 value=$2 tmp
    [[ $value != *$'\n'* ]] || fail 2 "$key contains a newline"
    tmp=$(mktemp)
    awk -v k="$key" -v l="$key=$value" '
        index($0, k"=") == 1 { if (!done) print l; done=1; next }
        { print }
        END { if (!done) print l }
    ' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}

do_install() {
    log "installing packages"
    export DEBIAN_FRONTEND=noninteractive
    local need=() p
    for p in wine wine64 xvfb xauth winbind curl git ca-certificates jq; do
        dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
    done
    if ((${#need[@]})); then
        apt-get update -qq
        apt-get install -y -qq "${need[@]}" >/dev/null
    fi

    id "$MT5_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$MT5_HOME" --shell /usr/sbin/nologin "$MT5_USER"

    if [[ ! -f $REPO_DIR/mt5_sidecar/server.py ]]; then
        [[ -e $REPO_DIR ]] && fail 1 "$REPO_DIR exists but has no mt5_sidecar/server.py"
        log "cloning the repository into $REPO_DIR"
        git clone --quiet "$REPO_URL" "$REPO_DIR"
    fi

    install -d -o "$MT5_USER" -g "$MT5_USER" -m 750 "$PREFIX"
    local cache=$MT5_HOME/.cache-installers
    install -d -o "$MT5_USER" -g "$MT5_USER" "$cache"

    if ! as_mt5 timeout 300 xvfb-run --auto-servernum wine python --version >/dev/null 2>&1; then
        log "installing Windows Python 3.11 into $PREFIX"
        as_mt5 curl -fsSL -o "$cache/python-3.11.9-amd64.exe" "$PYTHON_URL"
        as_mt5 timeout 900 xvfb-run --auto-servernum wine "$cache/python-3.11.9-amd64.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
        as_mt5 wineserver -w || true
        # The systemd unit runs `wine python`, so python must be on the
        # prefix's PATH, not just present.
        as_mt5 timeout 300 xvfb-run --auto-servernum wine python --version >/dev/null 2>&1 ||
            fail 1 "Windows Python is not on the PATH of $PREFIX after installing"
    fi
    log "python: $(as_mt5 timeout 300 xvfb-run --auto-servernum wine python --version 2>/dev/null | tr -d '\r')"

    if [[ ! -f $TERMINAL_UNIX ]]; then
        log "installing the MT5 terminal from $INSTALLER_URL"
        as_mt5 curl -fsSL -o "$cache/mt5setup-$INSTANCE.exe" "$INSTALLER_URL"
        as_mt5 timeout 900 xvfb-run --auto-servernum wine "$cache/mt5setup-$INSTANCE.exe" /auto || true
        # The setup program downloads the terminal and may return before it
        # has finished; wait for the binary.
        local i
        for ((i = 0; i < 120; i++)); do
            [[ -f $TERMINAL_UNIX ]] && break
            sleep 5
        done
        as_mt5 wineserver -k || true
        [[ -f $TERMINAL_UNIX ]] || fail 1 "the terminal did not appear at $TERMINAL_WIN. A broker installer may use another folder: pass it as MT5_TERMINAL_PATH in $ENV_FILE and re-run."
    fi
    log "terminal: present"

    log "installing the sidecar's Python packages"
    as_mt5 timeout 900 xvfb-run --auto-servernum wine python -m pip install --quiet --disable-pip-version-check \
        -r 'Z:\opt\tradingapp\mt5_sidecar\requirements.txt'

    # Settings. The secret and login come from the environment; a value
    # already in the file is kept when the variable is not given.
    install -d -m 750 -o root -g "$MT5_USER" "$ENV_DIR"
    [[ -f $ENV_FILE ]] || install -m 640 -o root -g "$MT5_USER" /dev/null "$ENV_FILE"
    local secret=${MT5_BRIDGE_SECRET:-$(env_get MT5_BRIDGE_SECRET)}
    [[ ${#secret} -ge 24 ]] || fail 2 "MT5_BRIDGE_SECRET is missing or shorter than 24 characters; export a random one (openssl rand -hex 32) and enter the same value as the connection's Bridge secret in the app"
    env_set MT5_BRIDGE_SECRET "$secret"
    env_set MT5_SIDECAR_HOST 0.0.0.0
    env_set MT5_SIDECAR_PORT "$PORT"
    [[ -n $(env_get MT5_TERMINAL_PATH) ]] || env_set MT5_TERMINAL_PATH "$TERMINAL_WIN"
    env_set MT5_PORTABLE false
    env_set MT5_SERVER_TZ "$SERVER_TZ"
    [[ -n $(env_get MT5_MAGIC) ]] || env_set MT5_MAGIC 61000
    [[ -n $(env_get MT5_DEVIATION_POINTS) ]] || env_set MT5_DEVIATION_POINTS 20
    # Demo accounts only from this script.
    env_set MT5_ALLOW_REAL false
    local k
    for k in MT5_LOGIN MT5_PASSWORD MT5_SERVER; do
        [[ -n ${!k:-} ]] && env_set "$k" "${!k}"
    done
    chmod 640 "$ENV_FILE"
    chown root:"$MT5_USER" "$ENV_FILE"

    install -m 644 "$REPO_DIR/mt5_sidecar/deploy/mt5-sidecar@.service" /etc/systemd/system/mt5-sidecar@.service
    systemctl daemon-reload
    systemctl enable "$UNIT" >/dev/null 2>&1
    systemctl restart "$UNIT"
    log "service $UNIT started on port $PORT; waiting for the terminal"
    local i
    for ((i = 0; i < 24; i++)); do
        curl -s -o /dev/null --max-time 5 -H "X-MT5-Bridge-Secret: $secret" "http://127.0.0.1:$PORT/health" && break
        sleep 5
    done
    do_check
}

do_check() {
    local secret body code status
    secret=$(env_get MT5_BRIDGE_SECRET)
    [[ -n $secret ]] || fail 2 "$ENV_FILE has no MT5_BRIDGE_SECRET; run install first"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/health" || true)
    body=$(curl -s --max-time 15 -H "X-MT5-Bridge-Secret: $secret" "http://127.0.0.1:$PORT/health" || true)
    status=$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)
    log "health: ${body:-no answer}"
    [[ $code == 401 ]] || fail 1 "a request without the secret got $code, not 401"
    case $status in
        ok)
            [[ $(jq -r '.account_type' <<<"$body") == demo ]] ||
                fail 1 "the terminal is logged in to a non-demo account; this install is for demo accounts only. Stop $UNIT."
            log "check: PASS (demo account $(jq -r '.login' <<<"$body") on $(jq -r '.server' <<<"$body"), unauthenticated 401)"
            ;;
        trading_disabled)
            fail 4 "the terminal is logged in but Algo Trading is off. Operator: run '$0 vnc --instance $INSTANCE' and turn it on."
            ;;
        *)
            fail 4 "the terminal is not connected. Operator: give MT5_LOGIN/MT5_PASSWORD/MT5_SERVER and re-run install, or log in by hand via '$0 vnc --instance $INSTANCE'."
            ;;
    esac
}

do_vnc() {
    local main xvfb display auth
    command -v x11vnc >/dev/null || apt-get install -y -qq x11vnc >/dev/null
    main=$(systemctl show -p MainPID --value "$UNIT")
    [[ $main != 0 ]] || fail 1 "$UNIT is not running"
    xvfb=$(pgrep -a -P "$main" Xvfb || true)
    [[ -n $xvfb ]] || fail 1 "no Xvfb under $UNIT"
    display=$(awk '{print $3}' <<<"$xvfb")
    auth=$(grep -o -- '-auth [^ ]*' <<<"$xvfb" | awk '{print $2}')
    log "serving display $display on localhost:5900 for one session."
    log "operator: ssh -L 5900:localhost:5900 root@<this host>, then open a VNC viewer on localhost:5900"
    runuser -u "$MT5_USER" -- x11vnc -display "$display" -auth "$auth" -localhost -rfbport 5900 -once -nopw -quiet
}

case $CMD in
    install) do_install ;;
    check)
        PORT=$(env_get MT5_SIDECAR_PORT)
        PORT=${PORT:-9100}
        do_check
        ;;
    vnc) do_vnc ;;
esac
