# Family Finance v1.0 — design

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plans (one per phase)
**Companion doc:** `2026-07-01-ui-redesign-claude-design-prompt.md` (prompt for the visual redesign)

## Goal

Turn the MVP into a version the family uses daily: complete the web app (Transações,
Resumo rápido, Configurações, caixinha balances, real invoice timing), put the Telegram
bot in production (webhook, real identity, persistent conversations, voice + LLM text
interpretation), deploy everything (Supabase self-host on the VPS, web on Vercel, bot on
the VPS), and re-skin the UI with the "Editorial acolhedor" language from the casa-nova
landing page.

Decomposition: this spec covers FOUR phases, each getting its own implementation plan
and shipping usable software on its own. Order: **Phase 1 UI foundation → Phase 2 web
features → Phase 3 bot → Phase 4 deploy.**

## Current-state facts that shape the design

- Sidebar links `/transactions` and `/settings` 404 — pages never existed (MVP built 6/8).
- `household_members` has NO `display_name` and NO `telegram_user_id` (verified 0001).
- `investment_buckets` has NO balance column (only slug+name).
- `apps/bot` is a **library nobody calls**: no HTTP server, no polling loop, no start
  script, no Dockerfile. `startBot()` exists and returns `{ handle }`; `handleWebhook` +
  `verifyWebhookSecret` exist but are unwired.
- The bot's Supabase client is anon-key with NO session → under RLS,
  `findHouseholdIdForCurrentUser` returns nothing in production. There is no
  telegram-user→member mapping of any kind.
- Conversation state is a module-scope in-memory `Map` — dies on restart.
- Voice pipeline (Telegram file → temp download → Whisper `providers.ts`/`audio.ts` →
  same text pipeline) is real and tested with size/timeout guards; needs only
  `OPENAI_API_KEY`.
- Text parsing is deterministic regex (`parser.ts`); AI today is only the categorization
  fallback (Anthropic) — not value/date/intent extraction.
- Confirmation state machine (`conversation.ts`) is solid: draft → editable pt-BR summary
  → correction commands (`valor 45,90`, `data 12/03`, `categoria X`, `responsável Karol`)
  → explicit `confirmar` persists. `resolveResponsibleUserId` is a stub returning
  `undefined`.
- Installments attribute `dueMonth` by purchase month; `credit_cards.closing_day`/
  `due_day` exist and are unused (tech debt #5).
- Dashboard "Caixinhas" card shows names/count only (tech debt #1).
- Deploy topology decided 2026-06-30: web → Vercel; Supabase → self-host Docker on the
  VPS (public HTTPS, e.g. `supabase.alvaroekarol.com.br`); bot → VPS. A
  `household_members` auto-provisioning trigger was recommended and is included here.

---

## Phase 1 — UI foundation ("Editorial acolhedor")

The visual language comes from the casa-nova landing (`~/desenv/personal/alvaro-e-karol/
casa-nova`, see its `HANDOFF.md` and `src/themes.ts`). The companion prompt doc is given
to Claude design to produce the concrete screens; this phase then implements the design
system so Phases 2-3 build screens directly in the new skin.

### 1.1 Design tokens

CSS custom properties, two themes, **Esmeralda (dark) default**, Sálvia (light) optional:

- Esmeralda: bg `#16352B`, surface `#1E4133`, surfaceSoft `#1A3A2E`, tint
  `rgba(212,175,106,0.14)`, ink `#F2EDE0`, inkSoft `rgba(242,237,224,0.66)`, accent
  `#D4AF6A`, accentHover `#E4C488`, border `rgba(212,175,106,0.24)`, onAccent `#16352B`.
- Sálvia: bg `#E8EDE3`, surface `#F7F9F3`, surfaceSoft `#EFF3EA`, tint
  `rgba(168,133,60,0.12)`, ink `#2E3A2A`, inkSoft `#5F6B58`, accent `#A8853C`,
  accentHover `#C2A258`, border `#CBD6C0`, onAccent `#FFFFFF`.
- Semantic additions the landing didn't need (finance app): `positive` (income green,
  derived from theme), `negative` (expense, warm red-brown family `#B4552F`), `warn`
  (pending-review amber). Exact values come from the Claude design output.
- Typography: Playfair Display 500/600 for display/titles, Inter 300-600 for body/UI,
  uppercase wide-tracked Inter kickers. Google Fonts with preconnect.
- Shape/depth: 10-16px radii on cards, 999px pills for chips/tabs/badges, 1px hairline
  borders everywhere, warm shadows `rgba(20,14,8, 0.05-0.16)` — never black.

### 1.2 Implementation shape

- Tokens live in `apps/web/app/globals.css` (`:root[data-theme="esmeralda"]` /
  `[data-theme="salvia"]`); theme chosen via cookie read in the root layout (server) so
  there is no flash; toggle in Configurações (Phase 2) and a small floating control like
  the landing's theme picker.
- Replace the current inline-style const idiom with a small set of shared presentational
  components in `apps/web/components/ui/`: `Card`, `StatCard` (kicker + big number +
  delta), `Badge`, `Button`, `Table`, `PageTitle` (serif), `EmptyState`. No component
  library dependency — hand-rolled like today, but centralized so all pages share one
  language. Pages keep their logic; only presentation moves.
- All existing pages (dashboard, imports, categories, accounts, cards, investments,
  login) are re-skinned in this phase. Copy tone follows the landing: warm pt-BR,
  first-person plural, e.g. dashboard greeting "Como estão as contas da casa?" — final
  copy comes from the Claude design output.

### 1.3 Deliverable gate

Claude design's output (HTML/JSX mockups) is reviewed by the user BEFORE the
implementation plan for this phase is written. The mockups cover: app shell + sidebar,
dashboard, **Resumo** (§2.2 — the simplified daily view), Transações table, imports flow,
and the shared components.

---

## Phase 2 — Web features

### 2.1 `/transactions` — Transações (view + edit)

- Server component page + client table. Data via new `packages/db` repos, all
  household-scoped:
  - `findTransactionsFiltered(client, householdId, filters, page)` — filters: month
    (`YYYY-MM`, default current), accountId?, creditCardId?, categoryId?,
    responsibleUserId? | 'household', pendingOnly? (uncategorized non-transfer — same
    rule as the existing `needsReview` helper), text search on description?. Ordered
    `occurred_on desc, created_at desc`, paginated 50/page (offset).
  - `updateTransaction(client, householdId, id, patch)` — patch limited to
    `category_id`, `subcategory_id`, `description`, `responsibility_scope` +
    `responsible_user_id`, `occurred_on`. Amount/kind/payment instrument are NOT
    editable in v1.0 (delete + re-add instead; avoids reconciliation edge cases with
    installments/imports).
  - `deleteTransaction(client, householdId, id)` — hard delete; blocked (clear pt-BR
    error) when `installment_id` is not null (parcelas are managed via their group, not
    row-by-row).
- UI: filter bar (month stepper + selects + "pendentes" pill toggle), table with inline
  category/subcategory selects (same pattern as imports preview), description edit on
  click, responsável select (house/Alvaro/Karol via `display_name`), delete with
  confirm. Pending rows get the `warn` badge. Mobile: table collapses to card list
  (design from Phase 1 mockups).
- Server actions re-validate with domain rules; audit trail: none beyond updated_at
  (YAGNI).

### 2.2 `/resumo` — quick daily dashboard

Read-only, one screen, no filters, optimized for a 10-second phone check (primary
persona: Karol). Content (all existing queries or trivial variants):

- Greeting + month label (serif display).
- **Gasto do mês** big number + comparison vs previous month (existing
  `getMonthlySummary` twice).
- **Fatura projetada** of the month per card (existing `getCardPressure`).
- **Pendentes de revisão** count with a deep link to `/transactions?pending=1`
  (existing `findPendingReviewTransactions` count).
- **Últimos lançamentos** — last 5 (existing `findRecentTransactions`), amount +
  description + who.
- Layout/visual comes from the Claude design mockups (explicit item in the prompt).
- `/resumo` becomes the first sidebar item; `/dashboard` stays as the detailed view.

### 2.3 `/settings` — Configurações (minimal)

- Theme picker (Esmeralda/Sálvia) writing the theme cookie.
- Household members list: `display_name` (editable), linked `telegram_user_id`
  (editable, nullable), role label. Backed by migration §2.5 and repos
  `listHouseholdMembers` / `updateHouseholdMember` (household-scoped; a member can edit
  any member — family trust model, matches everything else).
- Bot status card: last `bot_interactions` row (when, kind) so "o bot tá vivo?" is
  answerable in the UI.

### 2.4 Caixinha balances

- Migration: `alter table investment_buckets add column balance_cents bigint not null
  default 0 check (balance_cents >= 0);`
- Investimentos UI: edit balance inline (manual position — spec §08 "saldo manual").
- Dashboard + Resumo: caixinhas card shows total + per-bucket values (extend
  `loadDashboardData`).

### 2.5 Members migration

```sql
alter table household_members
  add column display_name text,
  add column telegram_user_id bigint unique;
```

- `display_name`/`telegram_user_id` are NOT seeded by the migration (emails aren't in
  this table, so there is no safe key to seed by) — the Settings UI (§2.3) is the
  seeding path for both fields.
- `telegram_user_id` unique across the table: one Telegram account maps to exactly one
  member.

### 2.6 Invoice timing (installments)

- `createInstallmentPlan` gains optional `closingDay?: number` input. Rule: purchase day
  > closing day → first `dueMonth` = purchase month + 1; else purchase month. Subsequent
  parcels remain contiguous months. Pure-function change + tests; callers (cards UI,
  fatura import confirm, bot) pass the chosen card's `closing_day` when set.
- Existing groups are NOT regenerated (their dueMonths stand). No migration.
- Dashboard projections keep grouping by `dueMonth` — they become invoice-accurate for
  new purchases automatically.

---

## Phase 3 — Bot in production shape

### 3.1 Entrypoint: standalone webhook server

- `apps/bot/src/server.ts`: plain `node:http` server (no framework dep) —
  `POST /webhook` verifies `X-Telegram-Bot-Api-Secret-Token` against
  `TELEGRAM_WEBHOOK_SECRET` (reuse `verifyWebhookSecret`), parses the update, calls the
  existing `handle`, always answers 200 fast (processing is awaited but short; Telegram
  retries on non-200). `GET /health` returns ok + last-update timestamp.
- `package.json` gains `"start": "node dist/server.js"`; `apps/bot/Dockerfile`
  (multi-stage: pnpm install + build → slim node runtime).
- No polling mode (webhook only — decided).

### 3.2 Identity: service-role + member mapping

- New env `SUPABASE_SERVICE_ROLE_KEY` (bot only, never in web). New
  `createServiceRoleClient` in `packages/db` (service key, `auth.persistSession=false`).
- On each update: resolve `update.message.from.id` against
  `household_members.telegram_user_id`. Match → that member's `user_id` becomes
  `created_by_user_id` and their household scopes every query. No match → reply
  "não conheço você" once, log to `bot_interactions`, ignore.
- `resolveResponsibleUserId` becomes real: case/accent-insensitive match of the spoken
  name against `display_name` of active members.
- Service-role bypasses RLS, so every bot-side repo call passes explicit
  `household_id` (the repos already take it) — the bot never queries unscoped.

### 3.3 Persistent conversations

- Migration:

```sql
create table bot_conversations (
  chat_id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

  (service-role access only — no RLS policies granted to anon/authenticated; deny by
  default with RLS enabled.)
- `index.ts` swaps the `Map` for load→apply→save around each update (the state machine
  in `conversation.ts` is already pure — state in, state out; the store is the only
  change). Stale conversations (>24h) are treated as absent on load and deleted lazily.

### 3.4 LLM text interpretation (fallback, not replacement)

- Flow: deterministic `parseExpenseText` first. If it fails OR yields no amount, the
  update goes to a new `interpretExpenseText` using the existing `AiCompletionClient`
  (Anthropic): prompt extracts `{amount_cents, description, occurred_on?, category_hint?,
  responsible_hint?}` as JSON; result feeds the SAME draft + confirmation flow — the AI
  never saves anything directly; the user always sees the summary and must `confirmar`.
- No key / API error / unparseable → today's behavior (asks the user to rephrase).
- Voice path benefits automatically (transcription → same text pipeline).

### 3.5 Env summary (bot container)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL` (public HTTPS),
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (voice), `ANTHROPIC_API_KEY` +
`ANTHROPIC_MODEL` (categorization + text interpretation).

---

## Phase 4 — Deploy

### 4.1 Supabase self-host (VPS)

- Official Supabase docker-compose under `deploy/supabase/` in the repo (compose +
  `.env.example`, real `.env` stays on the VPS only). Public HTTPS via Caddy reverse
  proxy (`deploy/caddy/Caddyfile`) at `supabase.alvaroekarol.com.br`.
- Migrations 0001..000N applied via `supabase db push` (or psql) against the VPS
  instance; seed household + members.
- **Provisioning trigger** (new migration): `on auth.users insert`, if the new user's
  email is in the allowlist table, insert into `household_members(Casa)`. Allowlist
  becomes a tiny `allowed_emails` table (seeded with the two Gmail addresses, dotted
  form) so the trigger doesn't parse env vars. Web keeps its env-based check as
  belt-and-braces.
- Google OAuth: production redirect URLs registered; GoTrue config mirrors the working
  local `config.toml` (skip_nonce_check, external google, secret via env).

### 4.2 Web (Vercel)

- Project envs: `NEXT_PUBLIC_SUPABASE_URL=https://supabase.alvaroekarol.com.br`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `AUTHORIZED_EMAILS` (dotted Gmail forms — known
  gotcha). Custom domain optional v1.0.
- `unpdf` already builds on Vercel (no native deps — why it was chosen).

### 4.3 Bot (VPS)

- `deploy/bot/` compose service (image built from `apps/bot/Dockerfile`), same Caddy
  fronting `bot.alvaroekarol.com.br` (or a path on the main domain). After up:
  `setWebhook` with the secret; runbook documents the exact curl.
- Restart policy `unless-stopped`; logs via `docker logs`.

### 4.4 Verification gate (per environment)

The 26-check RLS/RPC proof script (`scratchpad/rls_proof.mjs`, now versioned under
`deploy/checks/`) runs against the VPS Supabase before the web/bot cut over. Bot
smoke: text lançamento + voice lançamento end-to-end in a private chat, confirmed rows
in `transactions` + `bot_interactions`.

---

## Out of scope (YAGNI, v1.0)

- Multi-household support; roles/permissions beyond the family trust model.
- Editing amount/payment-instrument of existing transactions (delete + re-add).
- Regenerating existing installment groups under the new invoice timing.
- Budgets/alerts, recurring transactions, reports/exports.
- Bot group-chat support (private chats of the two members only).
- Web push/PWA (the Resumo page is mobile-friendly web).

## Testing strategy

- Every pure change (invoice timing, LLM extraction parsing, conversation store
  contract, transaction filters) gets unit tests in its package, existing suites stay
  green (129+ tests).
- Bot server: integration test hitting the HTTP handler with a fake Telegram update +
  fake providers (no network).
- Deploy phase verified by the §4.4 gate, not unit tests.

## Risks

- **Supabase self-host operational surface** (upgrades, backups) — accepted; mitigation:
  document `pg_dump` cron in the deploy runbook.
- **Service-role key on the VPS** — bot container only, never client-side; `.env` on VPS
  with 600 perms.
- **LLM extraction wrong values** — mitigated by the unchanged mandatory confirmation
  step.
- **Design phase blocking** — if Claude design output stalls, Phases 2-3 can build on
  the current skin and re-skin later (explicitly allowed fallback).
