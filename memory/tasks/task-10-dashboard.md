# Task 10: Monthly Dashboard Prototype

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md`

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (section 08 · Dashboard)

**Owner:** agent (web)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- A deliberately SIMPLE monthly dashboard (no charts/projections — post-MVP).
- Server-component dashboard page guarded by `requireAuthorizedUser()`, rendering
  summary cards (receitas, despesas, saldo estimado, cartões, caixinhas, pendentes),
  recent transactions, pending-review list, and upcoming installments.
- A `queries.ts` data layer building on `@family-finance/db` repositories.
- Pure aggregation/mapping helpers in `packages/db` with unit tests.
- Does NOT cover: writing/correcting transactions from the dashboard (read-only),
  caixinha balances (schema has no balance column — buckets listed by name/slug only),
  charts/projections/comparative analytics.

## Progress

- [x] Pure db helpers + tests: `currentMonth`, `summarizeCardPressure`,
  `mapUpcomingInstallment`, `mapDashboardTransaction`, `needsReview`.
- [x] RLS-scoped db reads: `getCardPressure`, `findUpcomingInstallments`,
  `findRecentTransactions`, `findPendingReviewTransactions` (reuse `getMonthlySummary`,
  `monthDateRange`, `listInvestmentBuckets`).
- [x] `dashboard/queries.ts` assembles the month dataset; degrades to a zeroed/empty
  state on any failure (no household / unreachable DB / placeholder secrets).
- [x] Presentational components: `summary-card.tsx`, `recent-transactions.tsx`,
  `pending-review-list.tsx` (pt-BR labels, BRL cents formatted).
- [x] `dashboard/page.tsx` server component, guarded, `dynamic = "force-dynamic"`.
- [x] Verification green.

## Acceptance Criteria

- [x] Dashboard answers how much entered (Receitas do mês).
- [x] How much is left (Saldo estimado = entradas − saídas).
- [x] Card pressure (Cartões = compras diretas no mês + parcelas com due_month = mês;
  plus "Próximas parcelas" panel).
- [x] Caixinhas (count + names of the household's investment buckets).
- [x] What needs review (count + "Precisa de revisão" list of uncategorized rows).

## QA

```txt
Command: pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build
Result: GREEN.
  - typecheck: 12/12 tasks successful.
  - test: all suites pass — db 21 tests (incl. 6 new Task-10 specs), web 7, bot 27,
    domain 14, categorization 22, importers 11, config 4.
  - web build: compiled successfully; /dashboard listed as ƒ (Dynamic, server-rendered),
    builds with placeholder secrets (no real env).
Notes: No live network in tests; new helpers are pure and unit-tested. Build is
  placeholder-safe (force-dynamic page, queries.ts catches load failures).
```

## Review

### Final Review State

not-reviewed

## Decisions Made During Task

- "Pending review" in the MVP = transaction with no macro category (`category_id IS NULL`,
  excluding `transfer`). There is no status column in the schema; this is the natural
  signal for imports/quick bot entries that land uncategorized. Encoded in the pure
  `needsReview` helper and the `findPendingReviewTransactions` query.
- "Card pressure" = current-month card-paid expense transactions (direct) + installment
  parcels attributed to the month (`installments.due_month = month`). Card refunds
  (income on a card) are intentionally excluded from direct pressure. Pure
  `summarizeCardPressure`.
- Caixinhas show count + names only. The `investment_buckets` schema carries no balance
  (per Task 9 decision), so the dashboard reflects "posição simples" by listing them; a
  real balance is deferred (see Follow-Ups).
- `formatBrlCents` lives in `queries.ts` and is passed into the presentational components
  so money formatting is consistent and components stay logic-free.

## Follow-Ups

### Tech Debt

- Dashboard does not link list items to a correction/review screen; "Precisa de revisão"
  is informational only. A generic `/transactions` review screen is still absent (also
  noted in Task 9). Revisit in Task 11 / when a review UI exists.

### Ideas

- None new (charts/projections remain explicitly post-MVP).

### Risks Or Blockers

- Inherits the open risk "Web auth wiring not exercised against real Supabase": the
  dashboard reads were typechecked and unit-tested at the pure-helper level but the
  RLS-scoped reads were NOT run against a live Supabase (no secrets/network here). When
  Supabase is reachable, confirm the six dashboard reads return household-scoped data and
  that the zero state shows only when truly empty.

## Handoff Notes

- New db exports (Task 10): `currentMonth`, `summarizeCardPressure`,
  `mapUpcomingInstallment`, `mapDashboardTransaction`, `needsReview`, `getCardPressure`,
  `findUpcomingInstallments`, `findRecentTransactions`, `findPendingReviewTransactions`,
  and types `CardPressure`, `UpcomingInstallment`, `DashboardTransaction`.
- Task 11 (end-to-end review loop) should assert dashboard totals reconcile with seeded
  imports + a bot-created transaction + a parcelado purchase, using `loadDashboardData`.
