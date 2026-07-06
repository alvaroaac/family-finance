# Bot card installments + card-bill payment (PR-2) — design

**Date:** 2026-07-06 · **Status:** approved by user · **Scope:** apps/bot +
packages/domain + packages/db + one migration (+ dashboard read-side)

Completes the PR-2 half of
[recurring-obligations/design.md](../../../thoughts/features/recurring-obligations/design.md):
the two card intents the unified classifier already recognizes but answers
"em breve" — `card_installment` (parcelado entry) and `mark_paid{card}`
("nubank pago"). Builds on the inline-buttons feature
([2026-07-04 design](2026-07-04-bot-buttons-and-category-creation-design.md)).

## Problem

1. "notebook 3600 em 12x no nubank" is classified `card_installment` but the
   intent carries NO fields (`apps/bot/src/interpret.ts` emits a bare
   `{intent}`), and the conversation answers a terminal "em breve". The full
   persistence stack exists and is unused by the bot: pure
   `createInstallmentPlan` (packages/domain/src/installments.ts, closing-day
   month attribution) + atomic `create_installment_purchase` RPC (migration
   0002), both proven by the web /cards flow.
2. "nubank pago" is classified `mark_paid{card}` and also dies on "em breve".
   The blocker was a schema question the PR-1 design deliberately deferred:
   `transactions` requires exactly one of `account_id`/`credit_card_id`, but a
   bill payment moves money BETWEEN two instruments.

## Decisions (user's picks)

- **Bill payment records BOTH** the cash movement and the settled status: a
  single `kind = 'transfer'` transactions row (account = source, card =
  destination) that doubles as the settled marker. Approach A — no paired
  rows, no side table.
- **Amount:** default = the month's computed invoice
  (`getCardPressureForCard`: parcels due + direct charges); typed override
  allowed ("nubank pago 2.350", `valor` correction) for interest/partial/drift.
- **Why not an expense:** purchases are already expenses at purchase time
  (per-category, parcelas on invoice months); paying the fatura is settling
  recorded debt — an expense row would double-count the month. `transfer` is
  excluded from income/expense summaries (`summarizeMonth` verified).
- **Month settled = current calendar month**, mirroring
  `mark_paid{obligation}`. No month override via bot; corrections in the web.
- **One PR**, stacked on `feat/family-finance-mvp` like PR #6.

## 1. Card installment entry (2a — bot-side only)

**Classifier** (`apps/bot/src/interpret.ts`): `card_installment` gains a
payload:

```
{ intent: "card_installment",
  purchase: {
    description: string,
    totalCents?: number,          // "3600 em 12x" → total
    perInstallmentCents?: number, // "12x de 300" → per parcel
    installmentCount: number,
    purchasedOn?: string,         // ISO; default today
    cardKeyword?: string,         // "no nubank"
    categoryHint?: string } }
```

Amount disambiguation reuses the PR-1 wording rule: "12x de X" / "X 12x" =
per-parcel; "X em 12x" = total. The conversation layer normalizes to a total
(`perInstallmentCents × installmentCount`) because `createInstallmentPlan`
takes `totalAmount`. Exactly one of the two amount fields must be present;
neither → treat like a missing amount (ask "valor?").

**Conversation** (`apps/bot/src/conversation.ts`): new
`InstallmentDraftInProgress` + status `awaiting_installment_confirmation`,
shaped like the obligation flow:

- **Card resolution:** `cardKeyword` matches active card names case- and
  accent-insensitively. No keyword + exactly 1 active card → auto. Ambiguous
  or no match with 2+ cards → card-picker button grid (`cd:<uuid>` tokens,
  one per active card; ≤64-byte rule as before). No active card at all →
  refuse: installment purchases are card-bound; point to the web.
- **Category:** shared `suggestCategory` engine, same context building as
  obligations (hint appended as free text). New-category proposals behave
  exactly as in the 2026-07-04 design (nca / nocat / grid).
- **Missing count:** ask "Em quantas parcelas?" (next numeric text fills it;
  `cancelar` aborts) — a small `awaiting_installment_count`-style prompt is
  NOT a new status; reuse the correction loop: the draft is shown with the
  missing field and a `parcelas N` correction fills it (consistent with how
  missing `valor` works today).
- **Confirmation summary** (never one line per parcel):
  `Compra parcelada: Notebook — R$ 3.600,00 em 12× de R$ 300,00 no Nubank
  (1ª parcela ago/2026)` + category/responsável lines + suggestion line,
  confirm/cancel + categoria buttons, typed corrections:
  `valor 3.700` (total) · `parcelas 10` · `cartão X` · `categoria Y` ·
  `data 12/06` (purchase date).
- **Confirm:** domain `createInstallmentPlan` with the chosen card's
  `closingDay` (same derivation as `apps/web/app/(app)/cards/actions.ts`) →
  new `createInstallmentPurchase(plan)` dep in `buildDeps` → existing atomic
  RPC. Validation failures surface the pt-BR field name (existing pattern).
- Buttons inherit the shipped callback safety net (stale → "Sessão expirada",
  double-tap → "Já salvo ✅", strip-on-act).

**RPC gate fix (required for 2a — found in review):** the bot's service-role
client calls RPCs with `auth.uid()` null, and `create_installment_purchase`'s
body gate (`0002`: `not is_household_member(...)`) rejects null-uid callers —
migration 0012 granted service_role EXECUTE intending bot use, but the body
gate still blocks it. Migration 0015 must ALTER the gate to the 0011 pattern:
`target is null OR (auth.uid() is not null AND not is_household_member(...))`.
Safe post-0012: anon/public EXECUTE is already revoked, so the only null-uid
caller that can reach the body is service_role — exactly the bot. The web
(authenticated) path is unchanged.

No domain or web changes in 2a; db change = the gate fix above.

## 2. Card-bill payment (2b)

**Migration `0015_card_bill_payments.sql`:**

- Add `bill_month text` nullable, check `^[0-9]{4}-(0[1-9]|1[0-2])$` (same
  pattern as `installments.due_month`).
- **Narrowed** instrument check (review finding: plain transfers already
  exist — the caixinha "Aporte" fixture is account-only, and the domain
  reserves `transfer` for caixinha movements):
  - `expense`/`income` → exactly one of `account_id`/`credit_card_id` (as
    today);
  - `transfer` with `bill_month IS NOT NULL` (a bill payment) → BOTH non-null
    (`account_id` = source, `credit_card_id` = destination);
  - `transfer` with `bill_month IS NULL` (caixinha/other) → exactly one, as
    today. Existing rows stay valid; no data migration.
- Unique partial index on `(credit_card_id, bill_month)` where
  `kind = 'transfer' and bill_month is not null` — a repeated "pago" for the
  same card+month is an idempotent no-op (obligations pattern).
- `settle_card_bill` RPC: SECURITY DEFINER with the **0011-pattern gate**
  (`auth.uid() is not null AND not is_household_member(...)` → reject), so
  the bot's null-uid service-role client passes while authenticated non-
  members are rejected; plus the full 0012 hardening in the same migration —
  REVOKE EXECUTE from anon/public, explicit GRANT to authenticated +
  service_role. The RPC also validates `created_by_user_id` is an active
  member of the target household (it cannot be derived from `auth.uid()` on
  the bot path). Takes `{household_id, credit_card_id, account_id,
  bill_month, amount_cents, paid_on, created_by_user_id}`; inserts the
  transfer row (description `Fatura <card> — <mês>/<ano>`), returns the row +
  `already_paid` boolean when the unique index blocks the insert. The RPC
  does NOT compute the amount — the caller does.

**Domain** (`packages/domain`): pure `createCardBillSettlement` draft builder
(amount > 0 cents, valid `YYYY-MM` bill month, both instrument ids non-empty,
description non-empty) mirroring `createTransactionDraft` conventions.

**Repository** (`packages/db`): `settleCardBill(client, draft)` wrapping the
RPC; `getCardPressureForCard` reused for the default amount (unchanged —
transfers don't enter pressure sums, which filter on kind). Settled state is
an explicit new read, not an overload of `CardPressure`:
`findCardBillSettlements(client, householdId, month)` →
`Array<{ creditCardId, amountCents, paidOn }>` (transfer rows with
`bill_month = month`). `TransactionRow` in `types.ts` gains `bill_month:
string | null`. The dashboard maps settlements onto its per-card pressure
line ("paga ✅").

**Bot flow** (replaces `cardBillDeferredMessage`):

1. `mark_paid{card}` keyword matches active card names (case/accent-
   insensitive). 2+ matches → card-picker grid; none → not-found reply
   pointing at card names.
2. Amount = `getCardPressureForCard(currentMonth)`; a trailing number in the
   message ("nubank pago 2350") or a later `valor` correction overrides.
   Computed zero and no override → "Fatura do <card> está zerada este mês —
   nada pra pagar. 👍", nothing written.
3. **Confirmation before writing** (it's money):
   `Fatura Nubank de jul/2026 — R$ 2.350,00. Pagar da conta [Conta]?` with
   confirm/cancel buttons; `conta X` correction switches the source account;
   defaults to household checking. No account in household → refuse with the
   existing no-account message.
4. Confirm → `settleCardBill`; `already_paid` → the friendly no-op reply
   (mirrors obligations). Success:
   `Fatura paga! ✅ Nubank — R$ 2.350,00 (jul/2026)`.

**Readers:** `summarizeMonth` already ignores `transfer` (no double-count —
verified). The transactions page lists the transfer row as-is. Web gets NO
new form; dashboard/pressure read-side only.

## 3. Error handling / edge cases

- Transfer rows are excluded from expense/income everywhere money is summed;
  any reader that filters by `kind` is unaffected by construction. Readers
  that assume "exactly one instrument" must be audited in the plan (e.g.
  `paymentLabel`-style helpers, transactions-page rendering, exports).
- Idempotency: double "nubank pago" in the same month → `already_paid` →
  no-op reply, no second transfer.
- Stale buttons / double-taps: inherited callback safety net.
- The bot never invents amounts: computed default is shown in the
  confirmation and requires an explicit confirm.
- **Web edit guard (review finding):** the transactions page's payment
  select posts a single instrument and `transactionUpdateFromPatch` nulls
  the other column — on a two-instrument bill transfer that would violate
  the new check and surface a raw DB error. `updateTransaction` gains a
  parcela-style guard: payment (and kind) edits are rejected on
  `kind = 'transfer'` rows with a clear pt-BR message; the page hides the
  payment select for them. Amount/date/description edits stay allowed.
- **Delete = undo (intentional):** deleting the bill-payment transfer row in
  the web un-settles that card+month — the idempotency marker goes with it,
  so a later "nubank pago" records a fresh settlement. That is the undo
  path; no extra guard.

## 4. Testing

- **Domain:** `createCardBillSettlement` validation matrix; installment-plan
  reuse needs no new domain tests (covered).
- **Migration/RLS:** extend `deploy/checks/rls-proof.mjs`: household
  isolation on `settle_card_bill`, anon cannot EXECUTE (settle_card_bill AND
  the re-gated create_installment_purchase), service-role null-uid path
  succeeds for both RPCs, idempotent repeat, constraint matrix (expense with
  both instruments rejected; bill transfer with one instrument rejected;
  plain caixinha transfer with one instrument still accepted).
- **Classifier:** extraction across phrasings — "3600 em 12x", "12x de 300",
  card keyword present/absent, count missing; `mark_paid{card}` with and
  without a trailing amount.
- **Conversation:** installment flow (auto-card, grid pick, corrections,
  confirm persists the plan); bill flow (computed amount, override, zero
  invoice, ambiguous card, already-paid repeat); typed/tapped parity.
- **Integration (fake store + telegram + supabase):** charge the card
  (installment via bot) → "nubank pago" → transfer row written with both
  instruments + bill_month, month summary expense total UNCHANGED by the
  payment, settled state visible, repeat is a no-op.
- Full gate: typecheck, tests, lint, build.

## Out of scope

Month override for bill payment ("nubank pago junho"), partial-payment
tracking beyond a single override amount, card-bill reminders, variable
obligations, web forms for bill payment, editing installment groups via bot,
statement reconciliation (Mercado Pago import stays the import path).
