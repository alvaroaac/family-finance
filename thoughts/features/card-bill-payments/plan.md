# Card bill payments and closing — Implementation Plan

**Goal:** Let the household close, reopen and pay credit-card faturas from `/cards` (and see them on `/resumo` and in the bot), with closed faturas frozen and partial payments supported.

**Architecture:** One migration adds a per-card+month closure override table, a stored `transactions.invoice_month` set by a trigger (freeze by attribution), an idempotency key on transactions and an 8-arg `settle_card_bill`. Pure domain functions decide closed/status/badge/pair; one db read model (`getCardFaturaPairs` / `getCardBillOverview`) feeds web and bot so they never disagree. Rejected: snapshotting closed totals (needs a second source of truth) and shifting parcelados inside the RPC (breaks idempotent replay and collides with open PR #40).

**Tech Stack:** Postgres/Supabase SQL, TypeScript, Next.js App Router server actions, Vitest, Playwright. No new dependencies.

**Spec:** `thoughts/features/card-bill-payments/spec.md` (rev 2 + D12). Edge-case IDs (E*, C*, P*, B*) below refer to its tables.

## Global Constraints

- TDD: each task's **Behavior** bullets are its test list — write failing tests from them first, then implement. Commit per task.
- Worktree: `/Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance/.claude/worktrees/card-bill-payments`, branch `feat/card-bill-payments`. Never touch the main checkout.
- Migration file: `supabase/migrations/0033_card_bill_closing_and_payments.sql`. Every statement re-runnable (`if not exists`, `drop … if exists`, `create or replace`, guarded `do $$` blocks as in 0015/0016).
- Security gate for RPCs = the 0019 pattern on main (`coalesce(auth.role(), '') <> 'service_role'` → must be `is_household_member`). Do not adopt PR #40's gate.
- `create_installment_purchase` and the import RPCs are **not** modified.
- Spending queries (`getMonthlySummary`, `getCardPressure`, Resumo conta/cartão split) are **not** modified (spec D12).
- São Paulo date everywhere: SQL `(now() at time zone 'America/Sao_Paulo')::date`; TS `currentHouseholdDate()` / `currentHouseholdMonth()` from `packages/domain/src/calendar.ts`.
- User-facing copy is pt-BR and exactly as in the spec tables (badges, error messages, button labels).
- Money is integer cents (`bigint` / `number`), formatted with the existing `brl` / `formatBrlCents` helpers.
- Match surrounding style; no dead code; no new deps.
- Done per task = its Verify commands green plus `pnpm typecheck` green.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/0033_card_bill_closing_and_payments.sql` | schema, trigger, `card_bill_is_closed`, 8-arg `settle_card_bill` | 1 |
| `packages/db/test/card-bill-functional.sql` | executable SQL assertions for 0033 | 1 |
| `scripts/verify-card-bill-migration.sh`, root `package.json`, `.github/workflows/ci.yml` | run them in CI | 1 |
| `packages/db/src/card-bill-migration.test.ts` | static guard on 0033 text (0019-test style) | 1 |
| `packages/domain/src/card-bills.ts` (+ `.test.ts`), `index.ts` export | pure fatura rules | 2 |
| `packages/domain/src/transactions.ts` | settlement schema gets `idempotencyKey` | 2 |
| `packages/db/src/types.ts` | `invoice_month`, `idempotency_key`, `card_bill_closures`, RPC arg/return types | 3 |
| `packages/db/src/repositories.ts` (+ tests), `index.ts` | payments, closures, overview, pairs, installment shift | 3 |
| `apps/web/integration/fake-supabase.ts` | support new table/columns used by integration tests | 3 |
| `apps/web/app/(app)/cards/actions.ts` | 5 new server actions, preview/save shift | 4 |
| `apps/web/integration/card-bill-actions.test.ts` | action tests | 4 |
| `apps/web/app/(app)/cards/page.tsx`, new `faturas-section.tsx`, `bill-payment-form.tsx`, `bill-close-form.tsx`, `purchase-form.tsx` | /cards UI | 5 |
| `apps/web/app/(app)/resumo/page.tsx`, `queries.ts`, `integration/resumo.test.ts` | Resumo pair blocks | 5 |
| `apps/bot/src/conversation.ts`, `replies.ts`, `index.ts`, `conversation-card-bill.test.ts` | bot rules | 6 |
| `apps/web/e2e/card-bill-payments.spec.ts`, `apps/web/e2e/local-auth.setup.ts`, `apps/web/playwright.config.ts`, `scripts/e2e-local-seed.ts` (or `.sql`) | local e2e | 7 |
| `thoughts/features/card-bill-payments/e2e-evidence/**` | evidence | 7 |
| `thoughts/tech-debt.md`, `thoughts/features/card-bill-payments/progress.md`, `docs/runbooks/local-mvp-verification.md` | docs | 8 |

---

### Task 1: Migration 0033 + SQL verification

**Files:**
- Create: `supabase/migrations/0033_card_bill_closing_and_payments.sql`, `packages/db/test/card-bill-functional.sql`, `scripts/verify-card-bill-migration.sh`, `packages/db/src/card-bill-migration.test.ts`
- Modify: root `package.json` (script `test:card-bill-migration`), `.github/workflows/ci.yml` (step after `test:migrations`)

**Interfaces:**
- Produces (SQL):
  - table `card_bill_closures(id uuid pk default gen_random_uuid(), household_id uuid not null, credit_card_id uuid not null, bill_month text not null check (bill_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), state text not null check (state in ('closed','open')), total_override_cents bigint null check (total_override_cents >= 0), updated_by_user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (credit_card_id, bill_month), check (state = 'closed' or total_override_cents is null))` + composite household FK to `credit_cards` (0013 style, `on delete restrict`) + RLS select/insert/update/delete for `is_household_member(household_id)` + grants like other household tables.
  - `card_bill_is_closed(target_credit_card_id uuid, target_month text) returns boolean` — stable, security invoker.
  - `transactions.invoice_month text null` (format check) + check: `invoice_month is null or (credit_card_id is not null and kind <> 'transfer')`; index `(household_id, credit_card_id, invoice_month)`.
  - `transactions.idempotency_key text null` + unique index `(household_id, idempotency_key) where idempotency_key is not null`.
  - `settle_card_bill(target_household_id uuid, target_credit_card_id uuid, target_account_id uuid, target_bill_month text, target_amount_cents bigint, target_paid_on date, target_created_by_user_id uuid, target_idempotency_key text) returns jsonb` → `{"transaction": <row>, "replayed": bool}`; old 7-arg overload dropped; grants as 0015 (revoke public/anon, grant authenticated, service_role).

**Behavior:**
- Applying all migrations then 0033 a second time succeeds (re-runnable).
- Backfill: every pre-existing card row with `kind <> 'transfer'` gets `invoice_month = to_char(occurred_on,'YYYY-MM')`; all other rows null; per-card per-month sums by `invoice_month` equal the old sums by `occurred_on` (C27).
- `card_bill_is_closed`: override `'closed'` → true; override `'open'` → false; no row → `closing_day is not null and today_SP > make_date(y, m, least(closing_day, last_day_of_m))`; today = closing date → false (C1, C3 for 30-day month and Feb, C4, C5 via a fixed date — tests freeze "today" by choosing months relative to the real SP date, e.g. a month 3 months in the past is always auto-closed when closing_day is set, current month with closing_day = 28 depends on date, so use past/future months only).
- Trigger (BEFORE INSERT OR UPDATE OF occurred_on, credit_card_id, kind, invoice_month): card expense, `import_batch_id is null` → start at month(occurred_on), advance while `card_bill_is_closed`, raise after 24 steps (C2, C6, C9, C10, B4); `import_batch_id is not null` → month(occurred_on), never bumped (C11); non-card or transfer → null; UPDATE that changes none of occurred_on/credit_card_id/kind keeps the stored value even if its fatura is closed (C12); changing occurred_on or credit_card_id recomputes (C13). A client-supplied `invoice_month` on insert is ignored (always computed).
- Reopen (`state='open'`) makes a backdated purchase land in that month again (C7, C8).
- Dropping `transactions_card_bill_month_uniq` allows two payments for the same card+month (E3).
- `settle_card_bill`: same key + same payload → returns the original row with `replayed=true`, one row total (E11); same key + different amount/account/month/date → raises SQLSTATE 22023 with message containing `idempotency key reused with a different payment` (E12); `paid_on > today_SP` → raises 22023 (E8); null/empty key → raises 22023; card or account from another household / non-member → same `not found` error as 0015 (E15); works for open and closed faturas; inserted row has `kind='transfer'`, `bill_month`, `occurred_on = paid_on`, `invoice_month` null (E16).
- RLS on `card_bill_closures`: member can CRUD own household rows; non-member sees none and cannot insert (C29). Test as `authenticated` with `auth.uid()` stubbed per existing functional files.
- Inserting a closure with `state='open'` and a non-null override fails the check (C20 at DB level).
- Static test asserts the file contains the dropped 7-arg signature, the 0019 gate string, the unique idempotency index, and no `create or replace function create_installment_purchase`.

**Verify:**
- Run: `pnpm test:card-bill-migration && pnpm test:migrations && pnpm --filter @family-finance/db test`
- Expected: script prints a success line; all green.

---

### Task 2: Domain fatura rules

**Files:**
- Create: `packages/domain/src/card-bills.ts`, `packages/domain/src/card-bills.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/transactions.ts` (+ its test)

**Interfaces:**
- Produces:
  ```ts
  export type CardBillOverrideState = "closed" | "open";
  export type CardBillStatus =
    | "open" | "open_partial" | "open_covered"
    | "nothing_due" | "closed_unpaid" | "closed_partial" | "paid";
  export function isCardBillClosed(input: {
    closingDay: number | null; month: string; todaySp: string; // YYYY-MM-DD
    override: CardBillOverrideState | null;
  }): boolean;
  export function cardBillClosingDate(closingDay: number, month: string): string; // YYYY-MM-DD, clamped
  export type CardBillSummary = {
    closed: boolean; chargesCents: number; totalCents: number; totalOverrideCents: number | null;
    paidCents: number; remainingCents: number; overpaidCents: number; status: CardBillStatus;
  };
  export function summarizeCardBill(input: {
    closed: boolean; chargesCents: number; totalOverrideCents: number | null; paymentCents: number[];
  }): CardBillSummary;
  export function cardBillBadge(summary: CardBillSummary): string;
  export function firstOpenInvoiceMonth(startMonth: string, isClosed: (month: string) => boolean): string;
  export function cardFaturaPair<T extends { summary: CardBillSummary }>(input: {
    open: T; previous: T | null;
  }): { pending: T | null; open: T };
  export function shiftInstallmentPlan(plan: InstallmentPlan, months: number): InstallmentPlan;
  ```
  `cardBillSettlementSchema` / `createCardBillSettlement` gain required `idempotencyKey: string` (min 1); the produced draft carries it.

**Behavior:**
- `isCardBillClosed` follows spec "Closed or open" exactly: C1 (purchase/today on closing day → open), C3 (closing 31 in Apr closes on 30th; in Feb on 28/29), C4 (null closing day → only override closes), C5, override precedence both ways (C7, C8).
- `summarizeCardBill`: `totalCents` = override only when `closed` and override not null, else charges; status table rows exactly (E1–E4, C21, C23, C24, C26); open with total 0 and paid 0 → `open`; open covered requires paid > 0.
- `cardBillBadge` strings exactly: `aberta`, `aberta · R$ X pago`, `aberta · paga até agora`, `nada a pagar`, `fechada · a pagar R$ X`, `fechada · parcial, falta R$ X`, `paga ✅`, `paga ✅ · R$ X a mais`, with R$ formatted by the existing `brl` helper.
- `firstOpenInvoiceMonth` walks month by month across year boundaries (Dec → Jan); throws after 24 closed months (C9).
- `cardFaturaPair`: pending = previous only when previous.summary.closed and status ∈ {closed_unpaid, closed_partial} (P1, P2); paid / nothing_due / overpaid previous → null (P3, P4); previous null → null (P6). (P5 and P7 are covered by how callers choose `open` and `previous`; test them in Task 3.)
- `shiftInstallmentPlan(plan, n)` moves every parcel's `due_month` forward n months, keeps everything else; n = 0 returns an equal plan.
- Settlement schema rejects empty `idempotencyKey`.

**Verify:**
- Run: `pnpm --filter @family-finance/domain test && pnpm --filter @family-finance/domain typecheck`
- Expected: green.

---

### Task 3: DB package — payments, closures, overview, pairs, parcel shift

**Files:**
- Modify: `packages/db/src/types.ts`, `packages/db/src/repositories.ts`, `packages/db/src/index.ts`, `packages/db/src/repositories.test.ts`, `apps/web/integration/fake-supabase.ts` (only what integration tests need)

**Interfaces:**
- Consumes: Task 1 SQL; Task 2 domain exports.
- Produces:
  ```ts
  export type CardBillPayment = { id: string; creditCardId: string; accountId: string; amountCents: number; paidOn: string; billMonth: string };
  export type CardBillClosure = { creditCardId: string; month: string; state: "closed" | "open"; totalOverrideCents: number | null };
  export type CardBillOverview = {
    card: CreditCardRow; month: string; closingDate: string | null; // YYYY-MM-DD or null
    summary: CardBillSummary; payments: CardBillPayment[];
  };
  export type CardFaturaPair = { card: CreditCardRow; pending: CardBillOverview | null; open: CardBillOverview };
  export type SettleCardBillResult = { transaction: TransactionRow; replayed: boolean };

  settleCardBill(client, draft: CardBillSettlementDraft): Promise<SettleCardBillResult>;
  findCardBillPayments(client, householdId: string, months: string[]): Promise<CardBillPayment[]>;
  deleteCardBillPayment(client, householdId: string, transactionId: string): Promise<void>; // throws Error("Pagamento não encontrado.")
  findCardBillClosures(client, householdId: string, months: string[]): Promise<CardBillClosure[]>;
  closeCardBill(client, input: { householdId: string; creditCardId: string; month: string; totalOverrideCents: number | null; userId: string }): Promise<void>;
  reopenCardBill(client, input: { householdId: string; creditCardId: string; month: string; userId: string }): Promise<void>;
  setCardBillTotal(client, input: { householdId: string; creditCardId: string; month: string; totalOverrideCents: number | null; userId: string }): Promise<void>;
  getCardBillCharges(client, householdId: string, creditCardId: string, month: string): Promise<number>;
  getCardBillOverview(client, householdId: string, month: string, todaySp: string): Promise<CardBillOverview[]>; // one per card
  getCardFaturaPairs(client, householdId: string, todaySp: string): Promise<CardFaturaPair[]>;
  planWithOpenFaturas(client, householdId: string, plan: InstallmentPlan, todaySp: string): Promise<{ plan: InstallmentPlan; shiftedFrom: string | null }>;
  ```
  `findCardBillSettlements` is removed (callers move to `findCardBillPayments`). `createInstallmentPurchase` keeps its signature; callers pass an already-shifted plan.

**Behavior:**
- `getCardBillCharges` sums card `expense` rows with `invoice_month = month` (refunds/income on card follow `summarizeCardPressure`'s existing sign rules) + installments with `due_month = month`; never filters by `occurred_on` (C28: purchase dated 30/10 attributed to fatura 11 counts in month 11 only).
- `closeCardBill` upserts `state='closed'`; when `totalOverrideCents` equals current charges it stores null (C17); different value stored (C18). `setCardBillTotal(null)` clears to live sum (C19). `reopenCardBill` upserts `state='open'`, override null (C20). All set `updated_by_user_id`, `updated_at`.
- `deleteCardBillPayment` deletes only `kind='transfer' and bill_month is not null` in the household; a regular transaction id or other household's id throws `Pagamento não encontrado.` and deletes nothing (E13, E14).
- `getCardBillOverview` combines closures + charges + payments through `isCardBillClosed`/`summarizeCardBill`; overpay (E4), future/past month payments (E5, E6), payments never change charges (E17), deleting a charge drops the closed total unless overridden (C14), editing a charge amount in a closed fatura changes the total unless overridden (C12).
- `getCardFaturaPairs`: per card, `openMonth = firstOpenInvoiceMonth(month(todaySp), m => closed(m))`, previous = overview of `openMonth − 1`, then `cardFaturaPair`. Current month manually closed → pending = current, open = next (P5); two-months-back unpaid closed fatura not surfaced (P7); card without closing day → single open block (P6). Batch queries (closures/payments for the needed months in one call each), not N+1 per month.
- `planWithOpenFaturas`: if parcel 1's `due_month` fatura is closed, shift whole plan to the first open month (`shiftInstallmentPlan`) and return `shiftedFrom` = original first month; else unchanged with `shiftedFrom: null` (C15). Same input → same output, so an idempotent replay re-sends an identical payload (C16).
- Closures/payments are read through RLS-scoped client; fake-supabase supports the new table and columns so web integration tests can seed closures, payments and `invoice_month`.

**Verify:**
- Run: `pnpm --filter @family-finance/db test && pnpm typecheck`
- Expected: green (web/bot may have type errors from the removed `findCardBillSettlements` / new settle result — fix callers minimally only to compile: Resumo keeps working; full UI changes are Task 5, bot Task 6).

---

### Task 4: Web server actions

**Files:**
- Modify: `apps/web/app/(app)/cards/actions.ts`
- Create: `apps/web/integration/card-bill-actions.test.ts`

**Interfaces:**
- Consumes: Task 3 repos; Task 2 domain.
- Produces (all `"use server"`, all `useActionState`-compatible `(prev, formData) => Promise<CardBillActionState>`):
  ```ts
  export type CardBillActionState = { status: "idle" } | { status: "success"; message: string } | { status: "error"; message: string };
  payCardBillAction        // fields: creditCardId, billMonth, amount (pt-BR money string), paidOn (YYYY-MM-DD), accountId, idempotencyKey
  undoCardBillPaymentAction // fields: transactionId
  closeCardBillAction      // fields: creditCardId, billMonth, total (optional money string; empty = live sum)
  reopenCardBillAction     // fields: creditCardId, billMonth
  setCardBillTotalAction   // fields: creditCardId, billMonth, total (empty = clear)
  ```
  `previewCardPurchase` / `saveCardPurchase` results gain `shiftedFrom: string | null` and use `planWithOpenFaturas` before preview and before `createInstallmentPurchase`.

**Behavior:**
- Error copy exactly per spec table: amount missing/≤0/garbage → `Informe um valor maior que zero.` (E7); no account → `Escolha a conta de onde saiu o pagamento.` (E9); paidOn > today SP → `A data do pagamento não pode ser no futuro.` (E8); bad `billMonth` → `Mês da fatura inválido.`; negative/garbage total → `Informe um total válido (zero ou mais).` (C22); RPC failures → `Não foi possível registrar o pagamento.` / `Não foi possível atualizar a fatura.` No RPC call on validation errors.
- Success: pay → `Pagamento registrado.` (replayed also success, E11); undo → `Pagamento desfeito.`; close → `Fatura fechada.`; reopen → `Fatura reaberta.`; total → `Total atualizado.`
- Every successful action revalidates `/cards`, `/resumo`, `/dashboard`, `/transactions`.
- Household and user come from the existing session helpers the other card actions use; ids from the form are never trusted for household.
- Parcel preview with a closed first fatura returns shifted parcels and `shiftedFrom`; save persists the same months (C15).

**Verify:**
- Run: `pnpm --filter @family-finance/web test && pnpm typecheck`
- Expected: green.

---

### Task 5: /cards and /resumo UI  *(design/taste task)*

**Files:**
- Modify: `apps/web/app/(app)/cards/page.tsx`, `apps/web/app/(app)/cards/purchase-form.tsx`, `apps/web/app/(app)/resumo/page.tsx`, `apps/web/app/(app)/resumo/queries.ts`, `apps/web/integration/resumo.test.ts`
- Create: `apps/web/app/(app)/cards/faturas-section.tsx` (server), `bill-payment-form.tsx` (client), `bill-close-form.tsx` (client: close / adjust total), `undo-payment-button.tsx` (client) — or fewer files if cleaner; one responsibility each.

**Interfaces:**
- Consumes: Task 3 `getCardFaturaPairs`, `getCardBillOverview`, `listAccounts`; Task 4 actions + `CardBillActionState`; Task 2 `cardBillBadge`.
- Resumo `ResumoData.cards` becomes `Array<{ id: string; name: string; pending: FaturaView | null; open: FaturaView }>` with `FaturaView = { month: string; closed: boolean; totalCents: number; badge: string }`; `settled` removed.

**Behavior:**
- `/cards` "Faturas" section above the cards grid; default view heading `Faturas de agora`, per card pending block (if any) above open block (P9); `?fatura=YYYY-MM` shows one block per card + link `Voltar para agora`; invalid param → default view (C30).
- Block content per spec "Fatura block": `Fatura MM/YYYY`, `fecha DD/MM` or `sem dia de fechamento`, badge, total/pago/falta, `total ajustado (soma dos lançamentos: R$ X)` when override active, payments list with `Desfazer`/`Desfazendo…`, `Fechar fatura` → reveal `Total da fatura` (prefilled live sum) + `Confirmar fechamento`; closed → `Reabrir` + `Ajustar total`; payment form `Valor` (prefilled remaining, empty when 0), `Data do pagamento` (default today, `max` today), `Conta` (preselected when single), hidden `billMonth`/`creditCardId`/`idempotencyKey` (server `randomUUID()` per render), `Registrar pagamento`/`Registrando…`, success `Pagamento registrado.`; zero accounts → `Cadastre uma conta para registrar pagamentos.` + link `/accounts` (E10).
- Purchase preview shows shifted months and `Fatura de MM/YYYY já fechada — começa em MM/YYYY.` when `shiftedFrom` set (C15).
- Resumo card block per spec layout: pending → main `Fatura MM · fechada`, big total, badge, divider, `Próxima MM · aberta` + open total (P1); no pending → single block `Fatura MM · aberta|fechada`, total, badge (P3). Headline spending numbers unchanged (P8).
- Reuse existing `Card`, `Badge`, `ff-*` classes and tokens; mobile-first (Resumo is a 10-second phone check); no new design primitives unless necessary. Badge tone: positive for `paga ✅`, warning for `fechada · …`, neutral otherwise.
- Testable via integration tests: Resumo query returns pair shape for P1/P3; page renders pending + próxima rows; payment form hidden/replaced when no accounts.

**Verify:**
- Run: `pnpm --filter @family-finance/web test && pnpm typecheck && pnpm --filter @family-finance/web build`
- Expected: green. Visual check happens in Task 7.

---

### Task 6: Bot

**Files:**
- Modify: `apps/bot/src/conversation.ts`, `apps/bot/src/replies.ts`, `apps/bot/src/index.ts`, `apps/bot/src/conversation-card-bill.test.ts`, `apps/bot/src/bot-card-flows.test.ts` (if affected)

**Interfaces:**
- Consumes: Task 3 `getCardBillOverview`, `getCardFaturaPairs`, `settleCardBill` (`{ transaction, replayed }`), `planWithOpenFaturas`; Task 2 settlement schema with `idempotencyKey`.
- Changes deps: `getCardBillAmount?: (creditCardId, month) => Promise<{ remainingCents: number; paidCents: number; closed: boolean }>`; new `resolveDefaultBillMonth?: (creditCardId: string) => Promise<string>` (pending ?? open month); `settleCardBill` returns `{ replayed: boolean }`. `CardBillDraftInProgress` gains `idempotencyKey: string` and `monthExplicit: boolean`.

**Behavior:**
- No month in the message → after the card is resolved, month = `resolveDefaultBillMonth(card)`; explicit month wins (B5).
- Remaining > 0 → prefill remaining (B1).
- Remaining = 0 and paid > 0 → new reply: fatura already paid (shows paid total) and asks for the extra amount; `amountCents` undefined until the user sends `valor X`, then `confirmar` saves a second payment (B2). `cardBillAlreadyPaidMessage` replaced.
- `idempotencyKey` = `randomUUID()` at draft creation, sent on confirm; `replayed: true` → same success message (B3).
- Bot installment purchases go through `planWithOpenFaturas` before `createInstallmentPurchase` (C15 on bot path).
- Existing bot card-bill tests keep passing after adapting to the new deps.

**Verify:**
- Run: `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot build && pnpm typecheck`
- Expected: green.

---

### Task 7: Local Playwright e2e + evidence

**Files:**
- Create: `apps/web/e2e/card-bill-payments.spec.ts`, `apps/web/e2e/local-auth.setup.ts`, `scripts/e2e-local-seed.sql` (or `.ts`), `thoughts/features/card-bill-payments/e2e-evidence/` (README + screenshots + report + trace + run log)
- Modify: `apps/web/playwright.config.ts` (setup project only when `E2E_LOCAL_SUPABASE=1`; screenshots/trace on), `apps/web/package.json` (script `test:e2e:local`)

**Interfaces:**
- Consumes: everything above; local Supabase at `http://127.0.0.1:54321` with 0033 applied.

**Behavior:**
- Guard: setup refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` host is `127.0.0.1` or `localhost`.
- Setup seeds (service role, local only) an allowlisted test user with password, a household + membership, one account, one card with a closing day, and a few purchases; signs in via local GoTrue password grant; writes the `@supabase/ssr` session cookie into a storage state file under the scratch/test-results dir (gitignored).
- Dev server runs with `AUTHORIZED_EMAILS` including the test user and local Supabase env.
- Scenario (screenshot each step into the evidence folder): purchase → open fatura badge → `Fechar fatura` with corrected total (C6, C18) → purchase after close lands in the next fatura and the pair view shows pending + open (C25, P1, P9) → partial payment (E2, C26) → double-click submit creates one payment (E11) → completing payment collapses to open (E3, P3) → `Desfazer` (E13) → invalid amount error (E7) → `?fatura=` future month payment (E5) → parcelado preview shift note (C15) → `/resumo` pair block (P1/P3).
- Evidence README lists command, environment (local only), date, pass/fail per step with screenshot names.

**Verify:**
- Run: `pnpm --filter @family-finance/web test:e2e:local`
- Expected: all steps pass; evidence files written and committed.

---

### Task 8: Docs

**Files:**
- Modify: `thoughts/tech-debt.md` (imports attributed by purchase date — worst with early closing days; PR #40 reconciliation of `settle_card_bill`/gate), `docs/runbooks/local-mvp-verification.md` (local e2e section)
- Create: `thoughts/features/card-bill-payments/progress.md`

**Behavior:**
- Tech-debt entries follow the file's existing format.
- Runbook shows the exact local e2e commands.

**Verify:**
- Run: `pnpm format` (prettier check on touched md, if covered)

---

## Execution roster (approved to run autonomously)

| Task | Model + effort | Why |
|---|---|---|
| 1 Migration + SQL tests | GPT-6.1 Sol high (Codex) | complex SQL, decided design |
| 2 Domain | Sonnet 5.5 | pure functions, exact contracts, unit tests |
| 3 DB package | GPT-6.1 Sol high (Codex) | multi-function repo work, decided interfaces |
| 4 Web actions | GPT-6.1 Sol high (Codex) | validation + wiring, copy fixed by spec |
| 5 /cards + /resumo UI | Opus 5.5 | taste-sensitive UI |
| 6 Bot | GPT-6.1 Sol high (Codex) | conversation state machine changes |
| 7 E2E + evidence | orchestrator (Opus 5.5, main session) | needs live local services + judgment on evidence |
| 8 Docs | orchestrator | small |
| Review | Fable 5.1 (primary) + GPT-6 Astra via `codex-review` | per routing table |

Waves: **W1** Task 1 (Codex) ‖ Task 2 (Sonnet) → **W2** Task 3 → **W3** Task 4 (Codex) ‖ Task 5 (Opus, starts from Task 4's fixed interface) → Task 6 (Codex, after Task 4 frees the workspace) → **W4** Task 7, Task 8 → reviews → fixes → PR.
