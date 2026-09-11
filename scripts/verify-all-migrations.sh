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
    [[ "$(basename "$migration")" < "0022_" ]] || continue
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
  [[ "$output" == *"$expected"* && ( "$expected" == "only through 0021" || "$output" == *"cannot baseline; missing schema fingerprints:"* ) ]] || {
    echo "baseline failed without expected fingerprint '$expected': $output" >&2
    exit 1
  }
  assert_no_ledger
}

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/seed.sql" >/dev/null

docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "grant execute on function confirm_import(jsonb, jsonb) to anon;" >/dev/null
assert_baseline_rejected "0012 anon RPC lock" \
  "$repo_root/deploy/migrate.sh" baseline 0021
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "revoke execute on function confirm_import(jsonb, jsonb) from anon;" >/dev/null

# Every protected table must retain RLS. Policy mutations also prove that
# missing, weakened and additional permissive policies fail closed.
for table in households household_members accounts investment_buckets credit_cards \
  categories subcategories transactions installment_groups installments import_batches \
  import_rows categorization_memory bot_interactions obligations bot_conversations \
  allowed_emails source_category_mappings import_suggestion_nonces import_ai_usage \
  import_ai_daily_usage import_item_claims; do
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -c \
    "alter table $table disable row level security" >/dev/null
  assert_baseline_rejected "0001 household RLS and policies" \
    "$repo_root/deploy/migrate.sh" baseline 0021
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -c \
    "alter table $table enable row level security" >/dev/null
done
for mutation in \
  'drop policy transactions_member_all on transactions' \
  'alter policy transactions_member_all on transactions using (true)' \
  'alter policy transactions_member_all on transactions with check (true)' \
  'alter policy transactions_member_all on transactions to authenticated' \
  'create policy unexpected_access on transactions for select using (true)'; do
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -c "$mutation" >/dev/null
  assert_baseline_rejected "0001 household RLS and policies" \
    "$repo_root/deploy/migrate.sh" baseline 0021
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -c \
    "drop policy if exists unexpected_access on transactions;
     drop policy if exists transactions_member_all on transactions;
     create policy transactions_member_all on transactions for all
       using (is_household_member(household_id)) with check (is_household_member(household_id));" >/dev/null
done

for trigger_case in \
  "auth.users|provision_member_on_signup|0009 member provisioning" \
  "public.allowed_emails|provision_member_on_allowlist|0014 resilient provisioning"; do
  IFS='|' read -r trigger_table trigger_name expected_fingerprint <<< "$trigger_case"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
    "alter table $trigger_table disable trigger $trigger_name;" >/dev/null
  assert_baseline_rejected "$expected_fingerprint" \
    "$repo_root/deploy/migrate.sh" baseline 0021
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
    "alter table $trigger_table enable trigger $trigger_name;" >/dev/null
done

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
  env MIGRATION_BASELINE_CHECK=/dev/null \
  "$repo_root/deploy/migrate.sh" baseline 0021
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
  < "$repo_root/supabase/migrations/0019_installment_purchase_idempotency.sql" >/dev/null

category_mutations=(
  "alter table categories drop constraint categories_kind_check"
  "alter table categories alter column kind drop not null"
  "alter table categories alter column kind drop default"
  "update categories set kind = 'expense' where name = 'Receitas'"
  "delete from categories where name = 'Salário'"
)
for mutation in "${category_mutations[@]}"; do
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
    "$mutation" >/dev/null
  assert_baseline_rejected "0021 category kind" \
    "$repo_root/deploy/migrate.sh" baseline 0021
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d postgres -f - \
    < "$repo_root/supabase/migrations/0021_category_kind.sql" >/dev/null
done

cp -R "$repo_root/supabase/migrations" "$scratch/pending-migrations"
printf '%s\n' 'create table if not exists migration_runner_success(id integer);' \
  > "$scratch/pending-migrations/0027_runner_success.sql"
assert_baseline_rejected "only through 0021" env \
  MIGRATION_BASELINE_VERSION=0027 \
  MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" baseline 0027

MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" baseline 0021
status_output="$(MIGRATIONS_DIR="$scratch/pending-migrations" \
  "$repo_root/deploy/migrate.sh" status)"
[[ "$status_output" == *"PENDING 0027_runner_success.sql"* ]] || {
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
# The compatibility migration must also be safe to reapply directly.
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -f - \
  < "$repo_root/supabase/migrations/0024_restore_obligation_payment_compatibility.sql" >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -f - \
  < "$repo_root/scripts/check-obligation-compatibility.sql" >/dev/null
runner_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.migration_runner_success') is not null)::int || '|' ||
          (exists(select 1 from family_finance_migrations.schema_migrations where version='0027'))::int")"
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
printf '%s\n' 'create table checksum_guard_was_bypassed(id integer);' \
  > "$scratch/checksum-migrations/0028_checksum_guard.sql"
if checksum_output="$(MIGRATIONS_DIR="$scratch/checksum-migrations" \
  "$repo_root/deploy/migrate.sh" apply 2>&1)"; then
  echo "apply accepted a changed applied migration" >&2
  exit 1
fi
[[ "$checksum_output" == *"checksum/name mismatch"* ]] || {
  echo "apply rejected checksum drift without the expected error: $checksum_output" >&2
  exit 1
}
checksum_apply_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.checksum_guard_was_bypassed') is null)::int || '|' ||
          (not exists(select 1 from family_finance_migrations.schema_migrations where version='0028'))::int")"
[[ "$checksum_apply_state" == "1|1" ]] || {
  echo "checksum rejection allowed a pending migration to run: $checksum_apply_state" >&2
  exit 1
}

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
  > "$scratch/failing-migrations/0028_intentional_failure.sql"
if MIGRATIONS_DIR="$scratch/failing-migrations" \
  "$repo_root/deploy/migrate.sh" apply >/dev/null 2>&1; then
  echo "failing migration unexpectedly succeeded" >&2
  exit 1
fi

rollback_state="$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "select (to_regclass('public.migration_should_rollback') is null)::int || '|' ||
          (not exists(select 1 from family_finance_migrations.schema_migrations where version='0028'))::int")"
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

upgrade_db="family_finance_upgrade"
docker exec "$container" createdb -U postgres "$upgrade_db"
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$upgrade_db" -c \
  "create schema auth;
   create table auth.users(id uuid primary key, email text);
   create function auth.uid() returns uuid language sql stable as 'select null::uuid';
   create function auth.role() returns text language sql stable as 'select ''authenticated''::text';" >/dev/null
for migration in "$repo_root"/supabase/migrations/*.sql; do
  [[ "$(basename "$migration")" < "0021_" ]] || continue
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d "$upgrade_db" -f - \
    < "$migration" >/dev/null
done
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$upgrade_db" -c \
  "insert into households (id, name)
     values ('00000000-0000-0000-0000-000000000001', 'Casa');
   insert into categories (household_id, name)
     values
       ('00000000-0000-0000-0000-000000000001', 'Alimentação'),
       ('00000000-0000-0000-0000-000000000001', 'Receitas'),
       ('00000000-0000-0000-0000-000000000001', 'Freelas');" >/dev/null
freelas_id="$(docker exec "$container" psql -X -U postgres -d "$upgrade_db" -Atc \
  "select id from categories where name = 'Freelas'")"
for _ in 1 2; do
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d "$upgrade_db" -f - \
    < "$repo_root/supabase/migrations/0021_category_kind.sql" >/dev/null
done
upgrade_state="$(docker exec "$container" psql -X -U postgres -d "$upgrade_db" -Atc \
  "select count(*) filter (where kind = 'income') || '|' ||
          count(*) filter (where kind = 'expense') || '|' ||
          count(*) filter (where name = 'Freelas' and id = '$freelas_id')
   from categories
   where household_id = '00000000-0000-0000-0000-000000000001'
     and name in ('Receitas', 'Salário', 'Freelas', 'Investimentos', 'Alimentação')")"
[[ "$upgrade_state" == "4|1|1" ]] || {
  echo "populated pre-0021 upgrade state is wrong: $upgrade_state" >&2
  exit 1
}

decoy_db="family_finance_enum_decoy"
docker exec "$container" createdb -U postgres "$decoy_db"
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$decoy_db" -c \
  "create schema auth;
   create table auth.users(id uuid primary key, email text);
   create function auth.uid() returns uuid language sql stable as 'select null::uuid';
   create function auth.role() returns text language sql stable as 'select ''authenticated''::text';
   create schema decoy;
   create type decoy.import_source as enum ('mercado_pago_pdf');" >/dev/null
for migration in "$repo_root"/supabase/migrations/000{1,2,3,4,5}_*.sql; do
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -d "$decoy_db" -f - \
    < "$migration" >/dev/null
done
if decoy_output="$(MIGRATION_DB_NAME="$decoy_db" \
  "$repo_root/deploy/migrate.sh" baseline 0021 2>&1)"; then
  echo "decoy import_source enum unexpectedly satisfied the baseline" >&2
  exit 1
fi
[[ "$decoy_output" == *"0006 mercado_pago_pdf"* ]] || {
  echo "schema-scoped enum rejection was not reported: $decoy_output" >&2
  exit 1
}
decoy_ledger="$(docker exec "$container" psql -X -U postgres -d "$decoy_db" -Atc \
  "select to_regclass('family_finance_migrations.schema_migrations') is null")"
[[ "$decoy_ledger" == "t" ]] || {
  echo "failed decoy baseline created a migration ledger" >&2
  exit 1
}

echo "all migrations apply cleanly twice"
