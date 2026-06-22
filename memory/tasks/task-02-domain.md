# Task 02: Domain Core

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md`

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** domain agent

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Implement the pure finance core in `packages/domain/src`: money (BRL cents), accounts, categories, transactions, and installment generation.
- Provide the single transaction-draft + installment-plan contracts that both the web app and the Telegram bot create transactions through.
- Domain stays pure: no imports from web, bot, db, or AI. Zod allowed for validation.
- Does NOT cover persistence (Task 3 db), UI, bot, importers, or categorization logic.

## Progress

- [x] `money.ts`: `MoneyAmount` (BRL cents only), `brl()`, arithmetic, and `splitCents` (exact remainder-absorbing split).
- [x] `accounts.ts`: `Account` (checking/investment), `InvestmentBucket` (filhos/casa/independencia_financeira), `CreditCard`.
- [x] `categories.ts`: `Category`, `Subcategory`, `CategoryRef` + zod schemas.
- [x] `transactions.ts`: `TransactionKind` (expense/income/transfer reserved), `TransactionDraft`, `Responsibility`, `PaymentInstrument`, `DomainResult`, `ValidationError`, `createTransactionDraft`.
- [x] `installments.ts`: `InstallmentGroupDraft`, `InstallmentDraft`, `InstallmentPlan`, `createInstallmentPlan` with stable `YYYY-MM` due months.
- [x] Tests written FIRST (TDD) covering all required scenarios; all pass.
- [x] `index.ts` exports only stable contracts.
- [x] Verified no forbidden cross-boundary imports.

## Acceptance Criteria

- [x] Installments support dashboard projections without a full invoice system (each installment carries `dueMonth` as `YYYY-MM`; sum-by-month needs no invoice model).
- [x] Web app and bot can both create transactions through the same contract (`createTransactionDraft` / `createInstallmentPlan`, returning structured results).
- [x] `MoneyAmount` stores BRL cents only.
- [x] Transactions default to household responsibility unless `responsibleUserId` is provided; `createdByUserId` always recorded.
- [x] Domain services return structured validation errors instead of throwing for expected user mistakes.

## QA

```txt
Command: pnpm --filter @family-finance/domain typecheck
Result:  tsc --noEmit -> exit 0 (no output)

Command: pnpm --filter @family-finance/domain test
Result:  vitest run -> 2 files, 14 tests passed (transactions.test.ts 8, installments.test.ts 6). exit 0

Command: grep -rEn "from .@family-finance/(web|bot|db|...)|@anthropic|openai|@supabase|next/|react" packages/domain/src/
Result:  NO_FORBIDDEN_IMPORTS (only zod + relative imports)
```

## Review

### Findings

- `splitCents` makes earlier parcels absorb the remainder cent (e.g. 10000/3 -> [3334,3333,3333]) so installments always sum back to the exact total.
- Due months are attributed by month (`YYYY-MM`), not day, so generation is stable across month lengths (no Jan-31 -> Mar-3 drift) and the dashboard can group by month directly.

### Changes Requested

- None.

### Final Review State

approved (self-verified green)

## Decisions Made During Task

- Transaction payment is modeled as a discriminated `PaymentInstrument` (`account` | `card`) rather than separate optional `accountId`/`creditCardId` fields, so a draft cannot be both at once. (Supersedes the placeholder shape in the original `index.ts`.)
- Responsibility is a discriminated union `{ scope: "household" }` | `{ scope: "user"; userId }` with `HOUSEHOLD_RESPONSIBILITY` as the default. Input still accepts a flat optional `responsibleUserId` for ergonomics.
- `createInstallmentPlan` treats `installmentCount: 1` as à vista (single installment in the purchase month), unifying à vista and parcelado through one helper.
- Installments carry `dueMonth` (`YYYY-MM`) instead of a due date, deliberately deferring any invoice/closing-day modeling to a later phase.
- `createTransactionDraft` does NOT itself generate installments; callers compose `createTransactionDraft` + `createInstallmentPlan` for parcelado card purchases. Keeps each helper single-purpose.

## Follow-Ups

### Tech Debt

- `CreditCard.closingDay`/`dueDay` are defined but unused by installment generation (due-by-month only). When real invoice timing is needed, installment due-month derivation may need to account for the closing day. Revisit at dashboard/cards UI (Task 9/10).

### Ideas

- None.

### Risks Or Blockers

- None.

## Handoff Notes

- Persistence (Task 3 db) should map `TransactionDraft`, `InstallmentGroupDraft`, and `InstallmentDraft` to rows. Note the discriminated `payment` and `responsibility` unions: store as (account_id XOR credit_card_id) and (responsible_user_id nullable, null = household).
- Bot/web (Tasks 4, 7) must call `createTransactionDraft` / `createInstallmentPlan` and render `DomainResult.errors` (field/code/message) on `ok: false`; never re-implement transaction rules.
- For a parcelado card purchase, compose both helpers: build the draft for the card payment context and generate the plan; the group's `totalAmount` equals the purchase total and installments sum back exactly.
- Money is BRL integer cents everywhere. Use `brl(cents)` and `splitCents`; never use floats for money.
