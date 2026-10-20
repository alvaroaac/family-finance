# Installable web app + quick capture — Implementation Plan

**Goal:** Casa installs on our phones as an app, and "85 no mercado no nubank" (typed or spoken) fills an editable transaction form that saves through the existing manual-transaction path.

**Architecture:** The web keeps no AI keys. Server actions sign the text (or audio) plus the acting member and post them to two new internal bot routes over the existing HMAC channel. The bot loads the member's catalog under RLS and runs **the Telegram `startConversation` function unchanged** with read-only deps, then maps the returned conversation state to a closed draft contract. The extraction refactor the spec planned (decision `pipeline-reuse`) is replaced by this; see that block. Saving uses `createManualTransactionAction` as-is.

**Tech Stack:** Next.js 15 App Router, React, Supabase (RLS), node:http bot, zod, vitest, Playwright. MediaRecorder in the browser. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-pwa-quick-capture-design.md`
**Design:** `thoughts/features/pwa-quick-capture/design/Quick Capture.dc.html` (Claude Design export; open it in a browser next to `support.js`, which it loads). Summary in [Design reference](#design-reference).

## Global Constraints

- TDD: each task's **Behavior** bullets are its test list — write failing tests from them first, then implement. Commit per task.
- Work only in the worktree `.claude/worktrees/pwa-quick-capture`, branch `feat/pwa-quick-capture`. Never touch other branches or worktrees.
- No production access: no VPS, no production database, no Vercel project settings, no Telegram webhook changes. Preview deploys only when a task says so.
- OpenAI and Typesafe keys stay on the bot. No new env var on Vercel. Never use `SUPABASE_SERVICE_ROLE_KEY` in web code.
- The household of a web request always comes from the authenticated user's active membership, never from client input. The bot trusts `scopeKey` only after `resolveActorHouseholdId(actorUserId) === scopeKey`.
- Telegram behavior does not change. `apps/bot/src/conversation.ts` is not edited by this plan. All existing bot tests pass unchanged.
- `/transactions` "Novo lançamento" keeps posting the same FormData field names and values to `createManualTransactionAction`.
- User-facing copy is Brazilian Portuguese. Copy given verbatim in this plan or the spec is contractual.
- Non-test code under `apps/` and `packages/` must not contain "Alvaro", "Álvaro", "Karol" or "alvaroekarol" (the design file uses real names as sample data; do not copy them).
- Colors come from the existing theme CSS variables (`--bg`, `--surface`, `--accent`, …), never hard-coded hex, so Esmeralda, Sálvia and household themes all work.
- Release gate, all green before a task is reported done: `pnpm typecheck`, `pnpm test`, `pnpm lint`; tasks touching `apps/web` also `pnpm --filter @family-finance/web build`.
- Commit messages end with `Co-Authored-By: <model that wrote the commit> <noreply@anthropic.com>`.

## Changes vs spec

1. **Bot pipeline reuse:** call `startConversation` with read-only deps instead of extracting a stateless step (decision `pipeline-reuse` below). Drops the `pipeline-extractable` assumption and its fallback.
2. **Draft contract adds `responsibleUserId?`** (uuid of an active member). The design fills "Quem" from text ("… da Karol"); Telegram's draft already carries it.
3. **Capture options load on first open** through `loadCaptureOptionsAction()`, so the sheet opened from the AppShell does not make every page load accounts/categories.
4. **"+ Nova categoria" is a link-button next to the Categoria label** that swaps the select for an input + "Criar" (design), not an option inside the select.
5. **Field look follows the design** in both the capture sheet and the `/transactions` modal (decision `fields-look`).
6. Copy added by the design (verbatim): `Detalhes`, `IA`, `Escolha…`, `Nome da nova categoria`, `Criar`, `Ouvindo…` (textarea placeholder while recording), `Enter preenche` (desktop only), `Abrir Obrigações →`, `Fechar`, `Dispensar`, `Novo lançamento` (sheet title, + aria-label, desktop button), `Conta / cartão`, `Quem`, `Despesa`, `Receita`.

```decision id=pipeline-reuse
label: Sharing the Telegram text pipeline (revised)
question: How should the capture-draft handler reuse the Telegram text pipeline?
quote: The bot loads the member's catalog under RLS and runs the Telegram startConversation function unchanged
context: You picked A in the spec review. Mapping startConversation showed it already returns a pure value (ConversationOutcome.state with the draft, category candidates and payment candidates) and persists nothing itself. Its only writes before confirmation go through optional deps: materializeObligationPayment (a "paguei X" with one match) and createCategory/restoreCategory ("nova categoria X"). With those deps left out, those paths return a cancelled state and write nothing. logInteraction is passed as a no-op.
- A: Extract a stateless interpret step from startConversation; Telegram and capture both call it | One pipeline; a refactor of a 700-line function in the bot's busiest file, conflicts with other branches, regression risk on Telegram
- B: Capture composes the pieces itself (parser, detectFinancialRoute, classifier, suggestCategory) | No Telegram refactor; the two paths drift
- C: Capture calls startConversation unchanged with read-only deps and maps outcome.state to the draft contract | Same code as Telegram by construction, zero Telegram diff; the mapper depends on ConversationState's shape, locked by capture tests [pick]
```

```decision id=fields-look
label: Shared field set look
question: The design restyles the fields (Despesa/Receita segmented control, "R$" prefix, labels Conta / cartão and Quem, order Valor · Data · Descrição · Conta / cartão · Quem · Categoria). Where does that look apply?
quote: Field look follows the design in both the capture sheet and the /transactions modal
context: The design does not show Subcategoria, Forma or Parcelas. In every option they stay, shown only when they apply today (Subcategoria when the chosen category has subcategories; Forma/Parcelas for a card expense), placed under Categoria and Conta / cartão respectively.
- A: TransactionFields adopts the design look; both forms change | One field set, cannot drift; the /transactions modal changes visually (same FormData) [pick]
- B: Capture-only look; /transactions keeps today's labels | Two looks over one component via a variant prop; the drift the shared component was meant to stop
```

## Design reference

From `Quick Capture.dc.html` (mobile 390 bottom sheet, desktop 1440 modal). Prototype-only parts ignored: the state-jump toolbar, the floating theme picker, the fake regex parser and timers.

- **Entry points:** mobile bottom bar Resumo · Transações · **+** (raised round accent button, center) · Cartões · Mais. Desktop sidebar: accent "Novo lançamento" button above the nav.
- **Container:** mobile bottom sheet (drag handle, `sheetUp` entry, backdrop tap closes, sticky footer padded by `env(safe-area-inset-bottom)`); desktop centered modal (`popIn`, close button titled "Fechar (Esc)"). Esc closes on both. Header: "Novo lançamento" (Playfair) + round × button "Fechar".
- **AI box:** bordered box; textarea (2 rows, placeholder "Ex.: 85 no mercado no nubank", "Ouvindo…" while recording, "Transcrevendo…" while transcribing). Action row: "Gravar" (mic, outline) ↔ "Parar" (pulsing red dot) + timer `0:SS / 1:00`; "Transcrevendo…" with spinner; desktop hint "Enter preenche"; accent "Preencher" button (spinner + "Preenchendo…" while running). Box border: `--neg` while recording, `--accent` while filling. Thin accent progress bar at the box bottom while filling (eases to ~92%, never completes on its own). Enter fills, Shift+Enter is a newline.
- **Message banner** (role=status, dismiss × "Dispensar"), tones: unavailable → muted; rate_limited, non_financial, mic denied → warn; transcription failure → negative; unsupported_intent → accent with link "Abrir Obrigações →" to `/obligations`. Typing in the textarea clears the non_financial message.
- **Result block** (after a successful fill): small explanation line; when `needsReview`, a warn line "Há regras conflitantes para este lugar — escolha a categoria" and the Categoria field border turns `--warn` until a category is picked; up to 3 category chips, the selected one filled with `--accent`.
- **Form:** "Detalhes" heading with Despesa/Receita segmented control (Despesa in `--neg`, Receita in `--pos`); Valor with "R$" prefix and `inputMode="decimal"`; Data; Descrição (placeholder "Ex.: Mercado Guanabara"); Conta / cartão; Quem; Categoria with "+ Nova categoria" / "Cancelar" link-button and an inline input "Nome da nova categoria" + "Criar" (Enter creates).
- **AI marks:** every field the AI filled shows an "IA" pill in its label and a `--tint` background with `--accent` border. Editing the field removes both. A later Preencher never overwrites a field the user edited.
- **Footer:** "Cancelar" (ghost) + "Salvar" (accent, dimmed and disabled until Valor has a value).
- **Offline:** banner "Sem conexão — seu rascunho está salvo" at the top of the sheet; Preencher and Gravar disabled.
- **Saved:** sheet closes, toast "Lançamento salvo" with a check icon.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/web/app/manifest.ts` | Web app manifest | 1 |
| `apps/web/public/icons/casa-{192,512,512-maskable}.png` | App icons | 1 |
| `apps/web/app/layout.tsx` | `appleWebApp` metadata; `generateViewport` themeColor | 1, 2 |
| `apps/web/app/globals.css`, `components/ui/ui.css` | Safe-area padding | 2 |
| `apps/web/lib/bot-client.ts` | Sign + post to the bot's internal routes | 3 |
| `apps/web/app/(app)/imports/suggestion-client.ts` | Moves onto `bot-client` | 3 |
| `apps/bot/src/server.ts` | Shared signed-route verification; capture routes | 4, 5, 6 |
| `apps/bot/src/capture.ts` | Capture draft + transcribe handlers, rate limiter, outcome mapper | 5, 6 |
| `apps/bot/src/index.ts` (or new `conversation-deps.ts`) | Export `buildDeps`; wire capture routes in `main()` | 5, 6 |
| `apps/bot/src/audio.ts` | `transcribeAudioBuffer` | 6 |
| `apps/web/components/transaction-fields.tsx` | Shared controlled field set | 7 |
| `apps/web/app/(app)/transactions/new-transaction-form.tsx` | Uses `TransactionFields` | 7 |
| `apps/web/app/(app)/categories/actions.ts` | Create actions return `id` | 7 |
| `apps/web/app/(app)/capture/actions.ts` | Suggest, transcribe, load-options server actions | 8 |
| `apps/web/lib/capture-copy.ts` | Error code → pt-BR copy and tone | 8 |
| `apps/web/next.config.mjs` | `serverActions.bodySizeLimit = "2mb"` | 8 |
| `apps/web/components/capture/capture-sheet.tsx` | Sheet/modal shell + AI box + result block + form + footer | 9 |
| `apps/web/components/capture/use-capture-draft.ts` | Fill/merge rules, AI marks, localStorage draft | 9 |
| `apps/web/app/(app)/capture/page.tsx` | Full-page capture (manifest shortcut) | 9 |
| `apps/web/components/ui/app-shell.tsx` | + button, desktop "Novo lançamento" | 9 |
| `apps/web/components/capture/voice-button.tsx` | Record → transcribe → fill | 10 |
| `apps/web/e2e/quick-capture.spec.ts` | E2E with the bot stubbed | 11 |
| `deploy/README.md`, `deploy/vercel.md` | Bot routes, body limit | 11 |

## Tasks

### Task 1: Installable shell + iOS login check

**Files:**
- Create: `apps/web/app/manifest.ts`, `apps/web/public/icons/casa-192.png`, `casa-512.png`, `casa-512-maskable.png`
- Modify: `apps/web/app/layout.tsx`
- Test: `apps/web/app/manifest.test.ts`

**Interfaces:**
- Produces: `/manifest.webmanifest` served by Next; icon paths above.

**Behavior:**
- Manifest: `name` and `short_name` "Casa", `display: "standalone"`, `start_url: "/"`, `scope: "/"`, Esmeralda `background_color` and `theme_color`, icons 192, 512 and 512 `purpose: "maskable"`, `shortcuts: [{ name: "Novo lançamento", url: "/capture" }]`.
- Every URL in the manifest is relative (no host), so it is valid on every allowlisted host.
- Icons are generated once from `apps/mobile/assets/casa-icon.png` on the PR #28 branch (`git show codex/mobile-expo-prototype:apps/mobile/assets/casa-icon.png`) with `sips`; the maskable icon keeps the mark inside the central 80% safe zone on an Esmeralda background.
- `metadata.appleWebApp = { capable: true, title: "Casa", statusBarStyle: "default" }`; `apple-icon.png` stays as is.

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- manifest` and the release gate.
- Manual (owner, Risk 1): preview deploy of this branch → iPhone Safari → Add to Home Screen → open → Google sign-in → lands signed in on Resumo, and stays signed in after closing and reopening the app. **If this fails, stop and report**; an email 6-digit-code login task is planned then (spec Risk 1).

### Task 2: Theme color + safe areas

**Files:**
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/globals.css` and/or `apps/web/components/ui/ui.css`
- Test: `apps/web/app/layout.test.ts` (or the existing theme-resolution test file)

**Interfaces:**
- Consumes: the root layout's existing theme resolution (`resolveBaseTheme`, household theme, `ff-theme` cookie).

**Behavior:**
- `generateViewport()` returns `viewportFit: "cover"` and `themeColor` equal to the resolved theme's `--bg`: the household theme for a member, else the `ff-theme` cookie, else Esmeralda.
- Theme resolution is shared with the root layout (one function), not duplicated.
- `.ff-bottombar` gets `padding-bottom: env(safe-area-inset-bottom)`; the mobile header gets `padding-top: env(safe-area-inset-top)`. Desktop layout is unchanged.

**Verify:**
- Run: release gate.
- Manual: browser pane at 390×844, light and dark themes: no layout change in a normal tab.

### Task 3: `lib/bot-client.ts`

**Files:**
- Create: `apps/web/lib/bot-client.ts`, `apps/web/lib/bot-client.test.ts`
- Modify: `apps/web/app/(app)/imports/suggestion-client.ts` (and its tests)

**Interfaces:**
- Produces:
  ```ts
  export function signBotRequest(args: { secret: string; path: string; body: string; now?: number; nonce?: string }): Record<string, string>; // signing headers
  export type BotResponse = { ok: true; status: number; json: unknown } | { ok: false; reason: "not_configured" | "unreachable" | "timeout" };
  export async function postToBot(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<BotResponse>;
  ```
  `postToBot` reads `IMPORT_SUGGESTION_URL` (base origin) and `IMPORT_SUGGESTION_SHARED_SECRET`. A non-2xx HTTP status is `ok: true` with that `status` (callers map bot error codes).

**Behavior:**
- Signature string and header names are byte-identical to today's `signImportSuggestionRequest` (shared fixture: fixed secret, timestamp, nonce, body → known hex).
- Import suggestions keep the same URL, headers, timeout and error mapping; existing import tests pass unchanged.
- Missing env → `not_configured` without a network call; network error → `unreachable`; abort → `timeout`.
- Server-only module (`import "server-only"`).

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- bot-client suggestion` and the release gate.

### Task 4: Bot shared signed-route verification

**Files:**
- Modify: `apps/bot/src/server.ts`
- Test: `apps/bot/src/server.test.ts`

**Interfaces:**
- Produces (in `server.ts`):
  ```ts
  export type SignedRouteDeps = {
    secret: string;
    claimNonce: (nonce: string) => Promise<boolean>;
    resolveActorHouseholdId: (actorUserId: string) => Promise<string | null>;
    now?: () => number;
  };
  export type InternalRouteHandler = (
    json: unknown,
    actor: { userId: string; householdId: string },
  ) => Promise<{ status: number; body: unknown }>;
  export type InternalRoute = { path: string; maxBodyBytes: number; handle: InternalRouteHandler };
  ```
  `createBotServer(handle, options?: { importSuggestions?: ImportSuggestionRoute; internalRoutes?: InternalRoute[]; signed?: SignedRouteDeps })`. The exact option shape may differ if the import route's current options make another shape simpler, but there is one verification function used by every internal route.

**Behavior:**
- Order per internal request: method POST → body cap (413) → HMAC over `${timestamp}\n${nonce}\nPOST\n${path}\n${bodyHash}` (401) → timestamp within ±60 s (401) → JSON parse (400) → `actorUserId` and `scopeKey` present as uuids (400) → nonce claim (409 on replay; 503 if the claim throws) → `resolveActorHouseholdId(actorUserId) === scopeKey` (403; 503 if the lookup throws) → route handler.
- The import route keeps every status code and body it returns today, including its `version: 2` requirement; existing server tests pass unchanged.
- Signature comparison is constant-time.

**Verify:**
- Run: `pnpm --filter @family-finance/bot test -- server` and the release gate.

### Task 5: Bot `capture-draft`

**Files:**
- Create: `apps/bot/src/capture.ts`, `apps/bot/src/capture.test.ts`
- Modify: `apps/bot/src/server.ts` (path constant), `apps/bot/src/index.ts` (export `buildDeps`, or move it to `conversation-deps.ts` if importing `index.ts` has side effects; wire the route in `main()`)

**Interfaces:**
- Consumes: `InternalRoute` (Task 4); `startConversation`, `ConversationDeps`, `ConversationState` from `conversation.ts`; `buildDeps(client, householdId, ai?, interpretText?, classifyMessage?)`; the `categorizer` and deadline-wrapped `classifyMessage` instances `main()` already builds; `memberClient({ userId })`.
- Produces:
  ```ts
  export const CAPTURE_DRAFT_PATH = "/internal/v1/capture-draft";
  export function createCaptureDraftHandler(deps: {
    buildCaptureDeps: (actor: { userId: string; householdId: string }) => Promise<ConversationDeps>;
    limiter: CaptureRateLimiter;
    log: (event: string, fields: Record<string, unknown>) => void;
  }): InternalRouteHandler;
  export function toCaptureDraft(state: ConversationState, today: string): CaptureDraftResult; // pure mapper
  export type CaptureRateLimiter = { acquire(householdId: string): (() => void) | null }; // null → rate limited
  export function createCaptureRateLimiter(opts?: { perMinute?: number; concurrent?: number; now?: () => number }): CaptureRateLimiter; // defaults 20 / 2
  ```
  Request (zod `.strict()`): `{ version: 1, requestId: uuid, scopeKey: uuid, actorUserId: uuid, today: "YYYY-MM-DD", text: string 1–500 after trim }`.
  Response 200:
  ```
  { ok: true,
    intent: "plain" | "card_installment",
    draft: {
      description: string, amountCents?: int>0, date: "YYYY-MM-DD",
      kind: "expense" | "income",
      categoryId?, subcategoryId?, accountId?, creditCardId?, responsibleUserId?,
      installmentCount: int ≥1,
      candidates: [{ categoryId, subcategoryId?, explanation }],  // ≤3
      explanation: string,
      needsReview: boolean } }
  ```
  Errors `{ ok: false, error }`: `invalid_request` 400, `non_financial` 422, `unsupported_intent` 422, `rate_limited` 429, `unavailable` 503.

**Behavior:**
- Capture deps = `buildDeps(memberClient({ userId }), householdId, categorizer, interpretText, classifyMessage)` with `materializeObligationPayment`, `createCategory`, `restoreCategory`, `createSubcategory`, `restoreSubcategory`, `seedCategorizationMemory`, `createObligation`, `createInstallmentPurchase`, `settleCardBill`, `reconcileLegacyCardBillPayment` removed, `createTransaction` rejecting, and `logInteraction` a no-op. A test spies on every write dep and asserts none is called for: plain expense, "paguei aluguel" with exactly one matching obligation, "nova categoria Pets", a card-bill message.
- `startConversation` is called with `{ text, fromUserId: actorUserId, inputKind: "text" }` and `{ today }`.
- Mapping (`toCaptureDraft`):
  - `installmentDraft` present → `card_installment`; `amountCents` = `totalCents`, `creditCardId` = `cardId`, `installmentCount` from the draft (≥2), `date` = `purchasedOn`.
  - status `awaiting_confirmation`, `needs_amount` or `awaiting_payment_choice` with no obligation/card-bill/mark-paid data → `plain`, `installmentCount: 1`; `awaiting_payment_choice` leaves both `accountId` and `creditCardId` empty.
  - `obligationDraft`, `cardBillDraft`, `awaiting_mark_paid_choice`, or any other status → `unsupported_intent`.
  - `cancelled` → `non_financial`.
  - `candidates` come from `state.categoryCandidates` (top 3); when absent and a category was suggested, the single suggestion is the only candidate. `explanation` = `draft.categoryExplanation ?? ""`.
  - `needsReview` is `false` on today's main (no conflict signal yet); when `true`, `categoryId` and `subcategoryId` are omitted.
- Every returned id (category, subcategory, account, card, responsible) is checked against the deps' catalog / active lists; an unknown id is dropped (and a candidate with an unknown category is dropped).
- `kind: "income"` drafts never carry an expense `categoryId` (Telegram's catalog is expense-only).
- Rate limit: the 21st call for a household within 60 s → 429; a 3rd concurrent call → 429; the slot is released when the handler finishes or throws; another household is unaffected.
- `buildCaptureDeps` or `startConversation` throwing → 503 `unavailable`; the error is logged with `requestId`, never returned.
- A memory hit wins over Jev, and Jev unavailable falls back to GPT — asserted through a fake `suggestCategory` in deps, proving the handler passes the runtime's categorizer through rather than re-implementing it.
- `server.ts` routes the path with a 256 KB body cap through Task 4's verification.

**Verify:**
- Run: `pnpm --filter @family-finance/bot test` (all suites, including every `conversation-*.test.ts`, unchanged) and the release gate.
- `git diff main -- apps/bot/src/conversation.ts` is empty.

### Task 6: Bot `capture-transcribe`

**Files:**
- Modify: `apps/bot/src/audio.ts`, `apps/bot/src/capture.ts`, `apps/bot/src/server.ts`, `apps/bot/src/index.ts`
- Test: `apps/bot/src/audio.test.ts`, `apps/bot/src/capture.test.ts`

**Interfaces:**
- Consumes: `TranscriptionProvider`, `VoiceNoteTooLargeError`, `CaptureRateLimiter` (Task 5).
- Produces:
  ```ts
  export async function transcribeAudioBuffer(bytes: Uint8Array, mimeType: string, deps: { provider: TranscriptionProvider; maxBytes?: number }): Promise<string>;
  export const CAPTURE_TRANSCRIBE_PATH = "/internal/v1/capture-transcribe";
  export function createCaptureTranscribeHandler(deps: { provider: TranscriptionProvider | null; limiter: CaptureRateLimiter; log: (event: string, fields: Record<string, unknown>) => void }): InternalRouteHandler;
  ```
  Request (`.strict()`): `{ version: 1, requestId, scopeKey, actorUserId, mimeType: "audio/webm" | "audio/mp4" | "audio/mpeg" | "audio/ogg", audioBase64 }`. Response: `{ ok: true, text }` (≤ 4000 chars) or the Task 5 error codes.

**Behavior:**
- `transcribeVoiceMessage` and `transcribeAudioBuffer` share one temp-file + provider + `finally rm` step; the temp dir is removed on success, provider error and size error.
- `extensionFor` maps `audio/webm` → `webm` (today it falls to `ogg`), so Whisper sees the right container.
- Decoded audio > 1 MB → 400 `invalid_request` before any temp file is written; bad base64 or mime outside the list → 400.
- `provider` null (no `OPENAI_API_KEY`) → 503 `unavailable`; provider throws → 503, logged.
- Empty transcription → 422 `non_financial`; text longer than 4000 chars is truncated to 4000.
- Uses the same per-household limiter instance as capture-draft.
- `server.ts` routes the path with a 1.5 MB body cap.

**Verify:**
- Run: `pnpm --filter @family-finance/bot test -- audio capture server` and the release gate.

### Task 7: `TransactionFields` + category actions return the id

**Files:**
- Create: `apps/web/components/transaction-fields.tsx`, `apps/web/components/transaction-fields.test.tsx`
- Modify: `apps/web/app/(app)/transactions/new-transaction-form.tsx`, `apps/web/app/(app)/categories/actions.ts` (+ its test)

**Interfaces:**
- Consumes: `PaymentOption`, `CategoryOption`, `SubcategoryOption`, `ResponsibleOption` from `transactions/transactions-table.tsx` (move these types into `transaction-fields.tsx` and re-export if cleaner).
- Produces:
  ```ts
  export type TransactionFieldValues = {
    kind: "expense" | "income";
    amount: string;          // pt-BR reais text, e.g. "85,00"
    description: string;
    occurredOn: string;      // YYYY-MM-DD
    categoryId: string;
    subcategoryId: string;
    payment: string;         // "account:<id>" | "card:<id>" | ""
    purchaseMode: "avista" | "parcelado";
    installmentCount: number;
    responsible: string;     // "household" | member value used today
  };
  export type TransactionFieldKey = keyof TransactionFieldValues;
  export type TransactionFieldOptions = { accounts: PaymentOption[]; cards: PaymentOption[]; categories: CategoryOption[]; subcategories: SubcategoryOption[]; responsibles: ResponsibleOption[] };
  export function TransactionFields(props: {
    values: TransactionFieldValues;
    onChange: <K extends TransactionFieldKey>(key: K, value: TransactionFieldValues[K]) => void;
    options: TransactionFieldOptions;
    aiFilled?: ReadonlySet<TransactionFieldKey>;
    categoryHighlight?: "warn";
    categoryAction?: React.ReactNode;  // rendered right of the Categoria label
  }): JSX.Element;
  export function emptyTransactionFieldValues(options: TransactionFieldOptions, today: string): TransactionFieldValues;
  export function validateTransactionFields(values: TransactionFieldValues): string | null; // today's pt-BR pre-check messages
  export function toTransactionFormData(values: TransactionFieldValues): FormData;
  ```
  `createCategoryAction` / `createSubcategoryAction` return `{ ok: true; message: string; id: string } | { ok: false; message: string }` (keep today's failure shape).

**Behavior:**
- `toTransactionFormData` produces the exact keys and values `new-transaction-form` posts today, including `purchaseMode = "avista"` for anything that is not a card expense (snapshot test written against the current form **before** the extraction).
- Changing `kind` filters categories and hides cards from Conta / cartão for income; changing the category to one without the current subcategory clears `subcategoryId`; switching payment away from a card resets `purchaseMode` to `avista` — via `onChange` calls the test observes.
- Subcategoria shows only when the chosen category has subcategories; Forma shows only for a card expense; Parcelas only when Forma is Parcelado (min 2, max 48).
- A key in `aiFilled` renders the "IA" pill in its label and the tinted/accent field style; others render plain. `categoryHighlight="warn"` gives the Categoria control the `--warn` border.
- Look and order per decision `fields-look` and the Design reference. `new-transaction-form` keeps its dialog, buttons, validation messages and toasts; only the field block changes.
- `createCategoryAction` called twice with the same name in one household returns the same `id` (create-or-restore); the categories page ignores `id`.

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- transaction-fields new-transaction categories` and the release gate; `pnpm --filter @family-finance/web test:e2e:local -- manual-transaction-installments` stays green.
- Manual: `/transactions` → "+ Lançamento" in the browser pane, Esmeralda and Sálvia, 390 px and 1440 px.

### Task 8: Capture server actions

**Files:**
- Create: `apps/web/app/(app)/capture/actions.ts`, `apps/web/app/(app)/capture/actions.test.ts`, `apps/web/lib/capture-copy.ts`
- Modify: `apps/web/next.config.mjs`

**Interfaces:**
- Consumes: `postToBot` (Task 3); bot contracts (Tasks 5, 6); `TransactionFieldOptions` (Task 7); the import actions' household helper (`findHouseholdIdForCurrentUser` or `currentHousehold`) and the loaders `/transactions` uses for its options.
- Produces:
  ```ts
  export type CaptureDraft = { /* the bot's draft object, Task 5 */ };
  export type CaptureMessage = { text: string; tone: "muted" | "warn" | "neg" | "accent"; href?: string };
  export async function suggestCaptureDraftAction(text: string): Promise<{ ok: true; intent: "plain" | "card_installment"; draft: CaptureDraft } | { ok: false; message: CaptureMessage }>;
  export async function transcribeCaptureAudioAction(formData: FormData): Promise<{ ok: true; text: string } | { ok: false; message: CaptureMessage }>; // fields: audio (Blob), mimeType
  export async function loadCaptureOptionsAction(): Promise<{ options: TransactionFieldOptions; today: string; defaultResponsible: string }>;
  // lib/capture-copy.ts
  export function captureMessage(code: "unavailable" | "rate_limited" | "non_financial" | "unsupported_intent" | "transcribe_failed" | "mic_denied"): CaptureMessage;
  ```

**Behavior:**
- Each action resolves the active household of the signed-in user first; no membership → `unavailable` copy, and no bot call.
- The request body carries `version: 1`, a fresh `requestId`, `scopeKey` = that household id, `actorUserId` = the user id, `today` = `currentHouseholdDate()`.
- Code → copy (verbatim from the spec): `unavailable`, `not_configured`, `unreachable`, `timeout`, any 5xx or unknown body → "IA indisponível — preencha manualmente" (muted); `rate_limited` → "Muitas tentativas — aguarde um minuto" (warn); `non_financial` → "Não entendi como lançamento" (warn); `unsupported_intent` → "Isso parece uma obrigação — use Obrigações" (accent, `href: "/obligations"`); any transcribe failure, including `invalid_request` for audio → "Não consegui transcrever — tente de novo ou digite" (neg); `mic_denied` → "Permita o microfone nas configurações" (warn).
- The draft is re-validated with zod on the web side; a malformed bot body → `unavailable`.
- Audio over 1 MB or a mime type outside the four allowed → transcribe-failed copy, no bot call.
- Raw bot errors are logged server-side and never returned to the client.
- `next.config.mjs` sets `experimental.serverActions.bodySizeLimit = "2mb"`.

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- capture` and the release gate.

### Task 9: Capture sheet, `/capture`, AppShell entry, draft, inline category

**Files:**
- Create: `apps/web/components/capture/capture-sheet.tsx`, `apps/web/components/capture/use-capture-draft.ts`, `apps/web/components/capture/use-capture-draft.test.ts`, `apps/web/components/capture/capture-sheet.test.tsx`, `apps/web/app/(app)/capture/page.tsx`
- Modify: `apps/web/components/ui/app-shell.tsx`, `apps/web/components/ui/ui.css`

**Interfaces:**
- Consumes: Task 7 (`TransactionFields` and helpers, category actions with `id`), Task 8 actions and `captureMessage`, `createManualTransactionAction`, `useToast`.
- Produces:
  ```ts
  export function CaptureSheet(props: { open: boolean; onClose: () => void; variant: "sheet" | "page"; voice?: React.ReactNode }): JSX.Element | null;
  export function useCaptureDraft(): {
    text: string; setText(t: string): void;
    values: TransactionFieldValues; setField<K extends TransactionFieldKey>(k: K, v: TransactionFieldValues[K]): void;
    aiFilled: ReadonlySet<TransactionFieldKey>;
    applyDraft(draft: CaptureDraft, options: TransactionFieldOptions): void;
    result: { explanation: string; candidates: Array<{ categoryId: string; subcategoryId?: string; name: string }>; needsReview: boolean } | null;
    discard(): void; // clears state and storage
  };
  ```
  `voice` is the slot Task 10 fills with `<VoiceButton …/>`; until then the AI box shows no mic.

**Behavior:**
- `applyDraft` fills only keys the user has not edited since the sheet opened (or since the last `discard`), and marks exactly those as `aiFilled`; `setField` on a key removes its AI mark and protects it from later fills.
- Draft → values: `amountCents` → `centsToInputValue`; `accountId` → `account:<id>`, `creditCardId` → `card:<id>`; `card_installment` → `purchaseMode: "parcelado"` + `installmentCount`; `responsibleUserId` → the matching responsible value; `needsReview` → category stays empty and `categoryHighlight="warn"` until one is picked.
- Picking a chip sets `categoryId` (and `subcategoryId` when the candidate has one) as a user edit.
- Text and values persist to `localStorage["ff-capture-draft"]` on every change and restore on open; read/write wrapped in try/catch; a corrupt value is ignored. A successful save and "Cancelar" clear it; ×, Esc and backdrop close but keep it.
- Preencher: disabled when the text is empty, a fill is running, or offline; Enter in the textarea triggers it (Shift+Enter inserts a newline). While running the button reads "Preenchendo…", the fields stay editable, and a second fill cannot start. A fill result that arrives after the sheet closed is dropped.
- Error results show the message banner with the copy's tone; typing in the textarea clears a `non_financial` banner; × dismisses.
- Offline (`navigator.onLine` + `online`/`offline` events): banner "Sem conexão — seu rascunho está salvo", Preencher disabled. A save that throws (network) keeps the sheet open and shows the same banner.
- "+ Nova categoria" swaps the select for input + "Criar"; Criar (or Enter) calls `createCategoryAction` with the current `kind`, appends `{ id, name }` to the local options, selects it as a user edit, and returns to the select; a failure shows the action's message under the field.
- Salvar: disabled until `amount` is non-empty and while saving; runs `validateTransactionFields`, then `createManualTransactionAction(toTransactionFormData(values))`; success → close, `discard()`, toast "Lançamento salvo", `router.refresh()`; failure → message under the form, sheet stays open.
- Options load with `loadCaptureOptionsAction()` the first time the sheet opens in a page session (fields show the existing skeleton until then) and are reused after.
- AppShell: mobile bottom bar becomes Resumo · Transações · + · Cartões · Mais (the + button `aria-label="Novo lançamento"` opens the sheet); desktop sidebar gets the "Novo lançamento" button above the nav; the "Mais" sheet keeps every link that leaves the bar.
- `/capture` renders the same content with `variant="page"`; closing it navigates to `/`.
- Visuals per the Design reference; the sheet traps focus and restores it to the opener on close.

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- capture` and the release gate.
- Manual (browser pane, local dev with the bot stubbed or running): 390×844 and 1440×900, Esmeralda and Sálvia — empty, filling, filled with IA marks, conflict (stubbed `needsReview`), each banner, offline (DevTools offline), saved toast. Screenshots attached to the task report.

### Task 10: Voice button

**Files:**
- Create: `apps/web/components/capture/voice-button.tsx`, `apps/web/components/capture/voice-button.test.tsx`
- Modify: `apps/web/components/capture/capture-sheet.tsx` (fill the `voice` slot)

**Interfaces:**
- Consumes: `transcribeCaptureAudioAction`, `captureMessage` (Task 8); the sheet's fill function.
- Produces:
  ```ts
  export function VoiceButton(props: { disabled: boolean; onPhase(phase: "idle" | "recording" | "transcribing"): void; onText(text: string): void; onError(message: CaptureMessage): void }): JSX.Element;
  ```

**Behavior:**
- Tap "Gravar" → `getUserMedia({ audio: true })` → MediaRecorder with the first supported of `audio/mp4`, `audio/webm`; timer `0:SS / 1:00`; tap "Parar" or reach 60 s → stop.
- Permission denied → `mic_denied` message; no MediaRecorder support → the button is not rendered.
- After stop: "Transcrevendo…"; send the blob with its base mime type (parameters such as `;codecs=opus` stripped); on success `onText(text)` sets the textarea and the sheet runs Preencher automatically; on failure → transcribe-failed message and the textarea keeps what it had.
- A recording over 1 MB is not sent (transcribe-failed message).
- Closing the sheet while recording stops the recorder, releases the mic tracks, and sends nothing.
- Disabled while offline or while a fill is running.

**Verify:**
- Run: `pnpm --filter @family-finance/web test -- voice-button` and the release gate.
- Manual (owner): installed app on iPhone (Safari, `audio/mp4`) and Android Chrome (`audio/webm`): record "85 no mercado no nubank" → fields fill.

### Task 11: E2E + deploy docs

**Files:**
- Create: `apps/web/e2e/quick-capture.spec.ts` (+ a bot stub the harness can start)
- Modify: `deploy/README.md`, `deploy/vercel.md`

**Interfaces:**
- Consumes: the multi-tenant local E2E harness (`test:e2e:local`), Tasks 8–9.

**Behavior:**
- With a stub bot answering `capture-draft` for the signed request: member of household A taps + → types "85 no mercado no nubank" → Preencher → fields show the IA marks → changes the category → Salvar → toast "Lançamento salvo" → the transaction appears in `/transactions` for household A and not for household B.
- The stub verifies the signature with the real bot verifier (imported), so the E2E fails if signing drifts.
- `deploy/README.md` documents both capture routes, their body caps, the shared rate limit, and that they reuse `IMPORT_SUGGESTION_SHARED_SECRET`; `deploy/vercel.md` notes the 2 MB server-action body limit and that no new Vercel env is needed.

**Verify:**
- Run: `pnpm --filter @family-finance/web test:e2e:local -- quick-capture` and the full release gate plus `pnpm build`.

## Order and parallelism

Tracks: **A** 1 → 2 (Task 1's manual iOS check gates everything after it only if it fails). **B** 3. **C** 4 → 5 → 6. **D** 7. Then 8 (needs 3, 5, 6, 7) → 9 → 10 → 11.

## Agent roster

| Task | Model + effort | Why |
|---|---|---|
| 1 Installable shell | Sonnet 5.5 | Mechanical: manifest, icon generation, metadata to a fixed spec |
| 2 Theme color + safe areas | Sonnet 5.5 | Small, decided, testable |
| 3 bot-client | Sonnet 5.5 | Move + generalize with a byte-identical fixture as the done-check |
| 4 Bot signed-route verification | GPT-6.1 Sol via Codex, high | Security-path refactor; must keep every status code |
| 5 Bot capture-draft | GPT-6.1 Sol via Codex, high | Multi-file, the state mapper is the subtle part |
| 6 Bot capture-transcribe | GPT-6.1 Sol via Codex, high | Size/temp-file guarantees; same files as 5, so sequential |
| 7 TransactionFields | Opus 5.5 | UI extraction plus design look; taste + FormData parity |
| 8 Capture actions | Sonnet 5.5 | Contracts and copy table fully decided |
| 9 Capture sheet | Opus 5.5 | Main UI surface; taste-critical |
| 10 Voice button | Opus 5.5 | UX states around browser APIs |
| 11 E2E + docs | GPT-6.1 Sol via Codex, high | Harness work, multi-file |
| Visual check after 9 and 10 | GPT-6 Astra via `codex-computer-use` | Screens vs the design file, both themes, both sizes |
| Final review | Fable 5.1 (primary) + GPT-6 Astra via `codex-review` | Per routing rules |

High-tier concurrency stays ≤ 2 (Opus tasks 7 and 9/10 are sequential anyway).

## Self-review

- **Spec coverage:** installable app (1, 2); AI capture (5, 8, 9); voice (6, 10); inline category (7, 9); signed channel and membership (3, 4); rate limit (5, 6); body limit (8); copy (8, 9, 10); testing list (bot 4–6, web 3, 7–10, E2E 11); deploy docs (11); Risk 1 (1); Risk 2 is removed by `pipeline-reuse` C; Risk 3 (10).
- **Interfaces:** `InternalRoute`/`InternalRouteHandler` (4) used by 5, 6; `CaptureRateLimiter` (5) used by 6; `postToBot` (3) used by 8; `TransactionFieldValues`, `TransactionFields`, `toTransactionFormData`, `validateTransactionFields` (7) used by 9; `CaptureDraft`, `CaptureMessage`, actions (8) used by 9, 10.
- **Open:** if `pipeline-reuse` comes back A, Task 5 splits into an extraction task (Sol, high) plus the handler, and the Telegram-diff check is replaced by the conversation suites passing unchanged.
