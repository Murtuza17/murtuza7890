#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Run the server-side test suite against a throwaway local Postgres.
#
# No Supabase account, no network, no credentials. The migrations that run here
# are byte-for-byte the ones that run in Supabase, so a green run means the
# schema, the RPCs, the RLS policies and the claim arbitration all work.
#
#   ./scripts/test-db.sh              schema + RPC tests + RLS probes
#   ./scripts/test-db.sh --race       also run the concurrent double-claim test
# ---------------------------------------------------------------------------
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
export PGDATA=${PGDATA:-/tmp/vetswap-pgdata}
export PGPORT=${PGPORT:-55432}
export PGHOST=${PGHOST:-/tmp}
export PGUSER=postgres
DB=vetswap_test
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "$PGBIN/initdb" ]; then
  echo "Postgres 16 binaries not found at $PGBIN — set PGBIN to your install." >&2
  exit 1
fi
export PATH="$PGBIN:$PATH"

if ! pg_isready -q 2>/dev/null; then
  echo "== starting a throwaway postgres on port $PGPORT"
  rm -rf "$PGDATA"
  initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
  pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $PGHOST -c listen_addresses=''" -l /tmp/vetswap-pg.log start >/dev/null
  trap 'pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true' EXIT
  sleep 1
fi

echo "== rebuilding $DB from migrations"
psql -q -c "drop database if exists $DB;" -c "create database $DB;" postgres
# Supabase ships an `extensions` schema and the anon/authenticated roles.
psql -q -d "$DB" -c "create schema if not exists extensions;"
psql -q -d postgres -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;"

for m in "$ROOT"/supabase/migrations/*.sql; do
  echo "   -> $(basename "$m")"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$m" 2>&1 | grep -v "^NOTICE" || true
done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$ROOT/supabase/seed.sql" >/dev/null

echo ""
echo "== rpc tests"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$ROOT/supabase/tests/rpc_test.sql" 2>&1 \
  | grep -v "^CREATE FUNCTION" | sed 's/^psql:.*NOTICE:  //'

echo ""
echo "== rls probes (what a hostile browser holding the anon key can do)"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$ROOT/supabase/tests/rls_test.sql" 2>&1 \
  | grep -v "^CREATE FUNCTION" | sed 's/^psql:.*NOTICE:  //'

if [ "${1:-}" = "--race" ]; then
  echo ""
  echo "== concurrent double-claim"
  "$ROOT/scripts/race-test.sh" "$DB"
fi

echo ""
echo "all database tests passed"
