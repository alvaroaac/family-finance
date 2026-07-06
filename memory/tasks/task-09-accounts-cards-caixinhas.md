# Task 09: Accounts / Cards / Caixinhas

**Status:** in-review

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 9)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** agent

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- CRUD for checking + investment accounts (conta corrente / conta investimento).
- CRUD for investment buckets (caixinhas): filhos, casa, independencia_financeira/aposentadoria.
- CRUD for credit cards (name + optional closing/due day).
- Card purchase entry choosing a card, à vista OR parcelado with a parcel count,
  with the generated parcels VISIBLE before saving the purchase.
- Extended `packages/db` with household-scoped CRUD repos + pure insert builders.

Explicitly NOT covered: a generic account-vs-card transaction entry screen
(there is no `/transactions` page yet — the account-vs-card choice for the MVP
lives in the import flow and in this card purchase entry). Caixinha balances are
NOT modeled (the `investment_buckets` table has no balance column; the spec
allows "saldo manual ou posição simples" but the committed schema only carries
name + slug — see Follow-Ups).

## Progress

- [x] DB: TDD pure builders `accountInsert`, `investmentBucketInsert`,
      `creditCardInsert`, `installmentGroupInsertFromPlan`,
      `installmentInsertsFromPlan` (tests first, in `repositories.test.ts`).
- [x] DB: I/O repos list/create/update/delete for accounts, investment buckets,
      credit cards; `createInstallmentPurchase` (group + parcels).
- [x] DB: exported all new symbols from `packages/db/src/index.ts`.
- [x] Web: `/accounts` page + actions (CRUD).
- [x] Web: `/investments` page + actions (caixinha CRUD, slug-unique aware).
- [x] Web: `/cards` page + actions + `purchase-form.tsx` client component
      (CRUD + à vista/parcelado entry with visible parcel preview).
- [x] Nav updated with Cartões + Investimentos.
- [x] Verification green (see QA).

## Acceptance Criteria

- [x] Users can model the MVP financial structure (accounts, buckets, cards)
      without full banking complexity.
- [x] Parcel generation is visible before saving a card purchase
      (`previewCardPurchase` runs the pure domain `createInstallmentPlan` and the
      client renders the parcel table before `saveCardPurchase`).

## QA

```txt
Command: pnpm --filter @family-finance/db test && pnpm typecheck && pnpm --filter @family-finance/web build
Result: EXIT_CODE=0
  - db tests: 15 passed (1 file)
  - typecheck: 12/12 turbo tasks successful
  - web build: compiled; /accounts, /cards, /investments build as dynamic routes
Notes: All pages render with placeholder Supabase config at build time (loadData
  swallows errors -> empty dataset), matching the Task 4/5/6 pattern.
```

## Review

### Findings

- None yet.

### Changes Requested

- None yet.

### Final Review State

not-reviewed

## Decisions Made During Task

- Card purchase entry lives on the `/cards` page (no `/transactions` page exists).
  À vista is stored as one `transactions` row on the card; parcelado is stored as
  an `installment_groups` + `installments` rows via the domain `InstallmentPlan`.
- Parcel preview is computed by a server action (`previewCardPurchase`) that runs
  the PURE domain `createInstallmentPlan` with placeholder household/user ids
  (real ids resolved server-side at save). This keeps financial rules out of the
  React component while still showing the exact parcels that will be saved.
- Caixinhas: the create form only offers slugs not already used, honoring the
  `unique (household_id, slug)` constraint. The 3 MVP slugs are the only options.
- Money input parsing (pt-BR `1.234,56` and dot-decimal) is done in the client
  form to integer cents before calling the domain; the domain stays cents-only.

## Follow-Ups

### Tech Debt

- `createInstallmentPurchase` writes the group then the parcels without a
  transaction (Supabase JS has no client-side tx). If the parcel insert fails the
  group is orphaned. Acceptable for the family MVP; revisit with a Postgres RPC if
  partial writes become a real problem (same note already exists for category
  merge). 
- Caixinha "saldo manual / posição simples" (spec) is not implemented: the
  committed `investment_buckets` table has no balance column. Buckets are
  name+slug only. Adding a balance needs a new migration (out of scope for Task 9,
  which must not touch the committed schema). Logged as an idea/debt.

### Ideas

- A dedicated `/transactions` entry screen that lets the user pick account OR card
  for an arbitrary expense/income (the domain + db already support this via
  `createTransactionDraft` + `createTransaction`).
- Bucket balance / simple position tracking once a balance column exists.

### Risks Or Blockers

- Web write paths (CRUD + card purchase persistence) were NOT exercised against a
  real Supabase project (no secrets/network here), same standing risk as Tasks
  4-6. Pure domain + pure db builders ARE unit-tested; build is green.

## Handoff Notes

- New db exports for the dashboard (Task 10): `listCreditCards`,
  `listInvestmentBuckets`, `listAccounts`, and the installment tables now carry
  parcelado data (`due_month`) for card-pressure-by-month queries.
- The cards client form parses reais->cents; if a `/transactions` page is added,
  reuse that parser or move it into a shared helper.
