# Tech debt

Punted issues, deferred improvements, and known shortcomings. Append entries with absolute date + short context. Don't reorganize without being asked.

## Entries

> Migrado de `memory/project-tech-debt.md` em 2026-07-03 (o arquivo antigo é um ponteiro pra cá).

Track known compromises here. Debt should be specific enough that a future agent can act on it.

## Open Debt

## 2026-06-29: Migration 0001 shipped no table GRANTs (found via live Supabase)

**Area:** supabase/migrations

**Impact:** `0001` created every table but issued no GRANTs to the Supabase API
roles (`anon`/`authenticated`/`service_role`), relying on implicit default
privileges. On a fresh Supabase those default privileges (for the migration owner
`postgres`) grant the API roles only `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)
— NO SELECT/INSERT/UPDATE/DELETE — so PostgREST returns "permission denied for
table …" for every table regardless of RLS. The web app + bot would be 100%
broken on first real deploy. Invisible to the offline throwaway-Postgres checks:
those connected as the table owner/superuser, which skips the table-privilege
layer entirely. Only surfaced against the real Supabase API roles.

**Current workaround:** n/a — fixed.

**Revisit trigger:** n/a.

**Status:** resolved (2026-06-29) — added `supabase/migrations/0005_api_grants.sql`
granting tables+sequences to anon/authenticated/service_role plus ALTER DEFAULT
PRIVILEGES for future tables; the SECURITY DEFINER RPCs keep their explicit
0002–0004 execute grants (functions intentionally NOT re-granted). Proven on a
real local Supabase (CLI + Docker, `supabase start` / `db reset`): a 26-check
RLS + RPC proof flipped FAIL→PASS after the grant and re-passes from a clean
`db reset` off the migration alone. RLS still gates which rows each caller sees.

## 2026-06-22: Caixinhas have no balance / position (Task 9)

**Area:** supabase schema + apps/web/app/(app)/investments

**Impact:** Spec §08 says caixinhas support "saldo manual ou posição simples", but the
committed `investment_buckets` table (migration 0001) has only `name` + `slug`. The
Investimentos UI is name-only; the dashboard cannot show bucket balances.

**Current workaround:** Caixinhas are modeled as labeled buckets without a tracked amount.

**2026-06-22 (Task 10):** The dashboard ships with this limitation: the "Caixinhas" summary
card shows the bucket COUNT + names (spec §08 "posição simples"), not a balance, and there is
no caixinhas-balance query. When a balance is added (below), extend `loadDashboardData` to
surface it.

**Revisit trigger:** Add a `balance_cents` (or a simple positions table) via a new
migration when the dashboard needs to show caixinha balances; then extend the
`investment_buckets` repos + Investimentos UI + the dashboard caixinhas card.

**Status:** resolved (2026-07-01, v1.0 phases run) — migration `0007` added
`investment_buckets.balance_cents` (check >= 0); `updateInvestmentBucketBalance` repo;
Investimentos UI inline "Atualizar saldo" (pt-BR reais parsing, zero allowed); dashboard
Caixinhas card shows combined total + per-bucket values (`bucketsTotalCents`).

## 2026-06-22: Parcelado purchase write is not transactional (Task 9)

**Area:** packages/db `createInstallmentPurchase`

**Impact:** Persisting a parcelado card purchase inserts the `installment_groups` row then
the `installments` rows in two calls (Supabase JS has no client-side transaction). If the
parcel insert fails, a childless group is orphaned.

**Current workaround:** Errors surface to the user; the (empty) group can be retried/cleaned
up. Acceptable at family-MVP volume. Mirrors the same note on `mergeCategory`.

**Revisit trigger:** Move the group+parcels insert into a single Postgres RPC if partial
writes become a real problem.

**Status:** resolved (2026-06-28, commit 376ddaf) — added `create_installment_purchase`
SECURITY DEFINER RPC (migration `0002`) that inserts the group + all parcels in one
transaction with explicit `is_household_member` re-assertion; `createInstallmentPurchase`
now calls it. Atomic rollback proven on a throwaway Postgres 16 (forced NULL-parcel
failure leaves no orphan group).

## 2026-06-22: Web lint has no eslint config

**Area:** apps/web

**Impact:** `pnpm lint` for the web app runs `next lint` with no eslint config; first real run will scaffold/prompt. Not covered by Task 1 verification.

**Current workaround:** `lint` left as `next lint`; lint is not part of the baseline green gate.

**Revisit trigger:** Adding the first web feature, or wiring lint into CI.

**Status:** resolved (2026-06-28, commit b089652) — added `apps/web/.eslintrc.json`
(`next/core-web-vitals`) + `eslint`/`eslint-config-next` dev deps; `pnpm --filter
@family-finance/web lint` runs non-interactively and reports clean. Now part of the green gate.

## 2026-06-22: Packages use `--passWithNoTests`

**Area:** all packages and apps

**Impact:** `test` scripts pass even when a package has zero tests, so an accidentally empty test suite would not fail.

**Current workaround:** `vitest run --passWithNoTests` keeps `pnpm test` green until real tests exist (Task 2+).

**Revisit trigger:** Once a package has real tests, the flag is a harmless no-op but can be dropped for that package.

**Status:** resolved (2026-06-28, commit 7a5894f) — dropped `--passWithNoTests` from every
package/app that now has real test files; kept only where a package genuinely has zero tests.
`pnpm test` stays green (117 tests).

## 2026-06-22: Installments use month attribution, not invoice timing

**Area:** packages/domain (`installments.ts`), and future cards/dashboard UI

**Impact:** Installments carry a `dueMonth` (`YYYY-MM`) attributed by purchase month, not a real invoice due date. `CreditCard.closingDay`/`dueDay` exist but are unused. Card pressure projections are approximate (no closing-day shift of the first installment).

**Current workaround:** Dashboard projections group by `dueMonth`, which is enough for the MVP summary and keeps generation stable and invoice-free.

**Revisit trigger:** When the dashboard/cards UI needs accurate invoice timing (Task 9/10), derive the first installment's month from the card closing day.

**Status:** resolved (2026-07-01, v1.0 phases run, commit 7dd3735) — `createInstallmentPlan`
gained optional `closingDay` (1–28): purchase day > closing day shifts all dueMonths +1.
Callers (cards purchase actions, fatura import confirm) pass the card's `closing_day`.
Existing groups intentionally NOT regenerated (spec §2.6).

## 2026-06-22: Web auth uses a hand-rolled SSR cookie adapter instead of `@supabase/ssr`

**Area:** apps/web (`lib/supabase.ts`)

**Impact:** The recommended package `@supabase/ssr` was not installable in the offline
build environment (absent from the pnpm store/cache, no network). The server Supabase
client is built directly on `@supabase/supabase-js` with a custom Next.js cookie
`storage` adapter (the same mechanism `@supabase/ssr` uses internally) and a single
JSON session cookie. Token refresh (`autoRefreshToken`) is disabled in this path, and
the cookie write path is best-effort (silently ignored in read-only server contexts).
This is functionally sufficient for the guard/allowlist flow but is not the maintained
upstream integration.

**Current workaround:** Custom adapter + `getUser()` validation; the pure access policy
(`evaluateAccess`) is independent of the wiring and fully tested.

**Revisit trigger:** When the npm registry is reachable, run
`pnpm add @supabase/ssr --filter @family-finance/web` and replace `lib/supabase.ts`
with `createServerClient` from `@supabase/ssr` (add a middleware/route handler for the
OAuth code exchange + session refresh). Remove the manual cookie adapter.

**Status:** resolved (2026-06-28, commit 3a42673) — `lib/supabase.ts` now uses
`createServerClient` from `@supabase/ssr` with the App Router `getAll`/`setAll` cookie
adapter; the hand-rolled `SupportedStorage` adapter is gone. Added `app/auth/callback/route.ts`
(OAuth code exchange) and `middleware.ts` (session refresh); allowlist `evaluateAccess` flow
intact. Build + auth unit tests green. The OAuth round-trip and session flow were later
exercised successfully against the self-hosted production Supabase deployment.

## 2026-06-22: `@supabase/supabase-js` symlinked manually into apps/web

**Area:** apps/web/node_modules, pnpm-lock.yaml

**Impact:** Because `pnpm install` could not run online, the new `@supabase/supabase-js`
direct dependency of `apps/web` was linked by hand into `apps/web/node_modules` and the
lockfile was updated via `pnpm install --offline --lockfile-only`. node_modules is
gitignored, so the symlink is local-only; CI/fresh clones rely on a normal `pnpm install`
recreating it from the (now correct) lockfile entry.

**Current workaround:** Manual symlink + lockfile-only update; build and typecheck are green.

**Revisit trigger:** First clean `pnpm install` with network — verify the dep resolves
without the manual symlink and the lockfile is unchanged.

**Status:** resolved (2026-06-28) — not real debt. Removed the symlink and ran a clean
`pnpm install` (network now reachable): pnpm recreated `apps/web/node_modules/@supabase/supabase-js`
automatically (standard pnpm node_modules layout) and `pnpm-lock.yaml` was unchanged. No code change needed.

## 2026-06-22: Category merge is not atomic (no DB transaction)

**Area:** packages/db (`repositories.ts` `mergeCategory`), apps/web Categorias UI

**Impact:** `mergeCategory` re-points transactions, installment_groups, installments,
subcategories, and categorization_memory, then archives the source — as a sequence of
separate household-scoped `UPDATE`s. Supabase JS has no client-side transaction, so a
mid-sequence failure could leave a partially-merged state.

**Current workaround:** Each step is idempotent and re-runnable (filtering on the source
category id), so re-invoking the merge converges. Acceptable for the single-household MVP.

**Revisit trigger:** If merges become frequent or larger, move the logic into a Postgres
`SECURITY DEFINER` RPC function so the whole merge runs in one transaction.

**Status:** resolved (2026-06-28, commit 046adfa) — added `merge_category` SECURITY DEFINER
RPC (migration `0003`) that performs all re-points + the source archive in one transaction,
household-scoped with safe `search_path`; `mergeCategory` now calls it. Migration applies
cleanly to fresh Postgres 16; happy path covered by the db/web tests. (2026-06-29: rollback
NOW force-proven on a real local Supabase — a bogus `target_category_id` triggers an FK
violation mid-merge; afterward the source category stays active and the transaction stays
pointed at the source, i.e. no partial merge.)

## 2026-06-22: Web build needs `extensionAlias` for NodeNext `.js` specifiers

**Area:** apps/web (`next.config.mjs`)

**Impact:** Shared packages are authored as NodeNext ESM TS and expose `main: src/index.ts`,
so intra-package relative imports carry explicit `.js` extensions. Next's webpack uses
Bundler-style resolution and does not rewrite those, which broke the web build once a page
imported a transitively-`.js`-importing module (`@family-finance/db` repositories,
`@family-finance/categorization`). Fixed by adding the packages to `transpilePackages` and a
webpack `resolve.extensionAlias` mapping `.js` -> `.ts`/`.tsx`. This is a build-config
workaround, not the package's own concern.

**Current workaround:** `extensionAlias` in `next.config.mjs`; build is green.

**Revisit trigger:** If shared packages start publishing built `dist` output with proper
`exports`/`types` maps (instead of raw `src`), the alias can be removed.

**Status:** open

## 2026-06-22: Import writes rows one-by-one and skips `import_rows`

**Area:** apps/web (`app/(app)/imports/actions.ts`), packages/db

**Impact:** `confirmImport` inserts one transaction per kept row in a loop (no bulk
insert, no DB transaction), so a large historical import is many round-trips and can
fail partway — the persisted `import_batch` records `imported`/`error` counts but there
is no rollback. The `import_rows` table is also left unpopulated, so there is no per-row
audit trail of what was imported (only the batch summary). Imported transactions are NOT
linked to their batch via `import_batch_id` (the batch is created after the rows).

**Current workaround:** Single-household MVP volumes are small; the batch summary plus
per-row write errors surfaced in the UI are enough. `createTransaction` already supports
an `importBatchId` option if linkage is later wanted (create the batch first).

**Revisit trigger:** Large imports become slow/partial, or per-row reprocessing/audit is
needed — move to a bulk insert or a Postgres RPC that writes the batch + rows + linked
transactions in one transaction.

**Status:** resolved (2026-06-28, commit 7733473) — added `confirm_import` SECURITY DEFINER
RPC (migration `0004`) that, in one transaction, creates the `import_batch`, bulk-inserts the
kept transactions linked via `import_batch_id`, AND writes the `import_rows` audit records;
`confirmImport` now calls it (batch-summary return shape preserved). Migration applies cleanly
to fresh Postgres 16; integration mvp-flow test reconciles the same totals. (2026-06-29: rollback
NOW force-proven on a real local Supabase — a second row whose transaction has `amount_cents <= 0`
violates the CHECK mid-loop; afterward no `import_batch`, no transactions, and no `import_rows`
persist, including the first valid row.)

## 2026-06-22: Only name-matched CSV adapters; no XLSX or format variants

**Area:** packages/importers

**Impact:** Minhas Financas and Nubank adapters match CSV headers by name (accent-folded)
and auto-detect `;`/`,` delimiter, but there is no XLSX adapter and no distinct handling
of Minhas Financas "CSV padrão" vs "customizado" vs "XLSX exportado" (spec §07 lists all
three). Real exports may use other column names/encodings not yet covered.

**Current workaround:** Unmapped rows + unrecognized headers return as reviewable errors
(never a hard failure), and re-import after fixing the file is the documented recovery.

**Revisit trigger:** Real export samples are available — add fixtures + adapters behind the
existing `ImportAdapter` contract and register them in `importAdapters`.

**Status:** open

## 2026-06-22: Bot conversation state is in-memory only (Task 7)

**Area:** apps/bot (`index.ts` per-chat `Map`)

**Impact:** The confirmation state machine keeps each chat's in-progress draft in a
process-local `Map`. It does not survive a restart and is not safe across multiple
replicas / serverless invocations — a confirm could land on an instance that never
saw the original message and would be treated as a fresh entry.

**Current workaround:** Single small household, single instance. `conversation.ts`
is pure/stateless (state is passed in), so swapping the store is isolated to `index.ts`.

**Revisit trigger:** Bot deployed serverless or multi-replica — persist conversation
state (e.g. a `bot_conversations` table keyed by chat id, or Redis).

**Status:** resolved (2026-07-01, v1.0 phases run, commits 19ecb3d + a464627) —
migration `0008` added `bot_conversations` (chat_id pk, jsonb state, RLS on / no
policies = service-role only); `apps/bot/src/store.ts` `ConversationStore` (DB-backed +
in-memory for tests), >24h-stale states ignored + lazily deleted; the module-scope Map
is gone.

## 2026-06-22: No `createBotInteraction` repo; bot inserts directly (Task 7)

**Area:** apps/bot (`index.ts` `logInteraction`), packages/db

**Impact:** `bot_interactions` rows are written by a direct `client.from("bot_interactions").insert(...)`
inside the bot, not through a `packages/db` repository like every other write path.

**Current workaround:** The insert is injected via `ConversationDeps.logInteraction`, so the
boundary is preserved and it is mockable in tests; it is just not a named repo.

**Revisit trigger:** Add a `createBotInteraction(client, payload)` repo (and a `BotInteractionInsert`
type) when another caller needs to log interactions or for consistency.

**Status:** resolved (2026-06-28, commit e8109ae) — added `createBotInteraction(client, payload)`
repo + `BotInteractionInsert` type in `packages/db`; the bot's `logInteraction` now calls it
instead of the raw `client.from("bot_interactions").insert(...)`. Still injected via
`ConversationDeps.logInteraction`, so it stays mockable. Behavior identical; bot tests green.

## 2026-06-22: Telegram "responsável <nome>" is a no-op in production wiring (Task 7)

**Area:** apps/bot (`index.ts` `resolveResponsibleUserId`)

**Impact:** Corrections like "responsável Karol" map a display name to a member user id, but
the production wiring returns `undefined` (no display-name → `household_members` id map exists),
so live responsible-person corrections silently fall back to the house. The behavior IS covered
in tests via an injected resolver, and `createTransactionDraft` already supports it.

**Current workaround:** Responsibility defaults to the house (the spec default); the plumbing is
ready for a real resolver.

**Revisit trigger:** When household members have display names — wire a name→user-id lookup into
`resolveResponsibleUserId`.

**Status:** resolved (2026-07-01, v1.0 phases run, commit a464627) — members now carry
`display_name` (migration `0007`, editable in /settings); `resolveResponsibleUserId`
does a case/accent-insensitive match against active members' display names.

## 2026-06-22: AI provider resilience and response parsing (Task 8)

**Area:** apps/bot (`providers.ts`, `audio.ts`)

**Impact:** The edge `createAnthropicCompletionClient` (categorization fallback) and
`createOpenAiTranscriptionProvider` (Whisper) parse real provider HTTP responses but are
not unit-tested against the live API shapes (no network/secrets) — only the interfaces they
implement are mock-tested. There is also no timeout/retry on the provider `fetch` calls and
no max size/duration guard before a voice note is downloaded to a temp file and transcribed.

**Current workaround:** Any AI failure degrades to the deterministic path
(`createAiCategorizer` returns `null`; transcription errors still delete the temp file).
Family-MVP volumes and single-user usage keep risk low.

**Revisit trigger:** Reopen only if a provider changes its response contract or production
telemetry shows parsing/timeout regressions.

**Status:** resolved (2026-07-09). AbortController-based timeouts cover Anthropic and
OpenAI calls, voice notes have size/duration guards, and failures degrade safely. Production
telemetry has recorded successful Anthropic completion and Whisper transcription calls,
which verifies that both live HTTP response shapes cross the parsing seam. Model correctness
is a separate open quality item below; a successful API call does not prove a good answer.

## 2026-07-09: AI semantic quality is not measured

**Area:** apps/bot, packages/categorization, evaluation tooling

**Impact:** Telemetry records provider success, latency, tokens, status, and errors, but it
does not show whether intent, merchant cleanup, amounts, installment semantics, or categories
were correct. Haiku can be operationally healthy while still creating correction-heavy drafts.

**Current workaround:** Every draft requires confirmation and users can correct fields or
categories before persistence. Deterministic parsing remains authoritative where reliable.

**Revisit trigger:** Before changing the production model or prompts, run a versioned pt-BR
evaluation set across Claude and GPT candidates. Track exact intent/field accuracy, ranked
category usefulness, abstention quality, latency/cost, and the corrections a user would make.
Use Codex to review the prompt and dataset for contradictory labels, leakage, and missing cases.

**Status:** open

## 2026-06-22: LLM not used for complex/incomplete TEXT interpretation (Task 8)

**Area:** apps/bot, packages/categorization

**Impact:** The spec lists AI for "interpretação de mensagens complexas ou incompletas", but
the LLM is currently wired only for the categorization fallback and audio transcription. A
complex/ambiguous TEXT message still relies on the deterministic `parser.ts` and only gets
AI help for the category, not for value/date/intent extraction.

**Current workaround:** Deterministic parser flags uncertain fields and the confirmation
flow lets the user correct them; the categorization AI fallback covers ambiguous categories.

**Revisit trigger:** If deterministic text parsing proves too weak in real use — add an LLM
text-interpretation step (reuse `AiCompletionClient`) behind the same confirmation flow.

**Status:** resolved (2026-07-01, v1.0 phases run, commit 4c18afb) —
`apps/bot/src/interpret.ts` `createTextInterpreter(AiCompletionClient)` was later widened
to run for every new message when configured. Strict JSON/Zod validation feeds the SAME
confirmation flow (never saves directly); deterministic parsing retains reliable
amount/date precedence and any AI failure degrades safely.

## 2026-07-01: allowed_emails.household_slug is written but never read

**Area:** supabase/migrations/0009_member_provisioning.sql

**Impact:** The provisioning trigger inserts allowlisted signups into the FIRST
household (`select h.id from households h limit 1`) and ignores
`allowed_emails.household_slug`. Correct for the single-household v1.0, but silently
wrong if a second household ever exists.

**Current workaround:** Single household ("Casa") — first row is the only row.

**Revisit trigger:** Multi-household support — join `households` on the slug (needs a
slug column on households) or drop the `household_slug` column.

**Status:** open (flagged MINOR by the v1.0 final whole-branch review)

## 2026-07-02: Resumo lacks a spending-by-category chart

**Area:** apps/web/app/(app)/resumo (+ a new db aggregate query)

**Impact:** User asked for a "gasto por categoria" visual on /resumo; deferred by request
("pro futuro"). Today the resumo shows the composite total (conta + cartão) and the
per-card invoices, but no category breakdown anywhere in the app.

**Current workaround:** /transactions with the category filter answers the question
manually.

**Revisit trigger:** User asks again after living with v1.0 — add a household-scoped
`getMonthlyCategoryTotals(client, householdId, month)` repo (group expense transactions
by category, join names) + a simple bar/donut on /resumo using the design-system tokens
(no chart library; PressureBars-style CSS is enough).

**Status:** open (deferred by user, 2026-07-02)

## 2026-07-04: account/card/category FKs were not household-scoped at the DB layer

**Area:** supabase schema (transactions), packages/db write paths

**Impact:** The `transactions.account_id`/`credit_card_id` foreign keys only check
that the referenced row EXISTS — nothing at the DB layer asserts the instrument
belongs to the SAME household as the transaction. A crafted request could point a
transaction at another household's account/card id (RLS hides the other
household's rows from reads, but the FK insert/update itself succeeds via the
service-role bot path or any authenticated write whose RLS policy doesn't join
the instrument's household). Flagged by the 2026-07-04 final whole-branch review
of the manual-entry feature; pre-existing — applies equally to the bot, import,
and card-purchase paths, not introduced by that branch.

**Current workaround:** n/a — fixed.

**Revisit trigger:** When adding another household-owned foreign key, include a
same-household composite constraint in the same migration.

**Status:** resolved (2026-07-04). Migration `0013_composite_household_fks.sql`
adds `UNIQUE (household_id, id)` parent keys and composite foreign keys for
accounts, cards, categories, and subcategories across transactions,
installments, categorization memory, and obligations. Same-household references
are now enforced for every write path, including service-role RPCs.

## 2026-09-05: Alternativa B (obligation × month grid) never built

**Area:** apps/web/app/(app)/obligations (timeline-card.tsx)

**Impact:** The redesign spec offered two ways to read the 12-month horizon:
option A (the change-only list that shipped) and option B, a grid of obligation
rows × month columns. A picked A and B went to "Out of scope". The list answers
"what changes next month?" well but cannot answer "which months does *this one*
obligation still hit?" without opening each month's `<details>` — B was the view
that made a single template's future scannable.

**Current workaround:** The timeline's per-month `<details>` lists that month's
entries, and the edit dialog's progress panel gives one template's term span
("Parcela n de N · começou em … · termina em …").

**Revisit trigger:** More than ~8 active templates, or the user asking to see one
obligation across the horizon. Build it as an optional secondary view of the same
card (a segmented "Por mês | Grade" toggle over the existing `timeline` slots),
not a replacement — the change-only list is the default by design choice.

**Status:** open (deferred by design choice, 2026-09-04 spec "Out of scope")

## 2026-09-05: No Playwright coverage for the obligation dialogs

**Area:** apps/web/e2e

**Impact:** The redesign added five write round trips with no browser-level test:
create (both term modes), edit, encerrar (inline confirm), mark paid, and
desfazer. They are covered offline — `apps/web/integration/` drives the actions
and view model against the fake Supabase store — but nothing exercises the real
dialogs, the pending states, or the inline error paths in a browser. Visual QA
for this branch was also left to a human for the same reason (see
`thoughts/features/recurring-obligations/progress.md`, 2026-09-05 entry).

**Current workaround:** Integration tests over the fake store + a manual visual
QA checklist in the progress entry.

**Revisit trigger:** An e2e auth fixture exists. Both existing specs
(`e2e/mvp-flow.spec.ts`, `e2e/manual-transaction-installments.spec.ts`) skip
their authenticated halves unless `E2E_STORAGE_STATE` points at a pre-captured
allowlisted Google session, because OAuth cannot be scripted headlessly. Once
capturing that session is routine (or we add a test-only sign-in path), add an
`e2e/obligations.spec.ts` covering the five round trips.

**Status:** open

## 2026-09-05: `Field` renders a `<label>` with no association, so inputs have no accessible name

**Area:** apps/web/components/ui/forms.tsx

**Impact:** `Field` renders `<label className="ff-field__label">{label}</label>`
as a **sibling** of `{children}` — no `htmlFor`, no generated `id`, and the
control is not nested inside the label either. So no input rendered through
`Field` has an accessible name anywhere in the app: screen readers announce
"edit text, blank", and clicking the label does not focus the control. The new
obligation dialogs inherit this for every field they render (Nome, Valor por mês,
Primeira parcela, Vence todo dia, Quantas parcelas, Conta, Categoria).

**Current workaround:** None. The visual label is adjacent, so sighted mouse
users are unaffected.

**Revisit trigger:** Any accessibility pass, or the first screen-reader report.
Fix in the primitive: `useId()` in `Field`, put it on the `<label htmlFor>`, and
pass it down (a render-prop or a `cloneElement` on the child's `id`) so every
call site is fixed at once — there are enough of them that patching call sites
individually is the wrong move.

**Status:** open

## 2026-09-05: `MONTH_NAMES_PT` duplicated in two pages while `lib/format.ts` owns the helpers

**Area:** apps/web/app/(app)/dashboard/page.tsx, apps/web/app/(app)/transactions/page.tsx

**Impact:** Three copies of the same twelve-string array live in the web app:
`lib/format.ts:36` (behind the exported `monthLabelPtBr` / `monthNamePtBr`, which
the redesign introduced and `/obligations` uses) plus private copies in
`dashboard/page.tsx:26` and `transactions/page.tsx:46`, each with its own local
month-label function. A copy edit to a month name has to be made three times.

**Current workaround:** They currently agree, so nothing is visibly wrong.

**Revisit trigger:** Next time either page is touched — delete the local array
and local formatter, import `monthNamePtBr` / `monthLabelPtBr` from
`@/lib/format`.

**Status:** open

## 2026-09-05: English domain-validation messages can reach the obligations UI

**Area:** apps/web/app/(app)/obligations/actions.ts

**Impact:** `actionFailure` treats any `Error.message` as user-facing unless it
matches `isInternalErrorMessage` — a small denylist (`/^\w+ (lookup )?failed: /`,
`Missing required field`, `No active household`); everything else is shown
verbatim in the dialog's `ff-alert--negative`, and only otherwise falls back to
`Não foi possível salvar a obrigação.` That is deliberate for the pt-BR refusals
we author (e.g. `Esse lançamento não é um pagamento de obrigação.`), but the same
pass-through will surface English domain-validation text and raw Zod strings
straight into the UI: `createObligationAction` throws
`result.errors.map((e) => e.message).join(" ")` and those messages come from
`createObligationInputSchema.safeParse` in `packages/domain/src/obligations.ts`,
i.e. Zod's default English text.

**Current workaround:** The form's own client-side constraints (`required`,
`min`/`max`, number inputs) keep the common invalid submissions from reaching the
domain validator, so this is rarely hit in practice.

**Revisit trigger:** The first English string reported in a dialog. Invert the
policy — tag public errors explicitly (a `PublicError` class or an
`{ ok: false, error }` return from the domain layer) instead of denylisting
internal ones, and give the obligation validators pt-BR messages.

**Status:** open

## 2026-09-05: `updateObligation` cannot tell "no such obligation" from "nothing to change"

**Area:** packages/db/src/repositories.ts (`updateObligation`)

**Impact:** The function returns `void` and checks only `error`. A Supabase
`update` matching zero rows is not an error, so a bogus or another household's
obligation id produces `{ ok: true }` from `updateObligationAction` — the edit
dialog closes and toasts "Obrigação atualizada." having written nothing. It also
returns early when the change set is empty (`Object.keys(update).length === 0`),
so both cases look identical to callers. Not a data-integrity hole (the
`household_id` filter still scopes the write), just a silent no-op reported as
success.

**Current workaround:** Ids only ever come from the page's own rendered rows, so
a mismatch means the row was deleted or moved households since render.

**Revisit trigger:** Any bug report of "I saved and nothing changed", or when
another caller (bot, API) starts passing ids it did not just read. Select
`{ count: "exact" }` on the update and throw / return a distinguishable result
when the count is 0.

**Status:** open

## 2026-09-05: `payment-dialog.tsx` hand-rolls the dialog shell

**Area:** apps/web/app/(app)/obligations/payment-dialog.tsx

**Impact:** `obligation-dialog-shell.tsx` was extracted during the redesign and
is used by the create and edit dialogs (and its `useObligationAction` hook by the
undo button), but the older payment dialog still writes its own
`ff-dialog` / `ff-dialog__surface` / `__header` / `__close` / `__actions` markup
plus its own open/close, focus, and escape handling. Three copies of the dialog
contract on one page: a fix to focus trapping or escape handling has to be
applied twice.

**Current workaround:** The markup and class names currently match, so the two
shells look and behave the same.

**Revisit trigger:** The next change to dialog focus/escape/scroll-lock
behaviour, or the next a11y pass — port `payment-dialog.tsx` onto
`obligation-dialog-shell.tsx` then.

**Status:** open

## 2026-09-05: Design-system inconsistencies in the new obligations styles

**Area:** apps/web/components/ui/ui.css

**Impact:** Three small drifts found in review of the redesign CSS, none
user-visible on their own but each a wrong precedent to copy:
- `.ff-dialog__close:focus-visible` (line ~451) indicates focus with
  `color` / `background` / `border-color` and `outline: none` — no ring. The
  convention elsewhere (e.g. `.ff-seg__item:focus-visible`) is a two-step
  `box-shadow: 0 0 0 2px var(--ff-accent), 0 0 0 4px var(--ff-tint)` over a
  transparent outline (which survives forced-colors mode). The close button is
  the weakest focus target in the app.
- **Two "faded row" opacities:** `.ff-checklist__row--paid` uses `0.72` while
  `.ff-off` (the shared fade, used for the encerradas list) uses `0.55`. The
  0.72 traces to the mockup and the code comment says so, but "faded" now means
  two different things.
- **Two progress-track naming families:** `.ff-bar__track` / `.ff-bar__fill`
  (line ~718) and `.ff-track` / `.ff-track__fill` / `.ff-track__fill--positive`
  (line ~2749) are the same idea under two prefixes.

**Current workaround:** n/a — cosmetic and consistent within each usage.

**Revisit trigger:** Next design-system pass: give `.ff-dialog__close` the
accent+tint ring, pick one faded-row opacity (or name the two states), and
collapse the track families into one.

**Status:** open
## 2026-09-03: No migration control on the production VPS (P0)

**Priority:** P0

**Area:** `deploy/migrate.sh`, `supabase/migrations/`, self-hosted Supabase

**Impact:** Production migrations were applied through raw psql with no ledger.
Two later changes also reused the already-occupied `0018` and `0019` numbers,
making filenames insufficient evidence of the live schema.

**Current workaround:** The live database was fingerprinted directly. It has
the effects of both colliding pairs: payment-account override, installment
idempotency, legacy payment-RPC cleanup, and category kinds.

**Revisit trigger:** Before the next bot or web deployment, deploy this branch,
take a fresh database backup, run `./deploy/migrate.sh baseline 0021`, verify
`status`, and use `apply` before every subsequent build/restart.

**Status:** in progress (2026-09-03) — the controller, checksum ledger,
schema-fingerprint gate, canonical `0020`/`0021` files, and repeat-application
test are implemented locally. Production remains unledgered until the explicit
one-time baseline is approved and run.

## Entry Format

```md
## YYYY-MM-DD: Short Title

**Area:** package/app/file

**Impact:** What this makes harder, riskier, slower, or more confusing.

**Current workaround:** How the project currently survives with this debt.

**Revisit trigger:** What event should make us fix it.

**Status:** open | in-progress | resolved
```
