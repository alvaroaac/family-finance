# Multi-tenancy (spec 1: tenancy) Implementation Plan

**Goal:** A second household can use the existing deployment with database-enforced
isolation, its own bot scope, its own name and colors, on a neutral hostname.

**Architecture:** Shared database and schema, isolation by `household_id` + RLS. The
bot stops using the service-role key for business data and acts as the resolved
member under RLS. One deployment serves several web hostnames. Stack-per-household
was rejected: it multiplies operations while the operator stays root on every stack.

**Tech Stack:** Existing stack. No new runtime dependencies. The end-to-end harness
uses the Supabase CLI and Playwright, both already in use.

**Spec:** `thoughts/features/multi-tenancy/design.md`

**Approval:** Plan pre-approved by the owner on 2026-09-29 for unattended execution.
Execution mode: subagent-driven, orchestrated by the main session.

## Global Constraints

- TDD: each task's **Behavior** bullets are its test list — write failing tests from them first, then implement. Commit per task.
- Work only in the worktree `.claude/worktrees/multi-tenancy`, branch `feat/multi-tenancy`. Never touch other branches or worktrees.
- No production access: no VPS, no production database, no Vercel, no Google console, no Telegram webhook registration.
- Never touch the developer's running local Supabase stacks (`family-finance` on ports 5432x, `family-finance-mobile` on ports 5532x). The end-to-end stack is separate (Task 1).
- Migrations are new files numbered from `202610080001`. Never edit migrations `0001`–`0028`. Every migration must pass `pnpm test:migrations`, which applies each migration twice, so every statement is idempotent.
- Migrations must apply on a fresh database (no household exists until `seed.sql` runs) and on production (exactly one household, two members).
- Hand-written types in `packages/db/src/types.ts` are updated in the same task as the schema change.
- No service-role key in web code. This invariant already holds and must keep holding.
- The household of a request always comes from the authenticated user's membership. It never comes from the hostname, a query parameter, a cookie, or a client-supplied id that is not checked by RLS.
- User-facing copy is Brazilian Portuguese. Copy given verbatim in this plan is contractual.
- Non-test code under `apps/` and `packages/` must not contain "Alvaro", "Álvaro", "Karol" or "alvaroekarol" when the work is complete.
- Release gate, all green before a task is reported done: `pnpm typecheck`, `pnpm test`, and for tasks with migrations `pnpm test:migrations` and `pnpm test:category-migration`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| Path                                                                                                                                                                                     | Responsibility                                                      | Task    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| `e2e/supabase/config.toml`                                                                                                                                                               | Isolated local stack definition                                     | 1       |
| `e2e/stack.sh`                                                                                                                                                                           | Start, migrate, seed, stop the end-to-end stack                     | 1       |
| `e2e/lib/`                                                                                                                                                                               | Test helpers: users, sessions, fake Telegram API, bot process       | 1       |
| `supabase/migrations/202610080001_multi_household_provisioning.sql`                                                                                                                      | Allowlist to household mapping, membership uniqueness, theme column | 2       |
| `supabase/seed.sql`                                                                                                                                                                      | Seed allowlist row for the seeded household                         | 2       |
| `apps/web/lib/auth.ts`                                                                                                                                                                   | Membership-based access decision                                    | 3       |
| `packages/config/src/index.ts`                                                                                                                                                           | Env schema: remove email gate, add allowed hosts, bot JWT secret    | 3, 6, 9 |
| `scripts/create-household.mjs`                                                                                                                                                           | Operator provisioning tool                                          | 4       |
| `supabase/migrations/202610080002_free_form_investment_buckets.sql`                                                                                                                      | Bucket slug as text                                                 | 5       |
| `packages/domain/src/accounts.ts`, `apps/web/app/(app)/investments/*`, `apps/web/app/(app)/dashboard/page.tsx`                                                                           | Buckets as data                                                     | 5       |
| `supabase/migrations/202610080003_bot_member_scope.sql`                                                                                                                                  | Identity function, conversation key, tightened RPC gates            | 6       |
| `packages/db/src/index.ts`                                                                                                                                                               | `createMemberClient`                                                | 6       |
| `apps/bot/src/index.ts`, `apps/bot/src/store.ts`                                                                                                                                         | Member-scoped data access, conversation key                         | 6       |
| `apps/bot/src/{replies,interpret,financial-routing,conversation,index}.ts`                                                                                                               | Neutral copy, member-name routing                                   | 7       |
| `packages/domain/src/theme.ts`                                                                                                                                                           | Theme document schema and CSS variable mapping                      | 8       |
| `apps/web/app/layout.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/login/page.tsx`, `apps/web/app/globals.css`, `apps/web/components/ui/ui.css`                                   | Theme application, neutral branding                                 | 8       |
| `apps/web/lib/site-origin.ts`                                                                                                                                                            | Request host to site origin                                         | 9       |
| `deploy/checks/rls-proof.mjs`                                                                                                                                                            | Two-household proof                                                 | 10      |
| `apps/web/e2e/multi-tenant.spec.ts`, `e2e/bot-multi-tenant.test.ts`                                                                                                                      | End-to-end suites                                                   | 11      |
| `docs/runbooks/multi-tenancy-cutover.md`, `deploy/*.md`, `.env.example`, `README.md`, `docs/decisions/0002-*.md`, `thoughts/tech-debt.md`, `thoughts/features/multi-tenancy/progress.md` | Documentation                                                       | 12      |

## Task order and routing

Tasks run sequentially in one worktree because most of them touch
`packages/db/src/repositories.ts`, `packages/db/src/types.ts` or the config schema.

| Task                  | Implementer                             | Reviewer                               |
| --------------------- | --------------------------------------- | -------------------------------------- |
| 1 End-to-end harness  | GPT-6 Sol via Codex, high effort        | Orchestrator                           |
| 2 Provisioning schema | GPT-6 Sol via Codex, high effort        | GPT-6 Astra via `codex-review`         |
| 3 Membership gate     | GPT-6 Sol via Codex, high effort        | Orchestrator                           |
| 4 Provisioning script | GPT-6 Sol via Codex, high effort        | Orchestrator                           |
| 5 Free-form buckets   | Opus 5.5 (includes UI)                  | Orchestrator                           |
| 6 Bot member scope    | GPT-6 Sol via Codex, high effort        | GPT-6 Astra via `codex-review` + Fable |
| 7 Bot neutral copy    | GPT-6 Sol via Codex, high effort        | Orchestrator                           |
| 8 Theme and branding  | Opus 5.5                                | Fable                                  |
| 9 Multi-host          | GPT-6 Sol via Codex, high effort        | Orchestrator                           |
| 10 RLS proof          | GPT-6 Sol via Codex, high effort        | GPT-6 Astra via `codex-review`         |
| 11 End-to-end suites  | GPT-6 Sol via Codex, high effort        | Orchestrator runs them                 |
| 12 Documentation      | Orchestrator                            | —                                      |
| PR review loop        | Fable primary + GPT-6 Astra adversarial | —                                      |

---

### Task 1: End-to-end harness

**Files:**

- Create: `e2e/supabase/config.toml`, `e2e/stack.sh`, `e2e/lib/users.ts`, `e2e/lib/session.ts`, `e2e/lib/fake-telegram.ts`, `e2e/lib/bot-process.ts`, `e2e/README.md`, `e2e/package.json`, `e2e/vitest.config.ts`
- Modify: `pnpm-workspace.yaml`, `package.json` (scripts), `apps/web/playwright.config.ts`, `apps/bot/src/telegram.ts`, `apps/bot/src/audio.ts`, `packages/config/src/index.ts`
- Test: `e2e/harness.test.ts`, `apps/web/e2e/harness-smoke.spec.ts`

**Interfaces:**

- Produces:
  - Root scripts: `pnpm e2e:up` (start stack, apply all migrations, apply seed, print env), `pnpm e2e:down` (stop and delete volumes), `pnpm e2e:env` (print `KEY=value` lines), `pnpm e2e:bot` (bot suite), `pnpm e2e:web` (Playwright suite).
  - Stack: Supabase CLI project id `family-finance-e2e`, API port `56321`, database port `56322`. Only Postgres, GoTrue, PostgREST and Kong run; Studio, Realtime, Storage, Inbucket, Analytics and Edge Functions are disabled.
  - Web server for tests on port `3100`, reachable as `http://localhost:3100` and `http://127.0.0.1:3100`.
  - `createTestUser(email: string, password: string): Promise<{ userId: string }>` using the GoTrue admin API; the user is created confirmed.
  - `storageStateFor(email: string, password: string, origin: string): Promise<string>` returning the path of a Playwright storage state holding a valid `@supabase/ssr` session cookie for that origin.
  - `startFakeTelegram(): Promise<{ baseUrl: string; sent: SentMessage[]; stop(): Promise<void> }>` where `SentMessage = { method: string; chatId: number; text?: string; payload: unknown }`.
  - `startBot(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void> }>` running `apps/bot` server on a free port.
  - Env `TELEGRAM_API_BASE_URL` (optional URL, default `https://api.telegram.org`) honored by every Telegram call in the bot.

**Behavior:**

- `pnpm e2e:up` on a machine where the two developer stacks are running succeeds and leaves those stacks untouched and running.
- `pnpm e2e:up` applies every file in `supabase/migrations` in filename order, then `supabase/seed.sql`. A second `pnpm e2e:up` on a running stack resets the database to the same state.
- `createTestUser` for an email that is not allowlisted creates an `auth.users` row and no `household_members` row.
- A Playwright page opened with `storageStateFor` for a member of the seeded household renders `/dashboard` without redirecting to `/login`.
- With `TELEGRAM_API_BASE_URL` set, a webhook text message from a linked member produces a `sendMessage` call recorded by the fake and no request to `api.telegram.org`.
- With no AI keys set, the bot starts and handles a text message with the deterministic parser.
- The Playwright and bot end-to-end suites are not part of `pnpm test`.

**Verify:**

- Run: `pnpm e2e:up && pnpm e2e:bot && pnpm e2e:web && pnpm e2e:down`
- Expected: harness tests green; `docker ps` still lists the `family-finance` and `family-finance-mobile` containers.
- Run: release gate. Expected: green.

---

### Task 2: Provisioning schema

**Files:**

- Create: `supabase/migrations/202610080001_multi_household_provisioning.sql`, `packages/db/test/multi-household-provisioning-functional.sql`
- Modify: `supabase/seed.sql`, `packages/db/src/types.ts`, `scripts/verify-all-migrations.sh` (only if needed to include the new functional test)

**Interfaces:**

- Produces:
  - `allowed_emails(email text primary key, household_id uuid not null references households(id) on delete cascade)`. Column `household_slug` is dropped.
  - `household_members`: unique constraint on `user_id` alone, named `household_members_user_id_key`.
  - `households.theme jsonb not null default '{"base":"esmeralda"}'`.
  - Functions `provision_household_member()` and `provision_on_allowlist()` keep their names and triggers.

**Behavior:**

- Backfill: when exactly one household exists, every `allowed_emails` row gets that household's id.
- Backfill: when no household exists, existing `allowed_emails` rows are deleted with a `NOTICE` naming the count. `seed.sql` then inserts `alvaro.a.a.a.c@gmail.com` for the seeded household.
- Backfill: when more than one household exists and any `allowed_emails` row has no household, the migration raises an exception and changes nothing.
- A user signing up with an email allowlisted for household B becomes a member of B and of no other household.
- Allowlisting an email whose user already exists makes that user a member of the allowlisted household.
- Allowlisting an email whose user is already a member of another household fails with an exception; the allowlist row is not created and the membership is unchanged.
- Inserting an `allowed_emails` row with a null or unknown `household_id` fails.
- Email matching stays case-insensitive.
- The migration applied twice produces no error and no change.

**Verify:**

- Run: `pnpm test:migrations && pnpm test:category-migration && pnpm typecheck && pnpm test`
- Run: `pnpm e2e:up`. Expected: stack comes up with `202610080001` applied and the seed allowlist row present.

---

### Task 3: Membership-based access gate

**Files:**

- Modify: `apps/web/lib/auth.ts`, `packages/config/src/index.ts`, `packages/config/src/index.test.ts`, `apps/bot/src/index.ts`, `apps/bot/src/server.test.ts`, `apps/bot/src/jev.test.ts`, `apps/web/app/login/page.tsx` (denied state only), `.env.example`
- Test: `apps/web/lib/auth.test.ts` (or the existing test file for `evaluateAccess`)

**Interfaces:**

- Consumes: `findHouseholdIdForCurrentUser` from `packages/db`.
- Produces:
  - `evaluateAccess(principal: AuthPrincipal | null, householdId: string | null): AccessDecision` with the existing `AccessDecision` union.
  - `requireAuthorizedUser(): Promise<{ email: string; householdId: string }>`.
  - Removed exports: `getAuthorizedEmails`, `isEmailAuthorized`, `getHouseholdSlug`. Removed env keys: `AUTHORIZED_EMAILS`, `HOUSEHOLD_SLUG`.

**Behavior:**

- No session: `unauthenticated`.
- Session whose user has an active membership: `authorized`.
- Session whose user has no membership, or only an inactive one: `forbidden`, and the denied screen shows the email.
- Env parsing succeeds when `AUTHORIZED_EMAILS` is absent, and ignores it when present.
- A membership lookup that fails with a database error is treated as `unauthenticated`, never as `authorized`.

**Verify:**

- Run: release gate. Expected: green.
- Run: `grep -rn "AUTHORIZED_EMAILS\|HOUSEHOLD_SLUG" apps packages --include='*.ts' --include='*.tsx'`. Expected: no matches outside test descriptions asserting absence.

---

### Task 4: Provisioning script

**Files:**

- Create: `scripts/create-household.mjs`, `scripts/default-categories.json`
- Create: `supabase/migrations/202610080004_create_household_function.sql` only if the executor chooses a database function for atomicity; otherwise a single SQL transaction over a direct Postgres connection.
- Test: `e2e/create-household.test.ts`

**Interfaces:**

- Consumes: schema from Task 2; theme document shape from Task 8 (stated here so the script can validate without importing it):
  ```json
  { "base": "esmeralda" | "salvia", "lockBase": true, "overrides": { "--ff-accent": "#a1b2c3" } }
  ```
- Produces:
  - CLI: `node scripts/create-household.mjs --name <name> --email <email> [--email <email> ...] [--theme <path-to-json>]`
  - Connection from env `DATABASE_URL`. No default value.
  - Output on success: one line `household_id=<uuid>`.
  - `scripts/default-categories.json`: the category and subcategory set every new household receives, including category `kind`. Content equals what the existing household has from `seed.sql` plus migrations `0021` and `0022`.

**Behavior:**

- Creates the household, its theme, its default categories and subcategories, and one `allowed_emails` row per email, in one transaction.
- Creates no investment buckets, accounts or credit cards.
- Running it again with the same name and the same email set changes nothing and prints the same `household_id`.
- Running it with a name that exists but a different email set fails with a message naming the conflict, and changes nothing.
- An email already allowlisted for another household fails, and changes nothing.
- An invalid theme document (unknown base, unknown token, non-hex value) fails before any write.
- Missing `--name` or no `--email` fails with usage text and exit code 2.
- Emails are stored lowercase.
- The script refuses to run when `DATABASE_URL` is unset.

**Verify:**

- Run: `pnpm e2e:up && pnpm e2e:bot` (suite includes `create-household.test.ts`). Expected: green.
- Run: release gate. Expected: green.

---

### Task 5: Free-form investment buckets

**Files:**

- Create: `supabase/migrations/202610080002_free_form_investment_buckets.sql`
- Modify: `packages/db/src/types.ts`, `packages/db/src/repositories.ts`, `packages/db/src/index.ts`, `packages/domain/src/accounts.ts`, `packages/domain/src/index.ts`, `apps/web/app/(app)/investments/page.tsx`, `apps/web/app/(app)/investments/actions.ts`, `apps/web/app/(app)/dashboard/page.tsx`, `supabase/seed.sql`
- Test: `apps/web/integration/investments.test.ts`, `packages/db/src/repositories.test.ts`, `apps/web/integration/mvp-flow.test.ts`

**Interfaces:**

- Produces:
  - `investment_buckets.slug text not null`, check `slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`; type `investment_bucket_slug` dropped. `unique(household_id, slug)` kept.
  - `slugifyBucketName(name: string): string` in `packages/domain`: lowercase, accents removed, non-alphanumeric runs become `_`, trimmed of `_`.
  - Repository: `createInvestmentBucket(client, { householdId, name })`, `renameInvestmentBucket(client, { householdId, bucketId, name })`, `deleteInvestmentBucket(client, { householdId, bucketId })`.
  - Server actions with the same three operations on the investments page.

**Behavior:**

- Existing buckets keep their slug, name and balance through the migration.
- Creating "Viagem 2027" yields slug `viagem_2027`. Creating "Independência Financeira" yields `independencia_financeira`.
- Creating a bucket whose slug already exists in the household fails with the message "Já existe um objetivo com esse nome."
- A name that slugifies to an empty string is rejected with "Informe um nome para o objetivo."
- Renaming changes the name and keeps the slug.
- Deleting a bucket with a non-zero balance fails with "Só é possível excluir um objetivo com saldo zerado."
- Deleting a bucket with a zero balance removes it.
- A household with no buckets sees an empty state on the investments page with the create action, and the dashboard renders without a buckets section error.
- Two households can each have a bucket with the same slug.
- The UI follows the existing investments page components and tokens; no new visual language.

**Verify:**

- Run: release gate including both migration scripts. Expected: green.
- Manual, against the end-to-end stack: create, rename, delete a bucket on `/investments`.

---

### Task 6: Bot member scope

**Files:**

- Create: `supabase/migrations/202610080003_bot_member_scope.sql`, `packages/db/test/bot-member-scope-functional.sql`
- Modify: `packages/db/src/index.ts`, `packages/db/src/repositories.ts`, `packages/db/src/types.ts`, `packages/config/src/index.ts`, `apps/bot/src/index.ts`, `apps/bot/src/store.ts`, `apps/bot/src/server.ts`, `deploy/bot/docker-compose.yml` (env names only), `.env.example`
- Test: `apps/bot/src/bot.test.ts`, `apps/bot/src/webhook-http.test.ts`, `packages/db/src/member-client.test.ts`, new cases in existing bot test files

**Interfaces:**

- Produces:
  - SQL: `resolve_telegram_member(p_telegram_user_id bigint, p_telegram_username text) returns table (household_id uuid, user_id uuid, display_name text)`, `SECURITY DEFINER`, `EXECUTE` granted to `service_role` only. Performs the username match and the id back-fill that `resolveTelegramMember` does today.
  - SQL: `bot_conversations(chat_id bigint, telegram_user_id bigint, household_id uuid not null references households(id) on delete cascade, state jsonb, updated_at timestamptz, primary key (chat_id, telegram_user_id))`. Existing rows are deleted by the migration.
  - `createMemberClient(options: { supabaseUrl: string; anonKey: string; jwtSecret: string; userId: string; ttlSeconds?: number }): AppSupabaseClient` in `packages/db`. Token: HS256, claims `sub` = user id, `role` = `authenticated`, `aud` = `authenticated`, `exp` = now + `ttlSeconds` (default 300). Signed with `node:crypto`; no JWT library.
  - Bot env: `SUPABASE_JWT_SECRET` (required by `startBot`), `SUPABASE_ANON_KEY` (required by `startBot`, falling back to `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
  - Conversation store: `load(chatId, telegramUserId)`, `save(chatId, telegramUserId, householdId, state)`, `delete(chatId, telegramUserId)`.

**Behavior:**

- A webhook update from a linked member writes its transaction with that member's `household_id` and `created_by_user_id`, through a client that RLS applies to.
- A business write carrying another household's `household_id`, sent through the member client, is rejected by the database.
- A business read through the member client returns no row of another household, including categories, memory, cards and recent transactions.
- A sender that matches no member gets the refusal reply, and no row is written in any table.
- A sender matching by username gets `telegram_user_id` back-filled and `telegram_username` cleared, as today.
- `resolve_telegram_member` called with the anon or authenticated role fails with a permission error.
- Two members of different households writing in the same group chat hold independent conversation drafts.
- Two members of the same household writing in the same chat hold independent conversation drafts.
- A button tap by a user other than the draft's creator is refused, as today.
- The service-role client is used only for: `resolve_telegram_member`, the conversation store, `claim_import_suggestion_nonce`, `reserve_import_ai_paid_items`, `record_import_ai_paid_result`. A test enumerates the repository functions the bot calls and fails if any other one receives the service-role client.
- RPC gates that pass when `auth.uid()` is null are tightened for every RPC the bot now calls as a member: a null `auth.uid()` no longer passes. RPCs still called with the service-role key keep their current gate.
- In the import suggestion endpoint, the household used for quota is the one the signed payload's user belongs to; a payload naming a household the user is not a member of is rejected with 403.
- `startBot` throws a descriptive error when `SUPABASE_JWT_SECRET` or the anon key is missing.
- An expired member token causes one retry with a fresh token, then an error.

**Verify:**

- Run: release gate including both migration scripts. Expected: green.
- Run: `pnpm e2e:up && pnpm e2e:bot`. Expected: green, including the Task 1 bot smoke test, now through the member client.

---

### Task 7: Bot neutral copy and member-name routing

**Files:**

- Modify: `apps/bot/src/index.ts`, `apps/bot/src/replies.ts`, `apps/bot/src/interpret.ts`, `apps/bot/src/financial-routing.ts`, `apps/bot/src/conversation.ts`
- Test: `apps/bot/src/financial-routing-corpus.test.ts`, `apps/bot/src/interpret.test.ts`, `apps/bot/src/bot.test.ts`, `apps/bot/src/replies-*.test.ts`

**Interfaces:**

- Consumes: member identity from Task 6 (`householdId`, `userId`, `displayName`); the household's member list, read through the member client.
- Produces: routing and interpretation functions receive `memberNames: readonly string[]` for the sender's household.

**Behavior:**

- Unknown-sender reply, verbatim: "Oi! Eu ainda não conheço você por aqui — peça para quem administra a sua casa vincular seu Telegram nas Configurações."
- The identification-failure reply in `conversation.ts` names no person: "Não consegui te identificar. Peça para quem administra a sua casa conferir seu Telegram nas Configurações."
- "`<name>` comprou …" is routed as a purchase by that member for every `display_name` in the sender's household, case-insensitive and accent-insensitive.
- A name that belongs only to a member of another household is not treated as a member name.
- Every existing routing corpus case that used "Karol" still passes when "Karol" is a member name supplied to the router.
- LLM prompt examples and reply examples use the placeholder names "Ana" and "Bruno".
- A member with an empty `display_name` contributes no name and causes no error.

**Verify:**

- Run: release gate. Expected: green.
- Run: `grep -rniE "alvaro|álvaro|karol" apps/bot/src --include='*.ts' | grep -v '\.test\.ts' | grep -v '/evaluation/'`. Expected: no matches.

---

### Task 8: Theme and branding

**Files:**

- Create: `packages/domain/src/theme.ts`, `packages/domain/src/theme.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/db/src/repositories.ts`, `packages/db/src/types.ts`, `apps/web/app/layout.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/login/page.tsx`, `apps/web/app/opengraph-image.alt.txt`, `apps/web/app/(app)/settings/helpers.ts`, `apps/web/components/ui/theme-picker.tsx`, `apps/web/components/ui/ui.css`, `apps/web/lib/member.ts`
- Test: `apps/web/integration/app-shell-menu.test.tsx`, `apps/web/integration/settings.test.ts`, new `apps/web/integration/household-theme.test.tsx`

**Interfaces:**

- Produces:
  - `HouseholdTheme = { base: "esmeralda" | "salvia"; lockBase?: boolean; overrides?: Partial<Record<ThemeToken, string>> }`
  - `ThemeToken` = `--ff-bg`, `--ff-surface`, `--ff-surface-soft`, `--ff-tint`, `--ff-ink`, `--ff-ink-soft`, `--ff-accent`, `--ff-accent-hover`, `--ff-border`, `--ff-on-accent`.
  - `parseHouseholdTheme(value: unknown): { theme: HouseholdTheme; valid: boolean }`; an invalid document yields `{ base: "esmeralda" }` and `valid: false`.
  - `themeStyle(theme: HouseholdTheme): Record<string, string>` mapping override tokens to values.
  - `getCurrentHousehold(client): Promise<{ id: string; name: string; theme: HouseholdTheme }>` in `packages/db`.

**Behavior:**

- A value is accepted only as `#rgb` or `#rrggbb`. Anything else, including `url(...)`, `var(...)`, or a value containing `;`, invalidates the document.
- An unknown token invalidates the document.
- An invalid document renders the base `esmeralda` theme and logs one warning with the household id.
- Overrides are emitted as inline CSS custom properties on the root element of the authenticated layout, and nowhere on the login page.
- With `lockBase: true`, the household's `base` is used, the `ff-theme` cookie is ignored, and the theme picker is not rendered.
- Without `lockBase`, the cookie chooses the base and overrides apply on top.
- The header shows the household name. The fixed kicker "Nossa casa" is removed.
- The login page shows the product name "Family Finance" and the line "As contas da casa, do jeito de vocês." The invite line reads "Acesso por convite."
- Metadata description: "Workspace financeiro privado para a sua casa."
- The existing household, with the default theme document, renders pixel-identical to before in both base themes, apart from header text.
- Hex colors in `ui.css` that represent the brand accent or surface become token references. Hex colors that are status or neutral shadows stay.

**Verify:**

- Run: release gate. Expected: green.
- Manual, against the end-to-end stack with two households, one with `{"base":"salvia","lockBase":true,"overrides":{"--ff-accent":"#2f6fed","--ff-accent-hover":"#1f57c8"}}`: screenshots of `/dashboard` for both households and of `/login`.
- Run: `grep -rniE "alvaro|álvaro|karol" apps/web --include='*.ts' --include='*.tsx' --include='*.css' --include='*.txt' | grep -v integration/ | grep -v e2e/ | grep -v '\.test\.'`. Expected: no matches.

---

### Task 9: Multi-host

**Files:**

- Create: `apps/web/lib/site-origin.ts`, `apps/web/lib/site-origin.test.ts`
- Modify: `packages/config/src/index.ts`, `apps/web/app/login/page.tsx`, `apps/web/app/auth/callback/route.ts`, `.env.example`, any other reader of `NEXT_PUBLIC_SITE_URL`

**Interfaces:**

- Produces:
  - Env `ALLOWED_WEB_HOSTS`: comma-separated host list with optional port, e.g. `alvaroekarol.com.br,family-finance.ondemandly.dev`. Optional; when unset the list holds only the host of `NEXT_PUBLIC_SITE_URL`.
  - `resolveSiteOrigin(input: { host: string | null; forwardedProto: string | null }, env?): string`.

**Behavior:**

- A request whose host is in the list resolves to `<proto>://<host>`.
- A request whose host is not in the list resolves to the origin of `NEXT_PUBLIC_SITE_URL`.
- Host comparison is case-insensitive and ignores a trailing dot.
- The protocol is `https` unless the host is `localhost` or `127.0.0.1`, where it follows the forwarded protocol and defaults to `http`. The `x-forwarded-proto` header is never used to downgrade a non-local host to `http`.
- The Google sign-in action sends `redirectTo` = resolved origin + `/auth/callback`.
- The callback route redirects to a path on the origin the request arrived on. A `next` parameter that is not a same-origin path starting with a single `/` is replaced by `/dashboard`.
- Metadata and Open Graph URLs use `NEXT_PUBLIC_SITE_URL`.

**Verify:**

- Run: release gate. Expected: green.

---

### Task 10: RLS proof for two households

**Files:**

- Modify: `deploy/checks/rls-proof.mjs`, `deploy/README.md` (usage section)
- Create: `e2e/rls-proof.test.ts` (runs the script against the end-to-end stack)

**Interfaces:**

- Consumes: end-to-end stack env from Task 1.
- Produces: script env gains `MEMBER_B_EMAIL`, `MEMBER_B_PASSWORD`. The script creates a second throwaway household and removes it and its data on exit, including on failure.

**Behavior:**

- For every table with a `household_id` column, discovered from the database catalog and not from a hardcoded list: member A selects zero rows of household B; member A's insert with B's `household_id` fails; member A's update and delete of a B row affect zero rows.
- A table with a `household_id` column and no fixture in the script fails the proof with the table name, so a future table cannot be skipped silently.
- For `households` and `household_members`: A sees only its own household and its own household's members.
- For tables without policies (`bot_conversations`, `allowed_emails`, `import_suggestion_nonces`): A and the outsider read zero rows and cannot write.
- For every `SECURITY DEFINER` function in schema `public`, discovered from the catalog: called by A with B's household id or B's row ids, it fails or changes nothing in B. A function with no case in the script fails the proof with the function name.
- Composite foreign keys: A cannot create a transaction in A that references B's category, account, card or subcategory.
- The existing single-household checks keep passing.
- The script leaves no fixture behind; a run followed by a row count of both households' tables matches the count before.

**Verify:**

- Run: `pnpm e2e:up && pnpm e2e:bot`. Expected: `rls-proof.test.ts` green with every check printed `PASS`.

---

### Task 11: Multi-tenant end-to-end suites

**Files:**

- Create: `apps/web/e2e/multi-tenant.spec.ts`, `apps/web/e2e/global-setup.ts`, `e2e/bot-multi-tenant.test.ts`
- Modify: `apps/web/playwright.config.ts`

**Interfaces:**

- Consumes: Task 1 helpers, Task 4 script.
- Produces: fixture households created by running `scripts/create-household.mjs`:
  - "Casa Azul": members `ana@e2e.test`, `bruno@e2e.test`; theme `{"base":"salvia","lockBase":true,"overrides":{"--ff-accent":"#2f6fed","--ff-accent-hover":"#1f57c8"}}`.
  - "Casa Verde": member `carla@e2e.test`; default theme.
  - Outsider `dario@e2e.test`, not allowlisted.

**Behavior (web):**

- Ana and Carla each create a transaction, a category, a credit card and an investment bucket. Each sees only their own on every list page and on the dashboard totals.
- Bruno sees Ana's data. Carla sees neither's.
- Carla opening the URL of one of Ana's import batches, by id, gets a not-found state.
- Ana's header shows "Casa Azul"; Carla's shows "Casa Verde".
- Ana's root element carries `--ff-accent: #2f6fed`; Carla's carries no inline override. Ana sees no theme picker.
- Dario reaches the denied screen and no application page.
- A logged-out visitor on `/login` sees no household name and none of the forbidden names.
- Sign-in started from `http://localhost:3100` requests a `redirect_to` on `localhost:3100`; started from `http://127.0.0.1:3100` it requests one on `127.0.0.1:3100`. With a `Host` header outside the allowed list the `redirect_to` is on the canonical origin.
- A session obtained on `localhost:3100` is not authenticated on `127.0.0.1:3100`.

**Behavior (bot):**

- Ana and Carla link different Telegram ids. Each sends "mercado 50" and confirms. Each household gains exactly one transaction, created by the right user.
- Both send messages in the same chat id, interleaved. Drafts do not mix; each confirmation saves the sender's own draft.
- Carla taps the confirm button of Ana's draft. It is refused and nothing is saved.
- Ana asks for recent expenses. The reply contains only Casa Azul transactions.
- "Bruno comprou pizza 80" sent by Ana is attributed to Bruno. The same text sent by Carla is not attributed to any member named Bruno.
- An unlinked Telegram id gets the verbatim refusal reply and no row is written.
- No reply sent to any user contains the forbidden names.

**Verify:**

- Run: `pnpm e2e:up && pnpm e2e:bot && pnpm e2e:web && pnpm e2e:down`
- Expected: all green. The orchestrator runs this itself and records the output in `progress.md`.

---

### Task 12: Documentation and cutover runbook

**Files:**

- Create: `docs/runbooks/multi-tenancy-cutover.md`, `thoughts/features/multi-tenancy/progress.md`
- Modify: `deploy/README.md`, `deploy/vercel.md`, `deploy/supabase/README.md`, `.env.example`, `README.md`, `docs/runbooks/local-mvp-verification.md`, `docs/decisions/0002-rls-and-household-isolation.md`, `memory/project-goals.md`, `memory/project-decisions.md`, `thoughts/tech-debt.md`

**Behavior:**

- The cutover runbook lists every production step in order, each with its verification and its rollback: backup; migrations `202610080001`–`202610080003`; bot env (`SUPABASE_JWT_SECRET`, anon key) and bot redeploy; Supabase hostname move (Traefik route, GoTrue external URL, redirect allowlist); Google console (authorized redirect URI, consent screen in production status, scopes); Vercel (second domain, `ALLOWED_WEB_HOSTS`, `NEXT_PUBLIC_SITE_URL`, Supabase URL, removal of `AUTHORIZED_EMAILS`); running `rls-proof` against production; creating the tester's household; the disclosure to the tester.
- The runbook states the order constraint: the bot must be redeployed with the new env in the same window as migration `202610080003`, because the old bot cannot use the new conversation table or the tightened RPC gates.
- The tech-debt entry "allowed_emails.household_slug is written but never read" is marked resolved with the date and the migration number.
- ADR `0002` gains a dated section recording the move to multiple households and the bot's member scope.
- `progress.md` records decisions made during execution, deviations from this plan with their reason, the end-to-end output, and what remains for the owner.

**Verify:**

- Run: `pnpm format`. Expected: green for changed files.

---

## PR and review loop

1. Push `feat/multi-tenancy`, open a PR against `main`.
2. Primary review by Fable; adversarial review by GPT-6 Astra via `codex-review`, reading the diff with no session context.
3. Each finding is verified against the code before acting. Confirmed findings are fixed with a test; rejected findings are recorded in `progress.md` with the reason.
4. After fixes: release gate, both migration scripts, full end-to-end run.
5. Repeat from step 2 until a review round yields no confirmed finding of correctness or isolation, and CI is green.
6. The PR is left open for the owner to merge.
