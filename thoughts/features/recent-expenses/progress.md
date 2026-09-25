# Recent expenses ("últimos N") — progress

**State (2026-09-25):** implemented, tests green, committed on
`feat/bot-recent-expenses` (ported onto `main`; had lived uncommitted since 2026-09-03).

## What it does

A member types `últimos`, `últimos 10`, `ultimas 5 despesas`, `listar gastos`,
`extrato 15` (whole message must be the command) and the bot replies with the
N most recently **registered** expenses of the household. Default 5, clamped
1–15.

## Decisions

- **Deterministic regex, no AI.** Matched before the classifier in both
  `startConversation` and `applyMessage`, same slot as `nova categoria`. Zero
  LLM cost, zero latency.
- **Ordered by `created_at`, not `occurred_on`.** "Last registered" is the ask
  (visibility into what others entered), so a backdated entry still shows at
  the top. Differs from the dashboard "recent" list on purpose.
- **Expense rows only.** Transfers (card-bill settlements) and income excluded.
- **Payment label is the raw instrument name** (`Nubank`, `Mercado Pago`,
  `Conta da casa`) — no `Crédito`/`Conta` prefix. Household knows which is
  which. The confirmation-summary `paymentLabel` keeps its prefix.
- **Pending draft untouched.** Issued mid-draft, the list is sent and the same
  state object is returned so the draft's keyboard stays live.

## Not done / ideas

- No `/ultimos` slash command (bot has no command handling today).
- No filter by member or period; if wanted, extend the regex rather than
  routing through the classifier.

## Deploy — 2026-09-03

Deployed to the VPS bot container (health OK, `listening on :8787`). Shipped as
committed `HEAD` + only the recent-expenses files (built in a scratch tree via
`git archive HEAD` + overlay), because the working tree also carries uncommitted
category-kind work (`0019_category_kind.sql`, `c.kind === "expense"` filter in
`apps/bot/src/index.ts`) and prod is believed to be at migration 0017 — could not
verify (SSH psql probe denied). Do NOT rsync the full working tree until
0018/0019 are applied in prod.
