# Task 11: End-To-End Review Loop

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 11)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (§08 dashboard "dados úteis")

**Owner:** agent (final integration)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

Final integration that tests the STORY, not individual widgets. Delivered BOTH
halves because the full browser + Supabase E2E cannot run offline here:

- **(A) Runnable offline integration test** — `apps/web/integration/mvp-flow.test.ts`
  (+ `apps/web/integration/fake-supabase.ts`). Runs the whole MVP story through
  the REAL shared packages with an in-memory fake of the Supabase/db layer and
  injected Telegram/bot doubles. No network. Picked up by `pnpm test`
  (`*.test.ts`, NOT `*.spec.ts`).
- **(B) Playwright browser spec** — `apps/web/e2e/mvp-flow.spec.ts` (+
  `apps/web/playwright.config.ts`). Runs against a real dev server + Supabase.
  Excluded from vitest via `apps/web/vitest.config.ts` (`exclude: e2e/**`).
  `@playwright/test` added as a web devDependency so it typechecks.

Out of scope: live Supabase/Telegram/AI runs (no secrets/network here); any new
product surfaces (this task only adds tests + docs).

## Progress

- [x] In-memory fake Supabase client (`from().select/insert/update/delete` +
      `eq/neq/gte/lte/is/not/order/limit/single/maybeSingle`, thenable).
- [x] Seed household "Casa" with two authorized users + accounts/card/buckets/catalog.
- [x] Import synthetic Minhas Finanças CSV via `@family-finance/importers`,
      preview (0 errors/dupes, 4 importable), confirm via domain + db write path.
- [x] Category correction -> `createCategorizationMemory` -> next `suggestCategory`
      flips `uncategorized` to `matched`/`source: "memory"` (proves learning).
- [x] Telegram text "Uber 32 reais hoje no cartão" through `startConversation` +
      `applyMessage("confirmar")` -> card expense saved; confirmation-by-default
      verified (nothing saved pre-confirm); interaction logged.
- [x] Parcelado card purchase via `createInstallmentPlan` +
      `createInstallmentPurchase` (3x, June/July/Aug, sums to total).
- [x] Dashboard reconciliation: same six Task 10 reads `loadDashboardData` uses
      (`getMonthlySummary`, `getCardPressure`, `findUpcomingInstallments`,
      `listInvestmentBuckets`, `findRecentTransactions`,
      `findPendingReviewTransactions`) over the fake DB, with exact-number asserts.
- [x] Playwright config + spec (public no-session guarantees always run;
      authenticated walkthrough skipped unless `E2E_STORAGE_STATE`).
- [x] `docs/runbooks/local-mvp-verification.md` (install/typecheck/test/builds,
      offline test, Playwright vs real infra, Supabase migration apply, Telegram).
- [x] README: env table, Supabase setup, Telegram webhook, Vercel deploy, runbook link.

## Acceptance Criteria

- [x] A fresh agent can verify the whole MVP locally from README/runbook.
- [x] Dashboard totals reconcile with the seed/import/bot scenario (proven by the
      offline integration test).

## Reconciliation numbers (offline test, month 2026-06)

- incomeCents = 500000 (imported salary).
- expenseCents = 4590 (iFood) + 15000 (Mercado) + 3000 (Farmácia) + 3200 (bot
  Uber, card) = 25790. balanceCents = 474210.
- cardPressure: directCents 3200 (Uber on card) + installmentCents 40000 (first
  Geladeira parcel, 120000/3) = totalCents 43200.
- upcoming installments: 2026-06/07/08. buckets: filhos/casa/independencia_financeira.
- pending review after correcting Mercado: contains "Farmácia Saúde", excludes
  "Mercado do Bairro".

## QA

```txt
Command: pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build
Result:  GREEN.
  typecheck: 12/12 tasks successful (FULL TURBO).
  test: 12/12 tasks successful; apps/web -> lib/auth.test.ts (7) +
        integration/mvp-flow.test.ts (6) = 13 passed; suite total 99 tests across
        13 files (config 4, domain 14, importers 11, categorization 22, db 21,
        web 13, bot 27).
  web build: next build "Compiled successfully", 6/6 pages, all routes emitted.
Notes:  e2e/mvp-flow.spec.ts is NOT collected by vitest (vitest.config exclude).
        pnpm --filter @family-finance/bot build also green (release gate).
        @playwright/test installed (pnpm install added 5 packages).
```

## Review

### Final Review State

not-reviewed

## Decisions Made During Task

- The offline integration test exercises the REAL db repository I/O functions
  (createTransaction, getMonthlySummary, getCardPressure, createInstallmentPurchase,
  createCategorizationMemory, listActiveCategorizationMemory, ...) against an
  in-memory fake client, so the dashboard numbers are computed by the SAME code
  path production uses — only the Postgres/network edge is faked. This proves
  reconciliation, not just the pure reducers (already covered in db tests).
- Named the offline test `*.test.ts` under `apps/web/integration/` (vitest picks
  it up) and the browser spec `*.spec.ts` under `apps/web/e2e/` (Playwright only).
  Added `apps/web/vitest.config.ts` to exclude `e2e/**` so the two never collide.
- The integration test imports the bot conversation directly
  (`../../bot/src/conversation.js`) rather than re-implementing the flow, so the
  "Telegram entry" is the real state machine. `apps/bot` has no `main`, so a
  relative import is used (resolves under both vitest and the web tsconfig's
  Bundler resolution / Next build).
- Playwright authenticated walkthrough is `test.skip`-gated on `E2E_STORAGE_STATE`
  because Google OAuth cannot be scripted headlessly; the no-session public
  guarantees (protected route -> /login, login page content) always run.

## Follow-Ups

### Tech Debt

- The fake Supabase client supports only the operators the current repositories
  use; new query shapes will need fake support (or a real local Supabase run).
  Low impact — it is test-only and fails loudly on an unsupported `.not(...)`.

### Ideas

- None.

### Risks Or Blockers

- The online layer (real Supabase + Telegram + Playwright browser) was NOT run
  here (no secrets/network). This is the same standing risk noted for Tasks 4/7/
  8/10 in `risks-and-blockers.md`; Task 11 documents the exact procedure to close
  it but does not itself execute it. Updated the dashboard-reads risk entry.

## Handoff Notes

MVP release-gate commands are all green offline. To finish online verification,
follow `docs/runbooks/local-mvp-verification.md` step 2 onward (supabase start &&
db reset, fill apps/web/.env.local, npx playwright install, set E2E_STORAGE_STATE
from a manual login, then `pnpm --filter @family-finance/web test:e2e`). The
offline integration test is the authoritative proof that the dashboard reconciles
with import + correction + bot + parcelado.
