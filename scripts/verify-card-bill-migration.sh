#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

name="family-finance-card-bill-verify-${PPID}-${RANDOM}"
cleanup() { docker stop "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -d --name "$name" -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  docker logs "$name" >&2 || true
  echo "postgres did not become ready" >&2
  exit 1
fi

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin; create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as 'select null::uuid'; create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null

migration="supabase/migrations/202610070000_card_bill_closing_and_payments.sql"
functional="packages/db/test/card-bill-functional.sql"
for file in supabase/migrations/*.sql; do
  if [[ "$file" == "$migration" ]]; then
    docker exec -i "$name" psql -v ON_ERROR_STOP=1 -v prepare_backfill=true -U postgres -f - < "$functional" >/dev/null
  fi
  docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - < "$file" >/dev/null
done
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -v prepare_reapply=true -U postgres -f - < "$functional" >/dev/null
for file in supabase/migrations/*.sql; do
  [[ "$file" < "$migration" ]] && continue
  docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - < "$file" >/dev/null
done
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - < "$functional" >/dev/null

echo "card bill migration apply/reapply and functional assertions passed"
