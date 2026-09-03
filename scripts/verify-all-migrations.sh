#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
container="family-finance-migrations-$(basename "$scratch")"

cleanup() {
  docker stop "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

docker run --rm -d --name "$container" -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null

docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin; create table auth.users(id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as 'select null::uuid'; create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null

for pass in 1 2; do
  for migration in "$repo_root"/supabase/migrations/*.sql; do
    echo "pass=$pass migration=$(basename "$migration")"
    docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
      < "$migration" >/dev/null
  done
done

export MIGRATION_DB_CONTAINER="$container"
"$repo_root/deploy/migrate.sh" baseline 0021
"$repo_root/deploy/migrate.sh" status >/dev/null
"$repo_root/deploy/migrate.sh" apply >/dev/null

ledger_count="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select count(*) from family_finance_migrations.schema_migrations")"
[[ "$ledger_count" == "21" ]] || {
  echo "expected 21 baselined migrations, got $ledger_count" >&2
  exit 1
}

cp -R "$repo_root/supabase/migrations" "$scratch/checksum-migrations"
printf '%s\n' '-- mutation used only by the checksum regression test' \
  >> "$scratch/checksum-migrations/0021_category_kind.sql"
if MIGRATIONS_DIR="$scratch/checksum-migrations" \
  "$repo_root/deploy/migrate.sh" status >/dev/null 2>&1; then
  echo "changed applied migration was not rejected" >&2
  exit 1
fi

cp -R "$repo_root/supabase/migrations" "$scratch/duplicate-migrations"
cp "$scratch/duplicate-migrations/0021_category_kind.sql" \
  "$scratch/duplicate-migrations/0021_duplicate.sql"
if MIGRATIONS_DIR="$scratch/duplicate-migrations" \
  "$repo_root/deploy/migrate.sh" status >/dev/null 2>&1; then
  echo "duplicate migration version was not rejected" >&2
  exit 1
fi

cp -R "$repo_root/supabase/migrations" "$scratch/pending-migrations"
printf '%s\n' 'create table if not exists migration_runner_success(id integer);' \
  > "$scratch/pending-migrations/0022_runner_success.sql"
MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" apply >/dev/null
runner_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.migration_runner_success') is not null)::int || '|' ||
          (exists(select 1 from family_finance_migrations.schema_migrations where version='0022'))::int")"
[[ "$runner_state" == "1|1" ]] || {
  echo "pending migration was not applied and recorded: $runner_state" >&2
  exit 1
}
if "$repo_root/deploy/migrate.sh" status >/dev/null 2>&1; then
  echo "ledger entry with a missing local migration file was not rejected" >&2
  exit 1
fi

cp -R "$scratch/pending-migrations" "$scratch/failing-migrations"
printf '%s\n' \
  'create table migration_should_rollback(id integer);' \
  'select 1 / 0;' \
  > "$scratch/failing-migrations/0023_intentional_failure.sql"
if MIGRATIONS_DIR="$scratch/failing-migrations" \
  "$repo_root/deploy/migrate.sh" apply >/dev/null 2>&1; then
  echo "failing migration unexpectedly succeeded" >&2
  exit 1
fi

rollback_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.migration_should_rollback') is null)::int || '|' ||
          (not exists(select 1 from family_finance_migrations.schema_migrations where version='0023'))::int")"
[[ "$rollback_state" == "1|1" ]] || {
  echo "failed migration was not fully rolled back: $rollback_state" >&2
  exit 1
}

echo "all migrations apply cleanly twice"
