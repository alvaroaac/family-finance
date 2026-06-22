# 0001 - Package Boundaries

**Status:** accepted

**Date:** 2026-06-22

**Context source:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` ("Planned File Boundaries"), Task 1 (Repository Baseline).

## Decision

The monorepo is organized as a pnpm + Turborepo workspace with the package and app responsibilities below. Each package and app extends a single shared `tsconfig.base.json` (strict mode) and exposes consistent `build`, `typecheck`, and `test` scripts so any agent can run root scripts without guessing per-package commands.

### Workspace layout

```txt
family-finance/
  tsconfig.base.json        # shared strict TypeScript config
  apps/
    web/                    # @family-finance/web  (Next.js)
    bot/                    # @family-finance/bot   (Telegram)
  packages/
    domain/                 # @family-finance/domain
    db/                     # @family-finance/db
    importers/              # @family-finance/importers
    categorization/         # @family-finance/categorization
    config/                 # @family-finance/config
  supabase/                 # migrations, seed, RLS policies
```

### Package responsibilities

`packages/domain` (`@family-finance/domain`)

- Owns money, dates, transactions, installment generation, accounts, cards, categories, and validation schemas.
- Exposes pure functions and typed command/result contracts.
- MUST NOT import from web, bot, database clients, or AI providers. This is the hard architectural rule for the project: domain rules stay out of React components, bot handlers, DB clients, and AI providers.

`packages/db` (`@family-finance/db`)

- Owns Supabase client creation, generated/handwritten database types, repository functions, and RLS-aware access patterns.
- Exposes persistence methods named around domain concepts, not raw UI screens.
- Every write path is built around `household_id` from the start.

`packages/importers` (`@family-finance/importers`)

- Owns source adapters (Minhas Financas, Nubank), row normalization, preview models, duplicate candidates, and import batch summaries.
- Accepts files as transient input and returns normalized rows. Never persists original imported CSV/XLSX or raw audio.

`packages/categorization` (`@family-finance/categorization`)

- Owns deterministic categorization, memory lookup, confidence scoring, explainability, and the AI fallback interface.
- Usable by both the importer and the Telegram bot.
- Any AI output must return confidence, explanation, and a safe fallback path.

`packages/config` (`@family-finance/config`)

- Owns shared environment schema and configuration contracts (`zod`-validated `AppEnv`).
- No secrets are hardcoded; values come from validated environment variables.

`apps/web` (`@family-finance/web`)

- Owns authenticated screens: dashboard, imports, transaction review, categories, accounts, cards, and caixinhas.
- Calls server-side actions/routes that use `packages/domain` and `packages/db`.

`apps/bot` (`@family-finance/bot`)

- Owns the Telegram webhook, text/audio intake, confirmation/correction state, and reply formatting.
- Calls the same transaction and categorization services used by the web app. No duplicated transaction logic.

`supabase`

- Owns migrations, seed data, and RLS policies.

## Dependency direction

- `domain` depends only on `zod`. It is the leaf with no internal dependencies.
- `db`, `importers`, `categorization` may depend on `domain` (and `db` on `config`).
- `apps/web` and `apps/bot` may depend on `domain`, `db`, `config`, and `categorization`; they are the only edges allowed to wire infrastructure to UI/handlers.
- No package may depend on `apps/*`.

## TypeScript configuration

- `tsconfig.base.json` enables `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `forceConsistentCasingInFileNames`. Module resolution is `NodeNext`.
- Library packages and `apps/bot` extend the base directly, set `rootDir: src` / `outDir: dist`, and `build` runs `tsc` (emit), while `typecheck` runs `tsc --noEmit`. `dist` is gitignored.
- `apps/web` extends the base but overrides the options Next.js requires (`module: ESNext`, `moduleResolution: Bundler`, `jsx: preserve`, `noEmit: true`, DOM libs, the `next` plugin). Its `build` is `next build`.

## Cross-package resolution

- Internal packages are consumed as TypeScript source via their `main`/`types` pointing at `src/index.ts` and `workspace:*` ranges. Next.js consumes them through `transpilePackages`.
- No custom TypeScript `paths` aliases were added. Workspace package names already resolve consistently across `tsc`, Next.js, and vitest, so additional aliases would add maintenance cost without benefit. Revisit only if a tool stops resolving workspace names.

## Scripts contract (run from repo root)

- `pnpm typecheck` - `tsc --noEmit` per package via Turborepo.
- `pnpm test` - `vitest run` per package (`--passWithNoTests` until tests exist).
- `pnpm build` - `tsc` emit for libraries/bot, `next build` for web.
- `pnpm lint`, `pnpm dev`, `pnpm format` - per the root `package.json`.

Turborepo `typecheck` and `test` tasks `dependsOn ["^build"]`, so dependency packages are built before downstream typecheck/test runs.

## Alternatives considered

- **TypeScript project references / composite builds:** more incremental but heavier to maintain for a small MVP; deferred. Revisit if cold build times become painful.
- **Custom `paths` aliases:** rejected; `workspace:*` package-name resolution already works everywhere.
- **A single root tsconfig with includes:** rejected; per-package configs keep boundaries explicit and let Next.js diverge cleanly from the Node packages.

## Revisit if

- A feature task needs a dependency edge this document forbids (re-evaluate the boundary instead of silently crossing it).
- Build/typecheck times grow enough to justify project references.
- A tool stops resolving workspace package names and aliases become necessary.
