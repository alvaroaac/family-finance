#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migrations_dir="${MIGRATIONS_DIR:-$repo_root/supabase/migrations}"
baseline_check="${MIGRATION_BASELINE_CHECK:-$repo_root/deploy/checks/migration-baseline.sql}"
baseline_version="${MIGRATION_BASELINE_VERSION:-0021}"
db_container="${MIGRATION_DB_CONTAINER:-supabase-db}"
db_user="${MIGRATION_DB_USER:-postgres}"
db_name="${MIGRATION_DB_NAME:-postgres}"
ledger="family_finance_migrations.schema_migrations"
lock_key="728194613"

usage() {
  echo "Usage: deploy/migrate.sh status|apply|initialize|baseline <version>" >&2
  exit 2
}

fail() {
  echo "migration error: $*" >&2
  exit 1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

db_query() {
  docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" -Atc "$1"
}

db_stream() {
  docker exec -i "$db_container" psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" -f -
}

shopt -s nullglob
migrations=("$migrations_dir"/*.sql)
((${#migrations[@]} > 0)) || fail "no migrations found in $migrations_dir"

previous_version=""
for migration in "${migrations[@]}"; do
  filename="$(basename "$migration")"
  [[ "$filename" =~ ^([0-9]{4})_[a-z0-9_]+\.sql$ ]] || \
    fail "invalid migration filename: $filename"
  version="${BASH_REMATCH[1]}"
  [[ "$version" != "$previous_version" ]] || \
    fail "duplicate migration version: $version"
  previous_version="$version"
done
[[ "$baseline_version" =~ ^[0-9]{4}$ ]] || \
  fail "invalid baseline fingerprint version: $baseline_version"

command="${1:-}"
case "$command" in
  status|apply|initialize) [[ $# -eq 1 ]] || usage ;;
  baseline) [[ $# -eq 2 && "$2" =~ ^[0-9]{4}$ ]] || usage ;;
  *) usage ;;
esac

ledger_exists="$(db_query "select to_regclass('$ledger') is not null")"

create_ledger() {
  db_stream <<'SQL'
begin;
select pg_advisory_xact_lock(728194613);
create schema if not exists family_finance_migrations;
revoke all on schema family_finance_migrations from public;
create table if not exists family_finance_migrations.schema_migrations (
  version text primary key check (version ~ '^[0-9]{4}$'),
  name text not null unique,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
revoke all on family_finance_migrations.schema_migrations from public, anon, authenticated;
commit;
SQL
}

if [[ "$command" == "initialize" ]]; then
  [[ "$ledger_exists" == "f" ]] || fail "$ledger already exists"
  app_schema_exists="$(db_query "select to_regclass('public.households') is not null")"
  [[ "$app_schema_exists" == "f" ]] || \
    fail "refusing to initialize a non-empty database; use baseline after verifying its schema"
  create_ledger
  exec "$0" apply
fi

if [[ "$command" == "baseline" ]]; then
  through="$2"
  [[ "$ledger_exists" == "f" ]] || fail "$ledger already exists; baseline is one-time only"
  [[ "$through" == "$baseline_version" ]] || \
    fail "baseline fingerprint authorizes history only through $baseline_version"
  [[ -f "$baseline_check" ]] || fail "baseline check not found: $baseline_check"

  baseline_file_found="false"
  for migration in "${migrations[@]}"; do
    filename="$(basename "$migration")"
    [[ "${filename%%_*}" == "$through" ]] && baseline_file_found="true"
  done
  [[ "$baseline_file_found" == "true" ]] || \
    fail "baseline migration $through is missing from $migrations_dir"

  {
    printf '%s\n' 'begin;' "select pg_advisory_xact_lock($lock_key);"
    sed -e '$a\' "$baseline_check"
    printf '%s\n' \
      'create schema if not exists family_finance_migrations;' \
      'revoke all on schema family_finance_migrations from public;' \
      'create table family_finance_migrations.schema_migrations (' \
      "  version text primary key check (version ~ '^[0-9]{4}$')," \
      '  name text not null unique,' \
      "  checksum text not null check (checksum ~ '^[0-9a-f]{64}$')," \
      '  applied_at timestamptz not null default now()' \
      ');' \
      'revoke all on family_finance_migrations.schema_migrations from public, anon, authenticated;'
    for migration in "${migrations[@]}"; do
      filename="$(basename "$migration")"
      version="${filename%%_*}"
      ((10#$version <= 10#$through)) || continue
      checksum="$(hash_file "$migration")"
      printf "insert into %s (version, name, checksum) values ('%s', '%s', '%s');\n" \
        "$ledger" "$version" "$filename" "$checksum"
    done
    printf '%s\n' 'commit;'
  } | db_stream
  echo "baselined $ledger through $through"
  exit 0
fi

[[ "$ledger_exists" == "t" ]] || \
  fail "$ledger is missing; use initialize for an empty database or baseline for verified production"

while IFS= read -r recorded_version; do
  [[ -n "$recorded_version" ]] || continue
  found="false"
  for migration in "${migrations[@]}"; do
    filename="$(basename "$migration")"
    if [[ "${filename%%_*}" == "$recorded_version" ]]; then
      found="true"
      break
    fi
  done
  [[ "$found" == "true" ]] || \
    fail "ledger contains migration $recorded_version, but its file is missing"
done <<< "$(db_query "select version from $ledger order by version")"

if [[ "$command" == "status" ]]; then
  status_code=0
  for migration in "${migrations[@]}"; do
    filename="$(basename "$migration")"
    version="${filename%%_*}"
    checksum="$(hash_file "$migration")"
    record="$(db_query "select name || '|' || checksum from $ledger where version = '$version'")"
    if [[ -z "$record" ]]; then
      echo "PENDING $filename"
    elif [[ "$record" == "$filename|$checksum" ]]; then
      echo "APPLIED $filename"
    else
      echo "MISMATCH $filename recorded=$record" >&2
      status_code=1
    fi
  done
  exit "$status_code"
fi

{
  printf '%s\n' '\set ON_ERROR_STOP on' "select pg_advisory_lock($lock_key);"
  for migration in "${migrations[@]}"; do
    filename="$(basename "$migration")"
    version="${filename%%_*}"
    checksum="$(hash_file "$migration")"
    printf '%s\n' \
      "do \$migration_guard\$" \
      'declare recorded_name text; recorded_checksum text;' \
      'begin' \
      "  select name, checksum into recorded_name, recorded_checksum from $ledger where version = '$version';" \
      "  if recorded_name is not null and (recorded_name <> '$filename' or recorded_checksum <> '$checksum') then" \
      "    raise exception 'migration $version checksum/name mismatch';" \
      '  end if;' \
      'end' \
      '$migration_guard$;' \
      "select exists(select 1 from $ledger where version = '$version') as migration_applied \gset" \
      '\if :migration_applied' \
      "\echo already-applied $filename" \
      '\else' \
      'begin;'
    sed -e '$a\' "$migration"
    printf "insert into %s (version, name, checksum) values ('%s', '%s', '%s');\n" \
      "$ledger" "$version" "$filename" "$checksum"
    printf '%s\n' 'commit;' "\echo applied $filename" '\endif'
  done
  printf '%s\n' "select pg_advisory_unlock($lock_key);"
} | db_stream
