# Multi-tenancy (spec 1) — progress

Status on 2026-09-29: implementation complete on `feat/multi-tenancy`, PR open
against `main`. Production was not touched. Design: [design.md](design.md).
Plan: [plan.md](plan.md). Spec 2 research:
[spec-2-privacy-research.md](spec-2-privacy-research.md).

## What shipped

| Task | Result                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Isolated e2e harness (`family-finance-e2e`, ports 5632x), fake Telegram, real bot and production web build                    |
| 2    | Migration `0029`: allowlist per household, one membership per user, `households.theme`, scoped provisioning                   |
| 3    | Web access decided by an active membership; `AUTHORIZED_EMAILS` removed                                                       |
| 4    | `scripts/create-household.mjs`                                                                                                |
| 5    | Migration `0030`: free-form investment buckets per household                                                                  |
| 6    | Migration `0031`: bot acts as the resolved member (short-lived JWT), conversations keyed by chat, Telegram user and household |
| 7    | Bot copy without personal names; "<name> comprou" routes to a member of the sender's household                                |
| 8    | Per-household theme and household name in the shell; neutral login and metadata                                               |
| 9    | Auth redirects stay on an allowlisted request host (`ALLOWED_WEB_HOSTS`)                                                      |
| 10   | `deploy/checks/rls-proof.mjs` proves isolation between two households from the catalog                                        |
| 11   | Multi-tenant web and bot e2e suites                                                                                           |
| 12   | Cutover runbook and documentation                                                                                             |

## Decisions made during execution

- An allowlist insert for a user who already belongs to another household
  raises an error instead of being skipped with a warning. The plan said skip;
  an adversarial review showed the silent skip hides an operator mistake.
- Web e2e runs `next build` and `next start`. Dev mode hit the file watcher
  limit on the development machine.
- Theme overrides are emitted on `<html>` by the root layout, only for an
  authorized member, so the page background and portalled toasts inherit them.
  The login page never receives overrides.
- `opengraph-image.png` was regenerated; the previous image had names drawn in.
- `NEXT_PUBLIC_SITE_URL` is required at request time for login and callback.
- `rls-proof.mjs` needs `DATABASE_URL` for catalog discovery, and gained
  `--cleanup <marker>` for runs killed before teardown.
- The bot hostname stays on the first household's domain. No member sees it,
  and moving it would add a webhook change to the cutover. Recorded as tech debt.
- `updateInvestmentBucket` was renamed `renameInvestmentBucket`.
- `e2e/lib/multi-tenant-fixtures.ts` is shared by the web and bot suites so
  both are re-runnable against the same stack.

## Review findings

Reviews of plain code changes were run by GPT-6 Astra through Codex, reading
the diff with no session context. Each finding was checked against the code.

| Task | Finding                                                                      | Disposition                                                 |
| ---- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 2    | User in household A allowlisted for B is skipped silently                    | Accepted: insert raises                                     |
| 2    | `lower(email)` unique index can fail on case-variant duplicates              | Not fixed in code: runbook precheck 0.1                     |
| 2    | Functional SQL does not test RLS visibility                                  | Rejected: covered by `rls-proof`                            |
| 6    | Username fallback can rebind a member that already has a Telegram id         | Accepted: fallback only when the id is null                 |
| 6    | Webhook falls back to the service-role client when no member client is given | Accepted: member client required                            |
| 6    | A draft survives a household change                                          | Accepted: draft of another household is discarded           |
| 6    | Import route rejects a user with two memberships                             | Rejected: impossible since `0029` (one membership per user) |
| 10   | RPC cases pass when the response carries the other household's data          | Accepted                                                    |
| 10   | Discovery misses household foreign keys under other names, and views         | Accepted                                                    |
| 10   | Trigger functions were called as RPCs                                        | Accepted: real trigger events                               |
| 10   | Update check writes the same value                                           | Accepted: sentinel value and privileged read                |
| 10   | Only SIGINT handled                                                          | Accepted: SIGTERM and `--cleanup`                           |
| 10   | `resolve_telegram_member` only checked for denial                            | Accepted: service-role cases                                |
| 10   | Test compares counts only                                                    | Accepted: marker rows and run users asserted absent         |

Findings of the pull request review rounds are appended below.

## End-to-end evidence (local, 2026-09-29)

Release gate: `pnpm typecheck && pnpm test && pnpm test:migrations && pnpm test:category-migration`.

| Suite                                                                   | Result             |
| ----------------------------------------------------------------------- | ------------------ |
| domain                                                                  | 103 passed         |
| config                                                                  | 15 passed          |
| importers                                                               | 53 passed          |
| categorization                                                          | 38 passed          |
| db                                                                      | 108 passed         |
| bot                                                                     | 1963 passed        |
| web                                                                     | 521 passed         |
| `pnpm e2e:bot` (harness, create-household, rls-proof, bot multi-tenant) | 17 passed, 4 files |
| `pnpm e2e:web` (Playwright: harness smoke, multi-tenant)                | 7 passed           |
| `node deploy/checks/rls-proof.mjs` on the e2e stack                     | 361/361 PASS       |

The multi-tenant suites use real GoTrue sessions, Postgres with RLS, the
production Next.js build and the real bot webhook. Only Telegram is faked.
Households "Casa Azul" (two members, locked theme with accent overrides) and
"Casa Verde" (one member) are created by `scripts/create-household.mjs`.

## What remains for the owner

1. Review and merge the pull request.
2. Run [`docs/runbooks/multi-tenancy-cutover.md`](../../../docs/runbooks/multi-tenancy-cutover.md)
   in order. Start Google brand verification first (2–3 business days).
3. Take the decisions in runbook section 0.3 and send the disclosure of
   section 8 before the tester's first login.
4. Decide on spec 2 (18 owner decisions listed in the research document).

## Not verified

- Nothing ran against production: no VPS, database, Vercel, Google console or
  Telegram webhook access.
- Google sign-in itself is not exercised by the e2e suites; they use password
  sessions and assert the OAuth `redirect_to` only.
- `apps/web/e2e/mvp-flow.spec.ts` is not part of the harness run.
