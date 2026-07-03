# Recurring obligations — progress log

## 2026-07-03 — Spec: from "parse 72x" to a full obligations design, through plan-review

### Tried that worked
- Reframed the request. Started as "teach the bot to parse `Parcela solar 710,44
  72x`". Investigation found **no recurring/financing concept exists** — only
  card-bound installments (`createInstallmentPlan`, migration 0002). The solar
  case is a financing (boleto, like a mortgage), so `createInstallmentPlan` is
  the wrong target.
- Landed the model (user's synthesis): obligation = **template**; dashboard shows
  **projections**; **marking a month paid materializes** one real transaction.
- Design committed `f92e2a3`; plan-review round 1 → addressed in `14d8865`
  (pulled projection timeline + bot mark-paid into scope); plan-review round 2 →
  **Approved, 0 comments**.
- Moved to an **isolated git worktree** (`../family-finance-obligations`) so the
  feature branch stops colliding with the concurrent session.

### Tried that didn't work
- Committed the spec on the shared checkout first; a **concurrent session**
  (building a toast system on `feat/family-finance-mvp`) checked the working tree
  out from under me. Recovered — the commit + branch survived; the worktree is
  the fix. Don't work this feature from the shared checkout.
- `plan-review` CLI errors on relative paths → pass an **absolute** path.

### Decisions
- **Template + projection + materialize-on-paid.** Handles fixed-term (72×) and
  indefinite (bills) uniformly, avoids 360 mortgage rows, records actuals only
  when they happen.
- **Two PRs.** PR-1 = obligations end-to-end + unified interpreter + timeline +
  obligation mark-paid. PR-2 = card installment persistence + card-bill payment.
  Fewer PRs is fine given agentic implementation/review.
- **One shared bot intent classifier** (`plain | obligation | card_installment |
  mark_paid`) — can't detect obligations without also recognizing card parcelas.
- **`nubank pago` (card-bill payment) flagged with a schema wrinkle:**
  `transactions` requires exactly one instrument, but a bill payment is an
  account→card transfer. Resolve in PR-2's own design; do not assume the
  obligation materialization shape carries over.
- **Haiku model switch** (cost) is a *separate* concern — those edits are not on
  this branch (they were applied to the shared checkout on the mvp branch).

---

## 2026-07-03 (later) — PR-1 implemented end-to-end

### Tried that worked
- User gave the go-ahead with pre-approved plan execution (inline mode), so the
  writing-plans → executing-plans pipeline ran without pauses. Plan lives at
  `docs/superpowers/plans/2026-07-03-recurring-obligations-pr1.md`.
- **Migration verified on live Postgres** (local homebrew instance): the whole
  0001→0011 chain applies with an `auth`-schema shim (`auth.users(id, email)` +
  `auth.uid()` → null), and `materialize_obligation_payment` was smoke-tested
  live — idempotent repeat, `occurred_on` default = month+due_day, `paid_on`
  override, start/term bounds rejection. The 0009 trigger needs `email` on the
  shimmed `auth.users`.
- TDD throughout; every task landed with tests first. Full suite: 12/12 turbo
  tasks green (domain 46, db 48, bot 88, web 105 tests), typecheck clean.

### Tried that didn't work
- Fresh worktree had no `node_modules` — `pnpm install` needed before anything.
- `Card` UI primitive takes no `style` prop (design-firewall) — wrap in a div.
- Fake-supabase `CategorizationResult` needs `status: "uncategorized"` +
  `suggestion: null` (not `"no_match"`/`undefined`).

### Decisions (judgment calls to flag in PR review)
- **dueDay defaults to 1** when the message names no day (bot flow).
- **Classifier runs on every NEW conversation message** when the LLM is
  configured; `null`/plain falls back to the deterministic parser path, and a
  plain classification reuses its extracted fields instead of a second
  interpretText call.
- **Timeline month totals stay constant when paid**: the projection entry is
  suppressed but `totalCents = projected-unpaid + paid actuals`, so a paid
  month doesn't look cheaper.
- **Resumo/dashboard `obligationsCents` is display-only** — paid obligation
  transactions are already inside `expenseCents`; adding the line to gasto
  would double count.
- Migration takes **0011** (0010 reserved by the concurrent mvp branch).

---

## Current state

**PR-1 is fully implemented and green** on `feat/recurring-obligations`
(worktree `../family-finance-obligations`, based on `feat/family-finance-v1`,
local only — no upstream set). Everything from the approved spec's PR-1 scope
landed: domain module + projection engine, migration 0011 (table + tx link
columns + idempotent materialize RPC, live-verified), repositories +
obligations pressure, web `/obligations` (list/create/edit/cancel, mark-paid,
12-month timeline) + resumo/dashboard lines, and the bot's unified intent
classifier with obligation-create + mark-paid flows (card intents reply
"em breve" until PR-2).

**Next moves:** (1) push + open the PR-1 pull request stacked on PR #2;
(2) apply migration 0011 to the real Supabase project when merging;
(3) PR-2 (card installment persistence + card-bill payment — remember the
`nubank pago` schema wrinkle needs its own design).
