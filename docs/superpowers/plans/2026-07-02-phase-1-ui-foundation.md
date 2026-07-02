# Phase 1 — UI Foundation ("Editorial acolhedor") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the mockups' design system as a **plug-and-play presentational layer** — all visuals in `globals.css` + `components/ui/` (zero logic), all logic stays in pages — then re-skin every existing page by composing primitives.

**Architecture:** Two-file visual core (`app/globals.css` tokens + `components/ui/ui.css` classes) consumed by dumb primitives in `apps/web/components/ui/`. Primitives take props/children/callbacks only — **no data fetching, no `@family-finance/*` imports, no `lib/` imports, no `next/headers`** — enforced by an automated "design firewall" test. Pages keep 100% of their queries/actions and swap markup for primitive composition. Re-skinning later = touching `ui/` + the two CSS files, nothing else.

**Tech Stack:** Next.js App Router, `next/font/google` (Playfair Display + Inter), plain CSS classes (`.ff-*`) + CSS custom properties (`--ff-*`), `react-dom/server` `renderToStaticMarkup` for primitive tests (no new test deps), vitest.

## Global Constraints

- **Design source of truth:** `docs/design/2026-07-02-claude-design-mockups/*.dc.html`. Copy exact values (colors, radii, letter-spacing, sizes, copy strings) from these files — do not invent. `support.js` is the preview runtime — NEVER port it; `style-hover=`/`style-focus=`/`{{ }}`/`sc-if` become CSS classes / React logic.
- **Design firewall (the plug-and-play rule):** files under `apps/web/components/ui/` MUST NOT import `@family-finance/*`, `../../lib/`, `next/headers`, `next/cache`, or anything from `app/`. Data in via props; actions in via props (server actions passed down from pages/layouts are fine).
- Tokens: keep the existing `--ff-*` prefix (`apps/web/app/globals.css`). Esmeralda default via `data-theme` on `<html>` from the `ff-theme` cookie (already wired — do not change the mechanism; mockups' localStorage approach is preview-only).
- Semantic token values (from mockups, theme-aware): positive `#93C7A1`/`rgba(147,199,161,0.13)` esmeralda · `#3E7D52`/`rgba(62,125,82,0.12)` sálvia; negative `#E08B63`/`rgba(224,139,99,0.13)` · `#B4552F`/`rgba(180,85,47,0.10)`; warn `#E0B662`/`rgba(224,182,98,0.15)` · `#9A7526`/`rgba(154,117,38,0.13)`.
- Typography: Playfair Display 500/600 display/titles, Inter 300–600 body, kickers Inter 600 10-11px uppercase letter-spacing 0.22–0.28em, `font-variant-numeric: tabular-nums` on ALL money/number cells.
- Shape/depth: radii 10–16px cards/inputs, 999px pills; hairline 1px `var(--ff-border)`; shadows ALWAYS warm `rgba(20,14,8, 0.05–0.16)`; motion 0.15–0.5s, hover `translateY(-1px)`.
- pt-BR copy from the mockups verbatim (e.g. "Como estão as contas da casa?", "Tudo revisado por aqui ✨", "Deixa pra lá").
- **Strictly a re-skin:** no new queries/features. Mockup elements needing data we don't have are OMITTED in v1.0: account balances (Contas), "último aporte" (caixinhas), per-category monthly totals (Categorias), "+ Novo lançamento"/FAB manual entry, "@username" Telegram badges (show the numeric id we store).
- AA contrast: gold is accent/title only, never small body text; body text is ink/ink-soft over theme bg.
- Gate per task: `pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build && pnpm --filter @family-finance/web lint`. 251 tests must stay green. Commit per task; NO push. Never stage `thoughts/`, `memory/`, `.superpowers/`.
- Existing behavior tests (integration suites) must not change semantically — re-skins change markup, not logic. If a test asserts on markup, fix the assertion, never the behavior.

## File Structure

```
apps/web/app/globals.css                 # ALL tokens (extend in place)
apps/web/components/ui/ui.css            # ALL component CSS classes (.ff-*)
apps/web/components/ui/index.ts          # single export surface
apps/web/components/ui/primitives.tsx    # Card, StatCard, Badge, Button, Kicker, PageTitle, EmptyState, Delta
apps/web/components/ui/forms.tsx         # Field, Input, Select, MonthStepper, PillToggle
apps/web/components/ui/table.tsx         # Table (desktop grid) + RowCardList (mobile collapse)
apps/web/components/ui/charts.tsx        # PressureBars (pure CSS bar chart)
apps/web/components/ui/icons.tsx         # line-art SVG set (currentColor, stroke 1.7)
apps/web/components/ui/app-shell.tsx     # AppShell + SidebarNav + BottomNav (client for active state)
apps/web/components/ui/theme-picker.tsx  # floating ThemePicker (client; takes action prop)
apps/web/integration/ui-firewall.test.ts # design-firewall guard
apps/web/integration/ui-primitives.test.ts # renderToStaticMarkup assertions
```

Pages modified (logic untouched, markup recomposed): root `layout.tsx`, `login/page.tsx`, `(app)/layout.tsx`, and all 9 `(app)/*` pages + their client components.

---

### Task 1: Tokens, fonts, ui.css skeleton, design-firewall test

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/layout.tsx` (next/font + import ui.css)
- Create: `apps/web/components/ui/ui.css`
- Test: `apps/web/integration/ui-firewall.test.ts`

**Interfaces (Produces):** CSS vars `--ff-positive`, `--ff-positive-wash`, `--ff-negative`, `--ff-negative-wash`, `--ff-warn`, `--ff-warn-wash`, `--ff-radius-sm|md|lg|pill`, `--ff-shadow-card|float`, `--ff-font-display`, `--ff-font-body`; base classes `.ff-kicker`, `.ff-serif`, `.ff-num`.

- [ ] **Step 1: Write the failing firewall test**

```typescript
// apps/web/integration/ui-firewall.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(__dirname, "..", "components", "ui");
const FORBIDDEN = [
  /@family-finance\//,           // domain/db/config/etc.
  /from\s+["'].*\/lib\//,        // apps/web/lib helpers
  /next\/headers/, /next\/cache/, // server context — pages' job
  /from\s+["'].*\/app\//,        // app routes
];

describe("design firewall — components/ui is presentational only", () => {
  it("ui/ exists and no file imports logic layers", () => {
    expect(existsSync(UI_DIR)).toBe(true);
    for (const f of readdirSync(UI_DIR).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      for (const rule of FORBIDDEN) {
        expect(src, `${f} violates the design firewall: ${rule}`).not.toMatch(rule);
      }
    }
  });
});
```

- [ ] **Step 2: Run — FAIL** (`pnpm --filter @family-finance/web test -- ui-firewall`) — dir doesn't exist.
- [ ] **Step 3: Extend globals.css in place** (append to BOTH theme blocks + a shared block):

```css
/* append inside :root[data-theme="esmeralda"] */
  --ff-positive: #93c7a1; --ff-positive-wash: rgba(147, 199, 161, 0.13);
  --ff-negative: #e08b63; --ff-negative-wash: rgba(224, 139, 99, 0.13);
  --ff-warn: #e0b662;     --ff-warn-wash: rgba(224, 182, 98, 0.15);
/* append inside :root[data-theme="salvia"] */
  --ff-positive: #3e7d52; --ff-positive-wash: rgba(62, 125, 82, 0.12);
  --ff-negative: #b4552f; --ff-negative-wash: rgba(180, 85, 47, 0.10);
  --ff-warn: #9a7526;     --ff-warn-wash: rgba(154, 117, 38, 0.13);
/* new shared block */
:root {
  --ff-radius-sm: 10px; --ff-radius-md: 14px; --ff-radius-lg: 16px; --ff-radius-pill: 999px;
  --ff-shadow-card: 0 12px 30px rgba(20, 14, 8, 0.16);
  --ff-shadow-float: 0 8px 22px rgba(20, 14, 8, 0.3);
}
body { margin: 0; background: var(--ff-bg); color: var(--ff-ink); font-family: var(--ff-font-body), Inter, system-ui, sans-serif; }
```

- [ ] **Step 4: Fonts via next/font** in `apps/web/app/layout.tsx`: `Playfair_Display({ weight: ["500","600"], subsets: ["latin"], variable: "--ff-font-display" })`, `Inter({ weight: ["300","400","500","600"], subsets: ["latin"], variable: "--ff-font-body" })`; put both `.variable` classes on `<html>`. Import `../components/ui/ui.css` here too.
- [ ] **Step 5: Create `ui.css`** with the base utility classes (kicker/serif/tabular-nums) + `@keyframes ffFadeUp` (from mockups: `from {opacity:0; transform:translateY(8px)}`). Create `components/ui/index.ts` exporting nothing yet (empty export) so the dir exists.
- [ ] **Step 6: Run firewall test — PASS. Full gate. Commit** `feat(web): design tokens, fonts and design-firewall for the ui layer`

### Task 2: Core primitives + icons

**Files:**
- Create: `apps/web/components/ui/primitives.tsx`, `apps/web/components/ui/icons.tsx`; extend `ui.css`, `index.ts`
- Test: `apps/web/integration/ui-primitives.test.ts`

**Interfaces (Produces — exact signatures later tasks compose):**

```typescript
export function Kicker({ children }: { children: ReactNode }): JSX.Element;              // .ff-kicker, gold
export function PageTitle(props: { kicker: string; title: string; lead?: string; actions?: ReactNode }): JSX.Element;
export function Card(props: { children: ReactNode; soft?: boolean; hoverable?: boolean; warnEdge?: boolean; accentEdge?: boolean; className?: string }): JSX.Element;
export function StatCard(props: { kicker: string; value: string; hint?: ReactNode; tone?: "default" | "positive" }): JSX.Element; // Playfair value, tabular-nums
export type BadgeTone = "warn" | "negative" | "positive" | "accent" | "neutral";
export function Badge(props: { tone: BadgeTone; children: ReactNode; dot?: boolean }): JSX.Element;   // 999px pill, wash bg
export function Button(props: { variant?: "primary" | "ghost" | "danger" | "link"; type?: "button" | "submit"; onClick?: () => void; disabled?: boolean; children: ReactNode }): JSX.Element;
export function Delta(props: { direction: "down" | "up"; tone: "positive" | "negative"; children: ReactNode }): JSX.Element; // "↓ R$ 320 a menos que junho 🌱" chip
export function EmptyState(props: { icon: ReactNode; title: string; description: string; action?: ReactNode }): JSX.Element; // dashed border
// icons.tsx — all: (props: { size?: number }) => JSX.Element, stroke currentColor 1.7:
export { IconHome, IconGrid, IconTransfer, IconUpload, IconTag, IconBank, IconCard, IconJar, IconSliders, IconPencil, IconTrash, IconDoc, IconPlusCircle, IconDots };
```

- [ ] **Step 1: Failing tests** with `renderToStaticMarkup` (node env, no jsdom):

```typescript
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, Button, StatCard } from "../components/ui";
// Badge tone=warn renders .ff-badge--warn and children text
// Button variant=primary renders <button class~="ff-btn--primary" type="button">
// StatCard renders kicker uppercase text + value inside .ff-num
```

- [ ] **Step 2: FAIL → Step 3: implement** components + `.ff-card`, `.ff-badge--*`, `.ff-btn--*`, `.ff-stat`, `.ff-empty` classes in `ui.css`, copying exact paddings/sizes from `Design System.dc.html` (e.g. badge `5px 12px` font 600 11px; button primary `11px 20px` radius 12px shadow `0 4px 12px rgba(20,14,8,0.14)`; hover states as `:hover` rules).
- [ ] **Step 4: PASS. Gate. Commit** `feat(web): core ui primitives — card, statcard, badge, button, empty state, icons`

### Task 3: Form primitives, table + mobile collapse, pressure bars

**Files:**
- Create: `apps/web/components/ui/forms.tsx`, `table.tsx`, `charts.tsx`; extend `ui.css`, `index.ts`
- Test: extend `apps/web/integration/ui-primitives.test.ts`

**Interfaces (Produces):**

```typescript
export function Field(props: { label: string; children: ReactNode }): JSX.Element;        // uppercase mini-label
export function Input(props: ComponentProps<"input">): JSX.Element;                        // .ff-input (focus ring = 3px tint)
export function Select(props: ComponentProps<"select">): JSX.Element;                      // native select, styled shell
export function MonthStepper(props: { label: string; prevHref: string; nextHref: string }): JSX.Element; // pill ‹ mês ›, Link-based (GET filters preserved)
export function PillToggle(props: { active: boolean; href: string; children: ReactNode }): JSX.Element;  // "Só pendentes · 3"
export function Table(props: { columns: Array<{ key: string; label: string; align?: "right" }>; gridTemplate: string; children: ReactNode }): JSX.Element;
export function TableRow(props: { children: ReactNode; pending?: boolean; className?: string }): JSX.Element; // pending → warn inset stripe
export function RowCardList(props: { children: ReactNode }): JSX.Element;                  // mobile: children are Cards
export function PressureBars(props: { bars: Array<{ label: string; value: number; display: string; active?: boolean }> }): JSX.Element; // pure CSS bars, heights proportional to max
```

- [ ] **Step 1: Failing tests**: MonthStepper renders both hrefs; TableRow `pending` adds `.ff-row--pending`; PressureBars gives the max bar 100% height style and active bar `.ff-bar--active`.
- [ ] **Steps 2–3: TDD implement.** Responsive rule in `ui.css`: `@media (max-width: 720px) { .ff-table { display:none } .ff-rowcards { display:flex } }` and inverse on desktop — pages render BOTH Table and RowCardList; CSS picks (no JS, server-rendered).
- [ ] **Step 4: Gate. Commit** `feat(web): form, table and chart ui primitives with mobile collapse`

### Task 4: AppShell, nav, ThemePicker + root/login/app-layout re-skin

**Files:**
- Create: `apps/web/components/ui/app-shell.tsx` (client), `theme-picker.tsx` (client); extend `ui.css`
- Modify: `apps/web/app/(app)/layout.tsx`, `apps/web/app/login/page.tsx`, `apps/web/app/layout.tsx`
- Modify: `apps/web/app/(app)/settings/actions.ts` — export the existing `setThemeAction` unchanged (it's passed down as prop)
- Test: extend `ui-primitives.test.ts` (nav active state), keep auth tests green

**Interfaces (Produces):**

```typescript
export type NavItem = { href: string; label: string; icon: keyof typeof NAV_ICONS };
export function AppShell(props: {
  items: NavItem[];               // provided by (app)/layout.tsx — the ONLY nav source stays there
  brand: { kicker: string; title: ReactNode };
  user: { initial: string; name: string; email: string };
  signOut?: ReactNode;            // page-provided form/button
  themePicker?: ReactNode;
  children: ReactNode;
}): JSX.Element;                  // desktop: 256px sidebar (soft bg, active = tint + inset gold bar); mobile: bottom-nav (Resumo/Transações/Cartões/Mais per mockup)
export function ThemePicker(props: { current: "esmeralda" | "salvia"; onSelect: (t: "esmeralda" | "salvia") => Promise<void> }): JSX.Element; // floating bolinhas, fixed bottom-right
```

- [ ] **Step 1:** `(app)/layout.tsx` keeps `requireAuthorizedUser()` + NAV_ITEMS (adds icon keys) and renders `<AppShell …><ThemePicker current={theme} onSelect={setThemeAction}/></AppShell>`. Active item via `usePathname()` inside AppShell (client), sidebar brand: kicker "NOSSA CASA", title `Alvaro <i>&</i> Karol` (serif, gold italic &).
- [ ] **Step 2:** Login page per `Mais Telas.dc.html`: centered card, "convite de dois" copy, gold "Entrar com Google" button — existing auth wiring untouched.
- [ ] **Step 3:** Verify no-flash theming still works (cookie → `data-theme`, ThemePicker calls the server action then `router.refresh()`).
- [ ] **Step 4: Gate + manual smoke on :3000** (login redirect page renders new skin; sidebar + bottom nav at 390px via devtools). **Commit** `feat(web): app shell, bottom nav, floating theme picker — editorial acolhedor`

### Task 5: Re-skin Resumo + Dashboard

**Files:**
- Modify: `apps/web/app/(app)/resumo/page.tsx`, `apps/web/app/(app)/dashboard/page.tsx` (markup only; `queries.ts` files untouched)

Mapping (from `Resumo.dc.html` / `Dashboard.dc.html`):
- Resumo: Kicker "Nossa casa · <mês>" + serif "Oi, <nome>" + "Como estão as contas da casa?"; gasto do mês as 54–62px Playfair with cents in smaller span; `Delta` chip; pendentes → warn link-Card "Falta categorizar N lançamentos" / positive "Tudo revisado por aqui ✨"; faturas per card as icon Cards; últimos 5 as list Card with "ver tudo →".
- Dashboard: 4 `StatCard` (Entrou/Saiu/Sobrou/Cartões em <mês> with direct+parcelas hint); `PressureBars` fed from existing upcoming-installments data grouped by month (display = formatted thousands, active = current month); "Pra revisar" Card (existing pendingReview list, "categorizar" ghost pill links to `/transactions?pending=1`); últimos lançamentos Table+RowCardList; caixinhas Card with per-bucket rows + total footer (data exists since Phase 2).

- [ ] Steps: recompose each page; run `resumo.test.ts` + dashboard-touching integration tests unchanged (they test queries, not markup); manual smoke both themes; gate; **Commit** `feat(web): resumo and dashboard on the new design system`

### Task 6: Re-skin Transações + Importação

**Files:**
- Modify: `apps/web/app/(app)/transactions/page.tsx`, `transactions-table.tsx`; `apps/web/app/(app)/imports/page.tsx` (+ its client components)

Mapping (from `Transacoes.dc.html` / `Importacao.dc.html`):
- Transações: PageTitle + filter bar Card (MonthStepper + Selects + PillToggle "Só pendentes · N" auto-submitting the existing GET form); Table with pending rows (`TableRow pending`), inline-edit row = soft Card with accent inset (existing edit state), delete confirm = negative wash row "Isso não dá pra desfazer." / "Deixa pra lá" (replaces `confirm()` — same action wiring, nicer UI, still a client-side confirm step); footer "N lançamentos em <mês> · N pendentes" + pagination ghosts; mobile RowCardList with "Categorizar/depois" buttons on pending cards. NO FAB/new-entry button (out of scope).
- Importação: 3-dot stepper (gold done/current), passo 1 origem/cartão Fields + dashed dropzone Card ("Solta o arquivo aqui"), passo 2 Parcelamentos detectados panel (Badge "novo"/"já existe", editable Total/Parcelas/Compra Inputs — existing state), preview Table with checkbox squares + Badges (duplicata provável / já importada / sem categoria / "sugerida pela memória ✨" hint), sticky-ish footer summary + "Gravar N lançamentos" primary; passo 3 success Card "Tudo guardado ✨". All existing preview/confirm logic and state untouched.

- [ ] Steps: recompose; ALL transactions/imports integration tests stay green; manual smoke incl. a real preview against local stack; gate; **Commit** `feat(web): transações and importação on the new design system`

### Task 7: Re-skin Categorias, Contas, Cartões, Investimentos, Configurações

**Files:**
- Modify: `apps/web/app/(app)/{categories,accounts,cards,investments,settings}/page.tsx` (+ client components: `cards/purchase-form.tsx`, `settings/settings-forms.tsx`)

Mapping (from `Mais Telas.dc.html` / `Configuracoes.dc.html`), minus out-of-scope data:
- Categorias: list Cards with color dot + name + subcategory summary + "›" (NO monthly totals). Existing archive/merge/restore actions keep their controls, restyled as ghost Buttons.
- Contas: two-column Cards with icon + kind copy ("movimento do dia a dia") — NO balance numbers.
- Cartões: Cards with gold top border, "fecha dia N · vence dia N", fatura do mês (existing `getCardPressure`-based data if already on page — do not add queries), parcelamentos Badge + list from existing groups data, "+ Compra parcelada" primary opens the existing purchase form restyled with Field/Input/Select.
- Investimentos: caixinha Cards with Playfair balance + "guardar +"-style ghost pill = the existing "Atualizar saldo" inline form (keep its semantics; NO "último aporte" line).
- Configurações: theme cards (Esmeralda "escuro, aconchego de noite" / Sálvia "claro, manhã com café") calling existing `setThemeAction`; members Cards with avatar initial + Field displayName + telegram id Input (numeric, per stored data) + existing save action; "a casa" dashed pseudo-member row; bot status Card (existing `findLastBotInteraction` data + 🎙️).

- [ ] Steps: recompose all five; settings/investments integration tests green; manual smoke; gate; **Commit** `feat(web): remaining pages on the new design system`

### Task 8: Final gate, both-themes visual pass, docs

- [ ] Full gate: `pnpm typecheck && pnpm test && pnpm --filter @family-finance/web build && pnpm --filter @family-finance/web lint` (251+ tests green, firewall test included).
- [ ] Visual pass on :3000: every page × both themes × 1440/390 widths; check gold-on-esmeralda never used for body text (AA constraint); no page still using the old `#11271f`-style hardcoded colors — `grep -rn "#11271f\|#e9f5ef" apps/web/app` returns nothing.
- [ ] Adversarial review of the whole Phase-1 diff (fresh reviewer): firewall honored, logic diffs are markup-only, pt-BR copy fidelity.
- [ ] Update `thoughts/PROGRESS.md` + handoff; note in tech debt if any mockup element was deferred beyond the declared scope cuts.
- [ ] **Commit** docs. NO push.

---

## Self-Review

1. **Spec coverage:** §1.1 tokens → Task 1; §1.2 shared presentational components + all pages re-skinned → Tasks 2–7; theme toggle in Configurações + floating control → Tasks 4/7; copy tone → constraints + mappings. Deliverable gate (§1.3, user reviews mockups first) — satisfied: mockups imported + user-driven.
2. **Placeholders:** none — every component has a signature, every page a concrete mapping, scope cuts are explicit.
3. **Type consistency:** `Badge(tone)`, `TableRow(pending)`, `MonthStepper(prevHref/nextHref)`, `ThemePicker(onSelect: server action)` used consistently across Tasks 4–7.
