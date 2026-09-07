#!/usr/bin/env bash
#
# Per-boot service startup for the TradingApp environment. Brings up the
# infrastructure daemons (Redis + PostgreSQL) and waits until they are ready.
# The application services themselves run as `terminals` (see environment.json)
# so their logs stay visible and they can be restarted individually.
#
# Idempotent: skips anything that is already running.
set -euo pipefail

PGVER=16
PGBIN="/usr/lib/postgresql/${PGVER}/bin"
PGDATA="/var/lib/postgresql/tradingdata"

echo "==> Redis"
if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379
fi

echo "==> PostgreSQL"
# /var/run is a fresh tmpfs on each boot, so the default unix-socket/lock
# directory is absent and pg_ctl start would fail with "could not create lock
# file". Recreate it (idempotent) before starting the server.
sudo install -d -o postgres -g postgres -m 2775 /var/run/postgresql
if ! sudo -u postgres "${PGBIN}/pg_isready" -p 5432 -q; then
  sudo -u postgres "${PGBIN}/pg_ctl" -D "${PGDATA}" -l /tmp/pg.log -w start
fi
for _ in $(seq 1 30); do
  sudo -u postgres "${PGBIN}/pg_isready" -p 5432 -q && break || sleep 1
done

sudo -u postgres "${PGBIN}/pg_isready" -p 5432 \
  && echo "==> Infrastructure ready (Redis :6379, PostgreSQL :5432)."
