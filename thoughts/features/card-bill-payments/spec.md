# Card bill payments and closing (pagar e fechar fatura) — spec

**Date:** 2026-10-06 · **Status:** spec under review (rev 2, after plan-review) · **Branch:** `feat/card-bill-payments`

## Problem

Paying a credit-card fatura can only be registered from the Telegram bot. On
the web there is no action for it, so the only way is to hand-create a
transaction — which either double counts spending (expense on the account) or
is impossible (a bill payment needs both instruments). The bot also allows only
one payment per card+month, so a partial payment followed by the rest cannot be
recorded.

There is also no notion of a fatura being **closed**: every card charge counts
toward the calendar month it happened in, so a fatura's total can keep changing
forever and a paid fatura can silently become unpaid again.

## Goal

From `/cards`, for any month and card:

- see whether the fatura is open or closed, how much it is, how much was paid;
- close it in one click (optionally correcting the total to the bank's number),
  or reopen it;
- register one or more payments, and undo a payment registered by mistake.

Once a fatura is closed its contents are frozen: new card charges go to the
next open fatura. Payments are never counted as spending. The bot follows the
same payment rules.

## Non-goals

- Hiding bill-payment rows from `/transactions` (they stay, shown neutral as today).
- Quick-pay or close on `/resumo` (Resumo only shows the status badge).
- Matching imported bank-statement "Pagamento de fatura" lines to payments.
- Attributing **imported** card rows by the statement's reference month (see
  "Imports" below; logged as tech debt).
- A "force paga" flag. A closed fatura is paga only when payments reach its total;
  the total itself is what the user corrects.
- Account running balances (none exist for regular accounts).

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | A payment stays ONE `transactions` row: `kind='transfer'`, `account_id` = source, `credit_card_id` = destination, `bill_month` = fatura month.                                                                                                                                                    | Reuses 0015's model; transfers are already excluded from spending and card totals.                                                                                                   |
| D2  | Many payments per card+month are allowed.                                                                                                                                                                                                                                                         | User decision: partial now, rest later.                                                                                                                                              |
| D3  | Payment status is computed from sums, never stored.                                                                                                                                                                                                                                               | Nothing to drift out of sync.                                                                                                                                                        |
| D4  | Duplicate protection is an idempotency key per submission (0019 pattern).                                                                                                                                                                                                                         | Double-click / Telegram retry must never create a second row once multiples are legal.                                                                                               |
| D5  | Undo a payment = delete its row.                                                                                                                                                                                                                                                                  | Simplest reversible action; RLS already scopes deletes.                                                                                                                              |
| D6  | Month is a page-level selector on `/cards` (`?fatura=YYYY-MM`), any past or future month.                                                                                                                                                                                                         | One server render, one month for all cards.                                                                                                                                          |
| D7  | The old 7-arg `settle_card_bill` is dropped in the same migration.                                                                                                                                                                                                                                | No silently callable legacy overload (2026-07-25 tech-debt lesson).                                                                                                                  |
| D8  | Every card charge stores which fatura it belongs to (`transactions.invoice_month`), set by a DB trigger at write time.                                                                                                                                                                            | "Frozen" needs attribution decided when the charge is written, not recomputed at read time; a trigger covers every write path (web, bot, imports, edits).                            |
| D9  | A fatura is closed automatically once the São Paulo date is past the card's closing day in that month, or manually via "Fechar fatura". A per-card+month override row can close early or reopen (manual or auto).                                                                                 | Matches how cards work; one override row explains every non-default state.                                                                                                           |
| D10 | A closed fatura's total = corrected total if the user set one, else the live sum of charges attributed to it.                                                                                                                                                                                     | User decision: correct the total instead of forcing "paga". Freezing comes from attribution (D8), so no snapshot is needed.                                                          |
| D11 | Imported rows are authoritative: never bumped to another fatura.                                                                                                                                                                                                                                  | User decision: the bank statement _is_ that fatura.                                                                                                                                  |
| D12 | **Spending ≠ fatura.** Spending numbers (Resumo headline conta/cartão, dashboard, categories) stay by purchase date (`occurred_on`; parcelas by `due_month`, as today). Fatura numbers (fatura blocks, status, pay amount, bot) use `invoice_month`. A fatura is named by the month it closes in. | User decision (option A). Closing/reopening never moves spending between months; Resumo and dashboard keep matching; early closing days (e.g. day 1) don't lag the headline a month. |

## Fatura rules (contractual)

### Closed or open

For card `c` with `closing_day` and fatura month `M` (`YYYY-MM`):

- `closingDate(M)` = day `min(closing_day, last day of M)` of `M`.
- `autoClosed` = `closing_day is not null` and `today_SP > closingDate(M)`.
  A charge **on** the closing day still belongs to `M` (same as `createInstallmentPlan`).
  Cards without `closing_day` never auto-close.
- `override` = the `card_bill_closures` row for `(c, M)`, if any: `'closed'` or `'open'`.
- `closed` = `override = 'closed'` → true; `override = 'open'` → false; no row → `autoClosed`.

`today_SP` = `(now() at time zone 'America/Sao_Paulo')::date` in SQL, the same
São Paulo date in TypeScript (`currentMonth`-style helper).

### Which fatura a charge belongs to (`invoice_month`)

Applies to `transactions` rows with `credit_card_id is not null` and
`kind <> 'transfer'`. Every other row has `invoice_month = null`.

- **Insert, manual (`import_batch_id is null`):** start at the calendar month of
  `occurred_on`; while that fatura is `closed`, move to the next month
  (max 24 steps, then raise). Result stored in `invoice_month`.
- **Insert, imported (`import_batch_id is not null`):** `invoice_month` =
  calendar month of `occurred_on`; never bumped (D11). This is exactly today's
  attribution for imports.
- **Update:** recompute with the insert rule only when `occurred_on`,
  `credit_card_id` or `kind` changes. Amount/category/description edits leave
  `invoice_month` alone, even when the fatura is closed (corrections are allowed).
- **Backfill:** existing card rows get the calendar month of `occurred_on`, so
  no historical total changes.

Effect: with auto-close, a purchase on day 29 of a card closing on day 28
lands in next month's fatura — the real-card behaviour, achieved without a
separate rule. Worked example (closes day 28, due ~day 5):

| Purchase | Fatura | Closes | Paid   | Counts as spending in |
| -------- | ------ | ------ | ------ | --------------------- |
| 29/09    | 10     | 28/10  | ~05/11 | September             |
| 20/10    | 10     | 28/10  | ~05/11 | October               |
| 30/10    | 11     | 28/11  | ~05/12 | October               |

A card closing on day 1: purchases 02/10–01/11 form fatura 11 (closes 01/11);
they still count as October/November spending by their own dates.

**Parcelados** (`installments.due_month` already is the fatura month):
the manual web/bot path shifts the **whole plan** forward by N months, where N
is the smallest shift that puts parcel 1 in a fatura that is not closed. The
shift happens in `packages/db` `planWithOpenFaturas` (shared by web and bot)
_before_ calling the unchanged `create_installment_purchase` RPC. The bot
resolves the first open month once (`firstOpenMonth`), persists it with the
draft and pins it, so a retry sends the same schedule and the idempotent replay
payload stays identical. Import RPCs are not shifted (D11).
The `/cards` parcel preview uses the same helper, so preview = what is saved.

### Totals and status

- `chargesCents(c, M)` = card expenses with `invoice_month = M` + installments
  with `due_month = M` (new fatura query; the spending queries are untouched, D12).
- `totalCents` = `closed && override.total_override_cents is not null`
  ? that override : `chargesCents`.
- `paidCents` = sum of payment rows (`kind='transfer'`, `bill_month = M`, card `c`).
- `remainingCents` = max(0, total − paid); `overpaidCents` = max(0, paid − total).

Status and badge copy (contractual, same text on `/cards` and `/resumo`):

| closed | condition                 | status           | badge                                        |
| ------ | ------------------------- | ---------------- | -------------------------------------------- |
| no     | paid = 0                  | `open`           | `aberta`                                     |
| no     | 0 < paid < total          | `open_partial`   | `aberta · R$ X pago`                         |
| no     | paid > 0 and paid ≥ total | `open_covered`   | `aberta · paga até agora`                    |
| yes    | total = 0 and paid = 0    | `nothing_due`    | `nada a pagar`                               |
| yes    | paid = 0, total > 0       | `closed_unpaid`  | `fechada · a pagar R$ X`                     |
| yes    | 0 < paid < total          | `closed_partial` | `fechada · parcial, falta R$ X`              |
| yes    | paid > 0 and paid ≥ total | `paid`           | `paga ✅` (+ ` · R$ X a mais` when overpaid) |

An open fatura with total 0 and nothing paid is `open` / `aberta`.

### Fatura pair (what "now" shows, per card)

Right after a fatura closes, two faturas matter at once: the closed one still
being paid and the open one collecting new purchases. Per card, relative to
`today_SP`:

- `openMonth` = `firstOpenInvoiceMonth(month(today_SP))` — the fatura new
  purchases go to today.
- `pendingMonth` = `openMonth − 1` **only if** that fatura is closed and its
  status is `closed_unpaid` or `closed_partial`; otherwise none.
- Only one month back is surfaced. Older closed faturas are not, because
  history has no payment rows from before this feature and would all look unpaid.

Used by the Resumo card blocks, the default `/cards` view and the bot's default month.

## Data model — migration `202610070000_card_bill_closing_and_payments.sql`

Named with a short UTC timestamp (`deploy/migrate.sh` accepts timestamps and
legacy 4-digit versions). The later multi-tenant migrations are
`202610080001`–`202610080004`; `202610080003` replaces the 8-argument payment
function with the active-member JWT gate. Both fresh and upgrade paths end on
that definition. Applied migrations remain unchanged; definitions are replayed
in chronological order.

**Payments**

1. Drop index `transactions_card_bill_month_uniq`.
2. `transactions.idempotency_key text` + unique index
   `(household_id, idempotency_key) where idempotency_key is not null`.
3. Drop `settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)`; create the
   8-arg version (`…, target_idempotency_key text`) returning
   `{ "transaction": <row>, "replayed": boolean }`:
   - validation as 0015 plus: key non-empty; `target_paid_on <= today_SP`; account in household;
   - final gate after multi-tenant integration: authenticated active member JWT, with the caller recorded as creator; service-role, outsiders and inactive members are denied. Membership and household/key locks protect replay and definitive validation classification.
   - `on conflict (household_id, idempotency_key) do nothing`; on conflict, same card/account/month/amount/date → return existing with `replayed = true`, else raise 22023 "idempotency key reused with a different payment";
   - paying is allowed whether the fatura is open or closed.

**Closing** 4. Table `card_bill_closures`: `id`, `household_id`, `credit_card_id`,
`bill_month text` (YYYY-MM check), `state text check in ('closed','open')`,
`total_override_cents bigint null check (>= 0)`, `updated_by_user_id`,
`created_at`, `updated_at`. Unique `(credit_card_id, bill_month)`. Composite
household FKs as in 0013. `total_override_cents` must be null when
`state = 'open'`. RLS: household members select/insert/update/delete (same
policy shape as the other household tables). Card delete is blocked by FK
restrict as for transactions. 5. SQL function `card_bill_is_closed(card_id uuid, month text) returns boolean`
implementing the rule above (stable, SECURITY DEFINER so the attribution
trigger can read closures). Membership gate: an authenticated/anon caller
who is not a member of the card's household gets 42501; service_role and
migration contexts pass; an unknown card returns false. 6. **Attribution:** `transactions.invoice_month text` (YYYY-MM check) + check
`invoice_month is null` unless `credit_card_id is not null and kind <> 'transfer'`;
BEFORE INSERT/UPDATE trigger implementing the rule above; backfill existing
card rows; index `(household_id, credit_card_id, invoice_month)`. 7. `create_installment_purchase` is **not** modified (shift lives in `packages/db`, see Parcelados). 8. Grants: as 0015/0019 for the RPCs; table grants like the other household tables. 9. New `scripts/verify-card-bill-migration.sh` (+ `pnpm test:card-bill-migration`,
wired into CI) applies all migrations, re-applies the migration, and runs
`packages/db/test/card-bill-functional.sql` assertions.

## Domain — `packages/domain`

Pure, unit-tested, no I/O:

- `createCardBillSettlement` schema gains `idempotencyKey: z.string().min(1)`.
- `isCardBillClosed({ closingDay, month, todaySp, override })` → boolean (rule above).
- `summarizeCardBill({ closed, chargesCents, totalOverrideCents, paymentCents[] })`
  → `{ closed, totalCents, paidCents, remainingCents, overpaidCents, status }`.
- `cardBillBadge(summary)` → badge string (table above), formatted pt-BR.
- `firstOpenInvoiceMonth(startMonth, isClosed: (m) => boolean)` → month, max 24
  steps; used by `planWithOpenFaturas` to shift a plan (preview and save).
- `cardFaturaPair({ openMonth, previous })` → `{ pending | null, open }` applying
  the pair rule (pure: caller passes the previous month's summary).

## DB package — `packages/db`

- Spending queries unchanged (D12): `getMonthlySummary`, `getCardPressure`
  and the Resumo conta/cartão split keep filtering by `occurred_on`.
  `getCardPressureForCard` is no longer used by Resumo (replaced by fatura totals).
- New `getCardBillCharges(client, householdId, cardId, month)` →
  `chargesCents` by `invoice_month` + installments `due_month`.
- `settleCardBill` sends the key; result `{ transaction, replayed }`.
- `findCardBillPayments(client, householdId, month)` →
  `{ id, creditCardId, accountId, amountCents, paidOn }[]` (replaces
  `findCardBillSettlements`; Resumo aggregates per card).
- `deleteCardBillPayment(client, householdId, transactionId)` deletes only a row
  with that household, id, `kind='transfer'` and `bill_month is not null`; zero
  rows → throws `Pagamento não encontrado.`
- `findCardBillClosures(client, householdId, month)`;
  `closeCardBill(client, { householdId, creditCardId, month, totalOverrideCents | null, userId })`
  (upsert `state='closed'`); `reopenCardBill(…)` (upsert `state='open'`, override null);
  `setCardBillTotal(…)` (update override on a closed fatura; null = back to live sum).
- `getCardBillOverview(client, householdId, month, todaySp)` → per card:
  closing info + `summarizeCardBill` result + payments, for one month.
- `getCardFaturaPairs(client, householdId, todaySp)` → per card
  `{ card, pending: overview | null, open: overview }` (pair rule). Both are the
  single source for `/cards`, `/resumo` and the bot so the three never disagree.

## Web — `/cards`

New "Faturas" section above the cards grid.

- **Default view (no `?fatura=`):** per card, the fatura pair — the pending
  closed fatura block (when any) above the open fatura block, each with its own
  actions below. Heading `Faturas de agora`.
- **Month selector:** GET form with `<input type="month" name="fatura">` +
  link `Voltar para agora`. With `?fatura=YYYY-MM`, one block per card for that
  month. Invalid param → default view.
- **Fatura block** "Fatura MM/YYYY":
  - Line: `fecha DD/MM` (or `sem dia de fechamento`) and the badge.
  - Total, pago, falta. When a corrected total is active: `total ajustado (soma dos lançamentos: R$ X)`.
  - Payments list: `DD/MM/YYYY · <conta> · R$ X` + `Desfazer` (pending `Desfazendo…`).
  - **Open fatura** → button `Fechar fatura`, which reveals a small form
    `Total da fatura` prefilled with the live sum + `Confirmar fechamento`.
    Submitting the unchanged value stores no override; a different value stores it.
  - **Closed fatura** → `Reabrir` button and `Ajustar total` (same total form;
    clearing the field returns to the live sum).
  - **Pagar fatura** form (client component `bill-payment-form.tsx`, `useActionState`), available open or closed:
    - `Valor` prefilled with remaining (empty when 0), required;
    - `Data do pagamento` `type="date"`, default today, `max` = today;
    - `Conta` select, required; preselected when exactly one account;
    - hidden `billMonth`, `creditCardId`, `idempotencyKey` (server `randomUUID()` per render);
    - submit `Registrar pagamento` / pending `Registrando…`; success `Pagamento registrado.`
  - Zero accounts → payment form replaced by `Cadastre uma conta para registrar pagamentos.` + link to `/accounts`.
- **Parcel preview** (`purchase-form.tsx`) shows shifted months when the first
  fatura is closed, with the note `Fatura de MM/YYYY já fechada — começa em MM/YYYY.`
- Server actions (`cards/actions.ts`): `payCardBillAction`,
  `undoCardBillPaymentAction`, `closeCardBillAction`, `reopenCardBillAction`,
  `setCardBillTotalAction`. All revalidate `/cards`, `/resumo`, `/dashboard`, `/transactions`.

Error copy (contractual):

| Case                                  | Message                                       |
| ------------------------------------- | --------------------------------------------- |
| amount missing / ≤ 0 / unparsable     | `Informe um valor maior que zero.`            |
| no account chosen                     | `Escolha a conta de onde saiu o pagamento.`   |
| paid-on in the future                 | `A data do pagamento não pode ser no futuro.` |
| invalid month                         | `Mês da fatura inválido.`                     |
| corrected total negative / unparsable | `Informe um total válido (zero ou mais).`     |
| payment RPC/other failure             | `Não foi possível registrar o pagamento.`     |
| close/reopen/adjust failure           | `Não foi possível atualizar a fatura.`        |

## Web — `/resumo`

"Faturas dos cartões" uses `getCardFaturaPairs` (replaces `settled: boolean`).
Per card (contractual layout):

- **Pending closed fatura exists** → main block = pending: `Fatura MM · fechada`,
  its total (corrected when set) as the big number, its badge
  (`fechada · a pagar R$ X` / `fechada · parcial, falta R$ X`). Divider, then a
  small row `Próxima MM · aberta` + open fatura's running total.
- **No pending** → single block = open fatura: `Fatura MM · aberta` (or
  `fechada` / `paga ✅` if the current month was closed and settled — then the
  open one is next month and shows as the main block), its total, its badge.

Top spending numbers (gasto do mês, conta, cartão) are unchanged: by purchase
date, parcelas by due month (D12). Only the per-card fatura blocks use
`invoice_month`, so their totals can differ from the cartão spending number.

## Bot

- Default month when the user doesn't name one = the card's `pendingMonth` if
  any, else `openMonth` (paying in early October settles September's closed fatura).
  An explicit month in the message still wins.
- `getCardBillAmount` → `{ remainingCents, paidCents, closed }` from `getCardBillOverview`.
- Remaining > 0 → current flow, prefilled with remaining.
- Remaining = 0 and paid > 0 → reply that the fatura is already paid (paid total)
  and ask for the amount of an additional payment; draft keeps `amountCents`
  undefined so the existing "valor X" path fills it, then `confirmar`.
- `CardBillDraftInProgress` gains `idempotencyKey` (`randomUUID()` at draft
  creation); `replayed: true` → same success message. `cardBillAlreadyPaidMessage`
  is replaced by the new message.
- Bot card purchases: the trigger attributes à vista charges; installment
  plans are shifted by `planWithOpenFaturas` with the draft's pinned
  `firstOpenMonth`.

## Imports

Unchanged code. Imported card rows keep today's attribution (calendar month of
the purchase date) and are never bumped. Tech-debt entry to add: attribute
imported fatura rows by the statement's `referenceMonth` (needs the import RPCs
to carry it). Worst for early closing days: with closing day 1, nearly every
imported purchase lands one fatura early. Spending numbers are unaffected (D12).

## Edge cases → required tests

Layers: **D** domain unit · **M** migration SQL assertions · **R** db repo/fake-store integration · **A** server action unit · **B** bot · **E** Playwright e2e.

**Payments**

| #   | Case                                                  | Expected                                                                         | Layer |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| E1  | Closed fatura, pay full total                         | `paid`, `paga ✅`                                                                | D, E  |
| E2  | Closed fatura, pay less                               | `closed_partial`, `fechada · parcial, falta R$ X`; form prefilled with remaining | D, E  |
| E3  | Second payment completes it                           | `paid`                                                                           | D, E  |
| E4  | Overpay                                               | `paid`, `· R$ X a mais`                                                          | D, R  |
| E5  | Future month payment                                  | allowed, stored with that `bill_month`                                           | R, E  |
| E6  | Past month payment                                    | allowed                                                                          | R     |
| E7  | Amount 0 / negative / garbage                         | error copy, no row                                                               | A, E  |
| E8  | Paid-on in the future                                 | error copy, no row; RPC also rejects                                             | A, M  |
| E9  | No account chosen                                     | error copy                                                                       | A     |
| E10 | Household without accounts                            | form replaced by hint + link                                                     | R     |
| E11 | Same idempotency key twice (double click)             | one row, second `replayed`                                                       | M, E  |
| E12 | Same key, different payload                           | RPC error                                                                        | M     |
| E13 | Undo payment                                          | row deleted, status recomputed                                                   | R, E  |
| E14 | Undo non-bill transaction / other household's payment | throws, nothing deleted                                                          | R, M  |
| E15 | Card or account from another household                | RPC rejects                                                                      | M     |
| E16 | Paid in October for September's fatura                | counts toward September; `occurred_on` = October date                            | R     |
| E17 | Payments never counted as spending                    | Resumo totals and card totals unchanged by a payment                             | R     |

**Open vs closed, attribution**

| #   | Case                                                              | Expected                                                                                                  | Layer   |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| C1  | Card closes day 28, purchase on day 28                            | stays in that month                                                                                       | D, M    |
| C2  | Purchase on day 29, today past closing                            | `invoice_month` = next month                                                                              | M       |
| C3  | Closing day 31 in a 30-day month (and Feb)                        | closes on the last day                                                                                    | D, M    |
| C4  | Card without closing day                                          | never auto-closes; only manual                                                                            | D, M    |
| C5  | Today = closing day                                               | still open                                                                                                | D       |
| C6  | Manual close before closing day                                   | closed; new purchase dated in that month → next month                                                     | M, E    |
| C7  | Reopen a manually closed fatura                                   | open; new purchases land in it again                                                                      | M, R    |
| C8  | Reopen an auto-closed fatura                                      | `override='open'` beats auto; backdated purchase lands in it                                              | M       |
| C9  | Two consecutive closed faturas                                    | new purchase skips both, lands in first open                                                              | D, M    |
| C10 | Backdated manual purchase (date in a closed month, entered later) | goes to first open fatura                                                                                 | M       |
| C11 | Imported row dated in a closed month                              | keeps calendar month (authoritative), closed total grows unless overridden                                | M, R    |
| C12 | Edit amount of a charge in a closed fatura                        | stays put; closed total follows unless overridden                                                         | M, R    |
| C13 | Edit date/card of a charge                                        | re-attributed with the insert rule                                                                        | M       |
| C14 | Delete a charge in a closed fatura                                | total drops (unless overridden); paid may become overpaid                                                 | R       |
| C15 | Parcelado whose first parcel would land in a closed fatura        | whole plan shifts; preview shows the shift + note; import path not shifted                                | D, R, E |
| C16 | Parcelado idempotent replay (same payload)                        | returns originally stored parcels                                                                         | R       |
| C17 | Closing with the unchanged total                                  | no override stored                                                                                        | R       |
| C18 | Closing with a corrected total                                    | override used for status; `total ajustado` hint shown                                                     | R, E    |
| C19 | Clear corrected total                                             | back to live sum                                                                                          | R       |
| C20 | Reopen clears corrected total                                     | override null                                                                                             | M       |
| C21 | Corrected total 0, nothing paid                                   | `nada a pagar`                                                                                            | D       |
| C22 | Corrected total negative / garbage                                | error copy                                                                                                | A       |
| C23 | Open fatura fully covered early                                   | `aberta · paga até agora`; becomes `paga ✅` once closed if total unchanged                               | D, R    |
| C24 | Open fatura covered, then a new purchase arrives before closing   | `aberta · R$ X pago`                                                                                      | D, R    |
| C25 | Closed fatura paid, then a new purchase                           | purchase goes to next fatura; closed one stays `paga ✅`                                                  | M, E    |
| C26 | Closed unpaid (`fechada · a pagar R$ X`) then partial then full   | badge walks closed_unpaid → closed_partial → paid                                                         | D, E    |
| C27 | Backfill                                                          | every existing card row gets calendar-month `invoice_month`; card totals per month identical before/after | M       |
| C28 | Card purchase 30/10 on a card closing day 28                      | October spending (Resumo + dashboard) includes it; fatura 11 block includes it, fatura 10 does not        | R       |
| C29 | `card_bill_closures` RLS                                          | non-member cannot read/write; member can                                                                  | M       |
| C30 | Invalid `?fatura=`                                                | falls back to default (pair) view                                                                         | R       |

**Fatura pair (Resumo + `/cards` default)**

| #   | Case                                                             | Expected                                                                                                                     | Layer   |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1  | Previous fatura closed + partial, new purchases after close      | two rows: main `Fatura 09 · fechada` with `fechada · parcial, falta R$ X`; `Próxima 10 · aberta` with only the new purchases | D, R, E |
| P2  | Previous fatura closed + unpaid                                  | main row `fechada · a pagar R$ X` + próxima row                                                                              | D, R    |
| P3  | Pending fatura gets fully paid                                   | collapses to single open block                                                                                               | D, R, E |
| P4  | Previous fatura closed with total 0 (`nada a pagar`) or overpaid | no pending row                                                                                                               | D       |
| P5  | Current month closed manually early                              | pending = current month, open = next month                                                                                   | D, M    |
| P6  | Card without closing day, nothing closed                         | single open block, current month                                                                                             | D       |
| P7  | Two months back closed and unpaid                                | not surfaced; only one month back                                                                                            | D       |
| P8  | Closing, reopening or correcting a fatura                        | Resumo headline + dashboard spending identical before/after; only fatura blocks change                                       | R       |
| P10 | Card closing day 1                                               | purchase 15/10 → fatura 11, counts as October spending                                                                       | D, M, R |
| P9  | `/cards` default view                                            | pending + open blocks per card, each with its own pay/close/reopen actions; `?fatura=` shows one month                       | R, E    |

**Bot**

| #   | Case                                                             | Expected                                                            | Layer |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------- | ----- |
| B1  | Partially paid month                                             | prefilled with remaining                                            | B     |
| B2  | Fully paid month                                                 | "já está paga" + asks amount; extra payment saved on confirm        | B     |
| B3  | Confirm replayed (same key)                                      | success message, one row                                            | B     |
| B4  | Card purchase via bot after manual close                         | lands in next fatura (trigger)                                      | M     |
| B5  | "paguei a fatura" without month while previous fatura is pending | defaults to the pending month; with none pending, to the open month | B     |

## Verification and evidence

- `pnpm typecheck`, `pnpm test`, `pnpm test:migrations`, web + bot builds green.
- Playwright spec `apps/web/e2e/card-bill-payments.spec.ts` runs against **local
  Supabase** (`127.0.0.1:54321`, all migrations applied) and a local dev server
  pointed at it. Google OAuth can't be scripted, so a setup step seeds a local
  test user (allowlisted via `AUTHORIZED_EMAILS` for the run), household, account
  and card through the local service role, signs in with password against the
  **local** auth server, and writes the `@supabase/ssr` session cookie into a
  Playwright storage state. No production project or real credentials are touched.
- Browser scenario: purchase → open fatura → manual close with corrected total
  (C6, C18) → purchase after close lands next month (C25) → partial payment →
  completing payment (E2, E3, C26) → double click (E11) → undo (E13) → invalid
  amount (E7) → future-month payment (E5) → parcelado preview shift (C15) →
  Resumo pair view (pending + próxima, then collapsed after full payment, P1/P3).
- **Evidence folder:** `thoughts/features/card-bill-payments/e2e-evidence/` —
  step screenshots, Playwright HTML report, trace zip, run log.

## Done when

PR open against `main` with the above green and the evidence folder committed.
