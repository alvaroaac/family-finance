# Task 05: Import Pipeline

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 5)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (§07 Importação)

**Owner:** agent (Task 5)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Source adapters that turn a TRANSIENT import file into normalized rows + reviewable errors + a preview model with probable-duplicate detection.
- Minhas Financas CSV adapter (FIRST), then Nubank CSV adapter, both with fixture tests.
- Web Importação screen: upload → normalized preview → duplicate warnings → per-row category mapping + target-account → explicit confirm → persist `import_batch` (counts only) and one transaction per kept row.
- NOT covered: XLSX parsing (future adapter behind the same contract), persisting `import_rows`, AI-assisted category mapping at import time, account/card CRUD (Task 9).

## Progress

- [x] Core contracts in `packages/importers/src/types.ts`: `ImportAdapter`, `NormalizedImportRow`, `ImportRowError`, `AdapterResult`, `ImportPreview`, `DuplicateCandidate`, `ImportSource`.
- [x] Hand-rolled CSV parser + value/date/description normalizers in `normalize.ts` (no new dependency).
- [x] Probable-duplicate detection + preview assembly in `dedupe.ts`.
- [x] `minhas-financas-csv.ts` (semicolon/comma auto-detect, DD/MM/YYYY, decimal comma, optional Tipo column).
- [x] `nubank-csv.ts` (ISO date, dot decimals, signed amount, quoted commas).
- [x] `importers.test.ts` written FIRST (TDD), 11 tests incl. an unmapped-row case and a duplicate-candidate case, all with synthetic fixtures.
- [x] Web `imports/page.tsx` (client) + `imports/actions.ts` (server actions, `requireAuthorizedUser` guard).
- [x] `packages/db`: added `findAccountsByHousehold` + `createImportBatch` repositories (needed by the web action; importers stays db-free).

## Acceptance Criteria

- [x] Importing data requires explicit confirmation (separate `confirmImport` step; nothing written on preview).
- [x] Duplicate candidates are visible before write (preview table flags them, pre-excluded by default).
- [x] The original file is not saved permanently (read in-memory inside `previewImport` only; browser holds normalized rows; only counts + transactions persisted).

## QA

```txt
Command: pnpm --filter @family-finance/importers test && pnpm typecheck && pnpm --filter @family-finance/web build
Result: GREEN. importers 11/11 tests pass; typecheck 12/12 tasks pass; web build succeeds, /imports route emitted (dynamic, 3.21 kB).
Notes: Adapters/normalize/dedupe are pure and unit-tested without I/O. Web flow not exercised against real Supabase (no secrets/network here) — see risks.
```

## Review

### Findings

- None yet.

### Changes Requested

- None yet.

### Final Review State

not-reviewed

## Decisions Made During Task

- **Importer `ImportSource` kept independent of the DB enum.** Package uses `"minhas-financas" | "nubank"`; the web action maps to the DB `import_source` enum (`minhas_financas_csv` | `nubank_csv`). Keeps `packages/importers` free of any db coupling.
- **Money sign → kind.** `NormalizedImportRow.amount.cents` is always a positive magnitude; expense/income is carried by `kind` (matches the schema CHECK `amount_cents > 0` and the domain contract). An explicit Tipo column overrides the sign when present (unsigned exports).
- **Target account chosen per batch at confirm.** The transactions table requires exactly one payment instrument (account XOR card), so the import books every kept row against a single UI-selected account. Card/parcelado imports are out of scope for the MVP preview.
- **Category mapping happens in the web layer, never in the importer** (boundary rule). MVP mapping is per-row, optional (uncategorized allowed); `sourceCategory` is surfaced on normalized rows for future auto-mapping but never auto-applied.
- **`import_rows` not persisted by default.** Only the `import_batch` summary (source, status, counts) is written, honoring the privacy decision; the raw file never reaches the DB.

## Follow-Ups

### Tech Debt

- Import writes one transaction at a time (no batch insert / no DB transaction). For large historical imports this is many round-trips and partial-failure is possible (batch summary records `imported`/`error` counts). Revisit with a bulk insert or RPC if import volume grows.
- `import_rows` table is unused by this task; if per-row audit/reprocessing is wanted later, populate it (still no raw file).
- XLSX adapter and Minhas Financas "CSV padrão" vs "customizado" variants are not implemented — only a name-matched CSV header adapter. Add fixtures + adapters when real export samples are available.

### Ideas

- At-import categorization via `@family-finance/categorization` (suggest a category per row using rules/memory) could pre-fill the mapping dropdowns. Interface is ready (engine is pure); deferred to keep Task 5 focused.

### Risks Or Blockers

- Web import flow not run against real Supabase (no secrets/network here). Account/category dropdowns and the confirm write path are typed + build-green but unverified end-to-end. Extends the existing "web auth wiring not exercised against real Supabase" risk.

## Handoff Notes

- Adapters live behind `ImportAdapter` + `importAdapters`/`getImportAdapter` registry — add new sources (XLSX, other banks) by implementing the contract and registering them; the web action and preview model need no changes.
- `buildImportPreview({ source, rows, errors })` is the single place that computes duplicates + counts; reuse it for any new source.
- DB gained `findAccountsByHousehold` and `createImportBatch`; both are RLS-scoped and exported from `@family-finance/db`.
- The dashboard (Task 10) can rely on imported transactions carrying `import_batch_id` indirectly — note this task does NOT set `import_batch_id` on transactions (batch is created after the rows). If linkage is needed, create the batch first and pass `importBatchId` to `createTransaction` (the repo already supports it).
