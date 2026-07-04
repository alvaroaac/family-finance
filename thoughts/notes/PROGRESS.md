# Family Finance MVP — Progress Log

Durable, append-only record of the MVP build. Newest sessions at the bottom; read the
trailing **Current state** block first. Per-task detail lives in `memory/tasks/task-01..11.md`;
tech debt in `memory/project-tech-debt.md`. This log captures cross-session *why*, not the diff.

## 2026-06-27 — Implement the 11-task MVP plan via phased workflows

Implemented `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` end to end.

### Tried that worked
- **Probed env before orchestrating** — `pnpm install` (10.6s), npm registry reachable, Node 22 / pnpm 9.15.4. Confirmed agents could verify green at each boundary. Network IS available for pnpm.
- **4 phased background Workflows** instead of one giant run: core (1→2→3→4), then 6→5→9, then 7→8, then 10→11→gate. Each task = implement → adversarial review → one fix round. I checkpointed `typecheck`/`test`/`build` myself between phases.
- **Sequential, not parallel, within the shared working tree** — tasks heavily interdepend and must stay green + committed at each boundary; parallel agents would stomp each other / break typecheck. Foundation-gated: Phase 1 would stop if Task 1 baseline weren't green.
- **All 11 tasks passed review on the first fix budget.** Final: typecheck 12/12, 112 tests, web+bot builds green, release gate 10/10. Commits `a312809`..`3c376c2`.
- **Moved 11 commits off `main` onto `feat/family-finance-mvp`** (`git branch` + `git branch -f main origin/main`), pushed, opened PR #1.

### Tried that didn't work / gotchas
- **Baseline `typecheck`/`test` failed before Task 1** — only because per-package `tsconfig.json` didn't exist (tsc printed help). Expected; Task 1 fixed it. Not a real failure.
- **`@supabase/ssr` was assumed unavailable** by the Task 4 agent (it built a hand-rolled cookie client on `@supabase/supabase-js`). Network actually works, so this is removable later — flagged for review.
- **Next.js couldn't resolve shared NodeNext `.js` import specifiers** from raw-TS workspace packages → Task 6 added `transpilePackages` + webpack `resolve.extensionAlias` in `next.config.mjs`. Workaround, removable once packages ship built `dist`.
- **Playwright vs vitest** — `apps/web/e2e/mvp-flow.spec.ts` (Playwright) is kept OUT of the vitest path; the runnable offline story test is `apps/web/integration/mvp-flow.test.ts`.

### Decisions
- **Per-task commits with the plan's exact messages** (e.g. `feat(domain): add core finance model`) — small reviewable boundaries.
- **Offline = mock/fake everything external** — no live Supabase/Telegram/LLM exercised. Migration SQL complete + reviewable; local-apply documented in `docs/runbooks/local-mvp-verification.md`.
- **"Pending review" = uncategorized non-transfer transaction** (schema has no status column) — natural MVP signal, needs user confirm.
- **Caixinhas show names/count, not balance** — `investment_buckets` has no balance column. Spec §08 "posição simples" satisfied minimally.
- **Handoff/progress docs in `thoughts/`; tech debt stays in `memory/project-tech-debt.md`** (project convention) — no duplicate `thoughts/tech-debt.md`.

---

## 2026-06-28 — Tech-debt burndown (Batch 1 + 2)

User chose "burn down tech debt" over PR-review/integration (PR #1 still had zero reviews). Triaged
the 15 open items into: offline quick-wins, atomicity-via-RPC, and defer-as-features. Executed 8 via a
background Workflow + resolved #7 inline. 9 of 15 items now closed.

### Tried that worked
- **#7 was not real debt** — removed the "manual" `supabase-js` symlink, ran a clean `pnpm install`
  (network reachable now); pnpm recreated it automatically and the lockfile was unchanged. No commit.
- **One background Workflow, items strictly SEQUENTIAL in the shared tree** (same reason the MVP build
  was sequential: they share `repositories.ts`/`types.ts`/`fake-supabase.ts`/migrations and must stay
  green+committed at each boundary). Per item: implement → 3-lens adversarial review → budgeted fix →
  verify+commit. `thoughts/` + `memory/` excluded from staging so no stray edits leaked into commits.
- **7/8 items committed by the workflow** (`7a5894f`..`7733473`); I finished the 8th (eslint) by hand.
- **Independent RPC verification (didn't trust the agent's claim):** applied all 4 migrations to a
  throwaway Postgres 16 — clean apply validates the plpgsql bodies (CREATE-time ref checking). Then
  forced a partial-failure rollback on `create_installment_purchase`: a NULL-parcel insert rolled the
  whole group back, no orphan. Representative atomicity proof for the shared single-function-body pattern.
- **Whole tree re-verified green:** typecheck 12/12, **117 tests** (was 112), web+bot builds, web lint clean.

### Tried that didn't work / gotchas
- **The Workflow threw at the very end** — the `web-eslint` VERIFY agent blew the StructuredOutput retry
  cap (5×), so it never committed/reverted, leaving the eslint changes dangling uncommitted. The gate had
  not actually failed; I ran it myself (lint clean, builds green) and committed `b089652`. Lesson: a
  schema-validation flake on the LAST item can abort the run after all real work is done — check git state,
  don't assume total failure. 40 agents, ~2.1M tokens, ~90 min.
- **`merge_category` / `confirm_import` atomicity not independently rollback-forced** — only apply-clean +
  JS happy-path. They share the exact mechanism proven for `0002`, but a live forced-rollback is unproven.

### Decisions
- **Deferred 6 items as features needing a product call, not cleanup:** #1 caixinha balances, #5 invoice
  timing, #9 `extensionAlias` removal (needs packages to ship `dist`), #11 XLSX/format variants, #12 bot
  conversation persistence, #15 LLM text interpretation. #14 left OPEN but half-done (timeout+size guard
  landed; live-API parsing still unverified).
- **Commits stay on `feat/family-finance-mvp`, nothing pushed** — user can review before pushing.

---

## 2026-06-30 — Live #1 (DB+RLS) verified + #2 (web Google login) wired & working

User chose to "actually test this." Scoped to surfaces **#1 DB+RLS** (no secrets) + **#2 full web login**
(needs Google creds). #3 (Telegram bot) explicitly deferred. Ran inline (user's exec-mode pick).

### Tried that worked
- **Closed the year-old Supabase-CLI blocker.** `brew install supabase/tap/supabase` (net reachable),
  `supabase init` → `supabase/config.toml`, `supabase start` + `db reset` applied `0001`→`0005` + seed on
  the REAL Auth stack (GoTrue/PostgREST/Postgres), not the throwaway-PG stub.
- **26-check RLS + RPC proof** (`scratchpad/rls_proof.mjs`, supabase-js as member + outsider): RLS both
  directions; **forced-rollback of all 3 RPCs** — `merge_category` (bogus target → FK abort) and
  `confirm_import` (2nd row amount<=0 → CHECK abort) **force-proven for the first time**, leaving no partial state.
- **#2 wired + verified before any click:** `config.toml [auth.external.google]` (env() secret, redirect
  pinned to localhost, `skip_nonce_check=true`) + `apps/web/.env.local` (local stack). GoTrue reports
  `google:true`; the Supabase→Google authorize handshake returns the correct `client_id` + `redirect_uri`.
  **User then logged in via Google successfully.**
- **Granted data scope:** inserted alvaro's `auth.users` id into `household_members(Casa)` via service role.

### Tried that didn't work / gotchas
- **First proof run: "permission denied for table" for EVERY role** (incl. service_role). Root cause:
  `0001` shipped NO table GRANTs; a fresh Supabase's default privileges give the API roles only `Dxtm`.
  Real deploy-breaker, invisible offline (throwaway-PG queried as the owner). **Fixed → `0005_api_grants.sql`**
  (committed `e36c1e9`); 26/26 flip FAIL→PASS from a clean `db reset` off the migration alone.
- **Gmail dots:** Google returns `alvaro.a.a.a.c@gmail.com` (with dots); allowlist is exact-match →
  `AUTHORIZED_EMAILS` must be the dotted form (fixed in `apps/web/.env.local`).
- **localhost vs 127.0.0.1:** local Supabase's default callback derives `127.0.0.1` → would mismatch the
  `localhost` URI registered in Google. Pinned everything (`redirect_uri`, `site_url`,
  `NEXT_PUBLIC_SUPABASE_URL`) to **localhost**.
- **Background dev server died at the session boundary** (orphaned shell). Relaunched **detached**
  (`nohup … & disown`) so it now survives session teardown.

### Decisions
- **#1 committed + pushed** (`e36c1e9` grants+config, `d8320b0` memory) — user okayed; branch in sync with origin.
- **Deploy topology:** web → **Vercel**, Supabase → **self-host on the VPS** (public HTTPS, e.g.
  `supabase.alvaroekarol.com.br`), bot → VPS. Reason: Next builds native on Vercel and PostgREST-over-HTTP
  fits serverless; Supabase is load-bearing (Auth + PostgREST + RLS keyed to `auth.uid()`), so it can't be
  swapped for a hand-rolled API without a full rewrite — but it IS open-source Docker Compose, so
  self-hosting satisfies "everything in Docker on my VPS."
- **Membership provisioning gap:** `household_members` has no self-insert RLS policy (deliberate). Prod needs
  a trigger on `auth.users` to auto-link allowlisted emails to Casa (recommended, not yet built).

---

## 2026-07-01 — Designed Mercado Pago fatura (PDF) import

User asked to add MP credit-card **fatura** import to the dashboard, sample at
`~/Documents/Personal/Financeiro e Notas Fiscais/credit cards/credit-card-mp-statement.pdf`.
Brainstormed → wrote a design spec. **No implementation yet — spec pending user approval.**

### Tried that worked
- **Read the real fatura** (6-page statement PDF) to pin the format instead of guessing: multi-card
  sections (`Cartão Visa [****NNNN]`), rows `DD/MM <desc> R$ <valor>`, inline `Parcela X de Y`,
  international 2-line entries, a `Movimentações na fatura` payment block, dates with **no year**.
- **Grounded the design in the actual schema:** no credit-card `accounts.kind`; charges must use
  `transactions.credit_card_id` (CHECK: exactly one of account/card); `installment_groups.credit_card_id`
  NOT NULL; domain already supports `payment:{type:"card"}` and `confirm_import` already inserts
  `credit_card_id`/`installment_id`. So the feature reuses existing RPCs — **no new SQL** beyond an enum add.
- **PDF stays out of the pure `importers` package:** extract text in `previewImport` (web layer) via `unpdf`,
  feed the existing `adapter.parse(text)` contract. PDF bytes read → extracted → dropped (privacy parity w/ CSV).
- **Spec committed** `d71bc3a` (`docs/superpowers/specs/2026-06-30-mercado-pago-fatura-import-design.md`).

### Decisions
- **unpdf** for extraction (serverless/edge-friendly, zero native deps) — user picked recommended.
- **Sequential reuse of existing RPCs**, not a new combined fatura RPC (confirm_import for flat charges +
  create_installment_purchase per group). Non-atomic across the two; re-import dedupe makes it recoverable.
- **Single credit-card target** — all 3 Visa last-4 sections roll into one user-picked `credit_cards` row.
- **Parcelas → editable inferred installment groups.** Fatura shows only this month's parcel; count/total/
  purchase-month are inferred and **editable in preview**. Existing groups auto-detected + default-skipped.
- **Payments/credits skipped** — only consumo (expenses) import.
- **NormalizedImportRow** gains optional `installment?`/`cardLast4?` (additive, CSV adapters unaffected).

### Open questions raised to user (in the spec, awaiting review)
- §3 parcela year/occurredOn handling; §5 non-atomic confirm acceptable?; §4 dedupe key
  (description+count+purchase-month) loose-match OK with the "already exists" panel as safety net?

---

## 2026-07-01 (later) — MP fatura import BUILT via subagent-driven execution

User approved the spec after a self-review that found + fixed two real gaps, picked subagent-driven
execution, approved the plan. 9 tasks + final review executed, all green.

### Tried that worked
- **Self-review before approval caught two spec bugs:** (1) §5's "re-import detects already-imported
  charges" was FALSE — dedupe was within-batch only; added against-DB flat-charge check (spec amended
  `db5b02d`). (2) `installment_groups.purchased_on` needs a full DATE; spec only inferred month — added
  rule: row's DD + month from `statementMonth − (X−1)`, clamped.
- **Task 2 extracted the REAL PDF before writing the adapter** — critical: `unpdf.extractText(...,
  {mergePages:true})` returns ONE newline-free string for this document; payment block sits BEFORE card
  sections. The plan's line-based adapter sketch was invalid; adapter became a single-string scanner
  (split on card headers, row regex anchored on `DD/MM ... R$`, inter-match gap inspection for the
  international conversion fragment, sourceLine = transaction ordinal).
- **Final whole-branch review (opus) found a real cross-task seam** the per-task reviews couldn't: parcela
  exclusion from flat import was UI-only; a client could double-import a parcela row (flat + group). Fixed
  server-side (`9d57902`).
- **Real-PDF smoke:** 21 rows / 0 errors / 7 inferred groups / referenceMonth 2026-06. Gate: typecheck
  12/12, 129 tests, web+bot builds, lint clean. ~9 implementer/reviewer subagents + fixer, ledger in
  `.superpowers/sdd/progress.md`.

### Decisions
- Dedupe queries are HOUSEHOLD-scoped, not card-scoped (preview runs before the card is picked; strictly
  safer, flags are overridable) — small documented deviation from spec §4 wording.
- `creditCards` loaded for all sources in preview (uniform PreviewState), not MP-only.
- Enum migration applied via `supabase migration up` (NEVER `db reset` — live walkthrough data).

### Commits (all on feat/family-finance-mvp, UNPUSHED)
`db5b02d` spec amend · `e0a643c` plan · `8cd7218` migration 0006 · `7f7bc8c` fixture+unpdf · `8cba1cd`
adapter · `43cc3ba` reconstruction · `10e3427` db queries · `2783dbb` preview action · `d7ea968` confirm
action · `56334ad` UI · `9d57902` server-side parcela guard.

---

## 2026-07-01 (later ainda) — Fatura import verified LIVE + v1.0 designed

User ran the real import in the browser — **it worked**: batch `mercado_pago_pdf` confirmed, 21 rows,
14 flat card transactions (R$ 2.843,97, 30/05→27/06), 7 installment groups incl. the cross-year
`MERCADOLIVRE*EBAZARCOMBRL` 18x purchased 2025-05-02 (year inference proven live). Verified via psql
on the local stack. User then found `/transactions` (and `/settings`) 404 — pre-existing MVP gap: sidebar
links exist, pages never built.

Brainstormed + spec'd **v1.0** (user request: daily-usable app + Telegram bot with voice + cozy UI).

### Tried that worked
- **Explore agents on casa-nova + apps/bot before asking questions** — surfaced that the bot is worse
  than the tech-debt notes said: it's a LIBRARY nobody calls (no server/polling/Dockerfile/start), and its
  Supabase client is anon-key with no session → RLS returns nothing in prod. Also extracted the complete
  casa-nova design language ("Editorial acolhedor": Esmeralda `#16352B`+gold `#D4AF6A` / Sálvia light,
  Playfair Display+Inter, hairline borders, warm shadows, pt-BR íntimo).

### Decisions (user's picks)
- **v1.0 includes deploy** (Supabase self-host VPS + web Vercel + bot VPS) — daily use implies running.
- **Transações = view + edit** (category/sub/description/responsável/date inline; amount/payment NOT
  editable; delete blocked for parcelas). New **`/resumo`** simplified daily dashboard (persona: Karol,
  10-second phone check) — its layout is item #2 in the Claude design prompt.
- **Bot: standalone webhook server + service-role client + `household_members.telegram_user_id`
  allowlist**; persistent `bot_conversations` table; LLM text interpretation as fallback only (always
  behind the confirmation step). All 4 deferred MVP features enter v1.0 (caixinha balances, invoice
  timing via closing_day, bot conversation persistence, LLM text).
- **Theme: Esmeralda dark default + Sálvia toggle.**
- **Order: design prompt → web features → bot → deploy** (design-stall fallback: build on current skin).

### Artifacts
- Spec: `docs/superpowers/specs/2026-07-01-family-finance-v1-design.md` (4 phases, one plan each).
- Design prompt (self-contained, for user to paste in Claude design):
  `docs/superpowers/specs/2026-07-01-ui-redesign-claude-design-prompt.md`. Both committed `e6ff9b3`.

---

## 2026-07-01 (noite) — v1.0 Phases 2–4 BUILT (web features + bot production + deploy artifacts)

User said "implement the created spec, don't stop until your part is done" — explicit spec approval +
standing go. Wrote the master design prompt to `thoughts/2026-07-01-master-design-prompt.md` FIRST
(user's ask), then the Phases 2–4 plan (`4d32249`,
`docs/superpowers/plans/2026-07-01-family-finance-v1-phases-2-4.md`), then executed it via one
background Workflow: 13 tasks strictly sequential, each implement → adversarial review → budgeted fix
→ gate+commit. 28 agents, ~1.7M tokens, ~2h. Phase 1 (UI re-skin) untouched — gated on the user's
Claude-design mockups; everything built on the current skin (spec-allowed fallback).

### Tried that worked
- **Explore interface-report agent BEFORE writing the plan** — verbatim repo/type signatures let the
  plan pin exact interfaces per task; 11 of 13 tasks passed review first-try (only 2 fix rounds:
  Task 2 minor, Task 13 real).
- **Phase 2 (7 commits):** migration `0007` (members `display_name`/`telegram_user_id` unique +
  `investment_buckets.balance_cents`); repos (`findTransactionsFiltered` w/ pagination+ilike-escape,
  `updateTransaction`/`deleteTransaction` parcela-guarded, member profiles, bucket balance,
  `findLastBotInteraction`); domain `closingDay` invoice timing; **/transactions** (URL-contract
  filters, inline edit, guarded delete); **/resumo** (Karol's 10-second view, first nav item);
  **/settings** (ff-theme cookie w/ server-side `data-theme`, member editing, bot status);
  caixinha balances UI + dashboard totals.
- **Phase 3 (4 commits):** migration `0008` `bot_conversations` (RLS on, zero policies =
  service-role only) + `createServiceRoleClient` + `findMemberByTelegramUserId`; `handleWebhook`
  re-signed around `resolveMember` + injected `ConversationStore` (unknown telegram user → polite
  pt-BR refusal, member's `user_id` becomes createdByUserId — the anon/no-session identity bug is
  DEAD); real accent-insensitive `resolveResponsibleUserId` via display names; LLM text
  interpretation fallback (`interpret.ts`, parser-first, always behind confirmar); `server.ts`
  (node:http, POST /webhook 1MB cap, GET /health) + Dockerfile + `start: tsx src/server.ts`.
- **Phase 4 (3 commits):** migration `0009` `allowed_emails` + SECURITY DEFINER provisioning trigger
  on `auth.users` (verified live: allowlisted fake signup → member row; non-allowlisted → none);
  `deploy/` tree (supabase self-host README+env, Caddyfile, bot compose, `deploy/checks/rls-proof.mjs`
  RECREATED — old scratchpad copy was lost — and PASSING against the local stack, 9-step runbook).
- **Task 13 reviewer caught a real deploy-breaker:** bot container couldn't boot — `getServerEnv()`
  hard-requires web-only vars (`NEXT_PUBLIC_*`, `AUTHORIZED_EMAILS`) absent from the bot env set.
  Fix `363303b`: `getBotServerEnv()`/botEnvSchema makes them optional for the bot path.
- **Final whole-branch review (high effort): APPROVE** with 2 MINORs. Fixed #1 inline+committed
  (`58bcd17` settings chip mapped `"voice"` but bot persists `"audio"`); #2 logged as new tech debt
  (`allowed_emails.household_slug` written but never read — trigger takes first household).

### Gotchas
- Workflow tool has no `run_in_background` param — it ALWAYS runs in background (first call errored).
- `getCardPressure` is household-wide; /resumo needed per-card projection → reused pure
  `summarizeCardPressure` with card-scoped queries instead of a new RPC.
- Fake store needed `.ilike`/`.range`/`count:"exact"` support (Task 2 extended it).

### Decisions
- Executed without pausing at the plan gate — the user's "implement the created spec, don't stop"
  message = explicit approval; execution mode = subagent-driven (user's standing pick from the fatura
  run). Deploy is ARTIFACTS ONLY: nothing touched the VPS/Vercel; live deploy needs user + secrets.
- Bot runs via `tsx` in Docker (workspace packages ship raw TS — dist/exports maps stay debt #9).
- Migrations applied with `supabase migration up` only; local live data preserved throughout.

### Commits (16 on feat/family-finance-mvp, UNPUSHED)
`4d32249` plan · `a06bcb6` 0007 · `e33c1e2` repos · `7dd3735` closingDay · `5aee62e` /transactions ·
`d90784a` /resumo · `71b3703` /settings · `0079f6e` caixinhas · `19ecb3d` 0008+store ·
`a464627` identity · `4c18afb` LLM fallback · `664d984` server+Dockerfile · `5edb650` 0009 trigger ·
`1c74d57` deploy tree · `363303b` bot env fix · `58bcd17` audio chip fix · `1d62581` tech-debt memory (17 total w/ docs).

---

## 2026-07-02 — Phase 1 UI foundation BUILT ("Editorial acolhedor", plug-and-play)

User ran the design prompt in Claude design; imported the project via DesignSync (`get_file` per file +
extraction from the session transcript JSONL — subagents can't see DesignSync, main-loop only). 7 mockup
screens + dc-runtime committed `5d78787` (`docs/design/2026-07-02-claude-design-mockups/`). Mockups cover
all 7 prompt deliverables; semantic tokens came back theme-aware (pos/neg/warn + washes per theme) —
richer than spec §1.1. User then set the architecture constraint: **design system must be plug-and-play,
decoupled from functionality**. Plan `101268f`
(`docs/superpowers/plans/2026-07-02-phase-1-ui-foundation.md`), user approved + picked subagent-driven.

### Tried that worked
- **Design firewall as a TEST** (`apps/web/integration/ui-firewall.test.ts`): files under
  `components/ui/` may not import `@family-finance/*`, `lib/`, `app/`, `next/headers|cache`. The
  plug-and-play rule is enforced by the gate forever, not by convention.
- **Two-file visual core:** all tokens in `app/globals.css` (semantics + washes + radii + shadows added
  to both themes), all component CSS in `components/ui/ui.css` (`.ff-*` classes, values verbatim from
  mockups). Re-skin later = touch these + `ui/` only.
- **Primitives** (props/children/actions-as-props only): Card, StatCard, Badge, Button, Delta, Kicker,
  PageTitle, EmptyState, Field/Input/Select, MonthStepper, PillToggle, Table/TableRow/RowCardList
  (CSS-only 720px mobile collapse — pages render both, media query picks), PressureBars, 14 line-art
  icons, AppShell (sidebar + mobile bottom-nav, active via usePathname), ThemePicker (floating bolinhas,
  server action injected as prop). Tested via `renderToStaticMarkup` — zero new test deps.
- **All 11 pages + shell + login re-skinned markup-only** — reviewers diffed queries/actions per task
  ("logic byte-identical"). window.confirm on delete became the mockup's inline confirm row ("Deixa pra
  lá") with the same action wiring.
- **7/7 tasks passed review first-try, zero fix rounds.** Final whole-phase review (high effort):
  APPROVE, 2 non-blocking observations (month-label adaptation; signOut action sanctioned by plan).
  15 agents, ~1.3M tokens, ~81 min.
- **Independent gate re-run:** typecheck 12/12, **276 tests** (was 251; +firewall +21 primitives/shell),
  web build + lint clean, `grep #11271f|#e9f5ef` → 0 (old skin gone).

### Gotchas
- **Detached dev server went 500 after the phase** — stale `next-server` predating next/font/globals
  changes. Restarted detached (`/tmp/ff-web-dev.log`) → login 200 with `data-theme="esmeralda"`,
  guarded routes 307. If pages 500 after big web changes: restart the dev server first.
- DesignSync `get_file` results >32KB persist to tool-results files (jq-extractable); smaller ones are
  inline-only — extract them from the session `.jsonl` transcript instead of retyping.

### Decisions
- Scope cuts held (mockup shows data we don't track): no account balances, no "último aporte", no
  per-category totals, no manual-entry FAB, numeric telegram id (not @username).
- Fonts via `next/font/google` (no-flash, self-hosted) instead of the mockups' <link> tags.
- Theme stays cookie+`data-theme` (mockups' localStorage is preview-only).

### Commits (9 on feat/family-finance-mvp, UNPUSHED)
`5d78787` mockups import · `101268f` plan · `8bde997` tokens+firewall · `eeb2b75` core primitives ·
`1b97693` forms/table/bars · `4c6ef0a` app shell+login · `ea9998f` resumo+dashboard ·
`64c0b36` transações+importação · `feb913d` remaining pages.

---

## 2026-07-03 — UI polish (toasts/loading), Haiku switch, LIVE deploy, bot fixes; 3 bot bugs planned

### Tried that worked
- UI polish shipped (toast system + route loading/error + wiring) via subagent-driven dev → commits `74d8c39..5b35104`, merged into PR #2, all reviews clean. Final review found the floating theme-picker swallowed failures → fixed in `5b35104`.
- Default Anthropic model → Haiku 4.5 (`fff013d`). `claude-haiku-4-5` is a valid API alias (verified via claude-api skill). Bot `.env` on VPS ALSO pins `ANTHROPIC_MODEL=claude-haiku-4-5` explicitly.
- **Live production deploy**: web → Vercel prod (`vercel --prod`), aliased `https://casa.alvaroekarol.com.br`. Bot → VPS via rsync + `docker compose build/up` (deploy/bot). Health `{"ok":true}`, Telegram webhook clean.
- Bot save-error fix (`1bb5281`): household with no account made `defaultAccountId=""` → domain rejected `accountId:""` with opaque English Zod msg. Now `defaultAccountId: string|undefined`; `persist` refuses no-account+no-card with pt-BR msg; validation errors mapped field→pt-BR. TDD, bot suite 68/68.
- Audio confirmed working end-to-end after redeploy (OPENAI_API_KEY present in VPS `.env` → transcribe wired at startup).

### Tried that didn't work / gotchas
- VPS `/opt/family-finance` is **NOT a git repo** — deploys are **rsync** from local, then `docker compose build`. Exclude `.env`/`.env.*` in rsync or you clobber the service-role + API keys.
- The bot `.env` is the ONLY place the Supabase service-role key lives outside the stack. Never rsync over it.
- SSH: host alias `minesupply` (ssh_config) = `ondemandly.cloud` = `2.24.71.244` = mine-ops = the family-finance VPS (Hostinger, Traefik-routed). Repo at `/opt/family-finance`.

### Decisions
- Redeploy target = **production** (user chose, not preview).
- 3 next bot bugs approved for a follow-up session (see handoff). Responsible default → **the Telegram sender**; description/category → **always use the Haiku interpreter** (not just when amount missing); strip trailing punctuation.

---

## 2026-07-03 (later) — 3 approved bot bugfixes BUILT (TDD, inline)

Implemented the 3 bugfixes from `thoughts/notes/2026-07-03-handoff.md`, inline with strict TDD
(RED verified: 9 failing tests before any production code). Commit `19a7dd4`, pushed to PR #2.

### What changed
- **Responsável = sender by default** (`conversation.ts`): `draft.responsibleUserId = input.fromUserId || undefined`
  (empty-string guard keeps the identity-error test path intact). "responsável casa"/unknown name → house via the
  existing resolver. New optional `ConversationDeps.memberDisplayName` shows the member's NAME in the summary
  ("Responsável: Alvaro", not "Pessoa específica"); wired in `index.ts` from the loaded members.
- **Interpreter always runs** (`conversation.ts` + `interpret.ts`): `interpretText` consulted on every new entry
  when configured; parser owns amount/date (`parsed.x ?? interpreted?.x`; interpreted date only when the parser's
  was uncertain); LLM description + categoryHint win. `needsAttention` no longer trips on `interpreted !== null`
  (kept: audio + uncertain amount/date). Prompt rule now demands JUST the merchant/serviço name, banning
  "gasto"/"compra"/"valor" words.
- **Punctuation strip** (`parser.ts`): exported `stripEdgePunctuation`, applied both in the parser's cleaner and
  on the final description in `startConversation` (covers the LLM path).

### Gotcha
- The change legitimately broke `apps/web/integration/mvp-flow.test.ts` (asserted the old house default) —
  expectation updated to sender (`responsibility_scope="user"`, column is `responsible_user_id`, NOT
  `responsibility_user_id`).

### Gate
Bot 75/75 tests + typecheck; whole repo: 12/12 test tasks, builds green, web lint clean (one PRE-EXISTING
toast-timers warning, untouched).

---

## 2026-07-04 — Manual transaction entry + payment/amount edit BUILT (subagent-driven)

User hit two gaps testing v1.0: no way to add a transaction from the web, and no way to convert an
account expense into a card expense. Brainstormed → spec (user plan-review: Approved, 0 comments) →
plan → subagent-driven execution (user's pick). 4 impl tasks + gate, all reviews clean, 2 fix rounds.

### What shipped (commits dd7d58a..333b375)
- **db:** `TransactionPatch` gained `amountCents` + `payment` (account↔card swap sets BOTH columns in
  one UPDATE — DB CHECK safe); parcela rows refuse amount/payment edits (same lookup pattern as the
  delete guard); income rows refuse card payments (guard shares the one lookup, fetches `kind`).
- **web action:** `createManualTransactionAction` + `manualEntryFromFormData` (pt-BR amount parsing,
  payment "account:<id>"/"card:<id>" encoding, entrada-só-conta server-side) via domain
  `createTransactionDraft`; `transactionPatchFromFormData` gained amount/payment keys.
- **web UI:** "Novo lançamento" inline panel on /transactions (collapsed; `?novo=1` opens; dashboard
  "+ Lançamento" button links there); edit row gained Pagamento select (income = accounts-only,
  parcela = plain text) + click-to-edit valor (parcela disabled).

### Review findings worth remembering
- **Final review (opus) caught the cross-task seam:** the EDIT path had no income+card guard at any
  layer (UI-only) — a crafted FormData could park an entrada num cartão and the money silently
  vanished from card-pressure math (sums only kind="expense"). Fixed in `333b375` by widening the
  parcela-guard lookup to `installment_id, kind` (no extra query). Per-task reviews couldn't see it.
- Pre-existing debt logged: account/card FKs not household-scoped at DB layer (thoughts/tech-debt.md).
- Deferred follow-ups: colonless payment value + blank description/occurredOn untested in
  manualEntryFromFormData; render tests can't exercise income→card reset (static markup).

### Gate
12/12 typecheck, db 47/47, web 122/122, builds green, lint clean (pre-existing toast warning only).
~11 subagents (impl sonnet/haiku, reviews sonnet, final review opus), 2 fix rounds, ledger in
`.superpowers/sdd/progress.md`. NOT deployed — web needs a Vercel prod deploy to go live.

---

## Current state

**v1.0 is LIVE.** Web on Vercel prod (`https://casa.alvaroekarol.com.br`), bot container running on the VPS (mine-ops), Supabase self-hosted, Telegram webhook healthy, audio (Whisper) working. Model = Haiku 4.5. Everything pushed to `feat/family-finance-mvp` (PR #2), working tree clean (thoughts/ local-only).

**3 approved bot bugfixes: DONE + pushed (`19a7dd4`) but NOT yet deployed.** The bot container on the VPS still runs the old code. **Next move: rsync-redeploy the bot** (user must confirm first — their standing instruction):
```
rsync -az --exclude='.git' --exclude='node_modules' --exclude='.turbo' --exclude='.vercel' --exclude='.env' --exclude='.env.*' --exclude='*.tsbuildinfo' --exclude='.DS_Store' <repo>/ minesupply:/opt/family-finance/
ssh minesupply 'cd /opt/family-finance/deploy/bot && docker compose build && docker compose up -d'
ssh minesupply 'curl -s localhost:8787/health && docker logs --since 60s family-finance-bot'
```
NEVER rsync over `deploy/bot/.env` (service-role + API keys; excluded above). Note: interpreter now fires on
every message → slightly higher Haiku usage + latency per lançamento (accepted in the approved plan).
Prior work unchanged below ↓

---

**(prior current-state — #1 DB+RLS DONE + pushed)** (`e36c1e9`, `d8320b0`; branch `feat/family-finance-mvp` in sync with origin).
Found + fixed a real deploy-breaker: missing table GRANTs → `0005_api_grants.sql`. **#2 (web Google login)
wired & WORKING live** — user logged into the local app, RLS scope granted via a `household_members` row.
**Mid-walkthrough:** 3 contas + 1 cartão created; **import, parcelado, and dashboard checks still pending**.
Local stack is **RUNNING detached** (12 Supabase containers + web dev on :3000, survives session boundary).
Uncommitted: `supabase/config.toml` (Google provider block — safe, no secrets). **Next:** either finish the
local walkthrough (import a CSV from `~/Downloads/exemplo-*.csv`, lançar a compra parcelada, conferir o
dashboard) OR start deploy prep (Supabase `docker-compose` for the VPS + Vercel env checklist + the
`household_members` provisioning trigger). #3 (Telegram bot) not started — still 2 code gaps (HTTP webhook
entrypoint + Supabase identity).
