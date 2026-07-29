# What the heck?

Codebase surprises logged by agents — footguns, undocumented quirks, hidden coupling, assumptions that turned out wrong. Read on startup before non-trivial tasks; prior surprises are warnings.

Agents: always ask permission before writing here. Auto mode does not override. Format and rules: see the `what-the-heck` skill.

## Entries

## 2026-07-28 17:09 — Locally valid JSON Schema was rejected by every strict-output provider

- **Where:** `apps/bot/src/codex.ts:137` (`CODEX_OUTPUT_SCHEMA`)
- **Expected:** A schema accepted by local JSON parsing and Zod validation would also be accepted by Codex/OpenAI structured output.
- **Found:** Constrained fields used `const`/`enum` without explicit `type`; Codex and OpenAI rejected the request with `invalid_json_schema` HTTP 400 before inference.
- **Why it surprised you:** Mocked runner tests validated result handling but never submitted the schema to a real provider.
- **Resolution:** Added explicit types to every constrained leaf, a recursive regression test, and a real synthetic Codex structured-output smoke test.
- **Context:** Production bot classifier recovery after Codex reauthentication.

<!-- Format:
### YYYY-MM-DD — short title
**Where:** path/to/file.ts:NN
**Expected:** what you assumed
**Actual:** what is true
**Why it matters:** the footgun / who gets bitten
-->
