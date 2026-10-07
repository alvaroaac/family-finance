#!/usr/bin/env bash
# Disposable local Supabase stack for the browser e2e suite.
#
# Lives in .e2e-supabase/ (gitignored) on its own ports (564xx) so it never
# touches a developer's regular local stack or data. Every run resets the
# database and applies all of supabase/migrations from scratch.
#
#   scripts/e2e-local-stack.sh start   # create/reset the stack, print env
#   scripts/e2e-local-stack.sh env     # print the env for an already running stack
#   scripts/e2e-local-stack.sh stop    # stop and delete the stack's data
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$ROOT/.e2e-supabase"
PROJECT_ID="ff-e2e-local"
EXCLUDED="vector,logflare,imgproxy,studio,edge-runtime,realtime,storage-api,mailpit,postgres-meta"

prepare() {
  mkdir -p "$STACK"
  if [ ! -f "$STACK/supabase/config.toml" ]; then
    (cd "$STACK" && supabase init --force >/dev/null)
    # Move every port from 543xx to 564xx and pin the project id.
    sed -i.bak \
      -e "s/^project_id = .*/project_id = \"$PROJECT_ID\"/" \
      -e 's/= 543\([0-9][0-9]\)/= 564\1/' \
      "$STACK/supabase/config.toml"
    rm -f "$STACK/supabase/config.toml.bak"
  fi
  rm -rf "$STACK/supabase/migrations"
  mkdir -p "$STACK/supabase/migrations"
  cp "$ROOT"/supabase/migrations/*.sql "$STACK/supabase/migrations/"
}

print_env() {
  (cd "$STACK" && supabase status -o env) | sed -n \
    -e 's/^API_URL=/E2E_SUPABASE_URL=/p' \
    -e 's/^ANON_KEY=/E2E_SUPABASE_ANON_KEY=/p' \
    -e 's/^SERVICE_ROLE_KEY=/E2E_SUPABASE_SERVICE_ROLE_KEY=/p'
}

# After a reset the API restarts and may serve a stale schema cache for a few
# seconds; wait until it can see the app's tables.
wait_for_api() {
  local url key
  url="$(print_env | sed -n 's/^E2E_SUPABASE_URL=//p' | tr -d '"')"
  key="$(print_env | sed -n 's/^E2E_SUPABASE_SERVICE_ROLE_KEY=//p' | tr -d '"')"
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$url/rest/v1/households?select=id&limit=1" \
      -H "apikey: $key" -H "Authorization: Bearer $key"; then
      return 0
    fi
    sleep 1
  done
  echo "Supabase API did not become ready." >&2
  exit 1
}

case "${1:-}" in
  start)
    prepare
    (cd "$STACK" && { supabase status >/dev/null 2>&1 || supabase start -x "$EXCLUDED"; })
    (cd "$STACK" && supabase db reset --local --no-seed) >&2
    wait_for_api
    print_env
    ;;
  env)
    print_env
    ;;
  stop)
    (cd "$STACK" && supabase stop --no-backup)
    ;;
  *)
    echo "usage: $0 start|env|stop" >&2
    exit 64
    ;;
esac
