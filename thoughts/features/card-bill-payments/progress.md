# Card-bill payments — progress log

## 2026-10-06 — Spec → plan → implementation → local e2e

Branch `feat/card-bill-payments`. The [spec](spec.md) is rev 2 + D12 and is
approved; the [plan](plan.md) has tasks T1–T8.

### Done

- **T1 migration** `202610070000_card_bill_closing_and_payments.sql`:
  - `card_bill_closures` override table;
  - `transactions.invoice_month` set by the `transactions_set_invoice_month`
    trigger;
  - `transactions.idempotency_key`;
  - 8-arg `settle_card_bill`.

  It has SQL functional tests (`pnpm test:card-bill-migration`).

- **T2 domain:** pure rules for closed/open, totals, status, badge copy, the
  pending/open pair and `planWithOpenFaturas`.
- **T3 db:** `getCardFaturaPairs` and `getCardBillOverview` read models, plus
  the closure and payment writes.
- **T4 web actions:**
  - pay, undo, close, reopen and correct the total;
  - card purchases skip closed faturas and report `shiftedFrom`.
- **T5 UI:**
  - "Faturas de agora" section on `/cards`, with a `?fatura=` month picker;
  - payment and close forms, undo, toasts;
  - pending + open pair on `/resumo`.
- **T6 bot:**
  - defaults to the pending fatura;
  - asks before an extra payment on a paid fatura;
  - replays are idempotent;
  - installments skip closed faturas.
- **T7 local e2e:**
  - `scripts/e2e-local-stack.sh` and `pnpm --filter @family-finance/web test:e2e:local`;
  - evidence in [e2e-evidence/](e2e-evidence/README.md), 12 steps, all green.
- **T8 docs:** two tech-debt entries (import attribution; PR #40
  reconciliation) and runbook §5b.

### Decisions made during implementation

- **Timestamped migrations:** new migrations use `YYYYMMDDHHMM_name.sql`.
  `deploy/migrate.sh` accepts both formats.
- **Bot, paid fatura:** the bot always asks "já está paga … pagamento extra?",
  even when the message carries an amount. This is safer than silently
  overpaying.
- **Separate e2e stack:** the local e2e uses its own Supabase project on ports
  564xx. Port 54622 was stuck on OrbStack, and this keeps the dev stacks
  untouched.
- **Fixed date in a legacy test:** `manual-transaction-action.test.ts` now pins
  the date. With the real clock the July fatura is closed, so the save shifted.

### Tried that didn't work

- **Supabase API right after `db reset`:** it briefly serves a stale schema
  cache ("Could not find the table 'public.households'"). The stack script now
  polls the REST API until the tables are visible.
- **Waiting on toasts in Playwright:** an earlier toast can still be on screen,
  so the wait passes too soon. The spec waits for the saved figures instead.

### Review (Fable 5.1 + Codex Astra) — fixed

- **Bot card-bill retry:** a failed settle now keeps the draft and its
  idempotency key, pins `paidOn`, and asks to confirm again. Before, a retry
  got a new key and could record a partial payment twice.
- **Bot installment retry:** the first open fatura is resolved once and
  stored in the draft (`firstOpenMonth`), so a retry sends the same schedule
  even if a fatura closed in between. Corrections clear it.
- **`card_bill_is_closed`:** raises 42501 for an authenticated non-member.
  service_role and migration contexts pass.
- **24-month limit:** the TS search checks offsets 0–24, matching the SQL
  trigger.
- **`setCardBillTotal`:** stores no override when it equals the live total,
  same as closing.
- **Undo error copy:** "Não foi possível desfazer o pagamento."
- **Attribution trigger:** fires only on updates of `occurred_on`,
  `credit_card_id`, `kind` or `invoice_month`. `invoice_month` stays in the
  list so a client cannot overwrite the stored month.

### Review — not changed

- **Bot, paid fatura with an amount:** still asks. The spec (B2) asks first on
  purpose.
- **Minor nits:** naming and comment suggestions with no behavior impact.

### Open

- **Merge order with PR #40:** see [tech-debt](../../tech-debt.md).
