# Project Tech Debt

Track known compromises here. Debt should be specific enough that a future agent can act on it.

## Open Debt

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

**Status:** open

## 2026-06-22: Parcelado purchase write is not transactional (Task 9)

**Area:** packages/db `createInstallmentPurchase`

**Impact:** Persisting a parcelado card purchase inserts the `installment_groups` row then
the `installments` rows in two calls (Supabase JS has no client-side transaction). If the
parcel insert fails, a childless group is orphaned.

**Current workaround:** Errors surface to the user; the (empty) group can be retried/cleaned
up. Acceptable at family-MVP volume. Mirrors the same note on `mergeCategory`.

**Revisit trigger:** Move the group+parcels insert into a single Postgres RPC if partial
writes become a real problem.

**Status:** open

## 2026-06-22: Web lint has no eslint config

**Area:** apps/web

**Impact:** `pnpm lint` for the web app runs `next lint` with no eslint config; first real run will scaffold/prompt. Not covered by Task 1 verification.

**Current workaround:** `lint` left as `next lint`; lint is not part of the baseline green gate.

**Revisit trigger:** Adding the first web feature, or wiring lint into CI.

**Status:** open

## 2026-06-22: Packages use `--passWithNoTests`

**Area:** all packages and apps

**Impact:** `test` scripts pass even when a package has zero tests, so an accidentally empty test suite would not fail.

**Current workaround:** `vitest run --passWithNoTests` keeps `pnpm test` green until real tests exist (Task 2+).

**Revisit trigger:** Once a package has real tests, the flag is a harmless no-op but can be dropped for that package.

**Status:** open

## 2026-06-22: Installments use month attribution, not invoice timing

**Area:** packages/domain (`installments.ts`), and future cards/dashboard UI

**Impact:** Installments carry a `dueMonth` (`YYYY-MM`) attributed by purchase month, not a real invoice due date. `CreditCard.closingDay`/`dueDay` exist but are unused. Card pressure projections are approximate (no closing-day shift of the first installment).

**Current workaround:** Dashboard projections group by `dueMonth`, which is enough for the MVP summary and keeps generation stable and invoice-free.

**Revisit trigger:** When the dashboard/cards UI needs accurate invoice timing (Task 9/10), derive the first installment's month from the card closing day.

**Status:** open

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

**Status:** open

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

**Status:** open

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

**Status:** open

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

**Status:** open

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

**Status:** open

## 2026-06-22: No `createBotInteraction` repo; bot inserts directly (Task 7)

**Area:** apps/bot (`index.ts` `logInteraction`), packages/db

**Impact:** `bot_interactions` rows are written by a direct `client.from("bot_interactions").insert(...)`
inside the bot, not through a `packages/db` repository like every other write path.

**Current workaround:** The insert is injected via `ConversationDeps.logInteraction`, so the
boundary is preserved and it is mockable in tests; it is just not a named repo.

**Revisit trigger:** Add a `createBotInteraction(client, payload)` repo (and a `BotInteractionInsert`
type) when another caller needs to log interactions or for consistency.

**Status:** open

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

**Status:** open

## 2026-06-22: AI provider HTTP clients are untested + lack timeout/size limits (Task 8)

**Area:** apps/bot (`providers.ts`, `audio.ts`)

**Impact:** The edge `createAnthropicCompletionClient` (categorization fallback) and
`createOpenAiTranscriptionProvider` (Whisper) parse real provider HTTP responses but are
not unit-tested against the live API shapes (no network/secrets) — only the interfaces they
implement are mock-tested. There is also no timeout/retry on the provider `fetch` calls and
no max size/duration guard before a voice note is downloaded to a temp file and transcribed.

**Current workaround:** Any AI failure degrades to the deterministic path
(`createAiCategorizer` returns `null`; transcription errors still delete the temp file).
Family-MVP volumes and single-user usage keep risk low.

**Revisit trigger:** Before real deployment — verify provider response parsing with live
keys, add a `fetch` timeout + graceful "tente por texto" fallback, and a voice-note size
guard in `transcribeVoiceMessage`.

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

**Status:** open

## Entry Format

```md
## YYYY-MM-DD: Short Title

**Area:** package/app/file

**Impact:** What this makes harder, riskier, slower, or more confusing.

**Current workaround:** How the project currently survives with this debt.

**Revisit trigger:** What event should make us fix it.

**Status:** open | in-progress | resolved
```

