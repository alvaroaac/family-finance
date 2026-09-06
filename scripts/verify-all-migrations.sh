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
ready=false
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  docker logs "$container" >&2 || true
  echo "postgres did not become ready" >&2
  exit 1
fi

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

assert_no_ledger() {
  local ledger_exists
  ledger_exists="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
    "select to_regclass('family_finance_migrations.schema_migrations') is null")"
  [[ "$ledger_exists" == "t" ]] || {
    echo "failed baseline created a migration ledger" >&2
    exit 1
  }
}

assert_baseline_rejected() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    echo "incomplete schema was unexpectedly baselined" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || {
    echo "baseline failed without expected fingerprint '$expected': $output" >&2
    exit 1
  }
  assert_no_ledger
}

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/seed.sql" >/dev/null

docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "alter table transactions drop constraint transactions_hh_category_fk;
   alter table installments add constraint transactions_hh_category_fk
     foreign key (household_id, category_id)
     references categories (household_id, id) on delete set null;" >/dev/null
assert_baseline_rejected "0013 household foreign keys" \
  "$repo_root/deploy/migrate.sh" baseline 0021
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "alter table installments drop constraint transactions_hh_category_fk;" >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/migrations/0013_composite_household_fks.sql" >/dev/null

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f - >/dev/null <<'SQL'
create or replace function create_installment_purchase(
  group_payload jsonb,
  installments_payload jsonb
)
returns jsonb
language plpgsql
as $old_rpc$
begin
  return jsonb_build_object('group', group_payload, 'installments', installments_payload);
end;
$old_rpc$;
SQL
assert_baseline_rejected "0019 installment idempotency" \
  "$repo_root/deploy/migrate.sh" baseline 0021
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/migrations/0019_installment_purchase_idempotency.sql" >/dev/null

docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "alter table categories drop constraint categories_kind_check;
   alter table categories alter column kind drop not null;
   alter table categories alter column kind drop default;
   update categories set kind = 'expense' where name = 'Receitas';
   delete from categories where name = 'Salário';" >/dev/null
assert_baseline_rejected "0021 category kind" \
  "$repo_root/deploy/migrate.sh" baseline 0021
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/migrations/0021_category_kind.sql" >/dev/null

cp -R "$repo_root/supabase/migrations" "$scratch/pending-migrations"
printf '%s\n' 'create table if not exists migration_runner_success(id integer);' \
  > "$scratch/pending-migrations/0022_runner_success.sql"
assert_baseline_rejected "only through 0021" env \
  MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" baseline 0022

MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" baseline 0021
status_output="$(MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" status)"
[[ "$status_output" == *"PENDING 0022_runner_success.sql"* ]] || {
  echo "post-baseline migration was not left pending" >&2
  exit 1
}

ledger_count="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select count(*) from family_finance_migrations.schema_migrations")"
[[ "$ledger_count" == "21" ]] || {
  echo "expected 21 baselined migrations, got $ledger_count" >&2
  exit 1
}

MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" apply >/dev/null
runner_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.migration_runner_success') is not null)::int || '|' ||
          (exists(select 1 from family_finance_migrations.schema_migrations where version='0022'))::int")"
[[ "$runner_state" == "1|1" ]] || {
  echo "pending migration was not applied and recorded: $runner_state" >&2
  exit 1
}

cp -R "$scratch/pending-migrations" "$scratch/checksum-migrations"
printf '%s\n' '-- mutation used only by the checksum regression test' \
  >> "$scratch/checksum-migrations/0021_category_kind.sql"
if MIGRATIONS_DIR="$scratch/checksum-migrations" \
  "$repo_root/deploy/migrate.sh" status >/dev/null 2>&1; then
  echo "changed applied migration was not rejected" >&2
  exit 1
fi

cp -R "$scratch/pending-migrations" "$scratch/duplicate-migrations"
cp "$scratch/duplicate-migrations/0021_category_kind.sql" \
  "$scratch/duplicate-migrations/0021_duplicate.sql"
if MIGRATIONS_DIR="$scratch/duplicate-migrations" \
  "$repo_root/deploy/migrate.sh" status >/dev/null 2>&1; then
  echo "duplicate migration version was not rejected" >&2
  exit 1
fi

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

fresh_db="family_finance_fresh"
docker exec "$container" createdb -U postgres "$fresh_db"
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$fresh_db" -c \
  "create schema auth;
   create table auth.users(id uuid primary key, email text);
   create function auth.uid() returns uuid language sql stable as 'select null::uuid';
   create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null
MIGRATION_DB_NAME="$fresh_db" "$repo_root/deploy/migrate.sh" initialize >/dev/null
for _ in 1 2; do
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$fresh_db" -f - \
    < "$repo_root/supabase/seed.sql" >/dev/null
done
MIGRATION_DB_NAME="$fresh_db" "$repo_root/deploy/migrate.sh" apply >/dev/null
category_state="$(docker exec "$container" psql -X -U postgres -d "$fresh_db" -Atc \
  "select count(*) filter (where kind = 'income') || '|' ||
          count(*) filter (where kind = 'expense')
   from categories
   where household_id = '00000000-0000-0000-0000-000000000001'
     and name in ('Receitas', 'Salário', 'Freelas', 'Investimentos', 'Alimentação')")"
[[ "$category_state" == "4|1" ]] || {
  echo "fresh migrations-then-seed category state is wrong: $category_state" >&2
  exit 1
}

echo "all migrations apply cleanly twice"
