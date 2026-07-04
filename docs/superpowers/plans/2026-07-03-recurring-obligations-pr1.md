# Recurring Obligations (PR-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model recurring fixed obligations (financings, bills) as templates with computed projections, materialize a real transaction on mark-paid, and turn the bot's interpreter into the unified intent classifier (`plain | obligation | card_installment | mark_paid`).

**Architecture:** Pure domain module (`packages/domain/src/obligations.ts`) owns validation + projection math; migration `0011` adds the `obligations` table, `transactions.obligation_id/obligation_month` link columns, and an atomic idempotent `materialize_obligation_payment` RPC; repositories translate; web gets an `/obligations` surface + 12-month timeline + resumo line; the bot interpreter becomes the shared classifier and the conversation layer gains obligation-create and obligation-mark-paid flows (card paths reply "em breve").

**Tech Stack:** TypeScript, zod, Supabase (plpgsql + RLS), Next.js 15 server actions, vitest.

## Global Constraints

- Money is ALWAYS integer BRL cents (`amount_cents bigint check (> 0)`).
- `dueDay` clamped/validated 1–28 (consistent with `closingDay`).
- Month strings are `YYYY-MM`; month math is DST-free integer arithmetic (same approach as `addMonths` in installments.ts).
- Anti-double-count: project a month ONLY when no transaction with that `(obligation_id, obligation_month)` exists; unique partial index enforces idempotent materialization.
- `paidOn` override: bot passes the message send date; dashboard default is `month + dueDay`.
- Migration number is **0011** (0010 is reserved by the concurrent mvp branch).
- Bot copy is pt-BR; obligation confirmation is a SUMMARY, never N lines.
- Deferred intents reply exactly:
  - `card_installment`: `Compra parcelada no cartão ainda não dá pra registrar por aqui — em breve. Por ora, cadastre em Cartões no painel.`
  - `mark_paid{card}`: `Baixa de fatura do cartão ainda não está disponível por aqui — em breve.`
- Work ONLY in worktree `/Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance-obligations`.
- Commit after each passing task (`git add <files> && git commit`).

---

### Task 1: Domain module `packages/domain/src/obligations.ts`

**Files:**
- Create: `packages/domain/src/obligations.ts`
- Create: `packages/domain/src/obligations.test.ts`
- Modify: `packages/domain/src/index.ts` (exports)

**Interfaces (Produces):**

```ts
export type ObligationStatus = "active" | "ended" | "canceled";

export type ObligationDraft = {
  householdId: string;
  description: string;
  amountCents: number;           // monthly, > 0
  startMonth: string;            // YYYY-MM
  termMonths: number | null;     // null = indefinite
  dueDay: number;                // 1–28
  category: CategoryRef;         // {} when uninferred (PENDING)
  responsibility: Responsibility;
  accountId: string;             // payment source
  createdByUserId: string;
};

export type CreateObligationInput = {
  householdId: string;
  description: string;
  amountCents: number;
  startMonth: string;
  termMonths?: number | null;
  dueDay: number;
  accountId: string;
  createdByUserId: string;
  responsibleUserId?: string;
  category?: CategoryRef;
};

export function createObligationDraft(input: CreateObligationInput): DomainResult<ObligationDraft>;

/** YYYY-MM + offset months -> YYYY-MM (pure, DST-free). */
export function addMonthsYm(month: string, offset: number): string;

/** Last month due, or null when indefinite. endMonth = startMonth + termMonths - 1. */
export function obligationEndMonth(startMonth: string, termMonths: number | null): string | null;

export type ProjectableObligation = {
  id: string;
  description: string;
  amountCents: number;
  startMonth: string;
  termMonths: number | null;
  dueDay: number;
  accountId: string;
  status: ObligationStatus;
};

export type ProjectedEntry = {
  obligationId: string;
  month: string;        // YYYY-MM
  amountCents: number;
  description: string;
  dueDay: number;
  accountId: string;
};

/**
 * DB-unaware projection: for each ACTIVE obligation, emit one entry per month
 * in [fromMonth, toMonth] intersected with [startMonth, endMonth], skipping
 * months present in `paid` (keys `${obligationId}:${month}`). Sorted by month
 * then description.
 */
export function projectObligations(
  obligations: ProjectableObligation[],
  options: { fromMonth: string; toMonth: string; paid?: ReadonlySet<string> },
): ProjectedEntry[];

export function paidKey(obligationId: string, month: string): string; // `${id}:${month}`
```

Validation rules in `createObligationDraft` (zod + explicit checks, mirroring `createInstallmentPlan`): description non-empty (trimmed), `amountCents` positive integer, `startMonth` matches `/^\d{4}-(0[1-9]|1[0-2])$/`, `termMonths` null/undefined or positive integer, `dueDay` integer 1–28, `accountId`/`householdId`/`createdByUserId` non-empty. Responsibility: `responsibleUserId` set → `{scope:"user",userId}`, else `{scope:"household"}`. `termMonths ?? null` normalized.

- [ ] **Step 1: Write failing tests** in `obligations.test.ts` covering:
  - `addMonthsYm("2026-10", 71) === "2032-09"`, `addMonthsYm("2026-01", -1) === "2025-12"` (year boundaries)
  - `obligationEndMonth("2026-10", 72) === "2032-09"`, `obligationEndMonth("2026-10", null) === null`, term 1 → same month
  - `createObligationDraft` happy path (solar: 71044, 72x, start 2026-10, dueDay 5) → ok, endMonth derivable; rejects dueDay 0/29, amount 0/negative/non-integer, bad startMonth ("2026-13"), empty description, termMonths 0
  - `projectObligations`: fixed-term window clipping (fromMonth before start, toMonth after end); indefinite fills the whole window; `paid` months skipped; non-active status excluded; sorted output; empty obligations → []
- [ ] **Step 2: Run** `pnpm --filter @family-finance/domain test` → FAIL (module missing)
- [ ] **Step 3: Implement** `obligations.ts` per interfaces above
- [ ] **Step 4: Run tests** → PASS; run `pnpm --filter @family-finance/domain typecheck`
- [ ] **Step 5: Export from index.ts, commit** `feat(domain): obligation templates + reusable projection engine`

### Task 2: Migration `supabase/migrations/0011_create_obligations.sql`

**Files:**
- Create: `supabase/migrations/0011_create_obligations.sql`

Content (mirrors 0001 conventions + 0002 RPC pattern):

1. `obligation_status` enum (`active|ended|canceled`).
2. Table:

```sql
create table if not exists obligations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  description text not null,
  amount_cents bigint not null check (amount_cents > 0),
  start_month text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  term_months integer check (term_months is null or term_months > 0),
  due_day integer not null check (due_day between 1 and 28),
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  responsibility_scope responsibility_scope not null default 'household',
  responsible_user_id uuid references auth.users (id) on delete set null,
  account_id uuid not null references accounts (id) on delete restrict,
  status obligation_status not null default 'active',
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (responsibility_scope = 'user' and responsible_user_id is not null)
    or (responsibility_scope = 'household' and responsible_user_id is null)
  )
);
create index obligations_household_idx on obligations (household_id);
```

3. RLS: `alter table obligations enable row level security;` + `obligations_member_all` policy identical to 0001's loop body (`for all using (is_household_member(household_id)) with check (...)`).
4. Transactions link columns + anti-double-pay index:

```sql
alter table transactions
  add column obligation_id uuid references obligations (id) on delete set null,
  add column obligation_month date;
create unique index transactions_obligation_month_uniq
  on transactions (obligation_id, obligation_month)
  where obligation_id is not null;
```

5. RPC `materialize_obligation_payment(obligation_id uuid, target_month text, paid_on date default null)`:
   - `security definer`, `set search_path = public, pg_temp`.
   - Loads the obligation; raises `42501` unless `is_household_member(obligation.household_id)`.
   - Rejects non-`active` status (`invalid_parameter_value`), validates `target_month` format, and rejects months outside `[start_month, end_month]` (end via integer month math on `term_months`).
   - `occurred_on := coalesce(paid_on, make_date(year, month, due_day))`.
   - Inserts a `transactions` row: kind `'expense'`, `amount_cents`, `occurred_on`, `description`, category/subcategory, `account_id`, responsibility columns, `created_by_user_id := auth.uid()` fallback to obligation.created_by_user_id when null (service-role bot), `obligation_id`, `obligation_month := make_date(year, month, 1)`.
   - `on conflict ... where obligation_id is not null` isn't expressible on a partial unique index via `on conflict do nothing` with a target — use `insert ... on conflict (obligation_id, obligation_month) where obligation_id is not null do nothing returning *`; if no row returned, select the existing one. Return `jsonb_build_object('transaction', to_jsonb(row), 'already_paid', <bool>)`.
   - `revoke all ... from public;` + guarded `grant execute to authenticated` (mirror 0002's defensive block).

- [ ] **Step 1: Write the migration** exactly as above
- [ ] **Step 2: Sanity check** with `psql` if available, else careful re-read against 0001/0002 syntax (no local Supabase in this environment — note it in the commit body)
- [ ] **Step 3: Commit** `feat(db): migration 0011 — obligations table, tx link columns, materialize RPC`

### Task 3: DB types + repositories

**Files:**
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/repositories.ts`
- Modify: `packages/db/src/repositories.test.ts`
- Modify: `packages/db/src/index.ts` (exports)

**Interfaces (Produces):**

```ts
// types.ts
export type ObligationStatus = "active" | "ended" | "canceled";
export type ObligationRow = {
  id: string; household_id: string; description: string; amount_cents: number;
  start_month: string; term_months: number | null; due_day: number;
  category_id: string | null; subcategory_id: string | null;
  responsibility_scope: ResponsibilityScope; responsible_user_id: string | null;
  account_id: string; status: ObligationStatus; created_by_user_id: string;
  created_at: string; updated_at: string;
};
export type ObligationInsert = Insertable<ObligationRow, "category_id" | "subcategory_id" | "responsibility_scope" | "responsible_user_id" | "term_months" | "status">;
// TransactionRow/TransactionInsert gain: obligation_id: string | null; obligation_month: string | null;
// Database.Tables += obligations; Database.Functions += materialize_obligation_payment
export type MaterializeObligationPaymentResult = { transaction: TransactionRow; already_paid: boolean };
```

```ts
// repositories.ts
export function obligationInsertFromDraft(draft: ObligationDraft): ObligationInsert; // pure
export function mapObligationRow(row: ObligationRow): ProjectableObligation & { householdId: string; categoryId: string | null; subcategoryId: string | null; responsibilityScope: ResponsibilityScope; responsibleUserId: string | null; createdByUserId: string };
export async function createObligation(client, draft: ObligationDraft): Promise<ObligationRow>;
export async function listObligations(client, householdId, opts?: { status?: ObligationStatus }): Promise<ObligationRow[]>; // default active only, ordered by description
export async function cancelObligation(client, householdId, obligationId): Promise<void>; // status='canceled'
export async function updateObligation(client, householdId, obligationId, changes: { description?: string; amountCents?: number; dueDay?: number; accountId?: string; termMonths?: number | null; categoryId?: string | null; subcategoryId?: string | null }): Promise<void>;
export async function materializeObligationPayment(client, args: { obligationId: string; month: string; paidOn?: string }): Promise<MaterializeObligationPaymentResult>; // rpc
export type ObligationPaymentKey = { obligationId: string; month: string };
export async function listObligationPayments(client, householdId, fromMonth, toMonth): Promise<ObligationPaymentKey[]>; // transactions where obligation_id not null and obligation_month in range; maps date -> YYYY-MM
export type ObligationsPressure = { month: string; projectedUnpaidCents: number; paidCents: number; totalCents: number };
export function summarizeObligationsPressure(month: string, projected: ProjectedEntry[], paidRows: Pick<TransactionRow, "amount_cents">[]): ObligationsPressure; // pure
export async function getObligationsPressure(client, householdId, month): Promise<ObligationsPressure>; // listObligations + payments + projector + paid tx amounts for the month
```

`updateObligation` builds a column patch (validates amountCents positive int, dueDay 1–28, empty patch = no-op) — same style as `transactionUpdateFromPatch`.

- [ ] **Step 1: Failing tests** in `repositories.test.ts` for the pure pieces: `obligationInsertFromDraft` (household/user responsibility, null category, term null), `mapObligationRow`, `summarizeObligationsPressure` (projected-unpaid + paid sum), obligation-month date→YYYY-MM mapping helper
- [ ] **Step 2: Run** `pnpm --filter @family-finance/db test` → FAIL
- [ ] **Step 3: Implement types + repositories**
- [ ] **Step 4: Tests + typecheck PASS** (`pnpm --filter @family-finance/db test && pnpm --filter @family-finance/db typecheck`)
- [ ] **Step 5: Export new symbols from db index.ts; commit** `feat(db): obligation repositories + pressure summarizer`

### Task 4: Web `/obligations` surface (list, create, cancel, mark-paid, timeline)

**Files:**
- Create: `apps/web/app/(app)/obligations/actions.ts`
- Create: `apps/web/app/(app)/obligations/queries.ts`
- Create: `apps/web/app/(app)/obligations/page.tsx`
- Create: `apps/web/app/(app)/obligations/queries.test.ts` (pattern: whatever resumo/dashboard queries tests use — check `apps/web` test layout first)
- Modify: `apps/web/app/(app)/layout.tsx` (nav item `{ href: "/obligations", label: "Obrigações", icon: "card" /* or closest existing icon */ }` after Cartões)

**actions.ts** (mirror `cards/actions.ts` — `authedHousehold()` helper, FormData):
- `createObligationAction(formData)` — fields: description, monthly amount (pt-BR decimal → cents), startMonth (`YYYY-MM` from `<input type="month">`), termMonths (blank = indefinite), dueDay, accountId, optional categoryId. Builds via domain `createObligationDraft` (createdByUserId from `client.auth.getUser()`), persists via `createObligation`, `revalidatePath("/obligations")` + `/resumo` + `/dashboard`.
- `cancelObligationAction(formData)` — `cancelObligation`.
- `markObligationPaidAction(formData)` — `materializeObligationPayment({ obligationId, month })` (no paidOn → RPC defaults to month+dueDay); revalidates same paths. Surfaces `already_paid` as a friendly no-op message.

**queries.ts**:
- `buildObligationsData(client, householdId, now)` → `{ month, obligations: [...mapped rows + remaining term + next due + paidThisMonth flag], timeline: Array<{ month, entries: ProjectedEntry[], totalCents }> (12 months from current), thisMonth: { entries (unpaid), paidEntries } , loadError: null }` composed from `listObligations` + `listObligationPayments(month, month+11)` + `projectObligations`.
- `loadObligationsData(now?)` wrapper degrading to a zero state (mirror `loadResumoData`).

**page.tsx** (server component, `dynamic = "force-dynamic"`, mirror accounts/cards page structure with `Card`, `PageTitle`, `Button`, `Field`, `Input`, `Select` from `components/ui`):
- Section "Este mês": each projected (unpaid) obligation with a "Marcar como pago" form-button → `markObligationPaidAction`; paid ones rendered with a ✓ and no button.
- Section "Obrigações ativas": table/cards — description, R$/mês, remaining term (`termMonths ? "N de M restantes" : "sem prazo"`), next due (dueDay), account, category; cancel button.
- Create form: all fields above.
- Section "Próximos 12 meses" (timeline): one row per month — pt-BR month label (reuse `monthLabelPtBr` style), entry descriptions + amounts, month total.

- [ ] **Step 1: Check web test conventions** (`ls apps/web` test files for queries) and write failing tests for `buildObligationsData` composition against the same fake-store pattern the resumo tests use (timeline window, paid suppression, remaining-term math)
- [ ] **Step 2: Run** `pnpm --filter @family-finance/web test` → FAIL
- [ ] **Step 3: Implement queries.ts, actions.ts, page.tsx, nav link**
- [ ] **Step 4: Tests + `pnpm --filter @family-finance/web typecheck` PASS**
- [ ] **Step 5: Commit** `feat(web): obligations surface — list, create, mark-paid, 12-month timeline`

### Task 5: Resumo + dashboard obligations line

**Files:**
- Modify: `apps/web/app/(app)/resumo/queries.ts` (+ its test file)
- Modify: `apps/web/app/(app)/resumo/page.tsx`
- Modify: `apps/web/app/(app)/dashboard/queries.ts` + `page.tsx` (only if a natural slot exists — resumo is the required surface; dashboard optional per spec "Dashboard loader gains an obligationsCents line")

Changes:
- `ResumoData` gains `obligationsCents: number` (this month's projected-unpaid + paid actuals = `getObligationsPressure(...).totalCents`), fetched in the existing `Promise.all`.
- Spending totals: paid obligation transactions are account expenses already inside `summary.expenseCents` — do NOT add them again; `obligationsCents` is a separate display line ("Obrigações fixas do mês") next to card pressure. Projected-unpaid is informational, not added to `totalSpentCents` (gasto is actuals).
- Zero state (`emptyResumo`) gains `obligationsCents: 0`.

- [ ] **Step 1: Failing test** — resumo composition includes `obligationsCents` from the fake store
- [ ] **Step 2: Run web tests** → FAIL
- [ ] **Step 3: Implement queries + page line**
- [ ] **Step 4: Tests + typecheck PASS**
- [ ] **Step 5: Commit** `feat(web): resumo shows month fixed-obligations total`

### Task 6: Bot interpreter → unified intent classifier

**Files:**
- Modify: `apps/bot/src/interpret.ts`
- Modify: `apps/bot/src/interpret.test.ts`

**Interfaces (Produces):**

```ts
export type InterpretedIntent =
  | { intent: "plain"; expense: InterpretedExpense }
  | { intent: "obligation"; obligation: InterpretedObligation }
  | { intent: "card_installment" }
  | { intent: "mark_paid"; target: "obligation" | "card"; keyword: string };

export type InterpretedObligation = {
  description: string;
  monthlyAmountCents?: number;
  termMonths?: number;      // undefined = indefinite
  startMonth?: string;      // YYYY-MM; undefined = current month
  dueDay?: number;          // 1–28; undefined = caller defaults
  categoryHint?: string;
  responsibleHint?: string;
};

export type MessageClassifier = (text: string, options: { today: string }) => Promise<InterpretedIntent | null>;
export function createMessageClassifier(client: AiCompletionClient): MessageClassifier;
export function buildClassifierPrompt(text: string, today: string): string;
// KEEP existing createTextInterpreter/InterpretedExpense exports untouched (fallback path still uses them).
```

Prompt (pt-BR, single strict JSON object) rules:
- Four intents with pt-BR examples: plain (`"mercado 230"`), obligation (`"Parcela solar 710,44 72x a partir de 05/10"`, `"aluguel 1200 todo mês dia 10"`), card_installment (`"notebook 3600 em 12x no nubank"` — an identified CARD purchase parcelada), mark_paid (`"placa solar pago"` → target obligation, keyword "placa solar"; `"nubank pago"` → target card, keyword "nubank").
- Disambiguation obligation vs card_installment: mentions of cartão/card names → card_installment; boleto/financiamento/recurring bills/no card → obligation.
- Per-month vs total: `"72x de 710"` / `"710 72x"` = per-month (monthly_amount_cents = 71044); `"51.000 em 72x"` = TOTAL → model must divide (emit per-month cents, integer division documented; remainder tolerated in MVP).
- `start_month` from "a partir de 05/10" → `"2026-10"` (resolve year with `today`), `due_day` 5. Clamp instructions: due_day 1–28 (29–31 → 28).
- mark_paid keyword = the thing being paid, minus "pago/paga/paguei".
- Schema (zod): discriminated on `intent`; same null→undefined mapping style as today; any failure → null.

- [ ] **Step 1: Failing tests** with a stubbed `AiCompletionClient` returning canned JSON: all four intents parse; solar phrasing variants map to obligation with 71044/72/2026-10/5; total-phrasing division; mark_paid targets; malformed JSON/missing fields → null; prompt contains the four intent names and today
- [ ] **Step 2: Run** `pnpm --filter @family-finance/bot test` → FAIL
- [ ] **Step 3: Implement classifier** (reuse `extractJsonObject`)
- [ ] **Step 4: Tests PASS**
- [ ] **Step 5: Commit** `feat(bot): unified intent classifier (plain/obligation/card_installment/mark_paid)`

### Task 7: Bot conversation — obligation create + mark-paid + deferred replies

**Files:**
- Modify: `apps/bot/src/conversation.ts`
- Modify: `apps/bot/src/replies.ts`
- Modify: `apps/bot/src/bot.test.ts` and/or new `apps/bot/src/conversation.test.ts` cases (follow where existing conversation tests live)
- Modify: `apps/bot/src/index.ts` (buildDeps + handleWebhook wiring, exports)
- Modify: `apps/bot/src/store.ts` ONLY if it validates state shape (extend the schema for new statuses)

**Interfaces (Produces):**

```ts
// conversation.ts additions
export type ConversationStatus =
  | "awaiting_confirmation" | "needs_amount" | "saved" | "cancelled"
  | "awaiting_obligation_confirmation"      // obligation draft pending confirm
  | "awaiting_mark_paid_choice";            // 2+ obligation keyword matches

export type ObligationDraftInProgress = {
  description: string;
  monthlyAmountCents?: number;
  termMonths: number | null;
  startMonth: string;   // resolved (default: current month)
  dueDay: number;       // resolved (default: 5? NO — default: due day 1? see below)
  accountId: string;    // default household checking
  categoryId?: string; subcategoryId?: string; categoryExplanation?: string;
  responsibleUserId?: string;
  createdByUserId: string;
};
// dueDay default when the message gives none: day of startMonth from occurred date is meaningless — default 1.

export type ConversationState = {
  status: ConversationStatus;
  draft: DraftInProgress;                      // unchanged for plain flow
  obligationDraft?: ObligationDraftInProgress; // set in obligation flow
  markPaidCandidates?: Array<{ id: string; description: string }>; // ambiguity
};

export type ConversationDeps = {
  // ...existing fields...
  classifyMessage?: MessageClassifier;   // new preferred entry; interpretText stays as plain-expense fallback
  listActiveObligations: () => Promise<Array<{ id: string; description: string; amountCents: number; startMonth: string; termMonths: number | null; dueDay: number; accountId: string; status: "active" }>>;
  createObligation: (draft: ObligationDraft /* domain */) => Promise<{ id: string }>;
  materializeObligationPayment: (args: { obligationId: string; month: string; paidOn: string }) => Promise<{ alreadyPaid: boolean }>;
  resolveAccountIdByName?: (name: string) => string | undefined; // "conta X" correction
};
```

`startConversation` flow change (top of function): when `deps.classifyMessage` is configured, classify the ORIGINAL text first (catch → null).
- `null` or `intent === "plain"` → EXACT existing behavior (parser + interpretText fallback; when plain came from the classifier, use its `expense` fields the same way `interpreted` is used today and skip the second LLM call).
- `intent === "card_installment"` → terminal reply `cardInstallmentDeferredMessage()`, state `{status:"cancelled", draft: <empty>}` (terminal so next message starts fresh).
- `intent === "mark_paid", target "card"` → terminal reply `cardBillDeferredMessage()`.
- `intent === "mark_paid", target "obligation"` → match `keyword` case/accent-insensitively (reuse `normalizeName`) as substring against active obligation descriptions:
  - 0 matches → reply `obligationNotFoundMessage(keyword)`, terminal.
  - 1 match → `materializeObligationPayment({ obligationId, month: currentMonth(today), paidOn: today })`; reply `obligationPaidMessage(...)` or `obligationAlreadyPaidMessage(...)` when `alreadyPaid`; log interaction; status `"saved"`.
  - 2+ → status `"awaiting_mark_paid_choice"`, store candidates, reply `obligationAmbiguousMessage(names)` (`"Solar ou Financiamento carro?"` style).
- `intent === "obligation"` → build `ObligationDraftInProgress`: defaults startMonth = current month of `today`, dueDay = clamp(1–28, default 1), accountId = `deps.defaultAccountId`, responsibleHint via `resolveResponsibleUserId`, category via `suggestCategory` (same hint-append pattern); missing `monthlyAmountCents` → reuse `needs_amount`-style ask (status `awaiting_obligation_confirmation` with a "valor?" line in the summary); reply `obligationConfirmationMessage(view)`; status `"awaiting_obligation_confirmation"`.

`applyMessage` additions:
- `awaiting_obligation_confirmation`: CANCEL_RE → cancelled; CONFIRM_RE → build domain draft via `createObligationDraft` (map fields; validation failure → surface first error, keep state), persist via `deps.createObligation`, log interaction, reply `obligationSavedMessage`; corrections: `valor X` (monthly amount via parser), `dia N` (dueDay 1–28), `conta <nome>` (via `resolveAccountIdByName`, unknown → notUnderstood); anything else → `notUnderstoodMessage()`-style obligation help.
- `awaiting_mark_paid_choice`: match reply text against stored candidates (substring, normalized); 1 match → materialize as above; else re-ask.

**replies.ts additions** (pure builders, pt-BR):
- `obligationConfirmationMessage(view)` — SUMMARY format: `Financiamento: Solar — R$ 710,44/mês × 72 (out/2026 → set/2032)` or `Obrigação fixa: Aluguel — R$ 1.200,00/mês (sem prazo)`; `Vence dia N` · `Pago via: <conta>` · categoria line; footer `Responda *confirmar* para salvar, corrija ("valor 710,44" · "dia 5" · "conta Nubank"), ou *cancelar*.` Needs a `monthRangePtBr(startMonth, endMonth)` helper (`"out/2026 → set/2032"`, pt-BR month abbreviations).
- `obligationSavedMessage(view)`, `obligationPaidMessage({description, amountCents, month})` (`"Pago! ✅ Solar — R$ 710,44 (outubro/2026)"`), `obligationAlreadyPaidMessage`, `obligationNotFoundMessage(keyword)`, `obligationAmbiguousMessage(names)`, `cardInstallmentDeferredMessage()`, `cardBillDeferredMessage()` (exact copy from Global Constraints).

**index.ts wiring:** `buildDeps` gains account-name resolver (from already-loaded `accounts`), `listActiveObligations` (via db `listObligations` mapped), `createObligation` (via db `createObligation(client, draft)`), `materializeObligationPayment` (via db rpc wrapper); `startBot` creates `classifyMessage = completionClient ? createMessageClassifier(completionClient) : undefined` and passes through `handleWebhook` args → deps. Keep `interpretText` wiring as-is.

**store.ts:** read it first; if the load-validation schema enumerates statuses/fields, extend it to accept the new statuses + optional `obligationDraft`/`markPaidCandidates` (old persisted rows must still parse).

- [ ] **Step 1: Failing tests**: obligation create happy path (classify → summary copy contains `R$ 710,44/mês × 72 (out/2026 → set/2032)` → confirmar → deps.createObligation called with correct domain draft); missing amount asks for valor; corrections valor/dia/conta; cancelar; mark_paid single match calls materialize with today as paidOn + current month; alreadyPaid reply; ambiguous → choice state → resolution; not found; card_installment + mark_paid{card} exact "em breve" copies; classifier null → legacy plain path unchanged (existing tests must keep passing)
- [ ] **Step 2: Run** `pnpm --filter @family-finance/bot test` → FAIL on new cases only
- [ ] **Step 3: Implement conversation + replies + index wiring (+ store schema if needed)**
- [ ] **Step 4: All bot tests PASS + `pnpm --filter @family-finance/bot typecheck`**
- [ ] **Step 5: Commit** `feat(bot): obligation create + mark-paid flows via unified classifier; card paths reply em breve`

### Task 8: Full verification + docs

- [ ] **Step 1:** `pnpm test` (turbo, all packages) and `pnpm typecheck` from repo root → all PASS
- [ ] **Step 2:** Self-review diff against `thoughts/features/recurring-obligations/design.md` (spec-coverage checklist: template model, projection engine reuse, anti-double-count, idempotency, bot copy, deferred intents, timeline, resumo line, defaults)
- [ ] **Step 3:** Update `thoughts/features/recurring-obligations/progress.md` (new dated section + Current state) and commit docs + plan file
- [ ] **Step 4:** Final commit; leave branch local (unpushed, per handoff)

## Self-Review Notes

- Spec coverage: domain (T1), schema+RPC (T2), persistence+pressure (T3), web surface+timeline (T4), resumo (T5), classifier (T6), bot flows+deferred (T7), tests woven through, verification (T8). `nubank pago` schema wrinkle intentionally NOT touched (PR-2).
- Type consistency: `ProjectableObligation`/`ProjectedEntry`/`paidKey` defined in T1, consumed T3/T4; `MessageClassifier`/`InterpretedIntent` defined T6, consumed T7; db repo names consistent (`createObligation`, `listObligations`, `materializeObligationPayment`, `listObligationPayments`, `getObligationsPressure`).
- Known judgment calls (flag in PR): dueDay default 1 when unstated; classifier runs on every NEW conversation message when LLM configured (falls back to deterministic path on null); projected-unpaid shown but not added to gasto totals.
