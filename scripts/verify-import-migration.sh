#!/usr/bin/env bash
set -euo pipefail

name="family-finance-import-verify-${PPID}"
cleanup() { docker stop "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -d --name "$name" -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name" pg_isready -U postgres >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin; create table auth.users(id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as 'select null::uuid'; create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null

for file in supabase/migrations/*.sql; do
  docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - < "$file" >/dev/null
done
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - \
  < supabase/migrations/0016_import_reliability.sql >/dev/null
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -f - \
  < packages/db/test/import-reliability-functional.sql >/dev/null

docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "select verify_concurrent_import('60000000-0000-0000-0000-000000000001', repeat('7',64), repeat('8',64));" >/dev/null &
first_pid=$!
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "select verify_concurrent_import('60000000-0000-0000-0000-000000000002', repeat('9',64), repeat('8',64));" >/dev/null &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
concurrent_count="$(docker exec "$name" psql -U postgres -tA -c \
  "select count(*) from transactions where description='Concurrent'")"
if [[ "$concurrent_count" != "1" ]]; then
  echo "concurrent claim assertion failed" >&2
  exit 1
fi

echo "import migration apply/reapply and functional assertions passed"
