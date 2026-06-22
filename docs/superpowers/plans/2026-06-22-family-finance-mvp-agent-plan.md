# Family Finance MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private family finance MVP where Alvaro and Karol can import historical data, launch expenses quickly through Telegram, review categorization, and see a simple monthly household summary.

**Architecture:** Keep the financial core in shared packages and make UI, bot, importers, and AI adapters thin consumers of that core. The MVP should be extension-friendly: new import sources, bot channels, category strategies, and dashboard panels should be added through contracts rather than rewrites.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Next.js App Router, Supabase Auth/Postgres/RLS, Telegram Bot API, Zod, Vitest, and Playwright for critical web flows.

---

## Operating Rules For Agents

- Before implementation, read `memory/README.md` and follow its Agent Read Protocol.
- Read the relevant task memory file in `memory/tasks/` before working; create it from `memory/tasks/_template.md` if it does not exist.
- Treat `docs/specs/2026-06-22-family-finance-mvp-spec.html` as the product source of truth.
- Do not implement post-MVP ideas from `docs/specs/project-ideas.md` unless a task explicitly says so.
- Prefer small, reviewable commits at task boundaries.
- Keep domain rules out of React components and bot handlers.
- Do not store original imported CSV/XLSX files permanently.
- Build every write path around `household_id` from the beginning.
- Any AI output must return confidence, explanation, and a safe fallback path.
- If a task requires a secret or external account, add env documentation and a stubbed local path; do not hardcode credentials.

## Workstream Map

### Sequential Core

These tasks should happen in order because downstream work depends on their contracts:

1. Repository baseline and shared conventions.
2. Domain model and transaction rules.
3. Supabase schema and RLS.
4. Authenticated web shell.

### Parallel After Core

Once Tasks 1-4 are merged, the following can run mostly in parallel:

- Import pipeline.
- Categorization engine.
- Telegram text flow.
- Dashboard prototype.
- Account/card/investment UI.

### Final Integration

The last phase connects imported history, bot-created transactions, category memory, and dashboard summaries into one coherent MVP.

## Planned File Boundaries

`packages/domain/src`

- Owns money, dates, transactions, installment generation, accounts, cards, categories, and validation schemas.
- Exposes pure functions and typed command/result contracts.
- Must not import from web, bot, database clients, or AI providers.

`packages/db/src`

- Owns Supabase client creation, generated/handwritten database types, repository functions, and RLS-aware access patterns.
- Should expose persistence methods named around domain concepts, not raw UI screens.

`packages/importers/src`

- Owns source adapters, row normalization, preview models, duplicate candidates, and import batch summaries.
- Must accept files as transient input and return normalized rows.

`packages/categorization/src`

- Owns deterministic categorization, memory lookup, confidence scoring, explainability, and AI fallback interface.
- Must be usable by both importer and Telegram bot.

`apps/web`

- Owns authenticated screens: dashboard, imports, transaction review, categories, accounts, cards, and caixinhas.
- Should call server-side actions/routes that use `packages/domain` and `packages/db`.

`apps/bot`

- Owns Telegram webhook, text/audio intake, confirmation/correction state, and reply formatting.
- Should call the same transaction and categorization services used by the web app.

`supabase`

- Owns migrations, seed data, and RLS policies.

## Task 1: Repository Baseline

**Decision:** Stabilize the monorepo before feature work. The scaffold exists, but agents need predictable scripts, TypeScript configuration, test conventions, and documented package boundaries.

**Files:**

- Modify: `package.json`
- Modify: `turbo.json`
- Create: `tsconfig.base.json`
- Create/modify: package-level `tsconfig.json` files
- Modify: `README.md`
- Create: `docs/decisions/0001-package-boundaries.md`

**Steps:**

- [ ] Add shared TypeScript config and make every package extend it.
- [ ] Ensure each package has `typecheck`, `test`, and `build` scripts or intentionally documented no-op equivalents.
- [ ] Add workspace path aliases only if they work consistently across tests, app, and bot.
- [ ] Document package responsibilities from this plan in `docs/decisions/0001-package-boundaries.md`.
- [ ] Run `pnpm install`, `pnpm typecheck`, and `pnpm test`.
- [ ] Commit with `chore: stabilize workspace baseline`.

**Acceptance Criteria:**

- A new agent can run root scripts without guessing package commands.
- No feature task has to invent package boundaries again.

## Task 2: Domain Core

**Decision:** Implement financial behavior as pure domain services first. This prevents the bot, web app, and importers from each creating slightly different transaction logic.

**Files:**

- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/src/money.ts`
- Create: `packages/domain/src/accounts.ts`
- Create: `packages/domain/src/categories.ts`
- Create: `packages/domain/src/transactions.ts`
- Create: `packages/domain/src/installments.ts`
- Create: `packages/domain/src/transactions.test.ts`
- Create: `packages/domain/src/installments.test.ts`

**Core Contracts:**

- `MoneyAmount` stores BRL cents only.
- `TransactionKind` supports `expense`, `income`, and reserves `transfer` for future use.
- A transaction defaults to household responsibility unless `responsibleUserId` is provided.
- `createdByUserId` records who launched the transaction.
- Credit card purchases may create an `InstallmentGroup` plus monthly `Installment` records.
- Domain services return structured validation errors instead of throwing for expected user mistakes.

**Steps:**

- [ ] Define account, investment bucket, card, category, transaction, and installment types.
- [ ] Write tests for one cash expense, one basic income, one household-default transaction, one responsible-user transaction, one card purchase à vista, and one 12x purchase.
- [ ] Implement pure creation helpers for transaction drafts.
- [ ] Implement installment generation with stable due-month behavior.
- [ ] Export only stable domain contracts from `packages/domain/src/index.ts`.
- [ ] Run `pnpm --filter @family-finance/domain test`.
- [ ] Commit with `feat(domain): add core finance model`.

**Acceptance Criteria:**

- Installments can support dashboard projections without needing a full invoice system.
- The web app and bot can both create transactions through the same contract.

## Task 3: Supabase Schema And RLS

**Decision:** Model the MVP data explicitly in Postgres and enable RLS immediately, even with one household. This is a private finance app; retrofitting isolation later is expensive.

**Files:**

- Create: `supabase/migrations/0001_initial_schema.sql`
- Modify: `supabase/seed.sql`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/src/types.ts`
- Create: `packages/db/src/repositories.ts`
- Create: `docs/decisions/0002-rls-and-household-isolation.md`

**Schema Scope:**

- `households`
- `household_members`
- `accounts`
- `investment_buckets`
- `credit_cards`
- `categories`
- `subcategories`
- `transactions`
- `installment_groups`
- `installments`
- `import_batches`
- `import_rows`
- `categorization_memory`
- `bot_interactions`

**Steps:**

- [ ] Create tables with `id`, `household_id`, timestamps, and foreign keys.
- [ ] Add constraints for money cents, supported transaction kinds, supported account kinds, and confidence range.
- [ ] Add RLS policies keyed by membership in `household_members`.
- [ ] Seed one household named `Casa` and initial category placeholders.
- [ ] Add repository functions for transaction creation, category lookup, and monthly summary reads.
- [ ] Document how local Supabase migrations are applied.
- [ ] Run migration against a fresh local Supabase project or document the exact blocker if local Supabase is unavailable.
- [ ] Commit with `feat(db): add initial finance schema`.

**Acceptance Criteria:**

- Unauthorized users cannot read or write household data.
- A transaction can be persisted with account/card/category references.
- Import batches can be tracked without retaining original files.

## Task 4: Authenticated Web Shell

**Decision:** Build the private web shell early so every feature has a real protected surface. Public signup stays out of scope.

**Files:**

- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/app/(app)/layout.tsx`
- Create: `apps/web/app/(app)/dashboard/page.tsx`
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/lib/auth.ts`
- Create: `apps/web/lib/supabase.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `.env.example`

**Steps:**

- [ ] Configure Supabase Auth helpers for Next.js.
- [ ] Enforce Google login and authorized email allowlist.
- [ ] Redirect unauthenticated users to login.
- [ ] Redirect unauthorized emails to an access-denied state.
- [ ] Create a minimal app layout with navigation to dashboard, imports, transactions, categories, accounts, and settings.
- [ ] Add smoke tests or Playwright route checks for protected routes.
- [ ] Commit with `feat(web): add authenticated app shell`.

**Acceptance Criteria:**

- Only allowed Google accounts can reach private app routes.
- The UI makes it clear this is the `Casa` workspace.

## Task 5: Import Pipeline

**Decision:** Treat imports as adapters feeding a common preview model. The first implementation should support at least one real format, while preserving contracts for Minhas Financas custom CSV, XLSX, and Nubank.

**Files:**

- Modify: `packages/importers/src/index.ts`
- Create: `packages/importers/src/types.ts`
- Create: `packages/importers/src/normalize.ts`
- Create: `packages/importers/src/dedupe.ts`
- Create: `packages/importers/src/minhas-financas-csv.ts`
- Create: `packages/importers/src/nubank-csv.ts`
- Create: `packages/importers/src/importers.test.ts`
- Create: `apps/web/app/(app)/imports/page.tsx`
- Create: `apps/web/app/(app)/imports/actions.ts`

**Steps:**

- [ ] Define `ImportAdapter`, `NormalizedImportRow`, `ImportPreview`, and `DuplicateCandidate`.
- [ ] Implement Minhas Financas CSV adapter first.
- [ ] Add Nubank CSV adapter with a small fixture-based test.
- [ ] Return unmapped rows as reviewable errors rather than failing the whole import.
- [ ] Build import page with upload, preview, duplicate warnings, category mapping, and confirm import.
- [ ] Discard uploaded file after preview/confirm processing.
- [ ] Commit with `feat(importers): add import preview pipeline`.

**Acceptance Criteria:**

- Importing data requires explicit confirmation.
- Duplicate candidates are visible before write.
- The original file is not saved permanently.

## Task 6: Category Cleanup And Memory

**Decision:** Categories start from the existing macro/subcategory model and should be simplified, not expanded automatically. New categories suggested by AI or imports remain pending until approved.

**Files:**

- Modify: `packages/categorization/src/index.ts`
- Create: `packages/categorization/src/rules.ts`
- Create: `packages/categorization/src/memory.ts`
- Create: `packages/categorization/src/confidence.ts`
- Create: `packages/categorization/src/categorization.test.ts`
- Create: `apps/web/app/(app)/categories/page.tsx`
- Create: `apps/web/app/(app)/categories/actions.ts`

**Steps:**

- [ ] Define a category suggestion contract with `macroCategoryId`, `subcategoryId`, `confidence`, and `explanation`.
- [ ] Implement deterministic rules from merchant/description/history.
- [ ] Implement categorization memory records that can be listed, disabled, and explained.
- [ ] Add category cleanup UI for merge, archive, and map old category names to current categories.
- [ ] Ensure suggestions for new categories are pending, not automatically created.
- [ ] Commit with `feat(categorization): add explainable category memory`.

**Acceptance Criteria:**

- Corrections improve future suggestions.
- An advanced user can understand why a category was suggested.
- Category sprawl is prevented by default.

## Task 7: Telegram Text Flow

**Decision:** Implement text before audio. Confirmation is on by default and direct-save mode is configurable later once the same command contract is stable.

**Files:**

- Modify: `apps/bot/src/index.ts`
- Create: `apps/bot/src/telegram.ts`
- Create: `apps/bot/src/parser.ts`
- Create: `apps/bot/src/conversation.ts`
- Create: `apps/bot/src/replies.ts`
- Create: `apps/bot/src/bot.test.ts`
- Modify: `.env.example`

**Steps:**

- [ ] Create Telegram webhook handler.
- [ ] Parse basic Portuguese expense text: value, description, date hints, card/account hints.
- [ ] Call categorization engine for suggestions.
- [ ] Reply with a confirmation summary before saving.
- [ ] Support correction for category, value, date, and responsible person.
- [ ] Persist confirmed transactions through shared repository/domain service.
- [ ] Commit with `feat(bot): add confirmed Telegram text entry`.

**Acceptance Criteria:**

- A text message can become a confirmed transaction.
- The saved transaction records `createdByUserId` and defaults responsibility to the house.

## Task 8: Telegram Audio And AI Fallback

**Decision:** Audio and LLM interpretation are extensions of the same bot command flow, not separate write paths.

**Files:**

- Create: `apps/bot/src/audio.ts`
- Create: `packages/categorization/src/ai.ts`
- Create: `packages/config/src/ai.ts`
- Modify: `apps/bot/src/conversation.ts`
- Modify: `apps/bot/src/bot.test.ts`

**Steps:**

- [ ] Download Telegram voice/audio temporarily.
- [ ] Transcribe audio through configured AI provider.
- [ ] Convert transcription into the same parsed transaction draft used by text.
- [ ] Use AI fallback only when deterministic parsing or categorization is uncertain.
- [ ] Delete temporary audio after processing.
- [ ] Add tests around low-confidence fallback behavior using mocked AI responses.
- [ ] Commit with `feat(bot): add audio entry with ai fallback`.

**Acceptance Criteria:**

- Audio never bypasses confirmation.
- Temporary audio handling is documented and does not persist raw audio unnecessarily.

## Task 9: Accounts, Cards, And Caixinhas

**Decision:** Keep financial instruments simple but structurally correct: one checking-account concept, one investment-account concept, investment buckets, and credit cards with installment math.

**Files:**

- Create: `apps/web/app/(app)/accounts/page.tsx`
- Create: `apps/web/app/(app)/cards/page.tsx`
- Create: `apps/web/app/(app)/investments/page.tsx`
- Create: `apps/web/app/(app)/accounts/actions.ts`
- Create: `apps/web/app/(app)/cards/actions.ts`
- Create: `apps/web/app/(app)/investments/actions.ts`

**Steps:**

- [ ] Add CRUD for checking and investment accounts.
- [ ] Add CRUD for investment buckets: filhos, casa, independencia financeira/aposentadoria.
- [ ] Add CRUD for credit cards.
- [ ] Ensure transaction entry can choose account or card.
- [ ] Ensure card entry supports à vista or parcelado with number of installments.
- [ ] Commit with `feat(web): add accounts cards and investment buckets`.

**Acceptance Criteria:**

- Users can model the MVP financial structure without managing full banking complexity.
- Parcel generation is visible before saving a card purchase.

## Task 10: Monthly Dashboard Prototype

**Decision:** Dashboard is deliberately simple. It validates whether the recorded data is useful; charts and projections wait for later phases.

**Files:**

- Modify: `apps/web/app/(app)/dashboard/page.tsx`
- Create: `apps/web/app/(app)/dashboard/queries.ts`
- Create: `apps/web/components/summary-card.tsx`
- Create: `apps/web/components/recent-transactions.tsx`
- Create: `apps/web/components/pending-review-list.tsx`

**Steps:**

- [ ] Query current-month income total.
- [ ] Query current-month expense total.
- [ ] Query estimated monthly balance.
- [ ] Query card totals and upcoming installments.
- [ ] Query investment bucket balances.
- [ ] Show recent transactions and pending review items.
- [ ] Commit with `feat(web): add monthly dashboard prototype`.

**Acceptance Criteria:**

- Dashboard answers: how much entered, how much left, card pressure, caixinhas, and what needs review.

## Task 11: End-To-End Review Loop

**Decision:** The MVP is only useful if import, bot entry, correction, and dashboard agree with each other. Final integration should test the story, not individual widgets.

**Files:**

- Create: `apps/web/e2e/mvp-flow.spec.ts`
- Create: `docs/runbooks/local-mvp-verification.md`
- Modify: `README.md`

**Steps:**

- [ ] Create a seeded household with two authorized users.
- [ ] Import fixture transactions and confirm them.
- [ ] Correct at least one category and verify categorization memory is created.
- [ ] Simulate a Telegram text transaction and confirm it.
- [ ] Add one parcelado card purchase.
- [ ] Verify dashboard totals include imports, bot-created transaction, income, and installments.
- [ ] Document local verification commands.
- [ ] Commit with `test: add mvp verification flow`.

**Acceptance Criteria:**

- A fresh agent can verify the whole MVP locally from README/runbook.
- Dashboard totals reconcile with the seed/import/bot scenario.

## Release Gate

Before declaring the MVP branch ready:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] Web app builds with `pnpm --filter @family-finance/web build`.
- [ ] Bot package builds with `pnpm --filter @family-finance/bot build`.
- [ ] Supabase migrations apply to a fresh local project or the blocker is documented.
- [ ] README documents env setup, Supabase setup, Telegram webhook setup, and Vercel deploy notes.
- [ ] No original import fixtures contain real personal financial data.
- [ ] No secrets are committed.

## Agent Dispatch Recommendation

Use one fresh agent per task after Task 1. Suggested parallel batches:

- Batch A: Task 2, then Task 3, then Task 4.
- Batch B after A: Tasks 5, 6, 9, and 10 can run in parallel with explicit contract checks.
- Batch C after text contracts stabilize: Tasks 7 and 8.
- Batch D: Task 11 final integration.

Each task should end with:

- Code changes.
- Verification output.
- Known limitations.
- Updated task memory and any relevant project memory files.
- Commit hash, if committed.
- Any spec mismatch or decision that needs user review.
