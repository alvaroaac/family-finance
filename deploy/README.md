# Deploy runbook — family-finance v1.0

Topology (spec §4): **web → Vercel**, **Supabase → self-host Docker on the
VPS** behind Caddy at `supabase.alvaroekarol.com.br`, **bot → VPS container**
behind the same Caddy at `bot.alvaroekarol.com.br`.

Artifacts in this tree:

| Path                   | What                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `supabase/`            | Self-host config template + pinning/backup instructions            |
| `caddy/Caddyfile`      | HTTPS reverse proxy for Kong (:8000) and the bot (:8787)           |
| `bot/`                 | Bot compose file + env template (image from `apps/bot/Dockerfile`) |
| `checks/rls-proof.mjs` | RLS/RPC verification gate — must pass 100% before cut-over         |
| `migrate.sh`           | Ordered, transactional migration ledger and runner                 |
| `vercel.md`            | Web env checklist + Google OAuth prod redirect                     |

Execute the steps IN ORDER. Do not cut the web/bot over before step 4 passes.

## 1. VPS Supabase up

Follow [`supabase/README.md`](./supabase/README.md): clone the official
`supabase/docker` stack at a pinned tag, configure `.env` from
[`supabase/.env.example`](./supabase/.env.example) (fresh secrets, public URLs,
Google OAuth), `docker compose up -d`. Bring Caddy up with
[`caddy/Caddyfile`](./caddy/Caddyfile) and confirm
`https://supabase.alvaroekarol.com.br/auth/v1/health` answers.

## 2. Migrations

Run the repository migration controller from the VPS checkout. It talks to the
`supabase-db` container by default, takes a database advisory lock, validates
the immutable filename/checksum ledger, and commits each pending migration in
its own transaction:

```bash
./deploy/migrate.sh status
./deploy/migrate.sh apply
```

`status` and `apply` fail closed if an applied file was edited, a version was
reused, a recorded file disappeared, or an existing database has no ledger.
Never apply `supabase/migrations/*.sql` directly in production again.

For a brand-new empty database, initialize the ledger and apply the complete
history with:

```bash
./deploy/migrate.sh initialize
```

The current production database predates the ledger. Its one-time bootstrap is
different: take a fresh backup, deploy these migration-control files, then run
the schema-fingerprint gate and baseline the explicitly verified history:

```bash
./deploy/migrate.sh baseline 0021
./deploy/migrate.sh status
```

`baseline` does not execute migrations. It records filenames and SHA-256
checksums through `0021` only after `deploy/checks/migration-baseline.sql`
proves those live effects, including both pairs historically applied under the
colliding `0018`/`0019` numbers. Later migration files remain pending and are
executed by `apply`; they can never be silently absorbed into this fingerprint.
The baseline is a one-time operation and refuses an existing ledger.

When the fingerprint is deliberately extended in the future, update the check
and the source-pinned `baseline_version` together. Neither the check path nor
its authorized version can be overridden through the environment. Never raise
the version without adding fingerprints and rejection tests for the new
history.

After migrations, apply `supabase/seed.sql` via psql when provisioning a new
environment. It is idempotent (conflict-safe inserts and category-kind
upserts) and seeds the household, caixinhas, and starter categories.

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
household's category/account/card; `0015` adds the `bill_month` column and
the `settle_card_bill` RPC, and re-gates `create_installment_purchase`, so the
bot's service-role (null `auth.uid()`) client can call both card flows.
`0016` adds reliable import claims, nonce replay protection, paid-fallback quota
reservation, and telemetry RPCs; `0017` records the actual value when a variable
obligation is paid; `0018` adds per-payment account overrides; `0019` makes bot
installment creation replay-safe; `0020` removes the obsolete three-argument
payment RPC; and `0021` adds expense/income category kinds. **All migrations
must be applied and `status` must be clean BEFORE a new bot or web deploy
starts.**

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

Run the RLS proof (all checks must pass) against the VPS instance (from the
repo root, after `pnpm install`; see the header of `checks/rls-proof.mjs` for
details):

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

## 5. Bot container up (before the v2 web deploy)

On the VPS, with the repo checked out and `deploy/bot/.env` filled from
[`bot/.env.example`](./bot/.env.example) (chmod 600 — this is the ONLY place
the service-role key lives outside the Supabase stack):

The image pins `@openai/codex@0.144.0`. Before enabling the Codex primary,
authenticate once into its named volume (never copy auth files into the repo or
image):

```bash
cd deploy/bot
docker compose build bot
docker compose run --rm bot codex login --device-auth
```

Then configure the VPS-only `.env`:

```dotenv
CODEX_ENABLED=true
CODEX_MODEL=gpt-5.5
CODEX_TIMEOUT_MS=12000
IMPORT_SUGGESTION_SHARED_SECRET=<same-random-32+-character-secret-as-vercel>
IMPORT_PAID_FALLBACK_ENABLED=true
IMPORT_PAID_FALLBACK_PROVIDER=openai
IMPORT_PAID_FALLBACK_MODEL=gpt-5.4
IMPORT_PAID_FALLBACK_MAX_ITEMS=10
OPENAI_API_KEY=<openai-api-key>
```

Paid fallback has an 8-second request timeout and runs only for operational
Codex failures or omitted/invalid items; explicit Codex abstentions stay manual.
The quota is capped per preview and at 25 items per household/day. OpenAI is the
evaluated recommendation; Anthropic remains available only when explicitly
configured with `provider=anthropic`, an exact model, and `ANTHROPIC_API_KEY`.
The `codex-auth` volume
persists device credentials across container replacement. This CLI login is
operationally more fragile than a service API: monitor the structured Codex
fallback telemetry and repeat device login if credentials expire. Whisper is
unchanged.
The CLI still holds a reusable device credential in-process; the deny list,
event audit, non-root user, read-only filesystem, empty cwd, and secret-free
child environment reduce exposure but do not eliminate credential risk. A
separate sidecar/broker remains a defense-in-depth follow-up.
Codex can surface a pending new subcategory in the confirmation explanation,
but creating/persisting that subcategory from Telegram is intentionally a
follow-up; it is never silently dropped into or written as an existing category.

```bash
cd deploy/bot
../migrate.sh apply
../migrate.sh status
docker compose build
docker compose up -d
curl -s http://localhost:8787/health   # → {"ok":true,...}
```

The bot accepts both v1 and v2 suggestion contracts during the rollback window.
Deploy it before the v2 web caller so either deployment order within this step
remains compatible without allowing legacy callers to spend paid quota.

## 6. Web — Vercel envs + deploy

Follow [`vercel.md`](./vercel.md): set the production env vars, including the
preview-signing secret, bot suggestion URL, and the same shared secret used by
the bot. Set project root `apps/web`, then deploy only after the bot is healthy.

## 7. Google OAuth prod redirect

In the Google Cloud console (same OAuth client as local), register
`https://supabase.alvaroekarol.com.br/auth/v1/callback` as an authorized
redirect URI and the Vercel URL as a JavaScript origin (details in
`vercel.md`). Then log in on the Vercel app with both Google accounts and
confirm each lands on the dashboard with a `household_members` row.

## 8. Register the Telegram webhook

Exact curl (secret must equal `TELEGRAM_WEBHOOK_SECRET` in `deploy/bot/.env`):

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://bot.alvaroekarol.com.br/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

Verify: `curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`
shows the URL with `pending_update_count` draining and no `last_error_message`.

## 9. Bot and import smoke test (end-to-end)

In a private chat with the bot, as a provisioned member:

1. **Text lançamento**: send e.g. `mercado 54,30 ontem no débito`, confirm the
   bot's confirmation prompt, reply to confirm.
2. **Voice lançamento**: send a voice note describing an expense; confirm.
3. Verify both rows appear in the web app's `/transactions` page and that the
   settings page shows the bot's status (last update timestamp moves).
4. `docker logs family-finance-bot` shows no errors.

Then exercise the complete paid import path with synthetic data:

1. Temporarily set `CODEX_ENABLED=false` in `deploy/bot/.env` and restart only
   the bot. This intentionally creates an operational Codex-unavailable outcome.
2. Record the household's current daily reservation counter before the request:

   ```sql
   select coalesce((
     select paid_items_reserved from import_ai_daily_usage
     where household_id = '<household-uuid>' and usage_date = current_date
   ), 0) as paid_items_before;
   ```

   Require `paid_items_before <= 24` so at least one daily slot remains. Pause
   other import-suggestion requests for this household until the after-value is
   recorded; otherwise a concurrent fallback makes the exact `+ 1` assertion
   ambiguous.

3. Generate a fresh marker (for example `date -u +%Y%m%dT%H%M%SZ`) and upload a
   Nubank CSV with today's date and that marker. Never reuse a previous marker:

   ```csv
   date,title,amount
   <YYYY-MM-DD>,PADARIA SMOKE OPENAI <fresh-marker>,-1.23
   ```

4. Request categorization suggestions. **The row must receive a `fallback pago`
   suggestion. An unresolved row is safe application behavior but fails this
   deployment smoke.** Confirm the import once and verify the transaction
   appears exactly once. Retrying confirmation must not duplicate it.
5. In Postgres, verify the newest usage row for this smoke exactly matches:

   ```sql
   select provider, model, outcome, paid_items_reserved, resolved_items,
          latency_ms, completed_at
   from import_ai_usage
   where household_id = '<household-uuid>'
   order by created_at desc
   limit 1;
   -- Required: openai | gpt-5.4 | success | 1 | 1 | non-null | non-null
   ```

   Query `import_ai_daily_usage` again and require `paid_items_reserved` to be
   exactly `paid_items_before + 1`. Any other outcome is a failed deployment
   gate, even though the application correctly degrades to manual review.

6. Confirm bot logs contain request IDs/counts/outcomes but not the synthetic
   description or model response.
7. Restore `CODEX_ENABLED=true`, restart the bot, and confirm `/health` again.

This smoke is mandatory on the first `0016`/v2 deployment. If any step fails,
restore the previous web deployment and bot image; the bot's dual v1/v2 reader
keeps the rollback window compatible.

Done. Record the deployed Supabase tag and date in `supabase/README.md`.

## Ongoing operations

- **Backups**: nightly `pg_dump` cron (documented in `supabase/README.md`) —
  verify the first night's file exists and periodically test a restore.
- **Bot logs**: `docker logs -f family-finance-bot`.
- **Restart policy**: bot is `unless-stopped`; the Supabase stack restarts with
  Docker.
