# Risks And Blockers

Use this file for active risks, unresolved questions, and external dependencies that can affect delivery.

## Active Risks

### Import format variance

**Risk:** Minhas Financas and Nubank exports may vary by date format, decimal format, column naming, or encoding.

**Mitigation:** Build import adapters with fixtures and preview errors instead of assuming a perfect file.

**2026-06-22 (Task 5):** Substantially mitigated for CSV. Both adapters match headers by
accent-folded NAME (column order independent), auto-detect `;`/`,`, and normalize BR
(`DD/MM/YYYY`, `3.000,00`) and ISO/dot-decimal formats. Unmapped rows + unrecognized headers
return as reviewable errors instead of failing the import, and re-import is the recovery path.
Remaining exposure: no XLSX adapter, no Minhas Financas CSV-padrão/customizado/XLSX variant
split, and adapters not validated against real export samples (only synthetic fixtures). See
tech debt "Only name-matched CSV adapters; no XLSX or format variants".

**Status:** watching

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

**2026-06-22 (Task 8):** The concrete AI fallback (`createAiCategorizer`) now also
carries confidence + explanation, fires only as a last resort (after memory + rules),
keeps novel categories pending, and degrades to `null` on any provider failure. The
AI completion client (Anthropic) and transcription provider (OpenAI) are injected
interfaces; their REAL HTTP response parsing was NOT exercised against the live
providers (no network/secrets). Remaining exposure: actual provider quality + the
untested edge `providers.ts` parsing.

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

### Telegram webhook not exercised against real Telegram + Supabase

**Type:** risk

**Impact:** The bot text flow (Task 7) is fully unit-tested with mocked Telegram, db, and
categorization (no network/secrets here). `handleWebhook` and `startBot()` assemble the
production wiring (secret verify -> parse update -> conversation -> send reply), but the
real webhook round trip (Telegram `setWebhook` secret header, RLS-authenticated Supabase
client carrying the bot identity's JWT, and the Bot API `sendMessage`) was NOT run. The
bot also currently has no HTTP entry point (Next.js route / small server) wrapping
`handleWebhook` — that wiring is pending.

**Next action:** When secrets/network are available, add a webhook route that calls
`handleWebhook`, register it with `setWebhook?secret_token=...`, and confirm a real text
message becomes a confirmed transaction. Decide how the bot authenticates to Supabase so
RLS scopes writes to the Casa household.

**Owner:** agent (bot)

**2026-06-22 (Task 8):** `handleWebhook` now also routes voice/audio (transcribe ->
same confirmation flow) and threads the AI categorization fallback. Still NOT exercised
against real Telegram + Supabase, and additionally the Anthropic (categorization) and
OpenAI (transcription) provider HTTP calls were not run against the real providers. When
verifying the webhook, also send a real voice note (confirm temp audio is deleted and the
transcription becomes a confirmed transaction) and a message that should trigger the AI
fallback.

**Status:** open

### Dashboard reads not exercised against real Supabase (Task 10)

**Type:** risk

**Impact:** The monthly dashboard (`apps/web/app/(app)/dashboard`) typechecks, builds with
placeholder secrets, and its pure aggregation helpers (`summarizeCardPressure`, `needsReview`,
`mapDashboardTransaction`, `mapUpcomingInstallment`, `currentMonth`) are unit-tested. But the
six RLS-scoped reads it composes (`getMonthlySummary`, `getCardPressure`,
`findUpcomingInstallments`, `findRecentTransactions`, `findPendingReviewTransactions`,
`listInvestmentBuckets`) were NOT run against a live Supabase (no secrets/network here). The
`loadDashboardData` failure path collapses any error to a zeroed/empty state, so a
mis-scoped query or wrong filter could silently look like "empty month" rather than erroring.

**Next action:** When Supabase is reachable, confirm each dashboard read returns
household-scoped data, that card pressure reconciles with seeded card transactions +
installments, and that the zero state appears only when the month is genuinely empty. Covered
naturally by Task 11 (end-to-end review loop).

**Owner:** agent (web)

**2026-06-22 (Task 11):** Substantially mitigated OFFLINE. The end-to-end review-loop
integration test (`apps/web/integration/mvp-flow.test.ts`) runs all six dashboard reads
(`getMonthlySummary`, `getCardPressure`, `findUpcomingInstallments`,
`findRecentTransactions`, `findPendingReviewTransactions`, `listInvestmentBuckets`) — the
REAL repository I/O — against an in-memory fake Supabase client, after seeding + importing +
correcting + a bot entry + a parcelado purchase, and ASSERTS the totals reconcile exactly
(income 500000; expenses 25790 incl. imports + bot Uber; card pressure 43200 = 3200 direct +
40000 June parcel). Remaining exposure: the reads were still NOT run against a LIVE Supabase
(no RLS scoping verified end-to-end, no real network). The Playwright spec
(`apps/web/e2e/mvp-flow.spec.ts`) and the runbook cover that real-infra step; it has not been
executed here.

**Status:** watching

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

