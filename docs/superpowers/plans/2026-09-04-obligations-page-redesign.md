# Obrigações Page Redesign (option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/obligations` as a household checklist — stats, this-month checklist with undo, change-only 12-month timeline, obligations table — and move create/edit into guided dialogs.

**Architecture:** Data composition stays in `queries.ts`; all new derivations (timeline changes, next due, stats, term progress) are PURE functions in a new `view-model.ts` tested against fixtures. Server actions switch to the `{ ok, error? }` result contract so the two new client dialogs (create, edit+encerrar) show inline errors; undo-payment is one new action deleting the materialized transaction. Page is a server component composed of small server sub-components (checklist, timeline, table) styled with new `ff-oblig-*` classes in `ui.css`, plus a `Segmented` control primitive.

**Tech Stack:** Next.js 15 App Router server components + server actions, React 19 (`useTransition`), `@family-finance/domain` (`addMonthsYm`, `obligationEndMonth`, `currentHouseholdDate`), `@family-finance/db` repos + `FakeSupabaseStore`, vitest (jsdom for dialogs, `renderToStaticMarkup` for server components), ff-* design system.

**Spec:** `docs/superpowers/specs/2026-09-04-obligations-page-redesign-design.md` — mockups in `docs/design/2026-09-04-obrigacoes-mockups/` (Main/Mobile/NovaObrigacao/EditarObrigacao `.dc.html`; open in a browser with `support.js` beside them). Copy, layout and states come from the spec + mockups; when they disagree the spec wins.

## Global Constraints

- **Branch:** `git checkout -b feat/obligations-page-redesign` from the current HEAD (`codex/drop-legacy-obligation-payment-overload`). The tree has UNRELATED uncommitted changes (bot, cards, categories, imports). Never `git add -A`; stage only the paths each task names. Do not stash or revert the unrelated files.
- All user-facing copy pt-BR, warm register; copy strings in the spec are verbatim (obligation is feminine: "paga", "pagas", "atrasada").
- TDD per task: failing test first, watch it fail, then implement.
- Design firewall: `apps/web/components/ui/**` imports no `@family-finance/*`, `lib/`, `app/` (`integration/ui-firewall.test.ts`). Dialogs and view-model live under `app/(app)/obligations/`.
- "Today" is `currentHouseholdDate()` from `@family-finance/domain` (Casa timezone), never `new Date().getDate()`.
- Amount formatting via `apps/web/lib/format.ts` (`formatBrlCents`, `parseReaisToCents`); month labels via `monthLabelPtBr` (`app/(app)/resumo/queries.ts`) and `monthAbbrPtBr` (moved into `view-model.ts`).
- No new dependencies. Reuse existing `ff-*` classes (`ff-dialog--transaction`, `ff-row-confirm`, `ff-off`, `ff-bubble`, `ff-iconbtn`, `ff-table__foot`, `ff-badge--*`, `ff-stat`, `ff-alert`) before adding CSS.
- Full gate before finishing: `pnpm typecheck && pnpm test && pnpm build && pnpm --filter @family-finance/web lint` (run from `family-finance/`).
- Model routing (CLAUDE.md): Tasks 1–3, 7, 8 are clear-spec execution → Codex/GPT 5.5 via thin Sonnet driver. Tasks 4–6 are user-facing UI → Opus 5. Review every task's diff regardless of tier.

---

### Task 1: View-model — pure derivations for the page

**Files:**
- Create: `apps/web/app/(app)/obligations/view-model.ts`
- Modify: `apps/web/app/(app)/obligations/page.tsx` (remove `MONTH_ABBR_PT` / `monthAbbrPtBr` / `termLabel`; import from view-model — page is rewritten fully in Task 7, so here only keep it compiling)
- Test: `apps/web/integration/obligations-view-model.test.ts`

**Interfaces (Produces — later tasks depend on these exact names):**
```ts
export function monthAbbrPtBr(month: string): string;            // "2026-10" -> "out/2026"
export function monthDiffYm(a: string, b: string): number;        // move from queries.ts, export

export type TimelineChange =
  | { kind: "starts"; description: string; amountCents: number }
  | { kind: "last"; description: string }
  | { kind: "ended"; description: string; amountCents: number };
/** Month -> changes; months with nothing changing are ABSENT. */
export function timelineChanges(
  obligations: ObligationListItem[], timeline: TimelineMonth[],
): Map<string, TimelineChange[]>;

/** First term ending inside the window: `{ fromMonth, amountCents }` = the month after it ends and the monthly relief; null when none. */
export function reliefNote(obligations: ObligationListItem[], timeline: TimelineMonth[]): { fromMonth: string; amountCents: number } | null;

export type DueStatus = { kind: "overdue" | "today" | "tomorrow" | "soon" | "later"; daysUntil: number };
/** `today` is `YYYY-MM-DD`; entries in a month after `today`'s month are "later" with the real day distance. */
export function dueStatus(month: string, dueDay: number, today: string): DueStatus;
/** Badge copy from a status: "atrasada" | "vence hoje" | "vence amanhã" | "vence em N dias" | null (later). */
export function dueBadgeLabel(status: DueStatus): string | null;

export type NextDue = { description: string; month: string; dueDay: number; status: DueStatus };
/** Earliest unpaid entry from this month (day >= today first, else overdue ones), then next month; null when nothing projected. */
export function nextDue(data: ObligationsData, today: string): NextDue | null;
/** Stat label: "hoje" | "amanhã" | "em N dias" | "atrasada · dia D". */
export function nextDueLabel(next: NextDue): string;

export type Committed = { totalCents: number; activeCount: number; fromMonth: string | null };
/** Sum of every active template; fromMonth = latest startMonth after `month`, else null. */
export function committedPerMonth(obligations: ObligationListItem[], month: string): Committed;

export type TermProgress =
  | { kind: "indefinite" }
  | { kind: "future"; startMonth: string; termMonths: number | null }
  | { kind: "running"; elapsed: number; total: number; endMonth: string; remainingCents: number };
/** elapsed = months strictly before `month` clamped to [0, total] (past months are assumed paid). */
export function termProgress(item: ObligationListItem, month: string): TermProgress;

/** Bar geometry for the timeline: fraction of the largest month, and the paid fraction of the same bar. */
export function barWidths(slot: TimelineMonth, maxTotalCents: number): { totalPct: number; paidPct: number };
```

**Decisions:**
- `timelineChanges`: "starts" when `startMonth === m` and `m` is after the first timeline month (a template starting in the current month is not "new" — it is simply listed); "last" when `endMonth === m`; "ended" on `addMonthsYm(endMonth, 1)` when that month is inside the window. Amount for "ended" is the template amount.
- `termProgress.remainingCents = (total − elapsed) × amountCents`.
- `barWidths` returns percentages 0–100 (rounded to one decimal); `maxTotalCents === 0` → both 0.

**Named test cases** (`describe("obligations view-model")`, fixtures built by hand from `ObligationListItem`/`TimelineMonth` literals — no fake store needed):
- `timelineChanges` marks only the changing months (starts / last / ended) and leaves steady months absent; a template starting in the current month is not marked.
- `reliefNote` returns the month after the first term end with its amount; null when every term ends outside the window.
- `dueStatus` yields overdue / today / tomorrow / soon (≤3 days) / later, crossing a month boundary correctly (today 2026-09-29, due 2026-10 day 1 → tomorrow... use real day math via `Date.UTC`).
- `nextDue` prefers the earliest not-yet-due entry this month, falls back to overdue ones, then to next month, then null.
- `committedPerMonth` sums all active templates and reports the latest future start month.
- `termProgress` covers indefinite, future start, running (elapsed/total/remainingCents), and a term whose last month is the current month (elapsed = total − 1).
- `barWidths` scales to the largest month and splits the paid slice.

**Validation:** `pnpm --filter @family-finance/web test -- obligations-view-model` then `pnpm --filter @family-finance/web typecheck`.

**Commit:** `feat(web): obligations view-model derivations` — stage `apps/web/app/(app)/obligations/view-model.ts`, `page.tsx`, `queries.ts`, the test.

---

### Task 2: Undo a payment (repository + action)

**Files:**
- Modify: `packages/db/src/repositories.ts` (`ObligationPaymentKey`, `listObligationPayments` ~line 3030; add `deleteObligationPayment` near `deleteTransaction` ~line 2374)
- Modify: `apps/web/app/(app)/obligations/queries.ts` (`thisMonth.paid` entries carry `transactionId`)
- Modify: `apps/web/app/(app)/obligations/actions.ts` (add `undoObligationPaymentAction`)
- Test: `packages/db/src/repositories.test.ts` (pure mapping, if any), `apps/web/integration/obligations.test.ts`

**Interfaces:**
- Consumes: `deleteTransaction` pattern, `FakeSupabaseStore` (`integration/fake-supabase.ts`).
- Produces:
  ```ts
  export type ObligationPaymentKey = { obligationId: string; month: string; amountCents: number; transactionId: string };
  /** Deletes the materialized transaction; refuses (pt-BR error) when the row is not an obligation payment of this household. */
  export async function deleteObligationPayment(client: AppSupabaseClient, householdId: string, transactionId: string): Promise<void>;
  // queries.ts
  thisMonth.paid: Array<{ obligationId: string; transactionId: string; description: string; amountCents: number; paidOn: string | null }>;
  // actions.ts
  export async function undoObligationPaymentAction(formData: FormData): Promise<ObligationActionResult>; // field: transactionId
  ```
  `ObligationActionResult` is defined in Task 3; if Task 2 lands first, define `export type ObligationActionResult = { ok: boolean; error?: string }` in `actions.ts` here and Task 3 reuses it.

**Decisions:**
- `listObligationPayments` also selects `id` and `occurred_on` (for "Paga em D de mmm"). Error copy: `"Esse lançamento não é um pagamento de obrigação."`
- Undo does NOT guard against edited/categorized transactions — it is the "I mis-clicked" path; the design accepts losing edits made in between.

**Named test cases** (`apps/web/integration/obligations.test.ts`):
- marking a month paid then `deleteObligationPayment` puts the entry back into `thisMonth.unpaid` and the timeline total is unchanged.
- `deleteObligationPayment` refuses a plain (non-obligation) transaction and a transaction of another household.
- `listObligationPayments` returns `transactionId` and `paidOn`.

**Validation:** `pnpm --filter @family-finance/db test && pnpm --filter @family-finance/web test -- obligations`.

**Commit:** `feat(obligations): undo a materialized payment`.

---

### Task 3: Actions return results; create accepts term mode; update accepts account/category

**Files:**
- Modify: `apps/web/app/(app)/obligations/form.ts` (`obligationInputFromForm`: new `termMode` field; new `obligationChangesFromForm`)
- Modify: `apps/web/app/(app)/obligations/actions.ts` (all actions → `ObligationActionResult`; ownership checks on update; shared `verifyAccountAndCategory` helper)
- Modify: `apps/web/app/(app)/obligations/payment-dialog.tsx` (action prop type → returns result; show inline error + toast; button label "Marcar como paga")
- Test: `apps/web/integration/obligations.test.ts` (form parsing), `apps/web/integration/payment-dialog.test.tsx` (label + error path), `apps/web/integration/obligation-actions.test.ts` (new — mock auth/supabase like `manual-transaction-action.test.ts`)

**Interfaces:**
```ts
export type ObligationActionResult = { ok: boolean; error?: string };
export async function createObligationAction(formData: FormData): Promise<ObligationActionResult>;
export async function updateObligationAction(formData: FormData): Promise<ObligationActionResult>; // fields: obligationId, description, amount, dueDay, accountId, categoryId ("" = none)
export async function cancelObligationAction(formData: FormData): Promise<ObligationActionResult>;
export async function markObligationPaidAction(formData: FormData): Promise<ObligationActionResult>;
export async function undoObligationPaymentAction(formData: FormData): Promise<ObligationActionResult>;
// form.ts
export function obligationInputFromForm(formData, ids): CreateObligationInput; // termMode: "indefinite" | "installments"; termMonths required only for installments
export function obligationChangesFromForm(formData: FormData): { obligationId: string; changes: ObligationChanges };
```
**Decisions:**
- `termMode` missing → fall back to today's rule (blank `termMonths` = indefinite) so the bot/other callers keep working.
- Actions catch every error and return `{ ok: false, error: message }` (pt-BR message from domain/form; generic `"Não foi possível salvar a obrigação."` for unknown errors). `revalidatePath` only on success.
- `categoryId === ""` maps to `categoryId: null` in `ObligationChanges` (clears the category).

**Named test cases:**
- form: `termMode=installments` + `termMonths=72` → 72; `termMode=indefinite` ignores a stray `termMonths`; missing `termMode` keeps blank-means-indefinite; `obligationChangesFromForm` maps amount/dueDay/account/category ("" → null).
- actions: update with an account of another household → `{ ok: false, error: "Conta de pagamento inválida." }`; create success → `{ ok: true }` and `revalidatePath` called; create with domain error → `{ ok: false }` with the domain message.
- payment dialog: button reads "Marcar como paga"; a failed action shows its message in a `role="alert"`.

**Validation:** `pnpm --filter @family-finance/web test -- obligation && pnpm --filter @family-finance/web typecheck`.

**Commit:** `refactor(obligations): result-returning actions, term mode, editable account/category`.

---

### Task 4: Design-system additions — `Segmented` control + obligations CSS

**Files:**
- Modify: `apps/web/components/ui/forms.tsx` (add `Segmented`), `apps/web/components/ui/index.ts` (export)
- Modify: `apps/web/components/ui/ui.css` (new section `/* ---- Obrigações ---- */`)
- Modify: `apps/web/components/ui/route-skeleton.tsx` (`ObligationsSkeleton`: heading with action, 3 stat blocks, 4 checklist rows, 6 timeline rows)
- Test: `apps/web/integration/ui-primitives.test.ts`

**Interfaces:**
```ts
export function Segmented<T extends string>(props: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; ariaLabel: string;
}): ReactElement; // role="radiogroup" wrapper, each option a button with aria-checked
```
**CSS classes to add (lift exact values from the mockups' `_tokens`/inline styles):** `.ff-seg`, `.ff-seg__item`, `.ff-seg__item--on`; `.ff-oblig-stats` (3-col grid, 2-col ≤720px); `.ff-track`/`.ff-track__fill`/`.ff-track__fill--positive` (6px pill progress); `.ff-checklist`, `.ff-checklist__row`, `.ff-checklist__row--warn`, `.ff-checklist__row--overdue` (wash + inset 3px stripe), `.ff-checklist__day` (44px chip "DIA 05"), `.ff-checklist__row--paid` (uses `ff-off`); `.ff-timeline__row` (grid `96px 1fr 132px 24px`, `<details>`/`<summary>`), `.ff-timeline__bar`, `.ff-timeline__bar-paid`, `.ff-timeline__detail`; `.ff-danger-zone`; `.ff-sticky-cta` (mobile-only fixed bottom primary button, hidden ≥720px). Keep the timeline grid at `72px 1fr 110px` ≤720px with badges wrapping under the bar.

**Named test cases:** `Segmented` renders a radiogroup with the active option `aria-checked="true"`; `RouteSkeleton variant="obligations"` still renders `role="status"`. `ui-firewall` stays green.

**Validation:** `pnpm --filter @family-finance/web test -- ui- && pnpm --filter @family-finance/web lint`.

**Commit:** `feat(ui): segmented control and obligations page styles`.

---

### Task 5: Create dialog — `NewObligationDialog`

**Files:**
- Create: `apps/web/app/(app)/obligations/new-obligation-dialog.tsx` (client)
- Test: `apps/web/integration/new-obligation-dialog.test.tsx` (jsdom, harness like `payment-dialog.test.tsx`)

**Interfaces:**
```ts
export type OptionItem = { id: string; name: string };
export function NewObligationDialog(props: {
  accounts: OptionItem[]; categories: OptionItem[];
  currentMonth: string;                              // "YYYY-MM"
  monthTotals: Record<string, number>;               // month -> projected totalCents (from data.timeline)
  action: (formData: FormData) => Promise<ObligationActionResult>;
  trigger?: "header" | "sticky";                     // renders "+ Nova obrigação" primary button, or the mobile sticky bar
}): ReactElement;
/** Pure, exported for tests: the summary sentence(s) from the current form state. */
export function summarize(state: { description: string; amountCents: number | null; startMonth: string; dueDay: number | null; termMode: "indefinite" | "installments"; termMonths: number | null; accountName: string | null }, monthTotals: Record<string, number>): { main: string | null; impact: string | null };
```
**Decisions:**
- Layout and copy: spec "Create dialog" section verbatim; sections numbered with the mockup's numbered dot + title; `ff-form-grid` two-column inside each section.
- Month select options: `currentMonth − 3 … currentMonth + 12`, labelled with `monthLabelPtBr`; default `currentMonth`.
- Term: `Segmented` "Sem prazo | Parcelado"; installments input defaults to 12 when switching to Parcelado; badge "até mmm/aaaa · total R$ x" computed with `obligationEndMonth`.
- Submit sends `termMode` + `termMonths` (Task 3 contract); on `{ ok: false }` show `ff-alert--negative` + `toast.error`; on success `toast.success("Obrigação criada.")`, reset, close.
- Client pre-checks mirror `new-transaction-form.tsx`: amount parse ("Não entendi o valor — use algo como \"710,44\"."), empty name, missing account, installments < 1.

**Named test cases:**
- `summarize` builds the parcelado sentence ("Placas solares — R$ 710,44 por mês, 72 vezes, de out/2026 a set/2032. Vence dia 5, sai da Conta Itaú.") and the sem-prazo variant ("todo mês a partir de out/2026"); impact line uses `monthTotals[startMonth] + amountCents` and is null outside the window.
- switching to Parcelado shows the "até … · total …" badge; switching back hides it.
- submit posts `termMode=installments` and `termMonths` in the FormData; a `{ ok: false, error }` result renders the error in `role="alert"` and keeps the dialog open.

**Validation:** `pnpm --filter @family-finance/web test -- new-obligation-dialog`.

**Commit:** `feat(web): guided "Nova obrigação" dialog`.

---

### Task 6: Edit dialog — `EditObligationDialog` with Encerrar confirm

**Files:**
- Create: `apps/web/app/(app)/obligations/edit-obligation-dialog.tsx` (client)
- Test: `apps/web/integration/edit-obligation-dialog.test.tsx`

**Interfaces:**
```ts
export function EditObligationDialog(props: {
  item: ObligationListItem; progress: TermProgress;   // from Task 1
  currentMonth: string; accounts: OptionItem[]; categories: OptionItem[];
  updateAction: (formData: FormData) => Promise<ObligationActionResult>;
  cancelAction: (formData: FormData) => Promise<ObligationActionResult>;
}): ReactElement; // trigger = pencil `ff-iconbtn` with aria-label `Editar ${item.description}`
```
**Decisions:**
- Progress panel copy from `TermProgress` (spec "Edit dialog"); `running` → "Parcela n de N · começou em mmm/aaaa · termina em mmm/aaaa" + "faltam R$ x" + track; `indefinite` → "Sem prazo · desde mmm/aaaa"; `future` → "Começa em mmm/aaaa".
- Save posts `obligationId, description, amount, dueDay, accountId, categoryId` (Task 3 contract). Success toast "Obrigação atualizada."
- Danger zone: "Encerrar…" toggles a `ff-row-confirm` block; "Sim, encerrar" posts `obligationId` to `cancelAction`; success toast "Obrigação encerrada.", close. "Deixa pra lá" hides the confirm.

**Named test cases:**
- renders the progress sentence for a running term and the "Sem prazo" variant.
- "Encerrar…" reveals the confirm row; "Deixa pra lá" hides it; "Sim, encerrar" calls `cancelAction` with the obligation id.
- save calls `updateAction` with all five fields; a failing result shows `role="alert"`.

**Validation:** `pnpm --filter @family-finance/web test -- edit-obligation-dialog`.

**Commit:** `feat(web): "Editar obrigação" dialog with encerrar confirm`.

---

### Task 7: Page composition — stats, checklist, timeline, table, encerradas

**Files:**
- Rewrite: `apps/web/app/(app)/obligations/page.tsx`
- Create: `apps/web/app/(app)/obligations/this-month-card.tsx`, `timeline-card.tsx`, `obligations-table.tsx` (server components, props in / markup out)
- Modify: `apps/web/app/(app)/obligations/queries.ts` (optional `includeEnded` → `ended: ObligationListItem[]` via `listObligations(..., { status: "ended" })` + `"canceled"`)
- Test: `apps/web/integration/obligations-page.test.tsx` (renderToStaticMarkup of the three cards with fixtures), extend `obligations.test.ts` for `includeEnded`

**Interfaces:**
```ts
export function ThisMonthCard(props: { data: ObligationsData; today: string; accountName: (id: string) => string; categoryName: (id: string | null) => string | null; markPaidAction; undoAction }): ReactElement;
export function TimelineCard(props: { timeline: TimelineMonth[]; changes: Map<string, TimelineChange[]>; relief: ReturnType<typeof reliefNote>; paidByMonth: Map<string, string[]> }): ReactElement;
export function ObligationsTable(props: { items: ObligationListItem[]; ended: ObligationListItem[]; showEnded: boolean; currentMonth: string; accountName; categoryName; accounts; categories; updateAction; cancelAction }): ReactElement;
```
**Decisions:**
- Page order and copy: spec "What changes" 1–5. `searchParams.encerradas === "1"` toggles the ended list; the footer link flips it (`href="?encerradas=1"` / `"?"`).
- Timeline rows are `<details className="ff-timeline__row">` with the month row inside `<summary>`; `open` on the first month present in `changes`. Detail lists that month's `entries` + paid names (from `paidByMonth`, current month only) with "paga" badges.
- `ThisMonthCard` unpaid rows sorted by `dueDay`; state classes from `dueStatus`; each row mounts the existing `ObligationPaymentDialog`. Paid rows: `ff-off`, check bubble, badge "paga", form → `undoObligationPaymentAction` with `SubmitButton className="ff-btn--link"` "desfazer".
- Table `gridTemplate="1fr 260px 140px 40px"`; mobile `RowCardList` cards with name/sub/amount + pencil.
- Header CTA = `NewObligationDialog trigger="header"`; mobile sticky = a second `NewObligationDialog trigger="sticky"` inside `.ff-sticky-cta`.
- Keep `loading.tsx` using `RouteSkeleton variant="obligations"` (updated in Task 4).

**Named test cases:**
- `TimelineCard` renders badges only for months present in `changes`, opens exactly the first changed month, shows the relief note when given.
- `ThisMonthCard` orders unpaid by due day, applies `--overdue`/`--warn` classes from `today`, renders paid rows with "paga" and a "desfazer" button.
- `ObligationsTable` renders "sem prazo", "n de N pagas · até …", and "começa em … · N parcelas" cells; ended list appears only when `showEnded`.
- `buildObligationsData(..., { includeEnded: true })` returns ended + canceled templates separately from `obligations`.

**Validation:** `pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web typecheck && pnpm --filter @family-finance/web build`.

**Commit:** `feat(web): redesign /obligations — checklist, change-only timeline, table`.

---

### Task 8: Docs, gate, visual QA

**Files:**
- Modify: `thoughts/features/recurring-obligations/progress.md` (dated entry: page redesign shipped, links to spec + mockups; note undo-payment semantics and the "past months assumed paid" progress rule)
- Modify: `thoughts/tech-debt.md` (append: Alternativa B grid view as optional secondary view; Playwright coverage for the new dialogs)

**Steps:**
- Run the full gate from `family-finance/`: `pnpm typecheck && pnpm test && pnpm build && pnpm --filter @family-finance/web lint`.
- Visual QA against the mockups with the dev server (`pnpm --filter @family-finance/web dev`, `/obligations`): desktop 1092px and mobile 390px, both themes (Esmeralda/Sálvia), create + edit + encerrar + mark paid + desfazer round trips. Use the `codex-computer-use` skill for screenshot comparison per CLAUDE.md; fix only pixel/copy drift found there.
- Commit: `docs(obligations): record page redesign`.

## Self-review notes

- Spec coverage: header/CTA (T5, T7), stats (T1, T7), checklist + undo (T2, T7), timeline change badges + details + relief (T1, T7), table + encerradas (T7), create dialog (T3, T5), edit + encerrar (T3, T6), mobile sticky CTA + row cards (T4, T7), skeleton (T4), docs (T8).
- Type consistency: `ObligationActionResult` (T2/T3) is consumed by T5, T6, T7; `TermProgress`, `TimelineChange`, `dueStatus` (T1) consumed by T6, T7; `OptionItem` (T5) reused by T6, T7; `transactionId` on paid entries (T2) consumed by T7's undo form.
