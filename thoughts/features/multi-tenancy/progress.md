# Multi-tenancy (spec 1) — progress

Status on 2026-09-29: implementation complete on `feat/multi-tenancy`, PR open
against `main`. Production was not touched. Design: [design.md](design.md).
Plan: [plan.md](plan.md). Spec 2 research:
[spec-2-privacy-research.md](spec-2-privacy-research.md).

## What shipped

| Task | Result                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Isolated e2e harness (`family-finance-e2e`, ports 5632x), fake Telegram, real bot and production web build                                      |
| 2    | Migration `0029`: allowlist per household, one membership per user, `households.theme`, scoped provisioning                                     |
| 3    | Web access decided by an active membership; `AUTHORIZED_EMAILS` removed                                                                         |
| 4    | `scripts/create-household.mjs`                                                                                                                  |
| 5    | Migration `0030`: free-form investment buckets per household                                                                                    |
| 6    | Migration `0031`: bot acts as the resolved member (short-lived JWT), conversations keyed by chat, Telegram user and household                   |
| 7    | Bot copy without personal names; "<name> comprou" routes to a member of the sender's household                                                  |
| 8    | Per-household theme and household name in the shell; neutral login and metadata                                                                 |
| 9    | Auth redirects stay on an allowlisted request host (`ALLOWED_WEB_HOSTS`)                                                                        |
| 10   | `deploy/checks/rls-proof.mjs` proves isolation between two households from the catalog                                                          |
| 11   | Multi-tenant web and bot e2e suites                                                                                                             |
| 12   | Cutover runbook and documentation                                                                                                               |
| —    | Migration `0032` (from review): membership only for confirmed emails, Telegram linking by one-time code, members update only their display name |

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

### Pull request review, round 1

GPT-6 Astra (Codex, adversarial, cold read): no actionable finding.
Fable 5.1 (primary): not mergeable for a second household. Findings:

| Id  | Finding                                                                                 | Disposition                                                                                       |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| M1  | Public email signup with autoconfirm lets anyone who knows an allowlisted email join    | Fixed: `0032` provisions only confirmed emails; production sets `ENABLE_EMAIL_AUTOCONFIRM=false`  |
| M2  | A member could write another person's Telegram id or username on their own row          | Fixed: `0032` one-time link code, column-level update grant, username matching removed            |
| M3  | Runbook omitted `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` and removed a redirect URI in use | Fixed in the runbook                                                                              |
| M4  | Merging before the migrations breaks the site when Vercel deploys automatically         | Fixed in the runbook: migrations and additive env vars first, merge after                         |
| m1  | No rollback procedure                                                                   | Fixed in the runbook: volume restore; the restore was not rehearsed                               |
| m2  | `create-household` idempotency check depends on database collation                      | Fixed                                                                                             |
| m3  | `create-household` duplicates theme validation, no email validation                     | Fixed; the script keeps its own token list (it runs with plain Node), guarded by an equality test |
| m4  | "Vale pros dois" copy                                                                   | Fixed                                                                                             |
| m5  | Personal email in seed and verifier                                                     | Fixed: `seed-member@example.test`                                                                 |
| m6  | Empty stray files at the repository root                                                | Removed                                                                                           |
| m7  | Comments describing the single-household model                                          | Fixed                                                                                             |
| m8  | `getAuthState` runs several times per request                                           | Fixed: React `cache`                                                                              |
| m9  | `confirm_import_v2` keeps a service-role branch                                         | Deferred to tech debt: members cannot reach it and the bot does not call it                       |
| m10 | Telegram API base URL read from `process.env`, not validated                            | Fixed: validated config, only `https://api.telegram.org` or a loopback host                       |
| m11 | Disclosure did not mention display names sent to AI providers                           | Fixed in the runbook                                                                              |
| m12 | Duplicated regex; sign-out branding not tested                                          | Fixed; the sign-out test passed without a product change                                          |
| m13 | Bot reply told an unknown sender to contact an administrator                            | Fixed: reply explains how to link Telegram                                                        |

Consequence for the owner: members whose Telegram link exists only as a
username (no numeric id yet) must link again with `/vincular`. Runbook
section 0 has the query that lists them.

### Pull request review, round 2

GPT-6 Astra (Codex, adversarial, cold read): three findings.

| Id  | Finding                                                                          | Disposition                                                                                                         |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A1  | `0032` applied while autoconfirm is still on; existing memberships never audited | Fixed in the runbook: autoconfirm goes off before the migrations (step 2.0), password identities audited (step 0.1) |
| A2  | Numeric Telegram ids stored before `0032` may come from username matching        | Fixed in the runbook: step 0.1 audits legacy bindings; doubtful ones are cleared and linked again by code           |
| A3  | Membership survives a change away from the allowlisted email                     | Rejected, by design: membership belongs to the account. Runbook section 9 documents removal (`is_active = false`)   |

Fable 5.1 (primary): code mergeable, runbook not ready. Findings:

| Id  | Finding                                                                        | Disposition                                                                       |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| M1  | Runbook changed `NEXT_PUBLIC_SITE_URL` while `main` still uses it for OAuth    | Fixed in the runbook: only `ALLOWED_WEB_HOSTS` first, site URL moves in step 5    |
| M2  | Bot `SUPABASE_URL` still pointed at the old hostname when its route is removed | Fixed in the runbook: bot moves first, checked before and after the route removal |
| m1  | Link command accepted in groups; a rejected code stayed valid                  | Fixed: private chat only, a rejected code is deleted                              |
| m2  | Username plumbing left in the bot and the resolver                             | Removed; `resolve_telegram_member` takes the numeric id alone                     |
| m3  | `redeemLinkCode` was an optional dependency                                    | Fixed: required                                                                   |
| m4  | Settings showed raw error text and no hint to reload after linking             | Fixed: errors are logged, friendly copy, reload hint                              |
| m5  | Telegram base URL declared twice; trailing slash not normalised                | Fixed: bot schema only, normalised to the origin                                  |
| m6  | Runbook promised that sessions survive the hostname move                       | Fixed in the runbook: sessions may end                                            |
| m7  | Compose mapping of `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` not confirmed         | Fixed in the runbook: step 4 checks the `auth` service environment                |
| m8  | Migration number `0028` lives on an unmerged branch                            | Recorded in tech debt                                                             |
| m9  | Renaming a bucket kept the old slug                                            | Fixed: the slug follows the name; a collision reports "Já existe um objetivo..."  |
| m10 | Rollback not rehearsed                                                         | Already stated in the runbook                                                     |
| m11 | No attempt limit on link codes                                                 | Accepted: 40-bit code, 10 minutes, single use, private chat only                  |

## End-to-end evidence (local, 2026-09-29)

Release gate: `pnpm typecheck && pnpm test && pnpm test:migrations && pnpm test:category-migration`.

| Suite                                                                   | Result             |
| ----------------------------------------------------------------------- | ------------------ |
| domain                                                                  | 104 passed         |
| config                                                                  | 19 passed          |
| importers                                                               | 53 passed          |
| categorization                                                          | 38 passed          |
| db                                                                      | 111 passed         |
| bot                                                                     | 1976 passed        |
| web                                                                     | 518 passed         |
| `pnpm e2e:bot` (harness, create-household, rls-proof, bot multi-tenant) | 21 passed, 4 files |
| `pnpm e2e:web` (Playwright: harness smoke, multi-tenant)                | 8 passed           |
| `node deploy/checks/rls-proof.mjs` on the e2e stack                     | 397/397 PASS       |

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
