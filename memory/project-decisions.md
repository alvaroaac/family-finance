# Project Decisions

Record durable decisions here. Keep entries short and revisit them when new evidence appears.

## 2026-06-22: MVP Shape

**Decision:** Build a hybrid MVP: Telegram-first quick entry plus historical import during onboarding.

**Why:** Quick entry creates daily value, while imported history gives categorization and dashboard context.

**Revisit if:** Import complexity blocks Telegram validation for too long.

## 2026-06-22: Platform

**Decision:** Use a responsive Next.js web app on Vercel with Supabase/Postgres.

**Why:** Fastest path to private family usage with a solid database and auth foundation.

**Revisit if:** Supabase Auth/RLS creates friction that outweighs its benefits.

## 2026-06-22: Auth

**Decision:** Google login with allowed emails only.

**Why:** The product is private to the family. Public signup is out of scope.

**Revisit if:** More family members need access or email identities become inconvenient.

## 2026-06-22: Bot Channel

**Decision:** Telegram first, WhatsApp later.

**Why:** Telegram is simpler to integrate and validate with text/audio during MVP.

**Revisit if:** Telegram usage does not match the family’s real habits.

## 2026-06-22: Workspace Baseline And Package Boundaries

**Decision:** Single shared strict `tsconfig.base.json` extended by every package/app; uniform `build`/`typecheck`/`test` scripts; package responsibilities and dependency direction documented in `docs/decisions/0001-package-boundaries.md`. No custom TS `paths` aliases (workspace package names already resolve everywhere).

**Why:** Feature agents must run root scripts without guessing per-package commands and must not re-invent boundaries. The hard rule "domain must not import web/bot/db/AI" is recorded once.

**Revisit if:** Build/typecheck times justify TypeScript project references, or a tool stops resolving workspace package names and aliases become necessary.

## 2026-06-22: Domain Core Contracts

**Decision:** The pure domain (`packages/domain`) is the single source of transaction rules. Money is BRL integer cents only (`MoneyAmount`). Transactions are created via `createTransactionDraft` and parcelado card purchases via `createInstallmentPlan`, both returning a structured `DomainResult` (`ok:false` carries field/code/message errors) instead of throwing for expected user mistakes. Payment is a discriminated union (`account` | `card`); responsibility defaults to household unless `responsibleUserId` is set; `createdByUserId` is always recorded. Installments carry a month attribution (`dueMonth` = `YYYY-MM`), not invoice timing.

**Why:** Web app and bot must create transactions through one contract so logic is not re-implemented per channel. Month-attributed installments let the dashboard project card pressure without a full invoice system.

**Revisit if:** Multi-currency is needed, or the dashboard needs real invoice/closing-day timing (then installment due-month derivation must use `CreditCard.closingDay`).

## 2026-06-22: Schema And RLS (Household Isolation)

**Decision:** The MVP Postgres schema (`supabase/migrations/0001_initial_schema.sql`) enables RLS on every table from day one. Access is granted only to active members of a row's `household_id`, via a single `SECURITY DEFINER` helper `is_household_member(household_id)` keyed on `household_members` + `auth.uid()`. Money is integer cents with `> 0` CHECKs; `transaction_kind`/`account_kind` are enums; confidence is `numeric(4,3)` CHECK `[0,1]`; payment is account-XOR-card; responsibility defaults to household with a CHECK that `responsible_user_id` is set iff scope is `user`. Import batches store only source/status/counts/notes — never the raw file. `packages/db` exposes hand-written static types (`types.ts`) and domain-named, RLS-aware repositories (`repositories.ts`) reusing `@family-finance/domain` contracts.

**Why:** Private finance app; retrofitting isolation later is expensive. One shared membership helper keeps policies consistent and non-recursive. Static DB types let the package typecheck with no live Supabase.

**Revisit if:** A second household/shared-resource scenario appears; real invoice timing is needed (installment `due_month` derivation changes); or generated Supabase types replace the hand-written ones. Details in `docs/decisions/0002-rls-and-household-isolation.md`.

## 2026-06-22: Web Auth Shell And Lazy Config

**Decision:** The web shell (`apps/web`) guards the whole `(app)` route group server-side
in `app/(app)/layout.tsx` via `requireAuthorizedUser()`. The entire auth/allowlist policy
is a single pure function `evaluateAccess(principal, allowlist)` in `apps/web/lib/auth.ts`
(no Next/Supabase imports), so it is unit-tested in isolation: no session → `/login`;
authenticated email not on `AUTHORIZED_EMAILS` → access-denied (`/login?denied=1`);
allowlisted email → authorized. `packages/config` exposes only LAZY env getters
(`getServerEnv`, `getSupabasePublicConfig`, `getAuthorizedEmails`, `isEmailAuthorized`) and
never validates/throws at import, so `next build` compiles without real secrets
(placeholders are used). Google login is initiated by a server action calling Supabase
`signInWithOAuth({ provider: "google" })`.

**Why:** Every feature must land on a real protected surface from day one; keeping the
policy pure prevents auth logic leaking into components and makes it testable. Build must
stay green in CI without secrets.

**Revisit if:** `@supabase/ssr` becomes installable (swap the hand-rolled cookie adapter,
add OAuth code-exchange middleware); more members need access; or env validation should be
enforced at runtime startup rather than per-request.

## 2026-06-22: Categorization Engine Contracts

**Decision:** `packages/categorization` is a PURE, hybrid, explainable suggestion engine
shared by the importer and the Telegram bot. `suggestCategory(context, { catalog,
memoryStore?, rules?, ai? })` resolves in strict trust order: categorization memory
(confirmed corrections) -> deterministic rules -> AI fallback. Every `CategorySuggestion`
carries `macroCategoryId`/`subcategoryId` (real catalog ids only), a `confidence` in
[0,1], an `explanation`, and a `source`. The richer `CategorizationResult` adds `status`
(`matched` | `pending_new_category` | `uncategorized`) and `requiresConfirmation`. Rules
and AI return category/subcategory by NAME; the engine resolves names against the
household catalog, so an unknown macro category becomes `pending_new_category` and is
NEVER auto-created (anti-sprawl). Confidence below `CONFIDENCE.HIGH` (0.85) sets
`requiresConfirmation`. The memory store and the AI categorizer are INTERFACES only
(`CategorizationMemoryStore`, `AiCategorizer`); the package imports only
`@family-finance/domain` + `zod` — never web/bot/db clients or an AI impl (Task 8 adds
`ai.ts`). Memory entries reference real ids and are created from confirmed corrections /
old-name mappings; they can be listed, disabled, and explained
(`descrição contém "X" -> Cat > Sub`). Category cleanup (archive/restore/merge) lives in
`packages/db` repositories, household-scoped, and is driven from the web Categorias UI via
guarded server actions.

**Why:** One engine for both channels keeps categorization logic in a single pure place;
explicit confidence + explanation + pending-new-category satisfy the spec's "categorias que
aprendem", auditability, and "novas categorias ficam pendentes" / "confiança baixa pede
confirmação" rules. Interfaces preserve the package boundary and let Task 8 plug in AI.

**Revisit if:** Amount/date-based rules are needed (reserved context fields exist); the
catalog grows large enough that linear name resolution matters; or merges need atomicity
(move to a Postgres RPC — see tech debt).

## 2026-06-22: Import Privacy

**Decision:** Do not permanently store raw imported CSV/XLSX files.

**Why:** Financial exports are sensitive, and re-uploading is acceptable when reprocessing is needed.

**Revisit if:** Reprocessing becomes frequent enough to justify encrypted temporary retention.

## 2026-06-22: Import Pipeline Contracts

**Decision:** `packages/importers` is a PURE adapter layer (imports `@family-finance/domain`
+ `zod` only — never web/bot/db). A source file is TRANSIENT text passed to an
`ImportAdapter.parse(fileText)`, which returns `NormalizedImportRow[]` + reviewable
`ImportRowError[]` (an unmapped/unparseable row NEVER fails the whole import). CSV parsing is
hand-rolled (`parseCsv`, quoted fields, `;`/`,` auto-detect) with no new dependency.
Normalization covers date (→ ISO `YYYY-MM-DD`, accepts `DD/MM/YYYY`), description (trimmed),
value (BRL integer cents via domain `brl`; BR `3.000,00` and dot-decimal both supported), and
type (sign → `expense`/`income`, with an explicit Tipo column overriding when present). Each
`NormalizedImportRow.amount.cents` is a POSITIVE magnitude; direction is in `kind` (matches the
schema CHECK `amount_cents > 0`). `buildImportPreview` assembles rows + errors + probable
`DuplicateCandidate[]` (same date + amount + normalized description, conservative) + counts;
the importer's `ImportSource` (`minhas-financas` | `nubank`) is kept independent of the DB
`import_source` enum, mapped in the web action. The web Importação flow is two-step: a preview
server action reads the file IN-MEMORY and discards it (only normalized rows reach the browser),
then an explicit confirm action books one transaction per kept row against a UI-chosen target
account and persists ONLY an `import_batch` summary (source/status/counts) — never the file.
Category mapping is per-row in the web layer (optional/uncategorized allowed), never inside the
importer. `packages/db` gained RLS-scoped `findAccountsByHousehold` + `createImportBatch`.

**Why:** Adapters behind one contract make new sources (XLSX, other banks) additive, not
rewrites. Keeping the importer pure preserves the package boundary and lets both the importer
and (later) the bot reuse the same normalization/categorization. Preview-before-write +
visible duplicates + discard-after-process satisfy the spec's "ver antes de gravar",
"detecção de duplicatas prováveis", and "arquivo original não é persistido".

**Revisit if:** XLSX or Minhas Financas CSV variants need real handling; imports get large
enough to need bulk/transactional writes (see tech debt); or imported rows must link to their
batch (`import_batch_id`) / populate `import_rows`.

## 2026-06-22: Accounts / Cards / Caixinhas (Task 9)

**Decision:** Financial instruments are managed through three guarded web screens
(`/accounts`, `/cards`, `/investments`) backed by household-scoped `packages/db`
repositories. `packages/db` gained pure insert builders (`accountInsert`,
`investmentBucketInsert`, `creditCardInsert`, `installmentGroupInsertFromPlan`,
`installmentInsertsFromPlan`) plus list/create/update/delete repos and
`createInstallmentPurchase` (group + parcels). Caixinhas (`investment_buckets`) are
the 3 MVP slugs (filhos / casa / independencia_financeira), one per slug per
household (enforced by the existing unique constraint); they carry name + slug only
(no balance — schema unchanged). A card purchase is entered on `/cards`: à vista is
ONE `transactions` row on the card; parcelado is an `installment_groups` +
month-attributed `installments` rows generated by the PURE domain
`createInstallmentPlan`. The generated parcels are shown BEFORE saving via a server
action (`previewCardPurchase`) that runs the same domain generator with placeholder
ids, so financial rules never leak into the React component while the preview is
exactly what gets saved. All mutations are `"use server"` actions guarded by
`requireAuthorizedUser()` and resolve the household via RLS.

**Why:** Satisfies the spec's account/card/caixinha modeling and the acceptance rule
that parcel generation is visible before the card purchase is committed, while keeping
the domain pure and the write paths household-scoped.

**Revisit if:** Caixinhas need a balance/position (new migration + repos); a generic
`/transactions` entry screen is added; or parcelado persistence needs to be atomic
(move group+parcels into a Postgres RPC — see tech debt).

## 2026-06-22: Telegram Text Flow (Task 7)

**Decision:** The Telegram bot (`apps/bot`) is a THIN consumer of the shared core, not a
second write path. A message flows: pt-BR parse (`parser.ts`, pure: value/date/card-account
hints + uncertain-field flags) -> `suggestCategory` (`@family-finance/categorization`, same
engine as the importer) -> editable confirmation summary -> on explicit confirm, build via
`createTransactionDraft` (`@family-finance/domain`) and persist via `createTransaction`
(`@family-finance/db`). The confirmation state machine (`conversation.ts`) is PURE and
dependency-injected (`ConversationDeps`: catalog, account/card resolvers, `suggestCategory`,
`createTransaction`, `logInteraction`), so the bot never re-implements transaction,
installment, or categorization logic and tests mock Telegram + db + categorization with NO
network. Confirmation is ON by default (states: `awaiting_confirmation` | `needs_amount` |
`saved` | `cancelled`); corrections are supported for value, date, category, and responsible
person, and a message without a value goes to `needs_amount` and cannot be confirmed until a
value is given. Saved transactions record `createdByUserId` = the linked Telegram identity and
default responsibility to the house (`HOUSEHOLD_RESPONSIBILITY`) unless a responsible person is
chosen. Each entry is logged to `bot_interactions` (channel `telegram`) for auditing. The
webhook secret (`TELEGRAM_WEBHOOK_SECRET`) is verified FAIL-CLOSED (unset => reject all). The
outgoing Bot API client is an injectable interface (`TelegramClient`) with HTTP + no-op impls.

**Why:** The spec requires Telegram quick-entry that "pede confirmação com sugestão editável"
and reuses the web app's domain services. Keeping the conversation pure + injected keeps
financial rules in one place, preserves package boundaries, and lets Task 8 (audio + AI
fallback) extend the SAME flow after transcription so audio never bypasses confirmation.

**Revisit if:** Direct-save mode is enabled (spec: configurable later); the bot is deployed
serverless/multi-replica (conversation state must move out of the in-memory per-chat map);
or a real names→member-id resolver is added for responsible-person corrections.

