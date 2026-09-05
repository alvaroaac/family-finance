# Recurring obligations — progress log

> Superseded status note (2026-07-09): recurring obligations are merged on
> `main`, migration `0011` has been applied in production, and the web/bot paths
> are live. The entries below are retained as implementation history. Card
> installment and bill-settlement integration is tracked separately.

## 2026-09-05 — Page redesign: checklist, change-only timeline, guided dialogs

Design: `docs/superpowers/specs/2026-09-04-obligations-page-redesign-design.md`
(option A, approved 2026-09-04). Plan:
`docs/superpowers/plans/2026-09-04-obligations-page-redesign.md`. Mockups:
`docs/design/2026-09-04-obrigacoes-mockups/` (Main, Mobile, NovaObrigacao,
EditarObrigacao).

### Tried that worked
- **Rewrote `/obligations` top to bottom** in 7 tasks + this docs task. Shipped:
  three-stat row ("Comprometido por mês" / "Este mês" / "Próximo vencimento");
  **Este mês checklist** with due-day chips, overdue/warn row states,
  "Marcar como paga" and a **"desfazer"** link on paid rows; **change-only
  12-month timeline** (a month gets a badge only when a template starts, hits
  its last parcela, or drops off) with per-month `<details>` and the relief note
  "↓ alívio de R$ x/mês a partir de <mês>"; **Suas obrigações** table with term
  progress ("n de N pagas · até mmm/aaaa") and a `?encerradas=1` toggle;
  guided **"Nova obrigação"** dialog (four numbered sections + "Sem prazo |
  Parcelado" segmented term mode + live summary card); **"Editar obrigação"**
  dialog with a read-only progress panel and an inline **encerrar** confirm;
  mobile sticky CTA + row cards; skeleton (`loading.tsx`) at parity with the
  new card stack.
- **View-model first.** All derivations (`termProgress`, `TimelineChange`,
  `dueStatus`, `isFinished`, `committedPerMonth`, `barWidths`) live in
  `apps/web/app/(app)/obligations/view-model.ts` and are unit-tested against the
  fake store, so the page components stayed presentational.
- **Server actions now return `{ ok, error? }`** (`ObligationActionResult`)
  instead of throwing, which is what lets the dialogs render inline errors. One
  gotcha: `unstable_rethrow` is required in the catch, or Next's redirect signal
  gets swallowed (fixed in `a40db4d`).
- Dialog chrome was extracted to `obligation-dialog-shell.tsx` once the second
  dialog existed, not before.

### Decisions
- **Undo-payment = delete the materialized transaction.**
  `deleteObligationPayment` (packages/db `repositories.ts`) looks the row up by
  household + id, refuses when `obligation_id` is null with
  `Esse lançamento não é um pagamento de obrigação.`, then deletes. It does
  **not** guard against edits made to that transaction in between — undo is the
  "I mis-clicked" path, so a hand-edited amount or date is discarded silently.
  Revisit if we ever let users edit obligation payments on /transactions.
- **Past months are assumed paid** for term progress. `termProgress` computes
  `elapsed = monthDiffYm(startMonth, currentMonth)` clamped to `[0, total]` —
  i.e. months *strictly before* the current one; the current month always counts
  as unpaid and stays in `remainingCents`. The edit dialog's label is therefore
  `elapsed + 1` ("Parcela 12 de 72" when 11 months have elapsed). We do not read
  the payments table for this — a skipped month in the past still reads as paid.
- **Nothing writes status `ended`.** `ObligationStatus` has the value and the
  archive query asks for it, but "Encerrar" calls `cancelObligation` →
  `status = "canceled"`. A template whose term simply ran out stays `active`
  and is hidden from the active table by `isFinished(item, month)`
  (`endMonth < month`); it shows up under "ver encerradas →" alongside the
  canceled ones. So "encerradas" in the UI = canceled ∪ finished-term, and
  `committedPerMonth` excludes both.
- **Term and first month are not editable.** The edit dialog says so
  ("Prazo e primeiro mês não mudam — pra isso, encerre esta e crie outra") —
  changing them retroactively would rewrite the meaning of payments already
  materialized.
- **Alternative B** (obligation × month grid) stayed out of scope; logged in
  `thoughts/tech-debt.md` as an optional secondary view of the timeline.

### Visual QA checklist (not yet run — needs a human)
No agent ran this. Every route sits behind Google OAuth with an allowlisted
Supabase session, `E2E_STORAGE_STATE` is not available, and the only env on hand
points at the **production** database — so create/edit/encerrar/mark-paid round
trips could not be exercised without writing real rows. Run it manually after
merge, at desktop 1092px and mobile 390px, in **both themes (Esmeralda and
Sálvia)**, comparing against `docs/design/2026-09-04-obrigacoes-mockups/`:

1. **Create** — "+ Nova obrigação" → both term modes; check the live
   "até mmm/aaaa · total R$ x" badge, the summary sentence, and the
   "A partir de <mês>, o mês da casa passa a R$ y." second line.
2. **Edit** — pencil on a row → progress panel numbers match the table's
   "n de N pagas"; save an amount change and confirm only unpaid months move.
3. **Encerrar** — "Encerrar…" reveals the confirm row; confirm the template
   leaves the active table and reappears under "ver encerradas →".
4. **Mark paid** — a checklist row → payment dialog → row moves to the bottom
   faded with badge "paga"; the "Este mês" stat and the timeline's paid slice
   both update.
5. **Desfazer** — undo that payment; the row returns to unpaid and the stat
   reverts. Also try it on a transaction that is not an obligation payment
   (expect `Esse lançamento não é um pagamento de obrigação.`).

Watch for: overdue/warn row washes, the timeline badge wrapper at narrow
widths, the segmented control's focus ring, the sticky CTA not covering the
table footer, and skeleton → content layout shift.

---

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

## Historical completion snapshot (superseded)

**PR-1 is fully implemented and green** on `feat/recurring-obligations`
(worktree `../family-finance-obligations`, based on `feat/family-finance-v1`,
local only — no upstream set). Everything from the approved spec's PR-1 scope
landed: domain module + projection engine, migration 0011 (table + tx link
columns + idempotent materialize RPC, live-verified), repositories +
obligations pressure, web `/obligations` (list/create/edit/cancel, mark-paid,
12-month timeline) + resumo/dashboard lines, and the bot's unified intent
classifier with obligation-create + mark-paid flows (card intents reply
"em breve" until PR-2).

Branch pushed; **PR #3 open**
(https://github.com/alvaroaac/family-finance/pull/3, base
`feat/family-finance-v1` — note PR #2 is already merged into
`feat/family-finance-mvp`, so a retarget to mvp is harmless).

**Next moves:** (1) get PR #3 reviewed/merged; (2) apply migration 0011 to the
real Supabase project when merging; (3) PR-2 (card installment persistence +
card-bill payment — remember the `nubank pago` schema wrinkle needs its own
design).
