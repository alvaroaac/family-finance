# 0002 - RLS And Household Isolation

**Status:** accepted

**Date:** 2026-06-22

**Context source:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 3, "Supabase Schema And RLS"); product spec `docs/specs/2026-06-22-family-finance-mvp-spec.html` ("Supabase", "Entidades principais", "Privacidade", "Privado por padrão").

## Decision

The MVP data model is implemented in `supabase/migrations/0001_initial_schema.sql` with Row Level Security (RLS) enabled on **every** table from day one, even though there is only one household (`Casa`). Access to a row is granted only when the current authenticated user is an **active member** of that row's household.

### Household isolation model

- Every household-scoped table carries a `household_id uuid not null references households(id)`.
- Membership lives in `household_members (household_id, user_id, is_active)`, where `user_id` references `auth.users(id)` (Supabase Auth identities).
- A single `SECURITY DEFINER` SQL helper answers isolation for all policies:

  ```sql
  is_household_member(target_household_id uuid) returns boolean
  -- true iff auth.uid() is an active member of target_household_id
  ```

  It is `SECURITY DEFINER` so it can read `household_members` without being subject to that table's own RLS (which would otherwise recurse). It only ever evaluates membership for the _current_ `auth.uid()`, so it cannot leak other households' membership.

- Policies:
  - `households`: members may `select`/`update` their own household.
  - `household_members`: members may `select` membership rows of their own household. There is no self-service `insert` policy — membership is provisioned by an admin/service role against the email allowlist (Task 4).
  - All 12 other scoped tables (`accounts`, `investment_buckets`, `credit_cards`, `categories`, `subcategories`, `transactions`, `installment_groups`, `installments`, `import_batches`, `import_rows`, `categorization_memory`, `bot_interactions`) share one `FOR ALL` policy: `using (is_household_member(household_id)) with check (is_household_member(household_id))`. Generated in a `DO` loop so the rule is defined once.

A user who is not a member of a household sees **no rows** of that household and cannot `insert`/`update`/`delete` into it. This was verified against a real Postgres (see "Verification").

### Data integrity constraints (mirror the domain contracts)

- **Money** is integer cents in `*_cents` columns (`bigint`), with `CHECK (amount_cents > 0)` on transactions/installments and `total_amount_cents > 0` on installment groups. Never reais as floats — matches `packages/domain` `MoneyAmount`.
- **Transaction kinds** are the enum `transaction_kind = ('expense','income','transfer')` (`transfer` reserved).
- **Account kinds** are the enum `account_kind = ('checking','investment')`.
- **Confidence** on `categorization_memory` and `bot_interactions` is `numeric(4,3)` with `CHECK (confidence >= 0 and confidence <= 1)` — the `[0,1]` range required for explainable AI output.
- **Payment instrument** is account XOR card on `transactions` (`CHECK` enforces exactly one of `account_id` / `credit_card_id`).
- **Responsibility** is `responsibility_scope ('household'|'user')` with a `CHECK` that `responsible_user_id` is set iff scope is `user`; default is `household` (Casa), matching the domain default.
- **Installment due month** is `text CHECK (due_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')` — `YYYY-MM` month attribution, not invoice timing.
- **Import privacy**: `import_batches` stores only source, status, and counts (`total/imported/duplicate/error_rows`) plus an optional `notes` string; `import_rows` stores only minimal normalized fields and per-row errors. **The original CSV/XLSX file is never persisted.** This satisfies the spec's "Arquivo original não é persistido" rule.

### DB package surface

`packages/db` ships:

- `packages/db/src/types.ts` — hand-written, static database types (Row/Insert/`Database`) that mirror the migration. No live Supabase connection is needed to typecheck. The `Database` type is compatible with `@supabase/supabase-js` generics.
- `packages/db/src/repositories.ts` — RLS-aware repository functions named around domain concepts: `createTransaction`, `findCategoriesByHousehold`, `findSubcategoriesByCategory`, `getMonthlySummary`. Plus pure, unit-tested mappers/query-builders: `transactionInsertFromDraft` (domain `TransactionDraft` -> insert row), `mapTransactionRow`, `monthDateRange`, `summarizeMonth`. The package reuses `@family-finance/domain` contracts (`TransactionDraft`, `MoneyAmount`, `brl`).
- `packages/db/src/index.ts` — `createDatabaseClient` plus re-exports.

Repositories take an already-authenticated client; they never bypass RLS. Pure helpers keep aggregation/mapping logic testable without a database.

## Local Supabase migration runbook

The canonical local workflow uses the Supabase CLI:

```sh
# 1. Install the Supabase CLI (one of):
brew install supabase/tap/supabase        # macOS
#   or: npm i -g supabase  /  see https://supabase.com/docs/guides/cli

# 2. From the repo root, start the local stack (Postgres + Auth + Studio in Docker):
supabase start

# 3. Apply the migration in supabase/migrations and run the seed:
supabase db reset        # drops, re-runs all migrations, then runs supabase/seed.sql

# 4. (optional) Inspect via Studio at the URL printed by `supabase start`.
```

Migrations live in `supabase/migrations/` and run in filename order (`0001_initial_schema.sql` first). The seed is `supabase/seed.sql` and contains no real financial data.

### Local verification status (2026-06-22)

The Supabase CLI is **not installed** in this environment and cannot be installed offline (`npx supabase` is canceled with no network; `brew`/`npm -g` install not run). This is the documented blocker — see `memory/risks-and-blockers.md`. The migration was **not** applied via `supabase db reset`.

To keep the SQL reviewable and proven anyway, the migration + seed were validated against a **throwaway plain-Postgres 16 container** (Docker is available) using a minimal `auth` schema stub (`auth.users`, `auth.uid()` reading a session GUC, mimicking Supabase). Results:

- Migration and seed apply cleanly (no errors).
- A **non-member** (`mallory`) sees 0 households / 0 accounts / 0 transactions and her `insert` into Casa is rejected (`insufficient_privilege`) by RLS.
- A **member** (`alice`) sees the `Casa` household and successfully persists a transaction referencing an account and a category, then reads it back.

When the Supabase CLI is available, re-run `supabase start && supabase db reset` to confirm against the real Auth stack; the schema is expected to apply unchanged because it only depends on `auth.users`/`auth.uid()`, both provided by Supabase.

## Alternatives considered

- **Defer RLS until multi-household is needed:** rejected. This is a private finance app; retrofitting isolation onto existing rows and write paths is expensive and risky. The plan explicitly requires RLS from day one.
- **Per-table bespoke policies instead of a shared helper:** rejected as repetitive and error-prone. The `is_household_member` helper + `DO`-loop keeps the rule defined once and consistent.
- **Inline `EXISTS (select ... from household_members)` in each policy:** workable but causes recursive policy evaluation on `household_members` and duplicates logic. The `SECURITY DEFINER` helper avoids both.
- **Storing money as `numeric(12,2)` reais:** rejected; integer cents matches the domain and avoids float drift.

## Revisit if

- A second household or shared-resource scenario appears (re-check the membership helper and any cross-household reads).
- Real invoice/closing-day timing is needed (installment `due_month` derivation would change).
- Generated Supabase types are adopted — then `packages/db/src/types.ts` is replaced by generated output and must stay column-compatible with this migration.
- The import flow needs temporary encrypted retention of raw files (currently forbidden by the privacy rule).
