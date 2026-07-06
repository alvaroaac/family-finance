# Family Finance v1.0 — Phases 2–4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement v1.0 spec Phases 2 (web features), 3 (bot production shape), and 4 (deploy artifacts — repo files only, NO live deploy) per `docs/superpowers/specs/2026-07-01-family-finance-v1-design.md`. Phase 1 (UI re-skin) is gated on user mockups; everything here builds on the current skin (spec-allowed fallback).

**Architecture:** pnpm/turbo monorepo. Web = Next.js App Router server components + server actions; all data through `packages/db` household-scoped repos on the user's RLS-scoped Supabase client. Bot = standalone `node:http` webhook server with a service-role client, telegram_user_id→member identity, DB-persisted conversations, LLM text fallback behind the existing confirmation state machine. Deploy = compose/Caddy/runbook artifacts under `deploy/`.

**Tech Stack:** TypeScript NodeNext, Next.js 14 App Router, Supabase (supabase-js, RLS, SECURITY DEFINER RPCs), vitest + FakeSupabaseStore, zod, tsx runtime for the bot.

## Global Constraints

- pt-BR copy everywhere in UI/bot replies; warm household tone (never corporativês).
- All web data access via `packages/db` repos, household-scoped; web NEVER sees `SUPABASE_SERVICE_ROLE_KEY`.
- Amount/kind/payment-instrument of existing transactions NOT editable (spec §2.1). Delete blocked when `installment_id` is not null.
- Bot: LLM never saves directly — always through the confirmation step (spec §3.4).
- Migrations: apply with `supabase migration up`. **NEVER `supabase db reset`** (live walkthrough data in local stack).
- New tables: enable RLS; service-role-only tables get NO anon/authenticated policies (deny by default). Grants for new tables already covered by `0005` ALTER DEFAULT PRIVILEGES.
- Commit per task, exact messages given. Do NOT push. `thoughts/`, `memory/`, `.superpowers/` never staged.
- Gate per task: `pnpm typecheck && pnpm test` green (129+ tests), plus `pnpm --filter @family-finance/web build` when web changed, `pnpm --filter @family-finance/bot build` when bot changed, `pnpm --filter @family-finance/web lint` when web changed.
- Existing interfaces (verbatim, from the interface survey): see "Interfaces appendix" at the bottom — every task's implementer must read it.

---

## Phase 2 — Web features

### Task 1: Migration 0007 — members profile + bucket balances

**Files:**
- Create: `supabase/migrations/0007_members_profile_and_bucket_balances.sql`
- Modify: `packages/db/src/types.ts` (HouseholdMemberRow, InvestmentBucketRow)

**Interfaces:**
- Produces: `HouseholdMemberRow` gains `display_name: string | null; telegram_user_id: number | null`. `InvestmentBucketRow` gains `balance_cents: number`.

- [ ] **Step 1: Write the migration**

```sql
-- 0007: household member profile fields + caixinha manual balances (spec v1.0 §2.4/§2.5)
alter table household_members
  add column display_name text,
  add column telegram_user_id bigint unique;

alter table investment_buckets
  add column balance_cents bigint not null default 0 check (balance_cents >= 0);
```

- [ ] **Step 2: Update types.ts** — add the three fields to the row types AND to the corresponding `Database` insert/update shapes in `packages/db/src/types.ts` (follow the file's existing pattern exactly).

- [ ] **Step 3: Apply + verify**

Run: `supabase migration up` then
`docker exec supabase_db_family-finance psql -U postgres -d postgres -tAc "select column_name from information_schema.columns where table_name='household_members' and column_name in ('display_name','telegram_user_id')"`
Expected: both columns listed. Same check for `investment_buckets.balance_cents`.

- [ ] **Step 4: Gate + commit**

`pnpm typecheck && pnpm test` green.
`git add supabase/migrations/0007_* packages/db/src/types.ts && git commit -m "feat(db): members display_name/telegram_user_id + caixinha balance_cents (migration 0007)"`

### Task 2: db repos — members, buckets balance, transactions filtered/update/delete, last bot interaction

**Files:**
- Modify: `packages/db/src/repositories.ts`, `packages/db/src/index.ts` (exports)
- Test: `packages/db/src/repositories.test.ts` (pure helpers) + coverage via `apps/web/integration` fake store in later tasks

**Interfaces (Produces — later tasks consume these exact names):**

```typescript
export type TransactionFilters = {
  month?: string;                    // YYYY-MM, filters occurred_on via monthDateRange
  accountId?: string;
  creditCardId?: string;
  categoryId?: string;
  responsible?: string | "household"; // user_id, or literal "household" => responsibility_scope = 'household'
  pendingOnly?: boolean;             // kind != 'transfer' AND category_id is null (same rule as needsReview)
  search?: string;                   // ilike %search% on description
};
export type TransactionListItem = PersistedTransaction; // reuse mapTransactionRow
export type TransactionPage = { rows: TransactionListItem[]; total: number; page: number; pageSize: number };

export async function findTransactionsFiltered(
  client: AppSupabaseClient, householdId: string, filters: TransactionFilters, page = 1, pageSize = 50,
): Promise<TransactionPage>
// order: occurred_on desc, created_at desc; select with { count: "exact" }; range((page-1)*pageSize, page*pageSize-1)

export type TransactionPatch = {
  categoryId?: string | null;
  subcategoryId?: string | null;
  description?: string;
  responsibility?: { scope: "household" } | { scope: "user"; userId: string };
  occurredOn?: string; // ISO date
};
export async function updateTransaction(
  client: AppSupabaseClient, householdId: string, transactionId: string, patch: TransactionPatch,
): Promise<void>
// builds a partial update object; validates occurredOn with /^\d{4}-\d{2}-\d{2}$/, description non-empty when present; .eq household_id + id

export async function deleteTransaction(
  client: AppSupabaseClient, householdId: string, transactionId: string,
): Promise<void>
// first select installment_id; if not null throw Error("Parcelas são gerenciadas pelo grupo do parcelamento — não dá para excluir uma parcela avulsa.")

export type HouseholdMemberProfile = {
  id: string; userId: string; role: string; isActive: boolean;
  displayName: string | null; telegramUserId: number | null;
};
export async function listHouseholdMembers(
  client: AppSupabaseClient, householdId: string,
): Promise<HouseholdMemberProfile[]>

export async function updateHouseholdMember(
  client: AppSupabaseClient, householdId: string, memberId: string,
  changes: { displayName?: string | null; telegramUserId?: number | null },
): Promise<void>

export async function updateInvestmentBucketBalance(
  client: AppSupabaseClient, householdId: string, bucketId: string, balanceCents: number,
): Promise<void>
// reject negative / non-integer with Error before hitting the DB

export async function findLastBotInteraction(
  client: AppSupabaseClient, householdId: string,
): Promise<Pick<BotInteractionRow, "created_at" | "input_kind" | "transaction_id"> | null>
// order created_at desc limit 1 maybeSingle
```

- [ ] **Step 1: Write failing tests** for the pure parts (filter-object construction if extracted, patch validation errors, negative balance rejection) in `repositories.test.ts`, following the file's existing test style.
- [ ] **Step 2: Run tests — FAIL** (`pnpm --filter @family-finance/db test`).
- [ ] **Step 3: Implement** all functions in `repositories.ts` following the existing query idioms (`.eq("household_id", householdId)` on every query). Export from `index.ts`.
- [ ] **Step 4: Extend `apps/web/integration/fake-supabase.ts`** if needed: it must support `.ilike`, `.range`, and `select(..., { count: "exact" })` for `findTransactionsFiltered`. Add minimal support following its existing builder pattern; add a fake-store test exercising findTransactionsFiltered end-to-end (filters + pagination + total).
- [ ] **Step 5: Gate + commit**

`pnpm typecheck && pnpm test` green.
`git commit -m "feat(db): transaction filters/update/delete, member profiles, bucket balance, last bot interaction repos"`

### Task 3: Invoice timing — `closingDay` in createInstallmentPlan + callers

**Files:**
- Modify: `packages/domain/src/installments.ts`
- Test: `packages/domain/src/installments.test.ts`
- Modify callers: `apps/web/app/(app)/cards/actions.ts` (purchase form), `apps/web/app/(app)/imports/actions.ts` (fatura confirm), pass the selected card's `closing_day` when set.

**Interfaces:**
- `CreateInstallmentPlanInput` gains `closingDay?: number` (1–28 validated). Rule (spec §2.6): purchase **day > closingDay** → first `dueMonth` = purchase month + 1; else purchase month. Subsequent months contiguous. Omitted/null closingDay → today's behavior unchanged.

- [ ] **Step 1: Failing tests** in `installments.test.ts`:

```typescript
// purchase 2026-07-10, closingDay 5 => first dueMonth "2026-08"; 3x => ["2026-08","2026-09","2026-10"]
// purchase 2026-07-05, closingDay 5 => first dueMonth "2026-07" (day == closing NOT after)
// purchase 2026-12-20, closingDay 15 => first dueMonth "2027-01" (year rollover)
// closingDay 0 / 29 / 1.5 => validation error field "closingDay"
// closingDay omitted => identical output to current behavior (regression)
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**: add `closingDay: z.number().int().min(1).max(28).optional()` to the schema; compute `const offsetBase = closingDay !== undefined && dateParts.day > closingDay ? 1 : 0;` and use `addMonths(dateParts.year, dateParts.month, offsetBase + index)`.
- [ ] **Step 4: Wire callers**: both call sites already load the chosen `CreditCardRow`; pass `closingDay: card.closing_day ?? undefined`. Existing groups untouched (no regeneration).
- [ ] **Step 5: Gate + commit**

`pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build`
`git commit -m "feat(domain): invoice-aware first dueMonth via card closingDay"`

### Task 4: `/transactions` page — Transações view + edit

**Files:**
- Create: `apps/web/app/(app)/transactions/page.tsx` (server component: auth, parse searchParams → filters, load data)
- Create: `apps/web/app/(app)/transactions/actions.ts` (server actions)
- Create: `apps/web/app/(app)/transactions/transactions-table.tsx` (client component)
- Test: `apps/web/integration/transactions-page.test.ts` (fake-store integration on the repos + action-level validation)

**Interfaces:**
- Consumes: `findTransactionsFiltered`, `updateTransaction`, `deleteTransaction`, `listHouseholdMembers`, `listAllCategories`, `listAllSubcategories`, `listAccounts`, `listCreditCards`, `currentMonth`, `createServerSupabaseClient`, `requireAuthorizedUser`, `findHouseholdIdForCurrentUser`.
- URL contract: `/transactions?month=YYYY-MM&account=&card=&category=&resp=&pending=1&q=&page=N` (all optional; month defaults to `currentMonth()`). `/resumo` links to `/transactions?pending=1`.

**Behavior (all pt-BR):**
- Filter bar: month stepper (‹ mês ›), selects conta/cartão/categoria/responsável (Casa + member display names, fallback "Membro" when null), pill toggle "pendentes", text search on description. Filters submit as GET (links/form), keeping server-component rendering; page size 50 with anterior/próxima pagination using `TransactionPage.total`.
- Table columns: data, descrição (click-to-edit input), categoria + subcategoria (inline selects, same pattern as imports preview), responsável select, valor (R$, sign by kind), badge "pendente" (amber) via `needsReview` rule, excluir button with `confirm()`.
- Server actions: `updateTransactionAction(formData)` and `deleteTransactionAction(formData)` — re-resolve household from session (never trust client household), call repos, `revalidatePath("/transactions")`, return `{ ok: boolean; error?: string }`. Delete of a parcela surfaces the repo's pt-BR error.
- Amount/kind/payment NOT editable anywhere in this UI.

- [ ] **Step 1: Failing integration test**: seed fake store with 60 transactions across 2 months incl. 1 parcela row (installment_id set) + members with display names; assert filter by month/pending/search, pagination totals, updateTransaction patch persists, deleteTransaction on parcela throws the pt-BR message.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** page + actions + client table using the imports page's established client/server-action idioms and current inline-style skin.
- [ ] **Step 4: Manual smoke** on the running dev server (:3000): `/transactions` renders the user's real data, month stepper works, editing a category persists.
- [ ] **Step 5: Gate + commit**

`pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build && pnpm --filter @family-finance/web lint`
`git commit -m "feat(web): /transactions — filtered list with inline edit and guarded delete"`

### Task 5: `/resumo` — quick daily dashboard

**Files:**
- Create: `apps/web/app/(app)/resumo/page.tsx`
- Create: `apps/web/app/(app)/resumo/queries.ts` (`loadResumoData`)
- Modify: `apps/web/app/(app)/layout.tsx` (NAV_ITEMS: add `{ href: "/resumo", label: "Resumo" }` FIRST)
- Test: `apps/web/integration/resumo.test.ts`

**Interfaces:**
- Consumes: `getMonthlySummary` (current + previous month), `getCardPressure` per card via `listCreditCards`, `findPendingReviewTransactions` (count), `findRecentTransactions(client, hh, 5)`, `currentMonth`, `formatBrlCents` (reuse from dashboard queries or move to a shared `apps/web/lib/format.ts` — move it, update dashboard import).
- Produces: `loadResumoData(now?: Date): Promise<ResumoData>` where

```typescript
export type ResumoData = {
  month: string;
  spentCents: number;               // current month expenseCents
  deltaVsPreviousCents: number;     // previous.expenseCents - current.expenseCents (positive = spending less)
  cards: Array<{ id: string; name: string; projectedCents: number }>; // getCardPressure(month).totalCents per card — NOTE: getCardPressure is household-wide; per-card requires filtering: reuse summarizeCardPressure with card-scoped queries (transactions .eq credit_card_id, installments .eq credit_card_id)
  pendingCount: number;
  recent: DashboardTransaction[];   // last 5
  loadError: string | null;
};
```

**Behavior:** read-only, no filters. Greeting "Como estão as contas da casa?" + month label; gasto do mês as big number with friendly comparison ("R$ 320 a menos que junho 🌱" / "R$ X a mais que <mês>"); fatura projetada per card; pendentes chip linking `/transactions?pending=1` ("Tudo revisado por aqui ✨" when 0); últimos 5 lançamentos. Current skin, mobile-friendly single column.

- [ ] **Step 1: Failing integration test** for `loadResumoData` on the fake store (delta sign, per-card projection, pending count, recent limit 5).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** queries + page + nav change (also add `/transactions` label already exists in NAV_ITEMS — verify it points at the now-real page).
- [ ] **Step 4: Manual smoke** on :3000.
- [ ] **Step 5: Gate + commit** — `git commit -m "feat(web): /resumo — 10-second daily summary page"`

### Task 6: `/settings` — Configurações + theme cookie

**Files:**
- Create: `apps/web/app/(app)/settings/page.tsx`, `apps/web/app/(app)/settings/actions.ts`
- Modify: `apps/web/app/layout.tsx` (read `ff-theme` cookie server-side, set `data-theme` on `<html>`; default `esmeralda`)
- Modify: `apps/web/app/globals.css` if present, else create — define ONLY the two token sets as CSS custom properties under `:root[data-theme="esmeralda"]` / `[data-theme="salvia"]` (exact hex values from spec §1.1). Full re-skin is Phase 1; this task just makes the toggle real and persisted.
- Test: `apps/web/integration/settings.test.ts`

**Interfaces:**
- Consumes: `listHouseholdMembers`, `updateHouseholdMember`, `findLastBotInteraction`.
- Actions: `setThemeAction(theme: "esmeralda" | "salvia")` → `cookies().set("ff-theme", theme, { path: "/", maxAge: 60*60*24*365 })`; `updateMemberAction(formData)` → validates `telegramUserId` as positive integer or empty→null, displayName trimmed or null, calls `updateHouseholdMember`, revalidates `/settings`.

**Behavior:** theme picker (two swatch buttons); members table (nome de exibição editable, Telegram vinculado editable, role label); bot status card from `findLastBotInteraction` ("último lançamento pelo bot: <data/hora> 🎙️" / "O bot ainda não registrou nada por aqui").

- [ ] **Step 1: Failing integration test**: member update round-trip on fake store incl. telegram id validation error; last-interaction null case.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Manual smoke**: toggle persists across reload (cookie), member name saves.
- [ ] **Step 5: Gate + commit** — `git commit -m "feat(web): /settings — theme cookie, member profiles, bot status"`

### Task 7: Caixinha balances in UI

**Files:**
- Modify: `apps/web/app/(app)/investments/page.tsx` + `actions.ts` (inline balance edit per bucket → `updateInvestmentBucketBalance`)
- Modify: `apps/web/app/(app)/dashboard/queries.ts` (buckets already loaded — surface `balance_cents`; add `bucketsTotalCents`), dashboard card + `/resumo` NOT required to change (resumo spec content is fixed; dashboard card shows total + per-bucket values)
- Test: extend `apps/web/integration` coverage (balance update, negative rejected)

- [ ] **Step 1: Failing test** — update balance persists; negative rejected with error.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** inline edit (R$ input parsed to cents — reuse the app's existing money parsing helper from cards purchase form) + dashboard card totals.
- [ ] **Step 4: Gate + commit** — `git commit -m "feat(web): caixinha manual balances — edit + dashboard totals"`

---

## Phase 3 — Bot production shape

### Task 8: Migration 0008 + conversation store + service-role client

**Files:**
- Create: `supabase/migrations/0008_bot_conversations.sql`
- Modify: `packages/db/src/repositories.ts` + `index.ts` + `types.ts`: `createServiceRoleClient`, `findMemberByTelegramUserId`, `loadBotConversation`, `saveBotConversation`, `deleteBotConversation`
- Test: `packages/db/src/repositories.test.ts` (pure bits) + bot tests in Task 9 exercise the store contract via fakes

**Interfaces (Produces):**

```sql
-- 0008
create table bot_conversations (
  chat_id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table bot_conversations enable row level security;
-- NO policies: anon/authenticated denied by default; service_role bypasses RLS.
```

```typescript
export function createServiceRoleClient(config: { supabaseUrl: string; serviceRoleKey: string }): AppSupabaseClient
// createClient with auth: { persistSession: false, autoRefreshToken: false }

export type BotMemberIdentity = { householdId: string; userId: string; displayName: string | null };
export async function findMemberByTelegramUserId(
  client: AppSupabaseClient, telegramUserId: number,
): Promise<BotMemberIdentity | null>
// household_members where telegram_user_id = X and is_active; maybeSingle

export async function loadBotConversation(client: AppSupabaseClient, chatId: number): Promise<{ state: unknown; updatedAt: string } | null>
export async function saveBotConversation(client: AppSupabaseClient, chatId: number, state: unknown): Promise<void> // upsert, updated_at = now
export async function deleteBotConversation(client: AppSupabaseClient, chatId: number): Promise<void>
```

- [ ] **Step 1: Write migration**, apply with `supabase migration up`, verify via psql (`\d bot_conversations` shows RLS enabled, zero policies).
- [ ] **Step 2: Failing tests → implement repos** (service-role client is config-only — assert it constructs and disables session persistence via its options; no network).
- [ ] **Step 3: Gate + commit** — `git commit -m "feat(db): bot_conversations table + service-role client + telegram member lookup"`

### Task 9: Bot identity + persistent conversations wired into handleWebhook

**Files:**
- Modify: `apps/bot/src/index.ts`
- Create: `apps/bot/src/store.ts` (ConversationStore contract + DB-backed impl + in-memory impl for tests)
- Test: `apps/bot/src/bot.test.ts` (extend)

**Interfaces (Produces — Task 10/11 consume):**

```typescript
// store.ts
export type ConversationStore = {
  load(chatId: string): Promise<ConversationState | undefined>;
  save(chatId: string, state: ConversationState): Promise<void>;
};
export function createInMemoryConversationStore(): ConversationStore
export function createDbConversationStore(client: AppSupabaseClient): ConversationStore
// DB impl: rows with updated_at older than 24h are treated as absent on load and lazily deleted (deleteBotConversation). State is validated structurally on load (has status + draft); malformed → undefined.

// index.ts — handleWebhook args CHANGE (replaces fixed householdId):
export async function handleWebhook(args: {
  rawBody: unknown;
  secretHeader: string | undefined;
  configuredSecret: string | undefined;
  client: AppSupabaseClient;
  telegram: TelegramClient;
  resolveMember: (telegramUserId: string) => Promise<BotMemberIdentity | null>;
  store: ConversationStore;
  ai?: AiCategorizer;
  transcribe?: TranscribeDeps;
}): Promise<WebhookResult>
```

**Behavior:**
- After parsing (voice or text), resolve `fromId` via `resolveMember`. No match → `telegram.sendMessage(chatId, "Oi! Eu ainda não conheço você por aqui — peça pro Alvaro vincular seu Telegram nas Configurações.")`, return 200 (do NOT log unmatched users to `bot_interactions` — no household to scope the row to; log to console).
- Match → `buildDeps(client, identity.householdId, ai)` where `createdByUserId` used by conversation input `fromUserId` becomes `identity.userId` (NOT the raw Telegram id).
- `resolveResponsibleUserId` becomes real inside `buildDeps`: load `listHouseholdMembers`, match name case/accent-insensitively (`normalize("NFD").replace(/\p{M}/gu,"")`, lowercase) against `display_name`; no/ambiguous match → `undefined`.
- Replace the module-scope `Map` entirely with `args.store` (load before, save after each update).
- `startBot()` rewires: `createServiceRoleClient` from `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env (extend `packages/config` envSchema with optional `SUPABASE_URL`; bot falls back to `NEXT_PUBLIC_SUPABASE_URL`), `createDbConversationStore`, `resolveMember` = `findMemberByTelegramUserId`. It no longer calls `findHouseholdIdForCurrentUser` (anon+no-session was broken — this is the fix).

- [ ] **Step 1: Failing tests**: unmatched telegram user → polite refusal + no transaction; matched user → draft created with member's user_id; responsável "Karol" resolves via display_name incl. accent-insensitive ("káról" no — use realistic "karol"/"KAROL"/"Álvaro"→"Alvaro"); conversation survives across two handleWebhook calls sharing a store; stale (>24h) state ignored.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS.**
- [ ] **Step 5: Gate + commit** — `git commit -m "feat(bot): real telegram identity, service-role wiring, persistent conversations"`

### Task 10: LLM text interpretation fallback

**Files:**
- Create: `apps/bot/src/interpret.ts`
- Modify: `apps/bot/src/conversation.ts` (fallback hook in `startConversation` only — corrections stay deterministic), `apps/bot/src/index.ts` (wire), `packages/…` none
- Test: `apps/bot/src/interpret.test.ts` + conversation fallback cases in `bot.test.ts`

**Interfaces:**

```typescript
// interpret.ts
export type InterpretedExpense = {
  amountCents?: number; description: string; occurredOn?: string;
  categoryHint?: string; responsibleHint?: string;
};
export function createTextInterpreter(client: AiCompletionClient): TextInterpreter
export type TextInterpreter = (text: string, options: { today: string }) => Promise<InterpretedExpense | null>
// Prompt (pt-BR) asks for STRICT JSON {amount_cents, description, occurred_on?, category_hint?, responsible_hint?};
// parse with a zod schema; any parse/API failure => null. Reuses AiCompletionClient (same interface the categorizer uses).

// conversation.ts — ConversationDeps gains OPTIONAL:
interpretText?: TextInterpreter;
```

**Behavior (spec §3.4):** in `startConversation`, run `parseExpenseText` first; if it throws no draft OR yields `amountCents === undefined`, and `deps.interpretText` is set, call it; a non-null result maps into the same `ParsedExpense`-shaped draft path (`responsibleHint` through `resolveResponsibleUserId`, `categoryHint` passed to `suggestCategory` context description — do NOT trust it as a category id). Result still lands in `awaiting_confirmation` — user must `confirmar`. Interpreter null → existing "needs_amount / rephrase" behavior unchanged. Voice benefits automatically (same text path).

- [ ] **Step 1: Failing tests**: parser-success case NEVER calls interpreter (spy); parser-miss + interpreter success → awaiting_confirmation with interpreted amount; interpreter null → today's rephrase reply; malformed LLM JSON → null (interpret.test).
- [ ] **Step 2–4: TDD cycle.**
- [ ] **Step 5: Gate + commit** — `git commit -m "feat(bot): LLM text interpretation fallback behind confirmation"`

### Task 11: Webhook server + Dockerfile

**Files:**
- Create: `apps/bot/src/server.ts`
- Create: `apps/bot/Dockerfile`
- Modify: `apps/bot/package.json` (`"start": "tsx src/server.ts"`, add `tsx` dep)
- Test: `apps/bot/src/server.test.ts`

**Interfaces:**

```typescript
// server.ts
export function createBotServer(handle: (rawBody: unknown, secretHeader: string | undefined) => Promise<WebhookResult>): http.Server
// POST /webhook: read body (1MB cap), JSON.parse (invalid → 200 {ok:true} so Telegram stops retrying), pass header
//   "x-telegram-bot-api-secret-token", respond with result.status + JSON body. Handler errors → log + 200.
// GET /health: 200 {"ok":true,"lastUpdateAt":<ISO|null>} (module-level timestamp set per webhook).
// main(): startBot() then listen on PORT (default 8787). Only runs when executed directly (import.meta check).
```

Dockerfile: `node:22-slim`, `corepack enable`, copy workspace manifests + sources (pnpm monorepo context = repo root), `pnpm install --frozen-lockfile --filter @family-finance/bot...`, `CMD ["pnpm","--filter","@family-finance/bot","start"]`. tsx runtime — packages ship raw TS (the NodeNext `dist` question stays tech debt #9).

- [ ] **Step 1: Failing server tests** (inject fake handle): wrong path → 404; GET /health → ok; POST /webhook happy path returns handler status; invalid JSON → 200; secret header forwarded verbatim.
- [ ] **Step 2–4: TDD cycle.** Verify `docker build -f apps/bot/Dockerfile .` completes locally (build only — no run).
- [ ] **Step 5: Gate + commit** — `git commit -m "feat(bot): standalone webhook server + Dockerfile"`

---

## Phase 4 — Deploy artifacts (repo files only; NO live deploy)

### Task 12: Provisioning trigger migration 0009

**Files:**
- Create: `supabase/migrations/0009_member_provisioning.sql`

```sql
-- allowlisted-email auto-provisioning into household "casa" (spec §4.1)
create table allowed_emails (
  email text primary key,
  household_slug text not null default 'casa'
);
alter table allowed_emails enable row level security; -- no policies: service/definer only

insert into allowed_emails (email) values
  ('alvaro.a.a.a.c@gmail.com');
-- NOTE: add Karol's dotted-form Gmail before prod deploy (runbook step) — not known at migration time.

create or replace function provision_household_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
  if exists (select 1 from allowed_emails where lower(email) = lower(new.email)) then
    select h.id into target_household_id from households h limit 1;
    if target_household_id is not null then
      insert into household_members (household_id, user_id, role, is_active)
      values (target_household_id, new.id, 'member', true)
      on conflict (household_id, user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

create trigger provision_member_on_signup
  after insert on auth.users
  for each row execute function provision_household_member();
```

- [ ] **Step 1: Write + apply** (`supabase migration up`).
- [ ] **Step 2: Verify live**: insert a fake `auth.users` row via SQL with an allowlisted email → `household_members` row appears; non-allowlisted email → no row; duplicate signup → no error (on conflict). Clean up test rows.
- [ ] **Step 3: Commit** — `git commit -m "feat(db): auto-provision allowlisted signups into the household (migration 0009)"`

### Task 13: deploy/ tree — compose, Caddy, checks, runbook

**Files:**
- Create: `deploy/README.md` (the runbook — ordered steps below)
- Create: `deploy/supabase/.env.example`, `deploy/supabase/README.md` (pin: clone `supabase/docker` at a tagged release, copy our `.env`, volumes/backup note, `pg_dump` cron line)
- Create: `deploy/caddy/Caddyfile` (`supabase.alvaroekarol.com.br` → kong :8000; `bot.alvaroekarol.com.br` → bot :8787)
- Create: `deploy/bot/docker-compose.yml` (build context `../..`, dockerfile `apps/bot/Dockerfile`, env_file, `restart: unless-stopped`)
- Create: `deploy/bot/.env.example` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `PORT=8787`)
- Create: `deploy/checks/rls-proof.mjs` — RE-CREATE the verification script (original was session-scratch, lost): supabase-js as member vs outsider; asserts (a) member SELECT sees household rows for transactions/accounts/credit_cards/categories, (b) outsider sees zero rows on the same tables, (c) outsider INSERT into transactions rejected, (d) forced-rollback of the 3 RPCs: `merge_category` bogus target → error + source stays active; `confirm_import` second row amount<=0 → no batch/transactions/import_rows persisted; `create_installment_purchase` invalid parcel → no orphan group. Config via env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MEMBER_EMAIL/PASSWORD`, `OUTSIDER_EMAIL/PASSWORD`, `SERVICE_ROLE_KEY` (setup/teardown). Exits non-zero on any failure, prints PASS/FAIL per check.
- Create: `deploy/vercel.md` — env checklist (`NEXT_PUBLIC_SUPABASE_URL=https://supabase.alvaroekarol.com.br`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `AUTHORIZED_EMAILS` dotted forms) + Google OAuth prod redirect registration + GoTrue config mirror of local `config.toml`.

**Runbook order (deploy/README.md):** 1 VPS Supabase up → 2 migrations `supabase db push` → 3 seed household/members + add Karol to `allowed_emails` → 4 `node deploy/checks/rls-proof.mjs` (must pass 100%) → 5 Vercel envs + deploy → 6 Google OAuth prod redirect → 7 bot compose up → 8 `setWebhook` curl (documented verbatim with secret) → 9 bot smoke: text + voice lançamento end-to-end, rows visible in `/transactions` + settings bot status.

- [ ] **Step 1: Write all files.** rls-proof.mjs is runnable against the LOCAL stack — run it there as its own test (all checks PASS locally before commit).
- [ ] **Step 2: Gate + commit** — `git commit -m "chore(deploy): VPS compose/Caddy artifacts, RLS proof script, deploy runbook"`

---

### Task 14: Final whole-branch review + docs

- [ ] Full gate: `pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build && pnpm --filter @family-finance/bot build && pnpm --filter @family-finance/web lint`
- [ ] Adversarial whole-branch review (opus) over Phases 2–3 seams: household scoping on every new repo, parcela delete guard server-side, service-role never imported by web, LLM behind confirmation, migrations idempotent-on-fresh.
- [ ] Fix round (budgeted), re-gate.
- [ ] Update `memory/project-tech-debt.md`: close #1 (caixinha balances), #5 (invoice timing), #12 (bot conversations), #15 (LLM text), bot responsável item; note webhook server closes the "library nobody calls" audit.
- [ ] Update `thoughts/PROGRESS.md` (new session section + Current state) + rewrite `thoughts/2026-07-01-handoff.md`.
- [ ] Commit docs. NO push.

---

## Interfaces appendix (existing, verbatim — do not re-derive)

- `createTransaction(client, draft, options?: { importBatchId?; installmentId? })` → `PersistedTransaction`
- `getMonthlySummary(client, householdId, month)` → `{ month, incomeCents, expenseCents, balanceCents }`
- `getCardPressure(client, householdId, month)` → `{ month, directCents, installmentCents, totalCents }` (household-wide)
- `summarizeCardPressure(month, cardTransactions, dueInstallments)` — pure, reusable for per-card
- `findRecentTransactions(client, householdId, limit = 8)` / `findPendingReviewTransactions(client, householdId, limit = 8)` → `DashboardTransaction[]`
- `needsReview(row: Pick<TransactionRow,"kind"|"category_id">)`: kind !== "transfer" && category_id === null
- `monthDateRange(month)` → `{ start, end }` (end exclusive); `currentMonth(now?)` → `YYYY-MM`
- `listCreditCards(client, householdId)` → `CreditCardRow[]` (`closing_day: number | null`)
- `listInvestmentBuckets(client, householdId)` → `InvestmentBucketRow[]`
- `listAllCategories` / `listAllSubcategories(client, householdId)`
- Web: `createServerSupabaseClient()` (apps/web/lib/supabase.ts), `requireAuthorizedUser()` (lib/auth.ts), `findHouseholdIdForCurrentUser(client)`
- Dashboard: `loadDashboardData(now?)` → `DashboardData` in `app/(app)/dashboard/queries.ts`; `formatBrlCents(cents)`
- Bot: `handleWebhook` current signature in `apps/bot/src/index.ts:174`; `ConversationDeps`/`ConversationState` in `conversation.ts`; `parseExpenseText(text, { today })` → `ParsedExpense`; `AiCompletionClient` in `providers.ts`; `createAnthropicCompletionClient({ apiKey, model, timeoutMs? })`
- Config: `getServerEnv()`, `getLlmConfig()`, `getTranscriptionConfig()` in `packages/config`
- Fake store: `apps/web/integration/fake-supabase.ts` (`FakeSupabaseStore`, builder chain `.eq/.neq/.gte/.lte/.is/.not().order().limit().single().maybeSingle()` — `.ilike/.range/count` added in Task 2)
- NAV_ITEMS: `apps/web/app/(app)/layout.tsx:10-19`
