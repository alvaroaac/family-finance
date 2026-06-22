# Task 03: Supabase Schema And RLS

**Status:** in-review

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 3)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** db agent

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Model the MVP data in Postgres with RLS enabled from day one.
- All 14 tables: households, household_members, accounts, investment_buckets,
  credit_cards, categories, subcategories, transactions, installment_groups,
  installments, import_batches, import_rows, categorization_memory,
  bot_interactions.
- Money-cents / kind / confidence constraints; RLS keyed by household membership.
- Seed `Casa` household + category/bucket placeholders (no real financial data).
- DB package: hand-written static types + domain-named, RLS-aware repositories.
- Decision doc + local Supabase migration runbook.
- NOT covered: auth/login wiring (Task 4), import parsing (Task 5), categorization
  logic (Task 6), generated Supabase types.

## Progress

- [x] `supabase/migrations/0001_initial_schema.sql` — all 14 tables, enums,
      constraints, `is_household_member` helper, RLS policies on every table.
- [x] `supabase/seed.sql` — Casa household, 3 caixinhas, placeholder categories
      + a couple subcategories. No financial data; no members seeded.
- [x] `packages/db/src/types.ts` — hand-written Row/Insert/`Database` types.
- [x] `packages/db/src/repositories.ts` — `createTransaction`,
      `findCategoriesByHousehold`, `findSubcategoriesByCategory`,
      `getMonthlySummary` + pure helpers `transactionInsertFromDraft`,
      `mapTransactionRow`, `monthDateRange`, `summarizeMonth`.
- [x] `packages/db/src/repositories.test.ts` — 8 unit tests on the pure helpers.
- [x] `packages/db/src/index.ts` — `createDatabaseClient` + re-exports.
- [x] Added `@family-finance/domain` workspace dep to `packages/db`.
- [x] `docs/decisions/0002-rls-and-household-isolation.md` (incl. runbook).
- [x] Migration + seed validated against throwaway Postgres; RLS proven.

## Acceptance Criteria

- [x] Unauthorized users cannot read or write household data (RLS) — verified:
      non-member sees 0 rows, insert blocked with `insufficient_privilege`.
- [x] A transaction can be persisted with account/card/category references —
      verified: member inserted an expense with account_id + category_id and
      read it back (1599 cents).
- [x] Import batches can be tracked without retaining original files —
      `import_batches` stores source/status/counts/notes only; no file bytes.

## QA

```txt
Command: pnpm --filter @family-finance/db typecheck
Result:  PASS (tsc --noEmit, no errors)

Command: pnpm --filter @family-finance/db test
Result:  PASS — Test Files 1 passed (1), Tests 8 passed (8)

Command: docker postgres:16-alpine + auth stub, apply migration + seed, RLS test
Result:  migration OK, seed OK.
         mallory (non-member): 0 households / 0 accounts / 0 transactions;
           insert into Casa blocked (insufficient_privilege).
         alice (member): sees Casa; inserts expense w/ account+category;
           reads back 1 tx, total 1599 cents.
Notes:   Supabase CLI unavailable/offline — used throwaway plain Postgres with a
         minimal auth.users/auth.uid() stub. `supabase db reset` NOT run.
```

## Review

### Findings

- None yet.

### Changes Requested

- None yet.

### Final Review State

not-reviewed

## Decisions Made During Task

- Single `SECURITY DEFINER` `is_household_member()` helper drives all RLS
  policies (avoids recursion on household_members; rule defined once via a
  DO loop over scoped tables).
- `installment_groups` declared before `transactions` so a transaction can
  carry an optional `installment_id`; `transactions.import_batch_id` FK is
  added after `import_batches` exists.
- DB types are hand-written and static so the package typechecks with no live
  Supabase; the `Database` type is shaped to be `@supabase/supabase-js`-compatible.
- Repositories reuse `@family-finance/domain` (`TransactionDraft`, `MoneyAmount`,
  `brl`); pure mappers carry the testable logic.

## Follow-Ups

### Tech Debt

- Hand-written `packages/db/src/types.ts` must be kept in sync with the migration
  by hand until generated Supabase types are adopted.

### Ideas

- A standalone `docs/runbooks/supabase-local-setup.md` would satisfy the release
  gate (runbook currently lives inside the 0002 decision doc).

### Risks Or Blockers

- Supabase CLI unavailable offline; `supabase db reset` not run. Documented in
  `memory/risks-and-blockers.md` (Supabase local setup, status: watching).
  Re-verify against real Supabase Auth when the CLI is installable.

## Handoff Notes

- Auth/web (Task 4): membership is provisioned by an admin/service role against
  the email allowlist — there is intentionally no self-service insert policy on
  `household_members`. Seed inserts the `Casa` household with stable id
  `00000000-0000-0000-0000-000000000001` but NO members (members link to real
  `auth.users`). After a user logs in, insert their `household_members` row.
- Importers (Task 5): use `import_batches` (source/status/counts) + `import_rows`
  (minimal normalized fields, never raw file) and link produced rows via
  `import_rows.transaction_id` / `transactions.import_batch_id`.
- Bot/categorization (Tasks 6-8): `categorization_memory` and `bot_interactions`
  both enforce confidence in [0,1] and carry an `explanation` column.
- Use `createTransaction(client, draft)` to persist — pass an authenticated
  Supabase client so RLS applies.
