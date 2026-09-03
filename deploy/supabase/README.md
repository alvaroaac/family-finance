# Supabase self-host on the VPS

The official Supabase docker compose stack is NOT vendored into this repo — it
is cloned from the upstream repo at a tagged release and configured with our
`.env`. This directory keeps only our configuration template
([`.env.example`](./.env.example)) and these instructions.

## 1. Clone the official stack (pinned)

```bash
# On the VPS. Pin to a tagged release — never track master for a live stack.
git clone --depth 1 --branch v1.24.09 https://github.com/supabase/supabase.git /opt/supabase-src
mkdir -p /opt/supabase
cp -r /opt/supabase-src/docker/* /opt/supabase/
cd /opt/supabase
```

(Check https://github.com/supabase/supabase/releases for the current tag and
record whichever tag you deploy here in this file.)

## 2. Configure

```bash
# Start from upstream's template, then apply OUR values from .env.example:
cp .env.example .env   # upstream template
# Merge in the variables documented in deploy/supabase/.env.example of this
# repo (JWT secret, anon/service keys, dashboard creds, public URLs, Google
# OAuth). Generate secrets as described in that file.
chmod 600 .env
```

Key points (see `.env.example` in this directory for the full list):

- `JWT_SECRET` is generated once; `ANON_KEY` / `SERVICE_ROLE_KEY` are minted
  from it (use the tool at
  https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys).
- `API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL` = `https://supabase.alvaroekarol.com.br`
  (Caddy fronts Kong, see `deploy/caddy/Caddyfile`).
- GoTrue Google OAuth mirrors the working local `supabase/config.toml`:
  external Google enabled, `skip_nonce_check = true`, client id/secret via env.
- Kong stays bound to localhost (`127.0.0.1:8000`); only Caddy is public.

## 3. Start

```bash
docker compose pull
docker compose up -d
docker compose ps   # everything healthy
```

## 4. Database migrations

Use the repository controller from `/opt/family-finance`; do not pipe migration
files directly into psql:

```bash
./deploy/migrate.sh status
./deploy/migrate.sh apply
```

On a new empty database, use `./deploy/migrate.sh initialize`. The existing
production database requires the one-time, fingerprint-checked baseline
documented in the root [`deploy/README.md`](../README.md).

## 5. Volumes & backups

- Postgres data lives in the compose `db` volume (`./volumes/db/data` in the
  official stack). Treat that path as the single source of truth — losing it
  loses the household's data.
- Nightly logical backup via cron (runs `pg_dump` inside the db container and
  keeps 14 days):

```cron
# /etc/cron.d/family-finance-pgdump
0 3 * * * root docker exec supabase-db pg_dump -U postgres -d postgres | gzip > /var/backups/family-finance/pgdump-$(date +\%F).sql.gz && find /var/backups/family-finance -name 'pgdump-*.sql.gz' -mtime +14 -delete
```

Create `/var/backups/family-finance` (mode 700) first. Periodically test a
restore (`gunzip -c ... | docker exec -i supabase-db psql -U postgres -d postgres`
against a scratch database).

## 6. Upgrades

Upgrade by bumping the pinned tag, re-copying `docker/`, diffing `.env` against
the new template, then `docker compose pull && docker compose up -d`. Take a
manual `pg_dump` immediately before any upgrade.

## Deployed

- **2026-07-02**: tag `v1.24.09` on the Hostinger VPS (mine-ops, 2.24.71.244),
  routed by the VPS's existing Traefik (host-mode, docker provider, Let's
  Encrypt) via `docker-compose.override.yml` labels on Kong — the Caddy file in
  this tree was NOT used. Bot routed the same way. Nightly pg_dump cron active.
