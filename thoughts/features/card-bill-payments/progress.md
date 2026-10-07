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

### Open

- **Before shipping:** reviews by Fable 5.1 and Codex (Astra), the full gates,
  then the PR.
- **Merge order with PR #40:** see [tech-debt](../../tech-debt.md).
