# Deploy runbook — family-finance v1.0

Topology (spec §4): **web → Vercel**, **Supabase → self-host Docker on the
VPS** behind Caddy at `supabase.alvaroekarol.com.br`, **bot → VPS container**
behind the same Caddy at `bot.alvaroekarol.com.br`.

Artifacts in this tree:

| Path | What |
| --- | --- |
| `supabase/` | Self-host config template + pinning/backup instructions |
| `caddy/Caddyfile` | HTTPS reverse proxy for Kong (:8000) and the bot (:8787) |
| `bot/` | Bot compose file + env template (image from `apps/bot/Dockerfile`) |
| `checks/rls-proof.mjs` | RLS/RPC verification gate — must pass 100% before cut-over |
| `vercel.md` | Web env checklist + Google OAuth prod redirect |

Execute the steps IN ORDER. Do not cut the web/bot over before step 4 passes.

## 1. VPS Supabase up

Follow [`supabase/README.md`](./supabase/README.md): clone the official
`supabase/docker` stack at a pinned tag, configure `.env` from
[`supabase/.env.example`](./supabase/.env.example) (fresh secrets, public URLs,
Google OAuth), `docker compose up -d`. Bring Caddy up with
[`caddy/Caddyfile`](./caddy/Caddyfile) and confirm
`https://supabase.alvaroekarol.com.br/auth/v1/health` answers.

## 2. Migrations

From a machine with the repo and the Supabase CLI, push migrations
`0001..0014` to the VPS database:

```bash
supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@<vps-host>:5432/postgres"
```

(Or apply `supabase/migrations/*.sql` in order via psql.) Then apply
`supabase/seed.sql` the same way — it is idempotent (`on conflict do nothing`)
and seeds the household, caixinhas, and starter categories.

**Apply `seed.sql` (or otherwise create the household) BEFORE the first login.**
Migration 0014 makes provisioning resilient (an `allowed_emails` trigger +
one-time backfill provision anyone who logged in early or was allowlisted
late, and a missing household now logs a `WARNING` instead of silently
dropping the member), but the clean path is still household-first.

Migration note: `0011` adds the obligations table + the idempotent
`materialize_obligation_payment` RPC; `0012` revokes `anon` EXECUTE on every
SECURITY DEFINER RPC (the Supabase default grants it — a real hole for the
obligations RPC, whose gate lets a null-uid caller through); `0013` adds
composite `(household_id, id)` FKs so no write path can reference another
household's category/account/card.

## 3. Seed household members + allowlist

Membership is provisioned automatically on first login by migration 0009's
trigger, driven by the `allowed_emails` table. Álvaro's email is seeded by the
migration; **Karol's dotted-form Gmail must be added now** (it was not known at
migration time):

```sql
insert into allowed_emails (email) values ('<karol-dotted-gmail>@gmail.com')
on conflict (email) do nothing;
```

Run via `docker exec -i supabase-db psql -U postgres -d postgres` on the VPS.

## 4. Verification gate — RLS proof (must pass 100%)

Run the 19-check proof against the VPS instance (from the repo root, after
`pnpm install`; see the header of `checks/rls-proof.mjs` for details):

```bash
SUPABASE_URL=https://supabase.alvaroekarol.com.br \
SUPABASE_ANON_KEY=<anon key> \
SERVICE_ROLE_KEY=<service role key> \
MEMBER_EMAIL=rls-proof.member@example.com MEMBER_PASSWORD=<random> \
OUTSIDER_EMAIL=rls-proof.outsider@example.com OUTSIDER_PASSWORD=<random> \
node deploy/checks/rls-proof.mjs
```

It creates two throwaway users + fixtures, proves member visibility, outsider
isolation, insert rejection, atomic rollback of the RPCs, that **`anon` cannot
EXECUTE any SECURITY DEFINER RPC** (regression gate for the 0012 grant hole),
and that `materialize_obligation_payment` is idempotent + rejects
out-of-window months, then cleans up after itself. **Exit code must be 0 and
every check PASS before continuing.**

## 5. Web — Vercel envs + deploy

Follow [`vercel.md`](./vercel.md): set the production env vars (anon key only,
dotted-form `AUTHORIZED_EMAILS`), project root `apps/web`, deploy.

## 6. Google OAuth prod redirect

In the Google Cloud console (same OAuth client as local), register
`https://supabase.alvaroekarol.com.br/auth/v1/callback` as an authorized
redirect URI and the Vercel URL as a JavaScript origin (details in
`vercel.md`). Then log in on the Vercel app with both Google accounts and
confirm each lands on the dashboard with a `household_members` row.

## 7. Bot container up

On the VPS, with the repo checked out and `deploy/bot/.env` filled from
[`bot/.env.example`](./bot/.env.example) (chmod 600 — this is the ONLY place
the service-role key lives outside the Supabase stack):

```bash
cd deploy/bot
docker compose build
docker compose up -d
curl -s http://localhost:8787/health   # → {"ok":true,...}
```

## 8. Register the Telegram webhook

Exact curl (secret must equal `TELEGRAM_WEBHOOK_SECRET` in `deploy/bot/.env`):

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://bot.alvaroekarol.com.br/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\"]"
```

Verify: `curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`
shows the URL with `pending_update_count` draining and no `last_error_message`.

## 9. Bot smoke test (end-to-end)

In a private chat with the bot, as a provisioned member:

1. **Text lançamento**: send e.g. `mercado 54,30 ontem no débito`, confirm the
   bot's confirmation prompt, reply to confirm.
2. **Voice lançamento**: send a voice note describing an expense; confirm.
3. Verify both rows appear in the web app's `/transactions` page and that the
   settings page shows the bot's status (last update timestamp moves).
4. `docker logs family-finance-bot` shows no errors.

Done. Record the deployed Supabase tag and date in `supabase/README.md`.

## Ongoing operations

- **Backups**: nightly `pg_dump` cron (documented in `supabase/README.md`) — 
  verify the first night's file exists and periodically test a restore.
- **Bot logs**: `docker logs -f family-finance-bot`.
- **Restart policy**: bot is `unless-stopped`; the Supabase stack restarts with
  Docker.
