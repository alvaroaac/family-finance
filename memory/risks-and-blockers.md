# Risks And Blockers

Use this file for active risks, unresolved questions, and external dependencies that can affect delivery.

## Active Risks

### Import format variance

**Risk:** Minhas Financas and Nubank exports may vary by date format, decimal format, column naming, or encoding.

**Mitigation:** Build import adapters with fixtures and preview errors instead of assuming a perfect file.

**Status:** open

### Supabase local setup

**Risk:** Local migration verification may be blocked if Supabase CLI or Docker is unavailable.

**Mitigation:** Document the exact blocker and keep SQL migrations reviewable.

**Status:** watching

**2026-06-22 (Task 3):** Supabase CLI is NOT installed in this environment and cannot be installed offline — `npx supabase` is canceled with "missing packages and no YES option" (no network); `brew install supabase/tap/supabase` / `npm i -g supabase` were not run. Docker *is* available and running. So `supabase db reset` was not executed. Mitigation applied: the migration (`supabase/migrations/0001_initial_schema.sql`) + seed (`supabase/seed.sql`) were validated against a throwaway plain-Postgres 16 Docker container with a minimal `auth.users`/`auth.uid()` stub. Result: schema + seed apply cleanly; RLS verified (non-member sees 0 rows and is blocked from inserting; member reads Casa and persists a transaction with account+category refs). Next action: when the Supabase CLI is available, run `supabase start && supabase db reset` to confirm against the real Auth stack. Runbook + details in `docs/decisions/0002-rls-and-household-isolation.md`.

### AI confidence and explainability

**Risk:** Categorization may feel magical or wrong if confidence/explanations are not visible.

**Mitigation:** Every suggestion must include confidence and explanation metadata.

**2026-06-22 (Task 6):** Substantially mitigated at the engine level. Every
`CategorySuggestion` from `packages/categorization` carries `confidence` (0..1),
`explanation`, and `source`; low confidence (< `CONFIDENCE.HIGH` 0.85) sets
`requiresConfirmation`; novel categories return `pending_new_category` (never
auto-created); memory patterns are listed/disabled/explained in the web Categorias UI.
Remaining exposure is only the actual AI provider quality (Task 8) and that the web UI
was not exercised against real Supabase.

**Status:** watching

### Web auth wiring not exercised against real Supabase

**Risk:** The web auth shell (Task 4) builds and the allowlist policy is unit-tested, but
the Supabase session/cookie flow and Google OAuth round-trip were NOT run against a real
Supabase project (no secrets/network in this environment). The custom cookie storage
adapter and OAuth code exchange may need a middleware/route handler for real session
refresh.

**Mitigation:** Pure `evaluateAccess` is fully tested; build is green with placeholders.
Tech debt logged to swap in `@supabase/ssr` and add OAuth callback handling.

**Status:** open

## Blockers

No active blockers recorded yet.

## Entry Format

```md
## YYYY-MM-DD: Risk Or Blocker

**Type:** risk | blocker | open question

**Impact:** What this can delay or break.

**Next action:** Specific action to reduce uncertainty.

**Owner:** person or agent role

**Status:** open | watching | resolved
```

