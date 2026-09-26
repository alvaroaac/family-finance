# Import Preview by Merchant (option A) Implementation Plan

**Goal:** Replace the flat "Prévia dos lançamentos" table with a merchant-grouped review (option A of the design canvas), an always-enabled "Gravar" button that explains blockers in a dialog, an in-section comparison error, and a local draft so long reviews survive a reload.

**Architecture:** Keep the page's per-row state model (`mapping`, `learning`, `excluded`, `rowEdits`, `provenance`) and the `confirmImport` contract untouched; option A is a presentation layer that groups row indices by `normalizeMerchantKey(description)`. Pure helpers (grouping/filters/summary, draft serialization, blocker derivation) live in small modules with unit tests; the grouped list and blocked dialog are new components; `page.tsx` swaps its render blocks and wires the helpers. Rejected: a server-side draft table (needs a migration and a prod DB step for a convenience feature; localStorage keyed by file fingerprint is enough).

**Tech Stack:** Next.js 15 App Router, React 19, TS strict, Vitest (jsdom for page tests). No new dependencies.

**Spec:** design canvas https://claude.ai/code/artifact/032e7fbb-9f5c-480f-8057-5d1797cb87ff (option A + "Gravar bloqueado" dialog + "Erro comparações" artboard); working files in `docs/design/2026-09-11-importacao-previa-mockups/`.

## Global Constraints

- `confirmImport` input shape unchanged; destination (account/card) is never persisted in the draft ("destination is a claim identity component, never guess it").
- Group category applies to every *attached*, non-excluded, non-installment-suppressed row of the group; a row detached via "mudar só esta" keeps its own category until re-attached via "segue o grupo".
- Choosing a group category turns the group's "Lembrar" on (sets `learning[i].merchant = true` for its editable rows); the user can turn it off.
- "Gravar" is disabled only while `isPending`; any other reason opens the blocked dialog instead of disabling.
- Copy in Brazilian Portuguese, same voice as the page ("Nada entra sem a sua revisão…"). Copy in this plan is contractual.
- TDD: each task's **Behavior** bullets are its test list — write failing tests from them first, then implement. Commit per task.
- `pnpm typecheck`, `pnpm test`, and `pnpm --filter @family-finance/web build` must stay green.

## File map

- Create `apps/web/app/(app)/imports/merchant-groups.ts` — grouping, ordering, filters, summary text (pure).
- Create `apps/web/app/(app)/imports/import-draft.ts` — localStorage draft save/load (pure + storage boundary).
- Create `apps/web/app/(app)/imports/confirm-blockers.ts` — blocker/pendência derivation (pure).
- Create `apps/web/app/(app)/imports/preview-list.tsx` — grouped desktop table + mobile cards, toolbar, footer.
- Create `apps/web/app/(app)/imports/confirm-blocked-dialog.tsx` — native `<dialog>` listing pendências.
- Modify `apps/web/app/(app)/imports/page.tsx` — wire helpers/components, remove flat table + mobile cards, remove merchant bulk controls, move undo to toolbar, in-section comparison error.
- Modify `apps/web/components/ui/ui.css` — `.ff-preview*` and dialog-list styles.
- Tests: `apps/web/app/(app)/imports/merchant-groups.test.ts`, `import-draft.test.ts`, `confirm-blockers.test.ts`; update `apps/web/integration/import-review-page.test.tsx`, `import-purchase-description-ui.test.tsx`.

### Task 1: merchant-groups.ts (Codex)

**Produces:**
```ts
export type MerchantGroup = { key: string; label: string; indices: number[]; totalCents: number; firstDate: string; lastDate: string };
export function buildMerchantGroups(rows: { description: string; occurredOn: string; amount: { cents: number }; kind: "expense" | "income" }[], descriptionOverrides?: Record<number, string>): MerchantGroup[];
export type GroupOrderInput = { group: MerchantGroup; uncategorizedSelected: number };
export function orderMerchantGroups(groups: GroupOrderInput[]): MerchantGroup[];
export type PreviewFilter = "all" | "uncategorized" | "duplicates" | "installments";
export function filterGroups(groups: MerchantGroup[], opts: { filter: PreviewFilter; search: string; isUncategorized: (i: number) => boolean; isDuplicate: (i: number) => boolean; isInstallment: (i: number) => boolean }): MerchantGroup[];
export function formatGroupDates(firstDate: string, lastDate: string): string; // "15 ago" | "07 e 19 ago" | "03 a 29 ago" | "28 ago a 02 set"
export function formatPeriod(rows: { occurredOn: string }[]): string; // "01 – 31 ago" | "28 ago – 02 set" | ""
export function countLabel(n: number, singular: string, plural: string): string; // "1 lançamento" / "7 lançamentos"
```

**Behavior:**
- Group key is `normalizeMerchantKey(description)` from `@family-finance/categorization`; `descriptionOverrides[i]` (edited description) wins over the row's description. Empty key falls back to the trimmed raw description uppercased; still empty → key `"—"`, label `"Sem descrição"`.
- Label is the shortest original description among the group's rows (mockup shows `IFOOD *IFD`, not the full line).
- `totalCents` sums expense as positive and income as negative (net outflow), matching page `formatBrl` usage.
- `firstDate`/`lastDate` are min/max `occurredOn` ISO strings; indices preserved in row order.
- `orderMerchantGroups`: groups with `uncategorizedSelected > 0` first, then by `indices.length` desc, then label asc (pt-BR locale compare).
- `filterGroups`: "uncategorized" keeps groups with any index where `isUncategorized`; "duplicates" any `isDuplicate`; "installments" any `isInstallment`; search matches label or key case/accent-insensitively; filters do not alter group membership.
- `formatGroupDates`: same day → `"15 ago"`; two distinct days same month → `"07 e 19 ago"`; range same month → `"03 a 29 ago"`; cross-month → `"28 ago a 02 set"`. Month abbreviations lowercase pt-BR without dot (jan fev mar abr mai jun jul ago set out nov dez).
- `formatPeriod`: min/max over rows; same month `"01 – 31 ago"`, cross-month `"28 ago – 02 set"`, single day `"15 ago"`, empty rows `""`.

**Verify:** `pnpm --filter @family-finance/web test -- merchant-groups`.

### Task 2: import-draft.ts (Codex)

**Produces:**
```ts
export type ImportDraft = { rowCount: number; savedAt: string; mapping: Record<number, { categoryId?: string; subcategoryId?: string }>; learning: Record<number, { sourceCategory?: boolean; merchant?: boolean }>; excluded: number[]; rowEdits: Record<number, { occurredOn?: string; description?: string; amountCents?: number; kind?: "expense" | "income" }>; detached: number[] };
export function draftKey(fileFingerprint: string): string; // "ff-import-draft:" + fingerprint
export function saveDraft(storage: Pick<Storage, "setItem">, fileFingerprint: string, draft: Omit<ImportDraft, "savedAt">, now?: Date): ImportDraft;
export function loadDraft(storage: Pick<Storage, "getItem">, fileFingerprint: string, rowCount: number): ImportDraft | null;
export function clearDraft(storage: Pick<Storage, "removeItem">, fileFingerprint: string): void;
export function formatSavedAt(iso: string): string; // "14:32"
```

**Behavior:**
- `saveDraft` stringifies with `savedAt = now.toISOString()` and returns the saved draft; storage errors (quota, private mode) are swallowed and the draft still returned.
- `loadDraft` returns null for missing key, invalid JSON, non-object payload, or `rowCount` mismatch; excluded/detached must be arrays of numbers (else null); missing mapping/learning/rowEdits default to `{}`.
- `formatSavedAt` renders local HH:MM zero-padded.

Note: the exact `rowEdits` value shape must match `RowEdit` in `apps/web/app/(app)/imports/actions.ts` — import that type rather than redefining it.

**Verify:** `pnpm --filter @family-finance/web test -- import-draft`.

### Task 3: confirm-blockers.ts (Codex)

**Produces:**
```ts
export type Pendencia = { id: "destination" | "comparison-failed" | "comparison-pending" | "nothing-selected" | "installment-review" | "uncategorized"; hard: boolean; title: string; detail: string; action: string };
export function derivePendencias(input: { destinationMissing: boolean; comparisonFailed: boolean; comparisonPending: boolean; selectedCount: number; pendingInstallmentReviews: number; uncategorized: { label: string; count: number }[] }): Pendencia[];
export function blockedDialogCopy(pendencias: Pendencia[], selectedCount: number): { title: string; lead: string; primary: "resolve" | "confirm-anyway" };
```

**Behavior:**
- Order: destination, comparison-failed, comparison-pending, nothing-selected, installment-review, uncategorized. Only present ones returned.
- Hard: destination, comparison-failed, comparison-pending, nothing-selected, installment-review. Soft: uncategorized.
- Copy (verbatim): destination → title `Conta ou cartão de destino não escolhido`, detail `Onde esses lançamentos entram`, action `Escolher`. comparison-failed → `Comparação com o banco falhou` / `Sem ela, não dá pra saber o que já existe` / `Tentar de novo`. comparison-pending → `Comparação com o banco ainda rodando` / `Só um instante, estamos vendo o que já existe` / `Aguardar`. nothing-selected → `Nenhum lançamento marcado` / `Marca pelo menos um pra gravar` / `Ver lista`. installment-review → `Parcelamentos sem decisão` (detail `1 grupo parecido com um já existente` / `N grupos parecidos com já existentes`) / `Comparar`. uncategorized → `Lançamentos sem categoria` / detail is the top three labels as `IFOOD ×2, 99APP ×1` plus ` e mais N` when more than three / action `Ver`.
- `blockedDialogCopy`: any hard → title `Ainda não dá pra gravar`, lead `Falta 1 coisa antes de gravar os N lançamentos` / `Faltam K coisas antes de gravar os N lançamentos` (N = selectedCount, "o 1 lançamento" when 1), primary `resolve`. Only soft → title `Gravar sem categoria?`, lead `N lançamentos vão entrar sem categoria. Dá pra categorizar depois na lista de lançamentos.` (singular `1 lançamento vai entrar sem categoria…`), primary `confirm-anyway`.

**Verify:** `pnpm --filter @family-finance/web test -- confirm-blockers`.

### Task 4: preview-list.tsx + confirm-blocked-dialog.tsx + page wiring + CSS (Fable, inline)

- Toolbar (sticky inside the scroll box): search input `aria-label="Buscar estabelecimento"`, period chip from `formatPeriod`, status chips `Sem categoria N · Todos N · Duplicatas N · Parcelas N` (buttons with `aria-pressed`), `Desfazer` (visible when an undo exists).
- Desktop grid `44px minmax(220px,1fr) 120px 170px 160px 90px 40px`, columns `check · Estabelecimento · Total · Categoria (vale pro grupo) · Subcategoria · Lembrar · expand`. Group row: checkbox `aria-label="Importar estabelecimento X"` (checked when any attached row selected, indeterminate when mixed), label + sub-line `N lançamentos · dates · state` where state ∈ `sem categoria` | `usar <Cat> · Codex` (pending AI suggestion) | `antes: <source>` | `misto` (rows differ) | `k/n` (installment) ; category/subcategory selects `aria-label="Categoria do grupo X"` / `Subcategoria do grupo X` show value when all attached rows agree, else blank with `misto` hint; Lembrar checkbox `aria-label="Lembrar X"`.
- Expanded group lists up to 3 occurrences, then `ver as outras N →` button reveals the rest. Occurrence row: checkbox `Importar linha N`, `dd/mm`, description, amount, badges (duplicata provável / já importada / entra pelo parcelamento / sem comparar), then `segue o grupo · mudar só esta` (button) or, when detached, own category/subcategory selects `Categoria linha N` / `Subcategoria linha N` + `segue o grupo` button; `editar` button reveals the date/description/amount/kind inputs; `ensinar categoria da origem` checkbox kept when `row.sourceCategory`.
- Mobile: group cards with same controls stacked; `Lembrar pra próxima fatura` toggle line.
- Footer: `N de M marcados · R$ total`, `K pendências antes de gravar ›` / `1 pendência antes de gravar ›` (button opens dialog; hidden when none), `Rascunho salvo às HH:MM`, `Continuar depois` (ghost; returns to step 1, draft kept), `‹ Voltar`, primary `Gravar N lançamentos`.
- Dialog: `.ff-dialog` native modal per obligation-dialog-shell pattern; header `title`, `lead`, note `O botão fica sempre ativo. Quando falta algo, a gente te conta aqui em vez de travar em silêncio.`; list items with action buttons (`Escolher` focuses destination select; `Tentar de novo` retries targets; `Ver` sets filter uncategorized and scrolls to the list; `Comparar` scrolls to first pending installment group; `Ver lista` sets filter all); actions `Fechar` + `Resolver a primeira` or `Gravar mesmo assim`.
- Comparison error: `.ff-alert--negative` inside the preview section with title `Não consegui comparar com o que já está no banco`, body `A lista continua aqui pra você revisar; a gravação só é liberada quando a comparação funcionar.`, `Tentar novamente`, `<details>` `Detalhe técnico` with the message.
- Draft: autosave (debounced 800ms) on any change of mapping/learning/excluded/rowEdits/detached; restore on preview when `loadDraft` matches; `clearDraft` after successful confirm.

**Verify:** integration tests updated; `pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build`; static render check of the page in the browser preview.
