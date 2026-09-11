# What the heck?

Codebase surprises logged by agents — footguns, undocumented quirks, hidden coupling, assumptions that turned out wrong. Read on startup before non-trivial tasks; prior surprises are warnings.

Agents: always ask permission before writing here. Auto mode does not override. Format and rules: see the `what-the-heck` skill.

## Entries

## 2026-09-05 21:34 — PostgreSQL readiness probe matched the temporary initialization server

- **Where:** `scripts/verify-all-migrations.sh` and `scripts/verify-import-migration.sh`
- **Expected:** A successful `pg_isready` probe meant the final PostgreSQL server was ready for migration tests.
- **Found:** The official image first starts a temporary Unix-socket-only server during initialization. The probe could match it just before shutdown, so the following `psql` failed intermittently with exit code 2.
- **Why it surprised you:** The container looked ready, but the probe observed a different server lifecycle phase than the tests needed.
- **Resolution:** Probe the final server over TCP at `127.0.0.1`, allow a longer startup window, and print container logs if readiness times out.
- **Context:** PR #24 migration-control CI failure.

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
