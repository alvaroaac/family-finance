#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Match Supabase's numeric migration identity, not the full filename.
seen_versions=" "
for file in supabase/migrations/*.sql; do
  version="${file##*/}"
  version="${version%%_*}"
  if [[ "$seen_versions" == *" $version "* ]]; then
    echo "duplicate migration version: $version" >&2
    exit 1
  fi
  seen_versions+="$version "
done
name="family-finance-category-verify-${PPID}-${RANDOM}"
cleanup() { docker stop "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm -d --name "$name" -e POSTGRES_PASSWORD=postgres postgres:17-alpine -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
# The entrypoint's temporary server accepts Unix sockets before restarting.
# Wait for TCP so the first SQL command reaches the final server.
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
sql() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }
sql -c "create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin; create table auth.users(id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as 'select null::uuid'; create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null
# Fresh database: no seed household exists when the migration runs.
for file in supabase/migrations/*.sql; do sql -f - < "$file" >/dev/null; done
# Simulate previously deployed category kinds, including an archived salary
# bucket and real references. Reapplying must correct kinds without replacing IDs.
sql -c "insert into households(id,name) values ('00000000-0000-0000-0000-000000000001','Casa'); insert into categories(id,household_id,name,is_active) values ('70000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Salário',false),('70000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Freelas',true),('70000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Investimentos',true); insert into subcategories(household_id,category_id,name) values ('00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','Preserved');" >/dev/null
for _ in 1 2; do
  sql -f - < supabase/migrations/0022_category_kind.sql >/dev/null
  sql -f - < supabase/migrations/0023_atomic_installment_category.sql >/dev/null
done
sql -f - < supabase/seed.sql >/dev/null
sql -f - < supabase/seed.sql >/dev/null
sql -f - < packages/db/test/category-kind-functional.sql >/dev/null
echo "category migrations: fresh setup, upgrade, replay, permissions, validation and rollback passed"
