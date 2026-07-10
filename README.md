# Family Finance

Private family finance MVP for Alvaro and Karol.

## Structure

- `apps/web`: Next.js web app (`@family-finance/web`).
- `apps/bot`: Telegram bot (`@family-finance/bot`).
- `packages/domain`: pure finance model and validation (`@family-finance/domain`).
- `packages/db`: Supabase client, types, and repositories (`@family-finance/db`).
- `packages/importers`: import source adapters (`@family-finance/importers`).
- `packages/categorization`: categorization and AI fallback (`@family-finance/categorization`).
- `packages/config`: shared env schema (`@family-finance/config`).
- `supabase`: migrations, seed data, and RLS policies.
- `docs/specs`: MVP spec and future backlog.
- `docs/decisions`: durable architecture decisions.

Package boundaries and dependency direction are documented in
`docs/decisions/0001-package-boundaries.md`.

## Setup

```sh
pnpm install
```

Copy `.env.example` to `apps/web/.env.local` before running locally and fill in
the values. `.env.example` documents every key (Supabase, Google login, the
authorized-email allowlist, Telegram bot, and AI providers). No secrets are
committed; the web build stays green with placeholder values.

### Environment variables

| Variable                                                    | Purpose                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser/server Supabase clients.                                     |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`          | Server-only Supabase secrets (never exposed to the client).          |
| `NEXT_PUBLIC_SITE_URL`                                      | Base URL used to build the Google OAuth redirect.                    |
| `AUTHORIZED_EMAILS`                                         | Allowlist of Google emails that can reach the private `Casa` routes. |
| `HOUSEHOLD_SLUG`                                            | Single MVP household slug (`casa`).                                  |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`             | Bot API access + fail-closed webhook verification.                   |
| `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL`), `OPENAI_API_KEY`   | Optional AI categorization fallback + voice transcription.           |
| `IMPORT_PREVIEW_SIGNING_SECRET`                             | Signs transient import previews before confirmation.                 |
| `IMPORT_SUGGESTION_URL`, `IMPORT_SUGGESTION_SHARED_SECRET`  | Authenticated web-to-bot import category suggestions.                |

### Supabase setup

Supabase provides Auth (Google login), Postgres, and RLS. Local workflow:

```sh
brew install supabase/tap/supabase   # or: npm i -g supabase
supabase start                       # Postgres + Auth + Studio (needs Docker)
supabase db reset                    # apply supabase/migrations/* then seed.sql
```

`supabase/migrations/0001_initial_schema.sql` enables RLS on every table and
`supabase/seed.sql` seeds the single `Casa` household (no real financial data).
Configure Google in the Supabase dashboard (Authentication > Providers > Google)
and add the allowlisted emails as `household_members`. Migration details and the
local CLI blocker are in
[`docs/decisions/0002-rls-and-household-isolation.md`](docs/decisions/0002-rls-and-household-isolation.md).

### Telegram webhook setup

1. Create a bot via @BotFather and set `TELEGRAM_BOT_TOKEN`.
2. Pick a `TELEGRAM_WEBHOOK_SECRET` (the handler rejects all requests when unset).
3. Register the webhook (Telegram echoes the secret back in a header the handler
   verifies):

   ```sh
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=https://<your-host>/api/telegram/webhook" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

Text entry works with just the token + secret. Voice notes additionally need
`OPENAI_API_KEY` (raw audio is downloaded to a temp file and deleted immediately,
never persisted). AI categorization fallback needs `ANTHROPIC_API_KEY`.

### Vercel deploy

- Deploy `apps/web` as the Vercel project (root `apps/web`); Turborepo builds the
  shared packages it depends on.
- Set every variable from the table above in Vercel project settings. Use the
  production Supabase URL/keys and set `NEXT_PUBLIC_SITE_URL` to the deployed URL
  (and add it to Supabase Auth's redirect allowlist + the Google OAuth client).
- The web build does not require secrets to compile, but the running app needs
  real Supabase credentials and `AUTHORIZED_EMAILS` to authenticate members.
- Point the Telegram webhook at the deployed host (see above). Configure the bot
  runtime (`apps/bot`) with the same Supabase + Telegram + AI variables.

### Verifying the whole MVP locally

Follow [`docs/runbooks/local-mvp-verification.md`](docs/runbooks/local-mvp-verification.md)
to verify the end-to-end story (import -> review/correct -> Telegram entry ->
parcelado purchase -> reconciled dashboard). The offline service-level
integration test (`apps/web/integration/mvp-flow.test.ts`, run by `pnpm test`)
proves the dashboard totals reconcile with no network; the Playwright spec
(`apps/web/e2e/mvp-flow.spec.ts`) covers the browser flow against real infra.

## Commands

Run these from the repo root; Turborepo fans them out across every package and app.

```sh
pnpm typecheck   # tsc --noEmit in every package
pnpm test        # vitest run in every package (--passWithNoTests until tests exist)
pnpm build       # tsc emit for libraries/bot, next build for web
pnpm lint        # lint every package
pnpm dev         # run dev servers
pnpm format      # prettier --check
```

### TypeScript config

Every package and app extends the shared strict `tsconfig.base.json`. Library
packages and `apps/bot` emit to `dist/` (gitignored) via `tsc`; `apps/web`
overrides the options Next.js requires and builds via `next build`.

### Per-package scripts

Each workspace package exposes the same script names so root commands work
uniformly:

- `build` - `tsc` (emit to `dist/`) for libraries and the bot; `next build` for web.
- `typecheck` - `tsc --noEmit`.
- `test` - `vitest run` (currently `--passWithNoTests` where no tests exist yet).

To target one package: `pnpm --filter @family-finance/<name> <script>`.
