# Task 01: Repository Baseline

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md`

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** baseline agent

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Stabilize the monorepo so feature tasks have predictable scripts, TypeScript config, and documented package boundaries.
- Add a shared strict `tsconfig.base.json` and a per-package/app `tsconfig.json` that extends it.
- Make `pnpm typecheck`, `pnpm test`, and `pnpm build` green at the root across all packages.
- Document package responsibilities in `docs/decisions/0001-package-boundaries.md`.
- Does NOT implement any feature/domain/db/import/categorization/bot/web logic (later tasks).

## Progress

- [x] Created `tsconfig.base.json` (strict mode + extra safety flags, NodeNext).
- [x] Created `tsconfig.json` for every package (domain, db, importers, categorization, config) and both apps (web, bot), each extending the base.
- [x] Library packages + bot: `build` = `tsc` emit to `dist/` (gitignored), `typecheck` = `tsc --noEmit`.
- [x] Web app tsconfig overrides Next.js-required options (ESNext/Bundler/jsx preserve/noEmit/DOM/next plugin).
- [x] Added `apps/web/next.config.mjs` (transpilePackages for workspace deps) and `apps/web/next-env.d.ts`.
- [x] Set `test` to `vitest run --passWithNoTests` in every package/app with no test files yet; added `test` + `vitest` devDep to web.
- [x] Updated `turbo.json` (globalDependencies on base config; build/test/typecheck outputs).
- [x] Updated `README.md` with the scripts contract and a link to the decision record.
- [x] Created `docs/decisions/0001-package-boundaries.md`.
- [x] Ran `pnpm install && pnpm typecheck && pnpm test` (all green).

## Acceptance Criteria

- [x] A new agent can run root scripts (`pnpm typecheck`, `pnpm test`, `pnpm build`) without guessing per-package commands.
- [x] No feature task has to invent package boundaries again (documented in decision 0001 + README).
- [x] Every package/app tsconfig extends `tsconfig.base.json` (strict on).
- [x] `build` emits cleanly to `dist/` for every tsc package; `next build` succeeds for web.

## QA

```txt
Command: pnpm install
Result:  Already up to date; Done. (exit 0)

Command: pnpm typecheck
Result:  Tasks: 10 successful, 10 total (exit 0)

Command: pnpm test
Result:  Tasks: 10 successful, 10 total (No test files found, exiting with code 0 per package) (exit 0)

Command: pnpm build
Result:  Tasks: 7 successful, 7 total; tsc emits dist/ with .d.ts + maps; next build static pages OK (exit 0)
Notes:   typecheck/test fan out to 10 turbo tasks because ^build pulls dependency builds in.
```

## Review

### Findings

- `tsc --noEmit` previously printed CLI help (no tsconfig existed); fixed by adding per-package configs.
- `vitest run` fails on "no test files" without `--passWithNoTests`; added the flag where no tests exist.

### Changes Requested

- None.

### Final Review State

approved (self-verified green)

## Decisions Made During Task

- No custom TypeScript `paths` aliases were added. `workspace:*` package-name resolution already works across `tsc`, Next.js (`transpilePackages`), and vitest; aliases would add cost without benefit. Documented in decision 0001 and README.
- Internal packages are consumed as TS source via `main`/`types` -> `src/index.ts`; `tsc` build still emits `dist/` for each so downstream `^build` (turbo) is satisfied.
- Web app keeps `next build` for `build` and `tsc --noEmit` for `typecheck`; its tsconfig diverges from base where Next requires it.

## Follow-Ups

### Tech Debt

- `apps/web` `lint` is still `next lint` with no eslint config yet; `pnpm lint` for web will scaffold/prompt on first real use. Not in this task's verification set. Revisit when adding the first web feature.
- Real test files are pending per package; `--passWithNoTests` is a temporary no-op that should be removed once a package has tests (it is harmless to keep).

### Ideas

- None.

### Risks Or Blockers

- None new. `next build` succeeds without secrets for the scaffold; future web features that read env at build time may need `.env.local`.

## Handoff Notes

- Extend `tsconfig.base.json` from any new package/app; set `rootDir: src` / `outDir: dist` and `include: ["src"]` for tsc packages.
- Run everything from the repo root: `pnpm typecheck`, `pnpm test`, `pnpm build`. Target one package with `pnpm --filter @family-finance/<name> <script>`.
- Package responsibilities and the hard rule "domain must not import web/bot/db/AI" live in `docs/decisions/0001-package-boundaries.md`.
- `dist/`, `.next/`, `.turbo/`, and `*.tsbuildinfo` are gitignored build artifacts — do not commit them.
