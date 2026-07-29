# Task 12: Codex Structured-Output Schema Compatibility

**Status:** done

**Plan reference:** Recovered production-fix plan from archived Codex task `019f94d1-d23e-7c23-969d-54ad004b332f`

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (Telegram confirmation flow and AI Services)

**Owner:** agent (bot)

**Started:** 2026-07-28

**Completed:** 2026-07-28

## Scope

- Make the shared Codex/OpenAI structured-output schema provider-compatible.
- Add regression coverage, verify the real hardened Codex path, and deploy only the production bot.
- Do not change financial interpretation semantics or the fallback order.

## Progress

- [x] Added explicit JSON Schema types to all `const`/`enum` constrained fields.
- [x] Added recursive provider-compatibility regression coverage.
- [x] Verified a real synthetic structured Codex invocation.
- [x] Ran the complete bot test/build/typecheck gate.
- [x] Deployed and verified the production Telegram classifier path.

## Acceptance Criteria

- [x] No constrained schema leaf omits `type`.
- [x] The real hardened Codex invocation returns a runtime-validated result.
- [x] Bot tests, build, and typecheck pass.
- [x] Production telemetry records Codex success without OpenAI/Anthropic fallback.

## QA

```txt
Command: pnpm --filter @family-finance/bot test -- src/codex.test.ts
Result: 26 passed.
Command: pnpm --filter @family-finance/bot test
Result: 18 files, 349 tests passed.
Command: pnpm --filter @family-finance/bot typecheck && pnpm --filter @family-finance/bot build
Result: clean.
Command: real createCodexMessageClassifier smoke with synthetic `teste schema 1 real`
Result: Codex outcome success; validated plain intent, amount 100 cents.
Notes: Codex websocket transport logged a transient HTTP 503, then completed successfully through its fallback transport.
Command: production-image structured smoke + live Telegram `teste schema 1 real`
Result: production image/auth smoke succeeded in 6.6s; live webhook telemetry recorded Codex primary success in 6.181s with no fallback event; zero transactions were inserted.
```

## Review

### Findings

- The original `action` defect was not isolated: three other `enum` fields also omitted explicit types.

### Changes Requested

- None.

### Final Review State

approved (self-verified locally and in production)

## Decisions Made During Task

- Guard every `const`/`enum` schema leaf recursively instead of asserting only `action`.
- Use a clearly synthetic external-model smoke payload; leave real household data to the explicit Telegram production smoke.

## Follow-Ups

### Tech Debt

- None yet.

### Ideas

- None.

### Risks Or Blockers

- None.

## Handoff Notes

Deployed bot image `sha256:4ba145dec656cbc303ed2c642e05ea2b070a5d1b2a1a43884877ff04e8590c50`. The production `.env` remained unchanged and mode 600. Rollback copies of the previous `codex.ts` and `codex.test.ts` are under `/opt/family-finance/.deploy-backups/20260728T201100Z/`.
