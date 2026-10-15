#!/usr/bin/env bash
# One end-to-end run: start the stack (the backend builds the schema), run the
# test, stop.
# Needs Postgres (TimescaleDB in CI) reachable through the POSTGRES_* variables,
# the backend built (`npm run build` in backend/), and Python with the broker
# service's and the sidecar's requirements installed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/tradingapp-e2e}"
PYTHON="${PYTHON:-python3}"
export E2E_DIR PYTHON

# No schema step: the backend creates and migrates the database itself when it
# starts (backend/src/services/migrations.ts), as on a real install, and the
# stack only counts as up once that has happened.

"$ROOT/e2e/stack.sh" start || { tail -n 50 "$E2E_DIR"/*.log; "$ROOT/e2e/stack.sh" stop; exit 1; }
"$PYTHON" -m pytest "$ROOT/e2e" -q -x
status=$?
"$ROOT/e2e/stack.sh" stop
if [ "$status" -ne 0 ]; then
  for log in "$E2E_DIR"/*.log; do
    echo "===== $log"
    tail -n 80 "$log"
  done
fi
exit "$status"
