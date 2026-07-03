# Recurring obligations + projections — design

**Status:** design approved, awaiting spec review
**Branch base:** `feat/family-finance-v1` (PR #2)
**Date:** 2026-07-03

## Problem

The bot cannot record fixed monthly obligations. A message like
`Parcela solar 710,44 72x a partir de 05/10` is a **financing** (paid by
boleto/débito, behaves like a mortgage or a fixed bill), but today:

- The deterministic parser ([apps/bot/src/parser.ts](../../../apps/bot/src/parser.ts))
  extracts amount/date/card-or-account only — no installment or term concept.
- The LLM interpreter ([apps/bot/src/interpret.ts](../../../apps/bot/src/interpret.ts))
  emits `amountCents`, `description`, `occurredOn`, `categoryHint`,
  `responsibleHint` — no field for a term or a monthly recurrence.

So the solar example silently becomes a **single R$710,44 expense** — the `72x`
and the recurrence are dropped. The model understands the phrase on any tier;
the gap is that there is nowhere in the schema to put it.

There is also **no recurring/financing/fixed-obligation concept anywhere in the
codebase.** The only installment concept is card-bound: migration
`0002_create_installment_purchase.sql` + `createInstallmentPlan`
([packages/domain/src/installments.ts](../../../packages/domain/src/installments.ts)),
which requires a `creditCardId` and projects onto card invoices — the wrong
model for a boleto financing.

## Goals

- Model recurring fixed obligations (financings, mortgage, bills) as a
  first-class concept, independent of credit cards.
- Show them as **projections** (no rows materialized up front); materialize a
  real transaction only when a month is **marked paid**.
- Let the bot create an obligation from free text, disambiguating it from a
  card parcela and from a plain expense with a **single shared intent
  classifier**.
- Keep the projection engine generic so future projection features (scheduled
  income, recurring charges) can reuse it.

## Non-goals (this design)

- Full projection-timeline UI (multi-month forward view). PR-1 ships only the
  current-month view + the obligation list with remaining term. The timeline is
  the "projections as a feature in itself" follow-up.
- Marking a month paid **from the bot**. PR-1 does mark-paid in the dashboard
  only.
- Editing/paying **card** installments from the bot beyond what PR-2 adds.

## Core model (the keystone decision)

An **obligation is a template**, not a set of rows:

- One `obligation` row is the source of truth: monthly amount, start month,
  term (fixed count or indefinite), due day, category, responsibility, payment
  source.
- The dashboard **projects** which months the obligation hits — computed, no
  materialized rows. Handles fixed-term (solar 72×) and indefinite (bills)
  uniformly, and avoids writing 360 rows for a mortgage.
- **Marking a month paid materializes** a real `transactions` row for that month
  (kind=expense, from the payment account), linked back to the obligation. That
  month then shows the actual and the projection is suppressed — no
  double-count.

## PR plan

Two PRs, both stacked on PR #2. The bot NLU is **one shared intent classifier**
(`plain` | `card_installment` | `obligation`) that lands whole in PR-1 — it
cannot detect obligations reliably without also recognizing card parcelas (to
avoid mis-filing them).

### PR-1 — Obligations + unified interpreter

**Domain — new pure module `packages/domain/src/obligations.ts`**

`Obligation` template fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` / `householdId` | string | |
| `description` | string | |
| `amountCents` | int | monthly amount, BRL cents, > 0 |
| `startMonth` | `YYYY-MM` | first month due |
| `termMonths` | `number \| null` | fixed term (72) or `null` = indefinite |
| `dueDay` | int 1–28 | clamped, consistent with `closingDay` in installments |
| `category` | `CategoryRef?` | optional; PENDING if uninferred |
| `responsibility` | household \| user | mirrors transactions |
| `accountId` | string | payment source (needed to materialize) |
| `status` | active \| ended \| canceled | `ended` derivable from term |
| `createdByUserId` | string | |

Derived `endMonth = addMonths(startMonth, termMonths - 1)` (null if indefinite).

**Projection engine (reusable)**

Pure `projectObligations(obligations, { fromMonth, toMonth })` →
`ProjectedEntry[]`, using the same DST-free `YYYY-MM` month math as `addMonths`
in installments.ts. DB-unaware: the caller passes the set of already-paid
`(obligationId, month)` pairs and the projector subtracts them. Kept generic so
future projection features reuse the month-range core; the obligation-specific
mapping stays thin.

**Schema — new migration `0011_create_obligations.sql`**

- `create table obligations (...)` mirroring existing conventions: `household_id`
  FK + RLS by household, `category_id`/`subcategory_id` FKs, `responsibility_scope`
  + `responsible_user_id`, `account_id`, `amount_cents bigint check (> 0)`,
  `start_month`, `term_months` nullable, `due_day` int check 1–28, `status`,
  `created_by_user_id`, timestamps. RLS policies mirror migrations 0009/0010.
- Extend `transactions`: nullable `obligation_id uuid references obligations(id)
  on delete set null` + `obligation_month date` (first of the satisfied month).
  Mirrors the existing `installment_id` nullable-FK precedent.
- **Unique partial index** on `(obligation_id, obligation_month)` where
  `obligation_id is not null` — enforces no double-pay.

**Persistence — `packages/db/src/repositories.ts`**

- `createObligation(draft)` — insert.
- `listObligations(householdId)` — active obligations.
- `materializeObligationPayment({ obligationId, month })` — atomic RPC (mirroring
  `0002_create_installment_purchase.sql`) inserting one `transactions` row
  (kind=expense, `occurred_on = month + dueDay`, `account_id`, category,
  responsibility, `obligation_id`, `obligation_month`); idempotent per
  `(obligation_id, month)` via the unique index.
- Dashboard loader gains an `obligationsCents` line (this month's projected-unpaid
  + actual), folded into the existing reducer pattern
  ([repositories.ts](../../../packages/db/src/repositories.ts) ~188–221).

**Web — `apps/web/app/(app)/`**

- New "Financiamentos / Obrigações fixas" surface: list obligations (monthly,
  remaining term, next due, category); create/edit/cancel form + server actions
  mirroring [cards/actions.ts](../../../apps/web/app/(app)/cards/actions.ts).
- Current-month view: each projected obligation has a **"marcar como pago"**
  button → `materializeObligationPayment` → becomes an actual, suppressing the
  projection.
- Resumo shows the month's fixed-obligation total next to card pressure.

**Bot — `apps/bot/src/`**

- Interpreter becomes a **single intent classifier**: `plain` |
  `card_installment` | `obligation`, emitting the right structured fields per
  intent. For obligations it emits `{ monthlyAmountCents, termMonths|null,
  startMonth, dueDay, category hint, responsible hint }`, disambiguating
  per-month vs total by wording ("72x de X" / "X 72x" = per-month; "X em 72x" =
  total → divide).
- Confirmation is a **summary, not 72 lines**:
  `Financiamento: Solar — R$710,44/mês × 72 (out/2026 → set/2032). Pago via:
  [conta]. Confirmar?` → on confirm, `createObligation`. Payment source defaults
  to household checking, editable. No card resolution (not card-bound).
- `card_installment` intent is **recognized but not yet persisted** in PR-1 — the
  bot replies honestly: `Compra parcelada no cartão ainda não dá pra registrar
  por aqui — em breve. Por ora, cadastre em Cartões no painel.`

### PR-2 — Card-installment persistence

- Route the already-classified `card_installment` intent →
  `createInstallmentPlan` + card resolution ("Qual cartão?" when the household
  has 2+ cards; auto when exactly one, reusing the existing `resolveCardId`
  hook) + summary confirmation. Replaces the "em breve" reply. No re-parsing —
  the interpreter already produced the intent in PR-1.

## Anti-double-count

The dashboard projects a month for an obligation **only if** no `transactions`
row exists with that `(obligation_id, obligation_month)`. Materialization is
idempotent via the unique partial index, so a repeated "marcar como pago" is a
no-op rather than a second charge.

## Testing

- **Domain:** `projectObligations` boundary tests — term end, indefinite, month
  math across year boundaries (reuse the `addMonths` approach); per-month vs
  total amount resolution.
- **Repo/RLS:** household isolation; idempotent materialization (no double-pay);
  correct `obligation_id`/`obligation_month` linkage.
- **Bot:** interpreter classification tests for the three intents, including the
  solar phrasing variants; obligation confirmation copy; `card_installment`
  "em breve" reply; `createObligation` wiring (mocked client).
- **Web:** server-action tests for create + mark-paid; anti-double-count
  (projection suppressed once a month is paid).

## Defaults (chosen; flag to change)

- `dueDay` clamped 1–28 (consistent with `closingDay`).
- Payment source defaults to the household checking account.
- Category optional; uninferred obligations land PENDING, like today's flow.

## Out of scope / future

- Projection-timeline UI (the reusable engine is built for it; the UI is later).
- Bot mark-paid.
- Variable-amount obligations (e.g. bills that change monthly) — MVP is a fixed
  monthly amount.
