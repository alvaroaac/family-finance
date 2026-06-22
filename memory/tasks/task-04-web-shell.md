# Task 04: Authenticated Web Shell

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 4)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** agent (web shell)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Build the private, authenticated web shell for the `Casa` workspace.
- Supabase Auth (Next.js App Router) with Google login.
- Authorized-email allowlist (`AUTHORIZED_EMAILS`).
- Redirect unauthenticated users to `/login`; show access-denied for non-allowlisted emails.
- Minimal `(app)` layout with nav: dashboard, imports, transactions, categories, accounts, settings.
- Smoke tests for the auth/allowlist logic.

Does NOT cover: real feature pages (imports/transactions/etc. screens), OAuth provider registration, dashboard data queries (Task 10).

## Progress

- [x] Pure auth/allowlist helpers + tests (`lib/auth.ts`, `lib/auth.test.ts`).
- [x] Lazy config env getters (no throw at build) (`packages/config/src/index.ts`).
- [x] Supabase server client wiring (`lib/supabase.ts`).
- [x] `(app)` server-side guard + layout + dashboard.
- [x] `/login` page + access-denied state + Google OAuth server action.
- [x] Build + typecheck green.

## Acceptance Criteria

- [x] Only allowed Google accounts can reach private app routes (server-side guard
      in `app/(app)/layout.tsx` -> `requireAuthorizedUser()` -> `evaluateAccess()`).
- [x] UI makes clear this is the `Casa` workspace (sidebar header + login card + titles).
- [x] `pnpm --filter @family-finance/web build` is green.

## QA

```txt
Command: pnpm --filter @family-finance/web typecheck && pnpm --filter @family-finance/web build
Result: GATE EXIT 0. typecheck (tsc --noEmit) clean; next build compiled successfully,
        6 routes generated. /dashboard and /login are server-rendered (ƒ dynamic),
        consistent with auth-guarded pages.
Notes:  Build succeeds with NO real secrets (placeholders used via getSupabasePublicConfig).

Command: pnpm --filter @family-finance/web test
Result: 1 file, 7 tests passed (evaluateAccess allowlist core).

Command: pnpm typecheck && pnpm test  (full repo regression after config change)
Result: typecheck 10/10 tasks ok; test 10/10 ok (web 7, domain 14, db 8).
```

## Review

### Findings

- None yet.

### Changes Requested

- None yet.

### Final Review State

not-reviewed

## Decisions Made During Task

- `@supabase/ssr` is NOT installable in this offline environment (absent from pnpm
  store/cache, no network). Implemented an equivalent thin SSR layer on top of the
  installed `@supabase/supabase-js` using its `storage` adapter (the same mechanism
  `@supabase/ssr` uses) backed by Next.js cookies. Architecture/contracts unchanged.
- Config env access made lazy (`getServerEnv()`/`getAuthorizedEmails()`) so
  `next build` never throws on missing secrets (per task gotcha).

## Follow-Ups

### Tech Debt

- Swap the hand-rolled cookie storage adapter for `@supabase/ssr` once network/registry
  access is available (recommended upstream package).

### Ideas

- None yet.

### Risks Or Blockers

- None yet.

## Handoff Notes

- Allowlist/auth logic lives in `apps/web/lib/auth.ts` (pure, testable).
- Supabase server/browser clients in `apps/web/lib/supabase.ts`.
- Protected routes live under `apps/web/app/(app)/` and are guarded server-side in
  `app/(app)/layout.tsx` via `requireAuthorizedUser()`.
