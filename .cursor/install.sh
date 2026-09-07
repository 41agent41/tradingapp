#!/usr/bin/env bash
#
# Idempotent bootstrap for the TradingApp development environment.
#
# Prepares everything a Cloud Agent needs to run the full stack:
#   - system services: Redis, PostgreSQL 16 + TimescaleDB
#   - backend  (Node/TypeScript, Express + Socket.IO) — deps + build
#   - frontend (Next.js) — deps
#   - broker_service (Python/FastAPI) — venv + deps
#   - a local TimescaleDB cluster with the app schema applied
#
# Safe to re-run: every step guards against work that is already done.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PGVER=16
PGBIN="/usr/lib/postgresql/${PGVER}/bin"
PGDATA="/var/lib/postgresql/tradingdata"

echo "==> [1/5] System packages (Redis, PostgreSQL ${PGVER}, TimescaleDB)"
if ! command -v redis-server >/dev/null 2>&1 \
  || [ ! -x "${PGBIN}/initdb" ] \
  || ! ls /usr/lib/postgresql/${PGVER}/lib/timescaledb*.so >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    redis-server postgresql-common gnupg lsb-release wget ca-certificates
  # TimescaleDB apt repository (ships the extension for PostgreSQL 16).
  if [ ! -f /usr/share/keyrings/timescale.gpg ]; then
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/timescale.gpg
    echo "deb [signed-by=/usr/share/keyrings/timescale.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" \
      | sudo tee /etc/apt/sources.list.d/timescaledb.list >/dev/null
    sudo apt-get update -qq
  fi
  sudo apt-get install -y -qq \
    postgresql-${PGVER} postgresql-client-${PGVER} \
    timescaledb-2-postgresql-${PGVER} timescaledb-2-loader-postgresql-${PGVER}
fi

echo "==> [2/5] Backend dependencies + build"
# Lockfiles are intentionally gitignored in this repo (see .gitignore), so a
# fresh checkout has none — use `npm install` (as CI does), not `npm ci`.
( cd backend && npm install --no-audit --no-fund && npm run build )

echo "==> [3/5] Frontend dependencies"
( cd frontend && npm install --no-audit --no-fund )

echo "==> [4/5] Broker service virtualenv + dependencies"
if [ ! -x broker_service/.venv/bin/python ]; then
  # Base images sometimes ship python3 without ensurepip/venv — install it.
  if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
    PYMINOR="$(python3 -c 'import sys; print(sys.version_info.minor)')"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "python3.${PYMINOR}-venv" python3-venv \
      || sudo apt-get install -y -qq python3-venv
  fi
  python3 -m venv broker_service/.venv
fi
broker_service/.venv/bin/pip install --upgrade pip >/dev/null
broker_service/.venv/bin/pip install \
  -r broker_service/requirements.txt -r broker_service/requirements-dev.txt

echo "==> [5/5] PostgreSQL cluster + schema"
# The data dir is postgres-owned and mode 0700, so probe it via sudo — a plain
# test as the install user would always fail and re-trigger initdb.
if ! sudo test -s "${PGDATA}/PG_VERSION"; then
  sudo mkdir -p "${PGDATA}"
  sudo chown -R postgres:postgres "${PGDATA}"
  sudo -u postgres "${PGBIN}/initdb" -D "${PGDATA}" -U postgres --auth=trust -E UTF8
  {
    echo "shared_preload_libraries = 'timescaledb'"
    echo "timezone = 'UTC'"
    echo "listen_addresses = '127.0.0.1'"
    echo "port = 5432"
  } | sudo tee -a "${PGDATA}/postgresql.conf" >/dev/null
fi

# Bring the cluster up briefly to create the role/db/schema, then stop it —
# per-boot startup is start.sh's job.
sudo -u postgres "${PGBIN}/pg_ctl" -D "${PGDATA}" -l /tmp/pg-install.log -w start || true
for _ in $(seq 1 30); do
  sudo -u postgres "${PGBIN}/pg_isready" -p 5432 -q && break || sleep 1
done

sudo -u postgres "${PGBIN}/psql" -p 5432 -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='tradingapp'" | grep -q 1 \
  || sudo -u postgres "${PGBIN}/psql" -p 5432 -c \
     "CREATE USER tradingapp WITH PASSWORD 'tradingapp123' SUPERUSER;"

sudo -u postgres "${PGBIN}/psql" -p 5432 -tAc \
  "SELECT 1 FROM pg_database WHERE datname='tradingapp'" | grep -q 1 \
  || sudo -u postgres "${PGBIN}/psql" -p 5432 -c \
     "CREATE DATABASE tradingapp OWNER tradingapp;"

# The canonical schema references the order_audit update-trigger before the
# table is declared, so a single fresh pass leaves that one trigger uncreated.
# The file is fully idempotent (IF NOT EXISTS throughout), so a second pass
# completes it. Errors on already-existing objects are expected and ignored.
for _ in 1 2; do
  sudo -u postgres "${PGBIN}/psql" -p 5432 -d tradingapp \
    -f backend/src/database/timescaledb-schema.sql >/dev/null 2>&1 || true
done

sudo -u postgres "${PGBIN}/pg_ctl" -D "${PGDATA}" -w stop || true

echo "==> Install complete."
