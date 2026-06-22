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

Copy `.env.example` to `.env.local` before running locally.

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
