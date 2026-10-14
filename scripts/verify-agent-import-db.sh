#!/usr/bin/env bash
# Disposable synthetic PostgreSQL proof; never reads production configuration.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="ff-agent-import-test-$$"
cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Dedicated port differs from the optional local browser/OAuth stack.
docker run --rm -d --name "$container" -p 127.0.0.1:58422:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null
ready=false
for _ in $(seq 1 60); do
 if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
 sleep 1
done
if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres <<'SQL' >/dev/null
create schema auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create role authenticator nologin;
create role supabase_auth_admin nologin;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $fn$
 select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$fn$;
create function auth.role() returns text language sql stable as $fn$
 select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role';
$fn$;
grant usage on schema auth to authenticated;
SQL
for migration in "$repo_root"/supabase/migrations/*.sql; do
 docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -1 -U postgres -f - < "$migration" >/dev/null
done
cd "$repo_root"
AGENT_IMPORT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:58422/postgres pnpm --filter @family-finance/import-service test
