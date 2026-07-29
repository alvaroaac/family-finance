# Task 13: Security And Calendar Stabilization

**Status:** done

**Plan reference:** In-thread stabilization plan approved 2026-07-29

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html`

**Owner:** agent

**Started:** 2026-07-29

**Completed:** 2026-07-29

## Scope

- Patch audited production dependency vulnerabilities in the web application.
- Make user-facing current date and month calculations follow the Casa household timezone.
- Preserve the separate Task 12 Codex schema compatibility repair.
- Do not change financial interpretation, categorization, or persistence semantics.

## Progress

- [x] Upgraded the Next.js 15.5 patch line and aligned `eslint-config-next`.
- [x] Overrode vulnerable transitive PostCSS and sharp versions with patched releases.
- [x] Added shared `America/Sao_Paulo` calendar helpers.
- [x] Replaced UTC-derived current dates/months in bot, dashboard consumers, forms, and import fallback.
- [x] Completed the full repository verification gate.

## Acceptance Criteria

- [x] `pnpm audit --prod --audit-level moderate` reports no known vulnerabilities.
- [x] The optimized web build succeeds with the patched dependencies.
- [x] `31/07/2026 22:30` in São Paulo remains `2026-07-31` and month `2026-07`.
- [x] Bot and web defaults share the same household calendar rule.
- [x] Full tests, typecheck, lint, build, and real-Postgres migration checks pass with documented pre-existing warnings.

## QA

```txt
Command: pnpm audit --prod --audit-level moderate
Result: No known vulnerabilities found.

Command: pnpm --filter @family-finance/web build
Result: Passed on Next.js 15.5.22; pre-existing Supabase Edge and toast lint warnings remain.

Command: domain, db, bot, and web test suites
Result: 647 targeted tests passed after the calendar change.

Command: domain, db, bot, and web typecheck
Result: Passed.

Command: pnpm test
Result: 726 tests passed across all seven packages/apps.

Command: pnpm typecheck
Result: 12 tasks passed.

Command: pnpm lint
Result: Passed; pre-existing deprecated `next lint` notice and toast timer cleanup warning remain.

Command: pnpm build
Result: Passed; pre-existing toast warning and missing metadataBase warning remain.

Command: pnpm test:import-migration
Result: Migration apply/reapply and functional concurrency assertions passed against temporary Postgres.
```

## Review

### Findings

- Next.js 15.5.22 still declares vulnerable transitive ranges for PostCSS and sharp, so root pnpm overrides are required until upstream dependency constraints move.
- UTC validation and date arithmetic remain intentionally used where they validate date-only values; only current household calendar derivation changed.

### Changes Requested

- None yet.

### Final Review State

approved

## Decisions Made During Task

- Casa uses the explicit IANA timezone `America/Sao_Paulo` across server and browser entry points.
- The existing database `currentMonth()` API remains stable and delegates to the domain calendar helper.
- Dependency fixes remain on Next.js 15.5 rather than introducing a major-version framework upgrade.

## Follow-Ups

### Tech Debt

- Migrate from deprecated `next lint` to the ESLint CLI separately.
- Resolve the pre-existing toast timer cleanup warning separately.

### Ideas

- Make household timezone configurable only if multi-household support enters scope.

### Risks Or Blockers

- None.

## Handoff Notes

Commits are kept separate for provider schema compatibility, dependency security, and calendar correctness. Nothing has been pushed or published.
