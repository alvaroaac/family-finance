# Manual transaction entry + payment/amount editing — design

**Date:** 2026-07-03 · **Status:** approved by user · **Scope:** apps/web + packages/db

## Problem

The web app has no way to manually add a transaction (expense OR income) — creation
only happens via CSV/PDF import and the card-purchase flow. And the /transactions
inline edit deliberately blocks amount and payment, so converting an account expense
into a card expense (a common correction) is impossible without delete+recreate —
which the UI also blocks for anything the user wants to keep.

## Decisions (user's picks)

- Entry points: button on the dashboard **and** on /transactions (same form).
- Form scope: **expense + income**, account or card payment, à vista only.
  Parcelado stays in the existing /cards flow. No transfers.
- Edit scope: **payment (account↔card) and amount** become editable.
  `kind` editing stays OUT (rare, sign-derivation risk; delete+recreate covers it).
- UI shape: **inline collapsible panel** on /transactions (existing app pattern —
  /cards, /imports). No new modal primitive.

## 1. Manual entry form

**Where:** `apps/web/app/(app)/transactions` — a collapsible "Novo lançamento"
panel above the filters. The dashboard `PageTitle` gains a "+ Lançamento" action
linking to `/transactions?novo=1`, which renders the page with the panel open.

**Fields:**

| Field | Widget | Rules |
|---|---|---|
| Tipo | expense / income toggle (PillToggle) | default expense |
| Valor | text input, pt-BR ("56,13") | parsed to integer cents; > 0 |
| Descrição | text input | required, trimmed |
| Data | date input | default today |
| Categoria / Subcategoria | cascading selects | optional; subcategory filtered by category |
| Pagamento | single select listing accounts ("Conta: X") and cards ("Cartão: Y") | income allows **accounts only** (card options hidden/disabled when Tipo=entrada) |
| Responsável | select: Casa or an active member | default: the logged-in member |

**Server action:** new `createManualTransaction` in
`apps/web/app/(app)/transactions/actions.ts`. Builds the draft via
`createTransactionDraft` (the shared domain choke point web + bot both use) and
persists via the existing `createTransaction` repo. The action ALSO enforces the
income-needs-account rule server-side (income + card payment → pt-BR error), not
just in the UI. Domain validation errors map to pt-BR field messages (same style
as the bot's `describeValidationError`).
On success: reveal the new row (revalidate the page), collapse the panel, toast.

## 2. Payment + amount editing

**Repo:** `TransactionPatch` (packages/db `repositories.ts`) gains:

```ts
amountCents?: number;                       // integer > 0
payment?: { type: "account"; accountId: string }
        | { type: "card"; creditCardId: string };
```

`transactionUpdateFromPatch` maps `payment` to BOTH columns in one UPDATE
(`account_id = X, credit_card_id = null` or the inverse) — atomic, so the DB
CHECK (exactly one of account/card) can never be violated mid-edit.

**Guard:** if the target row has `installment_id IS NOT NULL`, an amount or
payment patch throws a pt-BR error ("Parcelas são gerenciadas pelo grupo do
parcelamento — edite o parcelamento, não a parcela."), mirroring the existing
parcela delete guard. Description/category/responsável edits on parcelas stay
allowed (unchanged).

**UI:** the existing inline edit row gains a Valor input (pt-BR parsing, same
as the entry form) and a Pagamento select (same options list as the entry form,
account/card). Account→card conversion = open edit, pick "Cartão: X", save.
Income rows only offer accounts in the payment select (consistency with entry).

## 3. Data flow / loading

/transactions already loads accounts, cards, categories, subcategories, and
members — the entry form and the payment select reuse those props; no new
queries. The dashboard needs NO new data (its button is just a link).

## 4. Error handling

- Amount parse failure / non-positive → field-level pt-BR message, form stays open.
- Domain validation failure → mapped pt-BR message next to the offending field.
- Repo/DB failure → toast with a generic pt-BR failure + the row/form unchanged.
- Parcela guard → pt-BR error surfaced as a toast on the edit row.

## 5. Testing (TDD)

- **packages/db:** patch mapping for amount + payment (both directions), parcela
  guard rejects amount/payment but allows description, empty-patch no-op intact.
- **apps/web unit:** pt-BR amount parsing (reuse/extract the existing parser used
  by cards/investments if shareable), action validation-error mapping.
- **integration (fake supabase):** create expense via action → row persisted with
  the right columns; create income (account only); edit account→card → columns
  swapped atomically; parcela edit rejected.
- Full gate: typecheck, all tests, web build, lint.

## Out of scope

Transfers, parcelado in the manual form, `kind` editing, editing installment
amounts/payment, a modal/dialog primitive.
