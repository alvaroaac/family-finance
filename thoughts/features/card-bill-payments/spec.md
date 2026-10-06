# Card bill payments (pagar fatura) — spec

**Date:** 2026-10-06 · **Status:** approved design, spec under review · **Branch:** `feat/card-bill-payments`

## Problem

Paying a credit-card fatura can only be registered from the Telegram bot. On
the web there is no action for it, so the only way is to hand-create a
transaction — which either double counts spending (expense on the account) or
is impossible (a bill payment needs both instruments). The bot also allows only
one payment per card+month, so a partial payment followed by the rest cannot be
recorded.

## Goal

From `/cards`, register one or more payments against a card's fatura for any
month, see whether that fatura is aberta / parcial / paga, and undo a payment
registered by mistake. The bot follows the same multi-payment rules. A payment
is never counted as spending.

## Non-goals

- Hiding bill-payment rows from `/transactions` (they stay, shown neutral as today).
- Quick-pay on `/resumo` (Resumo only shows the status badge).
- Matching imported bank-statement "Pagamento de fatura" lines to payments.
- Changing how the projected fatura is computed (`getCardPressureForCard` stays as is).
- Account running balances (none exist for regular accounts).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | A payment stays ONE `transactions` row: `kind='transfer'`, `account_id` = source, `credit_card_id` = destination, `bill_month` = fatura month. | Reuses 0015's model; transfers are already excluded from spending and card pressure. |
| D2 | Many payments per card+month are allowed. | User decision: partial now, rest later. |
| D3 | Status is computed from the sum, never stored. | No flag to drift out of sync when purchases change the projection. |
| D4 | Duplicate protection is an idempotency key per submission (0019 pattern), not a per-month unique index. | Double-click / Telegram retry must never create a second row once multiples are legal. |
| D5 | Undo = delete the payment row. | Simplest reversible action; RLS already scopes deletes to the household. |
| D6 | Month is a page-level selector on `/cards` (`?fatura=YYYY-MM`), any past or future month. | One server render, one month for all cards; no per-card client state. |
| D7 | The old 7-arg `settle_card_bill` is dropped in the same migration. | Avoids a silently callable legacy overload (see 2026-07-25 tech-debt entry about 0017). |

## Status rules (contractual)

Inputs: `projectedCents` (= `getCardPressureForCard(card, month).totalCents`) and
the amounts of every payment row for that card + `bill_month`.

- `paidCents` = sum of payments
- `remainingCents` = max(0, projected − paid)
- `overpaidCents` = max(0, paid − projected)
- `status`:
  - `open` when `paidCents = 0`
  - `paid` when `paidCents > 0` and `paidCents ≥ projectedCents`
  - `partial` otherwise (`0 < paidCents < projectedCents`)

A new purchase after a fatura was paid can grow `projectedCents` and flip the
status back to `partial`. That is intended.

## Data model — migration `0029_card_bill_partial_payments.sql`

Numbered 0029 because `0028_import_evidence_and_memory.sql` is in flight on
another branch. Every statement re-runnable, like 0015.

1. Drop index `transactions_card_bill_month_uniq`.
2. `alter table transactions add column if not exists idempotency_key text;`
   plus `create unique index if not exists transactions_idempotency_key_uniq on
   transactions (household_id, idempotency_key) where idempotency_key is not null;`
3. Drop `settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)`.
4. Create `settle_card_bill(target_household_id uuid, target_credit_card_id uuid,
   target_account_id uuid, target_bill_month text, target_amount_cents bigint,
   target_paid_on date, target_created_by_user_id uuid, target_idempotency_key text)
   returns jsonb` → `{ "transaction": <row>, "replayed": boolean }`.
   - Validation as 0015 (month format, amount > 0, card in household,
     created_by active member) plus: idempotency key non-empty (22023);
     `target_paid_on` not after `current_date` (22023).
   - Gate: 0019 pattern — `auth.role() = 'service_role'` bypasses membership;
     everyone else must be `is_household_member`. Non-member and missing card
     raise the same "not found" error.
   - Insert with `on conflict (household_id, idempotency_key) do nothing`. On
     conflict, load the existing row: if card, account, bill_month,
     amount_cents and occurred_on all match → return it with `replayed = true`;
     otherwise raise `22023` "idempotency key reused with a different payment".
   - Description unchanged: `'Fatura <card> — MM/YYYY'`.
5. Revoke/grant exactly as 0015 (public/anon revoked; authenticated + service_role execute).
6. `scripts/verify-all-migrations.sh` covers 0029 (applies cleanly twice).

## Domain — `packages/domain`

- `createCardBillSettlement` schema gains `idempotencyKey: z.string().min(1)`.
- New pure `summarizeCardBill({ projectedCents, paymentCents: number[] })` →
  `{ projectedCents, paidCents, remainingCents, overpaidCents, status }` per the
  rules above. Exported from the package index.

## DB package — `packages/db`

- `settleCardBill` sends `target_idempotency_key`; `SettleCardBillResult` becomes
  `{ transaction, replayed }` (`already_paid` removed). Generated RPC types updated.
- `findCardBillSettlements` (used by Resumo) also returns `id` and `accountId`;
  callers aggregate per card.
- New `findCardBillPayments(client, householdId, month)` → payments for every
  card in that month: `{ id, creditCardId, accountId, amountCents, paidOn }`,
  ordered by `paidOn`, then creation. (May simply be the extended
  `findCardBillSettlements`; one function, not two.)
- New `deleteCardBillPayment(client, householdId, transactionId)`: deletes only
  where `household_id`, `id`, `kind='transfer'` and `bill_month is not null`
  match. Zero rows matched → throws "Pagamento não encontrado." (covers
  non-bill rows and other households).

## Web — `/cards`

Server page loads, for the selected month: cards, accounts, payments, and each
card's projection, then `summarizeCardBill` per card.

- **Month selector** at the top of a new "Faturas" section: `<input type="month">`
  in a GET form → `?fatura=YYYY-MM`. Default = current São Paulo month
  (`currentMonth()`). Invalid param → fallback to current month.
- **Per card block** "Fatura MM/YYYY":
  - Projected, paid, remaining amounts.
  - Badge copy (contractual):
    - open, projected > 0 → `aberta`
    - open, projected = 0 → `nada a pagar`
    - partial → `parcial · falta R$ X`
    - paid, no overpay → `paga ✅`
    - paid with overpay → `paga ✅ · R$ X a mais`
  - Payments list: `DD/MM/YYYY · <conta> · R$ X` + `Desfazer` button (server
    action form; pending label `Desfazendo…`).
  - **Pagar fatura** form (client component `bill-payment-form.tsx`, `useActionState`):
    - `Valor` prefilled with remaining in pt-BR format (empty when remaining = 0), required.
    - `Data do pagamento` `type="date"`, default today, `max` = today.
    - `Conta` select of household accounts, required, no default when > 1 account; preselected when exactly 1.
    - hidden `billMonth`, `creditCardId`, `idempotencyKey` (server `randomUUID()` per render; a successful save revalidates the page so the next render gets a new key).
    - Submit `Registrar pagamento` / pending `Registrando…`.
    - Success → inline `Pagamento registrado.`; error → inline alert, nothing written.
  - Household with zero accounts → form replaced with `Cadastre uma conta para registrar pagamentos.` + link to `/accounts`.
- Server actions in `cards/actions.ts`:
  - `payCardBillAction(prev, formData)` → `{ ok, message }`. Parses BRL amount with
    the existing parser used by the transaction form; validates via
    `createCardBillSettlement`; future date and invalid amount rejected before the
    RPC with pt-BR messages; revalidates `/cards`, `/resumo`, `/dashboard`, `/transactions`.
  - `undoCardBillPaymentAction(formData)` → `deleteCardBillPayment`, same revalidation.

Error copy (contractual):

| Case | Message |
|---|---|
| amount missing / ≤ 0 / unparsable | `Informe um valor maior que zero.` |
| no account chosen | `Escolha a conta de onde saiu o pagamento.` |
| paid-on in the future | `A data do pagamento não pode ser no futuro.` |
| invalid month | `Mês da fatura inválido.` |
| RPC/other failure | `Não foi possível registrar o pagamento.` |

## Web — `/resumo`

`settled: boolean` becomes `billStatus: 'open' | 'partial' | 'paid'` (via
`summarizeCardBill`). Badge: `paga ✅` for paid, `parcial` for partial, nothing
for open.

## Bot

- `getCardBillAmount` returns the **remaining** amount (projected − paid, floor 0)
  plus `paidCents` so the reply can mention it.
- Remaining > 0 → current flow, prefilled with remaining.
- Remaining = 0 and paid > 0 → reply that the fatura is already paid (with paid
  total) and ask for the amount of an additional payment; draft keeps
  `amountCents` undefined so the existing "valor X" correction path fills it,
  then `confirmar` as usual.
- `CardBillDraftInProgress` gains `idempotencyKey` (`randomUUID()` at draft
  creation); confirm passes it; `replayed: true` → same success message (no
  "already paid" no-op anymore). `cardBillAlreadyPaidMessage` is replaced by the
  new "already paid, quer registrar outro?" message.

## Edge cases → required tests

| # | Case | Expected | Layer |
|---|---|---|---|
| E1 | Pay full projected | `paid`, badge `paga ✅` | domain, web e2e |
| E2 | Pay less than projected | `partial`, badge shows remaining, form prefilled with remaining | domain, web e2e |
| E3 | Second payment completes it | `paid` | domain, web e2e |
| E4 | Overpay | `paid`, `R$ X a mais` | domain, integration |
| E5 | Projected 0, no payment | `open`, `nada a pagar`, amount empty | domain, integration |
| E6 | Projected 0, payment > 0 | `paid` | domain |
| E7 | Future month | allowed, saved with that `bill_month` | integration, e2e |
| E8 | Past month | allowed | integration |
| E9 | Amount 0 / negative / garbage | error copy, no row | action unit, e2e |
| E10 | Paid-on in the future | error copy, no row (action AND RPC reject) | action unit, migration |
| E11 | No account chosen | error copy | action unit |
| E12 | Household without accounts | form disabled + link | integration |
| E13 | Same idempotency key submitted twice | one row, second call `replayed` | migration, e2e (double click) |
| E14 | Same key, different payload | RPC error | migration |
| E15 | Undo | row deleted, status recomputed | repo, e2e |
| E16 | Undo of a non-bill transaction id / other household | throws, nothing deleted | repo, migration (RLS) |
| E17 | Purchase added after paid | flips to `partial` | integration |
| E18 | Payments never counted as spending | Resumo totals and card pressure unchanged by a payment | integration |
| E19 | Card or account from another household | RPC rejects | migration |
| E20 | Paid in October for September's fatura | counts toward September (`bill_month`), `occurred_on` = October date | integration |
| E21 | Bot: partially paid month | prefilled with remaining | bot |
| E22 | Bot: fully paid month | "já está paga" + asks amount, saves extra payment on confirm | bot |
| E23 | Bot: confirm replayed (same key) | success message, one row | bot |
| E24 | Invalid `?fatura=` param | falls back to current month | integration |

## Verification and evidence

- `pnpm typecheck`, `pnpm test`, `pnpm test:migrations`, web + bot builds green.
- Playwright spec `apps/web/e2e/card-bill-payments.spec.ts` runs against **local
  Supabase** (`127.0.0.1:54321`, all migrations applied) and a local dev server
  pointed at it. Google OAuth can't be scripted, so a setup step seeds a local
  test user (allowlisted via `AUTHORIZED_EMAILS` for the run), household, account
  and card through the local service role, signs in with password against the
  **local** auth server, and writes the `@supabase/ssr` session cookie into a
  Playwright storage state. No production project or real credentials are touched.
- Scenario covered in the browser: E1/E2/E3 path (partial → complete), E7, E9,
  E13 (double click), E15 (undo), Resumo badge.
- **Evidence folder:** `thoughts/features/card-bill-payments/e2e-evidence/` —
  step screenshots, Playwright HTML report, trace zip, and the run log.

## Done when

PR open against `main` with the above green and the evidence folder committed.
