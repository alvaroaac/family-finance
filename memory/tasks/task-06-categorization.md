# Task 06: Category Cleanup And Memory

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 6)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (#categorization)

**Owner:** agent (Task 6)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Explainable, hybrid category suggestion engine in `packages/categorization`
  (pure: imports only `@family-finance/domain` + `zod`; NO web/bot/db clients).
- Deterministic rules + categorization memory + confidence scoring + AI-fallback
  INTERFACE (no AI impl here — Task 8 provides `ai.ts`).
- Web "Categorias" cleanup UI (merge, archive/restore, memory map/disable),
  guarded by `requireAuthorizedUser()`, mutations via server actions calling
  household-scoped `packages/db` repositories.
- Does NOT cover: AI implementation, the importer/bot wiring of the engine
  (Tasks 5/7/8 consume it), real Supabase round-trip.

## Progress

- [x] TDD: `categorization.test.ts` written first (14 tests), all green.
- [x] `confidence.ts` — `scoreConfidence` (clamps [0,1]), `CONFIDENCE` tiers,
      `needsConfirmation`, `tierOf`.
- [x] `rules.ts` — `CategorizationRule`, `defaultRuleSet()` (IFOOD/RAPPI/UBER/99),
      `matchRules` (case-insensitive substring, names-not-ids), `ruleExplanation`.
- [x] `context.ts` — shared `CategorizationContext` (avoids import cycle).
- [x] `memory.ts` — `CategorizationMemoryEntry`, `CategorizationMemoryStore`
      INTERFACE, `matchMemory` (active-only, longest/most-confident wins),
      `describeMemory`, `memoryEntryFromCorrection`.
- [x] `index.ts` — `CategorySuggestion` contract (macroCategoryId, subcategoryId,
      confidence 0..1, explanation, source), `CategoryCatalog`, `AiCategorizer`
      INTERFACE, `suggestCategory` engine (memory -> rules -> AI; novel categories
      stay PENDING; low confidence requests confirmation).
- [x] `packages/db` repositories extended (household-scoped): category
      list/archive/restore/merge, memory list/active-list/create/enable/disable,
      `findHouseholdIdForCurrentUser`.
- [x] `apps/web/app/(app)/categories/{page.tsx,actions.ts}`.
- [x] `next.config.mjs`: add categorization to `transpilePackages` +
      `extensionAlias` so `.js` (NodeNext) source specifiers resolve in webpack.

## Acceptance Criteria

- [x] Corrections improve future suggestions: a memory entry (created from a
      correction/mapping) makes a previously-unmatched description resolve to a
      confident `matched` suggestion, with higher confidence than no-memory.
      (test: "memory match improves a suggestion").
- [x] An advanced user can understand why a category was suggested: every
      suggestion carries `explanation` + `source`; memory renders
      `descrição contém "X" -> Cat > Sub` (`describeMemory`, recomputed from live
      names) and the UI shows it with confidence %.
- [x] Category sprawl prevented by default: AI/import proposals for categories not
      in the catalog return `status: "pending_new_category"` and are NEVER
      auto-created; merge consolidates instead of expanding.

## QA

```txt
Command: pnpm --filter @family-finance/categorization test
Result:  14 passed (14) — green
Command: pnpm typecheck
Result:  11 successful, 11 total — green
Command: pnpm --filter @family-finance/web build
Result:  Compiled successfully; /categories is ƒ (server-rendered on demand) — green
Command: pnpm test (full)
Result:  categorization 14, web 7, db 8 — all green
Notes:   Boundary verified: categorization src imports only `zod` externally.
```

## Decisions Made During Task

- Suggestion contract uses `macroCategoryId`/`subcategoryId` (plan's exact
  names). The richer `CategorizationResult` wrapper adds `status`
  (matched | pending_new_category | uncategorized), `requiresConfirmation`, and
  `pendingCategory` so the same return type serves importer + bot.
- Rules/AI return category/subcategory by NAME; the engine resolves names to real
  catalog ids. Unknown macro name => pending; unknown sub under a known macro is
  dropped (macro still applies). This guarantees no auto-creation.
- Strategy order: memory > rules > AI. Memory confidence is floored at
  `CONFIDENCE.MEMORY` (0.97) so a confirmed correction outranks a bare rule.
- `CategorizationMemoryStore` and `AiCategorizer` are INTERFACES only, keeping the
  package pure; the web app wires the store to `categorization_memory` via db.
- Merge re-points transactions, installment_groups, installments, subcategories,
  and memory, then archives the source (soft-delete via `is_active=false`).
- Household id resolved per-request via `findHouseholdIdForCurrentUser` (RLS),
  not hardcoded to the seed id.

## Follow-Ups

### Tech Debt

- `mergeCategory` is a sequence of scoped updates (no DB transaction in
  Supabase JS); steps are idempotent/re-runnable but a partial failure could
  leave a half-merged state. Revisit with an RPC/Postgres function if merges
  become frequent. (Logged in `project-tech-debt.md`.)
- `next.config.mjs` `extensionAlias` `.js`->`.ts` workaround is needed because
  shared packages ship raw NodeNext TS via `main: src/index.ts`. Could be removed
  if packages publish built `dist` + proper `exports` maps. (Logged.)

### Ideas

- Amount/date-based rules (`context.amountCents`/`occurredOn` reserved fields).

### Risks Or Blockers

- Engine + memory matching are unit-tested in isolation; the web actions/page
  were NOT exercised against a real Supabase (no secrets/network) — same standing
  risk as Task 4. Build is green with placeholders; page degrades to an
  error-flagged empty state when the DB is unreachable.

## Handoff Notes

- Importer (Task 5) and bot (Tasks 7/8) should call `suggestCategory(context,
  { catalog, memoryStore, rules?, ai? })`. Build the `memoryStore` from
  `listActiveCategorizationMemory` (db) mapped to `CategorizationMemoryEntry`.
- Task 8 implements the `AiCategorizer` interface in `packages/categorization/
  src/ai.ts`; the engine already gates AI output (confidence + pending-new-category).
- To learn from a correction, persist a row via `createCategorizationMemory`
  (or build the payload with `memoryEntryFromCorrection`).
