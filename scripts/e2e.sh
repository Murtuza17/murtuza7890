#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Full stack, locally, with no Supabase account:
#   throwaway Postgres  ->  PostgREST shim  ->  built app  ->  headless Chromium
#
#   ./scripts/e2e.sh
# ---------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
export PGDATA=${PGDATA:-/tmp/vetswap-pgdata}
export PGHOST=${PGHOST:-/tmp}
export PGPORT=${PGPORT:-55432}
export PGUSER=${PGUSER:-postgres}
export PATH="$PGBIN:$PATH"

API_PORT=54321
WEB_PORT=4173
API_PID=""; WEB_PID=""
cleanup() {
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== database"
# Keep the server up: the shim, the browser and the re-seed all need it.
KEEP_PG=1 ./scripts/test-db.sh >/dev/null
echo "   migrations, seed and server tests green"

# The RPC tests deliberately mutate data — they dispense stock and resolve the
# contested transfers. Re-seed so the browser starts from the pristine demo
# state, including the unclaimed antivenom the double-claim check needs.
psql -q -d vetswap_test -f supabase/seed.sql >/dev/null
echo "   re-seeded to pristine demo state"

echo "== api shim on :$API_PORT"
node scripts/local-api.mjs "$API_PORT" vetswap_test > /tmp/vetswap-api.log 2>&1 &
API_PID=$!
for _ in $(seq 1 30); do
  curl -sf -X POST "http://localhost:$API_PORT/rest/v1/rpc/sweep_expired_reservations" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.3
done

echo "== build"
cat > .env.e2e <<ENV
VITE_SUPABASE_URL=http://localhost:$API_PORT
VITE_SUPABASE_ANON_KEY=local-dev-key
VITE_DEMO_MODE=true
ENV
npx vite build --mode e2e >/dev/null

echo "== preview on :$WEB_PORT"
npx vite preview --port "$WEB_PORT" --strictPort > /tmp/vetswap-web.log 2>&1 &
WEB_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 && break
  sleep 0.3
done

echo ""
node e2e/smoke.mjs
