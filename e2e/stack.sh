#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SUPABASE_TELEMETRY_DISABLED=1
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/private/tmp/family-finance-e2e-config}"
mkdir -p "$XDG_CONFIG_HOME"
project_id=family-finance-e2e
workdir="$root/e2e"

case "${1:-}" in
  up)
    supabase start --workdir "$workdir" --exclude realtime,storage-api,studio,mailpit,logflare,edge-runtime,imgproxy,postgres-meta,vector,supavisor >/dev/null
    supabase db reset --local --workdir "$workdir" --yes
    bash "$0" env
    ;;
  down)
    supabase stop --project-id "$project_id" --no-backup --workdir "$workdir"
    ;;
  env)
    supabase status --workdir "$workdir" --output env | while IFS= read -r line; do
      case "$line" in
        ANON_KEY=*) echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=${line#ANON_KEY=}"; echo "SUPABASE_ANON_KEY=${line#ANON_KEY=}" ;;
        SERVICE_ROLE_KEY=*) echo "SUPABASE_SERVICE_ROLE_KEY=${line#SERVICE_ROLE_KEY=}" ;;
        JWT_SECRET=*) echo "SUPABASE_JWT_SECRET=${line#JWT_SECRET=}" ;;
        API_URL=*) echo "NEXT_PUBLIC_SUPABASE_URL=${line#API_URL=}"; echo "SUPABASE_URL=${line#API_URL=}" ;;
        DB_URL=*) echo "DATABASE_URL=${line#DB_URL=}" ;;
      esac
    done
    ;;
  bot|web)
    eval "$(bash "$0" env)"
    export NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET DATABASE_URL
    if [[ "$1" == bot ]]; then
      cd "$root"
      exec pnpm --filter @family-finance/e2e test:bot
    else
      cd "$root"
      export E2E_HARNESS=1
      export NEXT_PUBLIC_SITE_URL=http://localhost:3100
      export ALLOWED_WEB_HOSTS=localhost:3100,127.0.0.1:3100
      pnpm --filter @family-finance/web build
      exec pnpm --filter @family-finance/web exec playwright test --config playwright.config.ts e2e/harness-smoke.spec.ts e2e/multi-tenant.spec.ts
    fi
    ;;
  *) echo "Usage: $0 {up|down|env|bot|web}" >&2; exit 2 ;;
esac
