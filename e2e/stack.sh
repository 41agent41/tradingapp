#!/usr/bin/env bash
# Start the paper stack for an end-to-end run: two simulated MT5 terminals
# behind the real sidecar, the broker service, and the backend with the
# strategy runner executing on paper. Everything runs on loopback.
#
#   e2e/stack.sh start   # needs Postgres reachable via POSTGRES_* and a built backend
#   e2e/stack.sh stop
#
# Logs and pids go to $E2E_DIR (default /tmp/tradingapp-e2e).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/tradingapp-e2e}"
PYTHON="${PYTHON:-python3}"
mkdir -p "$E2E_DIR"

export E2E_SECRET_A="${E2E_SECRET_A:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
export E2E_SECRET_B="${E2E_SECRET_B:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
export E2E_API_TOKEN="${E2E_API_TOKEN:-e2e-api-token-0123456789abcdef0123}"
export E2E_BROKER_TOKEN="${E2E_BROKER_TOKEN:-e2e-broker-token-0123456789abcdef}"

start_bg() { # name, then the command
  local name="$1"; shift
  "$@" >"$E2E_DIR/$name.log" 2>&1 &
  echo $! >"$E2E_DIR/$name.pid"
}

wait_for() { # url, then curl args
  local url="$1"; shift
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$@" "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $url" >&2
  return 1
}

start_sidecar() { # name port secret symbol login balance
  start_bg "sidecar-$1" "$PYTHON" "$ROOT/e2e/sim_sidecar.py" \
    --port "$2" --secret "$3" --symbol "$4" --login "$5" --balance "$6"
  wait_for "http://127.0.0.1:$2/health" -H "X-MT5-Bridge-Secret: $3"
}

# The economic calendar the backend reads for prop news blackouts, served from
# a file the test rewrites, because the real feed is not reachable from CI.
start_calendar() {
  mkdir -p "$E2E_DIR/calendar"
  [ -f "$E2E_DIR/calendar/calendar.json" ] || echo '[]' >"$E2E_DIR/calendar/calendar.json"
  # Also stands in for the dead-man's switch monitor the backend pings.
  echo ok >"$E2E_DIR/calendar/heartbeat"
  start_bg calendar "$PYTHON" -m http.server 9199 --bind 127.0.0.1 --directory "$E2E_DIR/calendar"
  wait_for "http://127.0.0.1:9199/calendar.json"
}

start_broker() {
  (
    cd "$ROOT/broker_service"
    export BROKER_CONNECTIONS='[
      {"id":"sim-a","platform":"mt5","url":"http://127.0.0.1:9101","secret_env":"E2E_SECRET_A",
       "account_mode":"paper","currency":"USD","default":true},
      {"id":"sim-b","platform":"mt5","url":"http://127.0.0.1:9102","secret_env":"E2E_SECRET_B",
       "account_mode":"paper","currency":"USD","symbol_map":{"EURUSD":"EURUSDm"}}]'
    export BROKER_SERVICE_TOKEN="$E2E_BROKER_TOKEN"
    exec "$PYTHON" -m uvicorn main:app --host 127.0.0.1 --port 8000 --log-level warning
  ) >"$E2E_DIR/broker.log" 2>&1 &
  echo $! >"$E2E_DIR/broker.pid"
  wait_for "http://127.0.0.1:8000/health" -H "X-Broker-Service-Token: $E2E_BROKER_TOKEN"
}

start_backend() {
  (
    cd "$ROOT/backend"
    export PORT=4000
    export API_TOKEN="$E2E_API_TOKEN"
    export BROKER_SERVICE_URL=http://127.0.0.1:8000
    export BROKER_SERVICE_TOKEN="$E2E_BROKER_TOKEN"
    export REDIS_ENABLED=false
    export BACKFILL_ENABLED=false
    export STREAMING_ENABLED=false
    export SYSTEMATIC_ENABLED=true
    export SYSTEMATIC_EXECUTION_ENABLED=true
    export SYSTEMATIC_INTERVAL_SECONDS="${SYSTEMATIC_INTERVAL_SECONDS:-5}"
    export SYSTEMATIC_INITIAL_DELAY_MS=1000
    export EXECUTIONS_SYNC_ENABLED=true
    export EXECUTIONS_SYNC_INTERVAL_SECONDS=5
    export EXECUTIONS_SYNC_INITIAL_DELAY_MS=1000
    export PROMOTION_PAPER_GATE=off
    export KILL_SWITCH_ACTION=halt
    export CONNECTION_MAX_DAILY_EQUITY_LOSS__MT5_SIM_A=50
    export CONNECTION_MAX_DRAWDOWN__MT5_SIM_A=80
    export PROP_RULES__MT5_SIM_B='{"firm":"Sim Prop 25k","initial_balance":25000,"daily_loss":{"pct":5,"basis":"higher"},"max_loss":{"pct":10,"mode":"trailing_equity"},"buffer_pct":20,"news_blackout":{"minutes_before":60,"minutes_after":60,"impact":["High"]}}'
    export NEWS_CALENDAR_URL=http://127.0.0.1:9199/calendar.json
    export NEWS_CALENDAR_REFRESH_MINUTES=0.05
    export HEARTBEAT_URL=http://127.0.0.1:9199/heartbeat
    export HEARTBEAT_INTERVAL_SECONDS=10
    export LOG_LEVEL=info
    exec node dist/index.js
  ) >"$E2E_DIR/backend.log" 2>&1 &
  echo $! >"$E2E_DIR/backend.pid"
  wait_for "http://127.0.0.1:4000/api/health" -H "Authorization: Bearer $E2E_API_TOKEN"
}

stop_one() {
  local pidfile="$E2E_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

case "${1:-}" in
  start)
    start_sidecar a 9101 "$E2E_SECRET_A" EURUSD.a 51234567 10000
    start_sidecar b 9102 "$E2E_SECRET_B" EURUSDm 88776655 25000
    mkdir -p "$E2E_DIR/calendar" && echo '[]' >"$E2E_DIR/calendar/calendar.json"
    start_calendar
    start_broker
    start_backend
    echo "stack up; logs in $E2E_DIR"
    ;;
  stop)
    for name in backend broker calendar sidecar-a sidecar-b; do stop_one "$name"; done
    ;;
  restart)
    # Restart one component in place: e2e/stack.sh restart backend|broker|sidecar-a|sidecar-b
    stop_one "$2"
    sleep 1
    case "$2" in
      backend) start_backend ;;
      broker) start_broker ;;
      calendar) start_calendar ;;
      sidecar-a) start_sidecar a 9101 "$E2E_SECRET_A" EURUSD.a 51234567 10000 ;;
      sidecar-b) start_sidecar b 9102 "$E2E_SECRET_B" EURUSDm 88776655 25000 ;;
    esac
    ;;
  *)
    echo "usage: $0 start|stop|restart <component>" >&2
    exit 2
    ;;
esac
