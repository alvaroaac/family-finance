# Local MVP Verification Runbook

How to verify the Family Finance MVP locally, from a clean checkout. A fresh
agent or developer should be able to follow this top to bottom.

The MVP story being verified: a household ("Casa") with two authorized users can
**import** historical transactions, **review/correct** categories (which the app
**learns** from), launch a transaction from **Telegram**, add a **parcelado**
card purchase, and see a **monthly dashboard** whose totals reconcile.

There are two layers of verification:

- **Offline (always runnable here):** a service-level integration test that runs
  the whole story through the real shared packages with an in-memory fake of the
  Supabase/db layer and mocked Telegram/AI. No network, no secrets.
- **Online (needs real infra):** a Playwright browser spec against a running dev
  server + a real Supabase project.

---

## 0. Prerequisites

- Node 22, pnpm 9.15.4 (`corepack enable` picks up the pinned version).
- For the online layer only: the Supabase CLI, Docker, and a Google OAuth app.

```sh
# from the repo root
pnpm install
```

---

## 1. Static checks + unit/integration tests (offline, no secrets)

These are the release-gate commands. All must exit 0 (green):

```sh
pnpm typecheck                          # tsc --noEmit across every package/app
pnpm test                               # vitest across every package/app
pnpm --filter @family-finance/web build # next build with placeholder env is fine
pnpm --filter @family-finance/bot build # tsc emit for the bot
```

`pnpm test` includes the **offline MVP flow** integration test:

```
apps/web/integration/mvp-flow.test.ts
```

It seeds "Casa" with two users, imports synthetic fixtures via
`@family-finance/importers`, confirms them, corrects a category (creating a
`categorization_memory` record and proving the next suggestion improves),
simulates a Telegram text transaction through the bot conversation flow, adds a
parcelado card purchase via the domain installment generator, and then computes
the dashboard totals with the Task 10 db queries and **asserts they reconcile**
(income, expenses including imports + the bot transaction, and card pressure
including the current-month installment parcel).

Run just that test while iterating:

```sh
pnpm --filter @family-finance/web exec vitest run integration/mvp-flow.test.ts
```

> The web build stays green with placeholder secrets. `apps/web/.env.local` is
> optional for the offline layer; the lazy env getters never throw at build time.

---

## 2. Supabase setup + migration apply (online layer)

The canonical local workflow uses the Supabase CLI:

```sh
# Install the CLI (one of):
brew install supabase/tap/supabase        # macOS
#   or: npm i -g supabase  /  https://supabase.com/docs/guides/cli

# Start local Supabase (Postgres + Auth + Studio) — needs Docker running:
supabase start

# Apply migrations and seed (drops, re-runs supabase/migrations/*, then seed.sql):
supabase db reset
```

- Migrations live in `supabase/migrations/` and run in filename order
  (`0001_initial_schema.sql` first).
- `supabase/seed.sql` seeds the single `Casa` household and category
  placeholders. It contains **no real financial data**.
- Studio is at the URL printed by `supabase start`.

> Known blocker recorded in `memory/risks-and-blockers.md`: the Supabase CLI is
> not installed in the sandboxed dev environment, so `supabase db reset` was
> validated against a throwaway Postgres container with an `auth` stub. Run the
> real `supabase start && supabase db reset` once the CLI is available; the
> schema only depends on `auth.users`/`auth.uid()` and should apply unchanged.
> Full detail: `docs/decisions/0002-rls-and-household-isolation.md`.

### Configure env

```sh
cp .env.example apps/web/.env.local   # fill REAL Supabase values
```

Required keys (see `.env.example` for the full annotated list):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (server only)
- `AUTHORIZED_EMAILS` — the allowlisted Google accounts (Alvaro + Karol)
- `NEXT_PUBLIC_SITE_URL` — e.g. `http://localhost:3000`

Google OAuth is configured in the Supabase dashboard (Authentication >
Providers > Google). Add the two allowlisted emails as members of the `Casa`
household in `household_members` (mapping their `auth.users.id`).

---

## 3. Run the app locally

```sh
pnpm dev                          # all dev servers via turbo
# or just the web app:
pnpm --filter @family-finance/web dev
```

Open `http://localhost:3000`. Unauthenticated visits to any `(app)` route bounce
to `/login`. After Google login with an allowlisted email you reach the Casa
dashboard.

Manual walkthrough that mirrors the offline test:

1. `/imports` — upload a synthetic CSV, review the preview (duplicates/errors),
   confirm. The original file is not persisted.
2. `/categories` — correct one suggested category; confirm a memory pattern is
   created and future suggestions improve.
3. Telegram — send a text expense to the bot; confirm the editable summary.
4. `/cards` — add a parcelado purchase; review the generated parcels before save.
5. `/dashboard` — verify receitas, despesas, saldo, pressão dos cartões,
   caixinhas, and "precisa de revisão" reflect everything above.

---

## 4. Telegram webhook setup (online layer)

1. Create a bot with @BotFather; set `TELEGRAM_BOT_TOKEN`.
2. Choose a `TELEGRAM_WEBHOOK_SECRET` (the handler **fails closed** when unset).
3. Register the webhook (Telegram echoes the secret in the
   `X-Telegram-Bot-Api-Secret-Token` header, which the handler verifies):

   ```sh
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=https://<your-public-host>/api/telegram/webhook" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

4. (Optional) Voice notes need `OPENAI_API_KEY` for transcription. Raw audio is
   downloaded to a temp file, transcribed, and deleted immediately — never
   persisted. Without the key, voice notes are politely rejected.
5. (Optional) AI categorization fallback needs `ANTHROPIC_API_KEY`; it fires only
   when deterministic rules + memory are uncertain and always asks to confirm.

See `.env.example` for the full annotated Telegram + AI configuration.

---

## 5. Playwright browser E2E (online layer)

The browser spec `apps/web/e2e/mvp-flow.spec.ts` drives the real app. It is
**excluded from `pnpm test`** (vitest config ignores `e2e/**`) and is run
separately:

```sh
npx playwright install                          # one-time browser download
pnpm --filter @family-finance/web test:e2e      # runs playwright test
```

- With **no session**, the spec asserts the public guarantees: a protected route
  redirects to `/login`, and the login page shows the Casa workspace + allowlist
  note.
- The **authenticated walkthrough** is skipped unless `E2E_STORAGE_STATE` points
  to a pre-captured authorized Google session (OAuth cannot be scripted
  headlessly). To capture one: log in manually once in a Playwright-controlled
  browser and save `await page.context().storageState({ path })`, then export
  `E2E_STORAGE_STATE=<that path>`.
- `E2E_BASE_URL` overrides the target (default `http://localhost:3000`). By
  default Playwright starts `pnpm dev` itself; set `E2E_NO_SERVER=1` to reuse an
  already-running server.

Exact-number reconciliation of the dashboard is proven deterministically by the
offline integration test (step 1); the browser spec proves the UI surfaces and
the auth boundary against real infra.

---

## Release gate checklist

- [ ] `pnpm typecheck` green.
- [ ] `pnpm test` green (includes the offline MVP flow integration test).
- [ ] `pnpm --filter @family-finance/web build` green (placeholder secrets OK).
- [ ] `pnpm --filter @family-finance/bot build` green.
- [ ] `supabase db reset` applies the migration + seed to a fresh project (or the
      documented CLI blocker stands).
- [ ] README documents env, Supabase, Telegram webhook, and Vercel deploy.
- [ ] No real personal financial data in fixtures; no secrets committed.
