#!/usr/bin/env bash
# One end-to-end run: fresh schema, start the stack, run the test, stop.
# Needs Postgres (TimescaleDB in CI) reachable through the POSTGRES_* variables,
# the backend built (`npm run build` in backend/), and Python with the broker
# service's and the sidecar's requirements installed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/tradingapp-e2e}"
PYTHON="${PYTHON:-python3}"
export E2E_DIR PYTHON

psql_e2e() {
  PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h "${POSTGRES_HOST:-localhost}" \
    -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-tradingapp}" "$@"
}

# The schema is applied twice, as the install script does: one pass on a fresh
# database leaves an index for a column added later in the file.
for _ in 1 2; do
  psql_e2e -q -f "$ROOT/backend/src/database/timescaledb-schema.sql" >"$E2E_DIR-schema.log" 2>&1
done

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
