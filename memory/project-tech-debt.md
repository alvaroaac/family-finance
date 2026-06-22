# Project Tech Debt

Track known compromises here. Debt should be specific enough that a future agent can act on it.

## Open Debt

## 2026-06-22: Web lint has no eslint config

**Area:** apps/web

**Impact:** `pnpm lint` for the web app runs `next lint` with no eslint config; first real run will scaffold/prompt. Not covered by Task 1 verification.

**Current workaround:** `lint` left as `next lint`; lint is not part of the baseline green gate.

**Revisit trigger:** Adding the first web feature, or wiring lint into CI.

**Status:** open

## 2026-06-22: Packages use `--passWithNoTests`

**Area:** all packages and apps

**Impact:** `test` scripts pass even when a package has zero tests, so an accidentally empty test suite would not fail.

**Current workaround:** `vitest run --passWithNoTests` keeps `pnpm test` green until real tests exist (Task 2+).

**Revisit trigger:** Once a package has real tests, the flag is a harmless no-op but can be dropped for that package.

**Status:** open

## 2026-06-22: Installments use month attribution, not invoice timing

**Area:** packages/domain (`installments.ts`), and future cards/dashboard UI

**Impact:** Installments carry a `dueMonth` (`YYYY-MM`) attributed by purchase month, not a real invoice due date. `CreditCard.closingDay`/`dueDay` exist but are unused. Card pressure projections are approximate (no closing-day shift of the first installment).

**Current workaround:** Dashboard projections group by `dueMonth`, which is enough for the MVP summary and keeps generation stable and invoice-free.

**Revisit trigger:** When the dashboard/cards UI needs accurate invoice timing (Task 9/10), derive the first installment's month from the card closing day.

**Status:** open

## 2026-06-22: Web auth uses a hand-rolled SSR cookie adapter instead of `@supabase/ssr`

**Area:** apps/web (`lib/supabase.ts`)

**Impact:** The recommended package `@supabase/ssr` was not installable in the offline
build environment (absent from the pnpm store/cache, no network). The server Supabase
client is built directly on `@supabase/supabase-js` with a custom Next.js cookie
`storage` adapter (the same mechanism `@supabase/ssr` uses internally) and a single
JSON session cookie. Token refresh (`autoRefreshToken`) is disabled in this path, and
the cookie write path is best-effort (silently ignored in read-only server contexts).
This is functionally sufficient for the guard/allowlist flow but is not the maintained
upstream integration.

**Current workaround:** Custom adapter + `getUser()` validation; the pure access policy
(`evaluateAccess`) is independent of the wiring and fully tested.

**Revisit trigger:** When the npm registry is reachable, run
`pnpm add @supabase/ssr --filter @family-finance/web` and replace `lib/supabase.ts`
with `createServerClient` from `@supabase/ssr` (add a middleware/route handler for the
OAuth code exchange + session refresh). Remove the manual cookie adapter.

**Status:** open

## 2026-06-22: `@supabase/supabase-js` symlinked manually into apps/web

**Area:** apps/web/node_modules, pnpm-lock.yaml

**Impact:** Because `pnpm install` could not run online, the new `@supabase/supabase-js`
direct dependency of `apps/web` was linked by hand into `apps/web/node_modules` and the
lockfile was updated via `pnpm install --offline --lockfile-only`. node_modules is
gitignored, so the symlink is local-only; CI/fresh clones rely on a normal `pnpm install`
recreating it from the (now correct) lockfile entry.

**Current workaround:** Manual symlink + lockfile-only update; build and typecheck are green.

**Revisit trigger:** First clean `pnpm install` with network — verify the dep resolves
without the manual symlink and the lockfile is unchanged.

**Status:** open

## Entry Format

```md
## YYYY-MM-DD: Short Title

**Area:** package/app/file

**Impact:** What this makes harder, riskier, slower, or more confusing.

**Current workaround:** How the project currently survives with this debt.

**Revisit trigger:** What event should make us fix it.

**Status:** open | in-progress | resolved
```

