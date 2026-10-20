# Installable web app + quick capture — design

**Status:** design approved section by section by Alvaro on 2026-09-25;
revised 2026-10-20 for today's main (Jev categorization, multi-tenancy,
category creation on the web). Spec pending review.
**Base:** `main` at `0f5a22c` (PR #40 multi-tenancy). The unmerged
`codex/merchant-categorization-evidence` branch is not a prerequisite.
**Replaces:** PR #28 (`codex/mobile-expo-prototype`, React Native/Expo app +
`/api/mobile/v1`). PR #28 was closed on 2026-10-20 with a link to this work;
its branch is kept.

## Problem

We want Casa on our phones with fast transaction entry: type or say
"85 no mercado no nubank" and get a filled form. PR #28 did this as a native
Expo app, which costs a second UI, a parallel mobile API, a session bridge in
every server action, and an app-store/EAS pipeline. The web app is already
responsive (AppShell with mobile bottom nav), so we make it installable and
bring the capture features to it instead.

## Scope

In:
1. Installable web app (manifest, icons, iOS metadata, safe areas).
2. AI quick capture: free text → AI-filled, editable form → save.
3. Voice capture: record → transcribe → same AI flow.
4. Inline category creation from the capture form.

Out (deliberately): cash-flow simulation (later round), offline queue,
service worker, push notifications, install-prompt banner, share-sheet
target, `packages/intake` extraction, any `/api/mobile` surface, capture of
obligations / fatura payments / card-bill flows (Telegram keeps those), and
a general assistant memory (free-form notes the AI remembers about the
household) — that is a separate feature; capture only reads the existing
categorization memory.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Where AI runs | **On the bot (VPS), called by the web over the existing signed channel** | OpenAI and Typesafe (Jev) keys never go to Vercel. `deploy/vercel.md` keeps Vercel to low-power secrets only; a leaked `IMPORT_SUGGESTION_SHARED_SECRET` can only call the bot's internal routes. The signed channel (HMAC, ±60 s timestamp, nonce replay protection, actor membership check) already exists for import suggestions. |
| Catalog source | **Bot loads it as the member** (`memberClient(actorUserId)` under RLS, like Telegram) | Same data path as Telegram, so the shared pipeline needs no adapters; the request stays text-only. Decided 2026-10-20 (option B). |
| Classifier | **Same pipeline as Telegram text messages** | Deterministic parsing/routing → GPT extraction-only classifier (with deadline) → `suggestCategory` (memory/rules → Jev → GPT fallback via `createCategoryRuntime(env)`). Telegram and web categorize the same way; model env stays in one place. |
| Save path | **Existing `createManualTransactionAction`**, unchanged | Already handles card installments, subcategory, and responsible member; one validation path. |
| Form | **One shared field set** extracted from `new-transaction-form.tsx` | The "Novo lançamento" modal and the capture sheet can't drift apart. |
| Inline category | **Existing `createCategoryAction`** (categories page), extended to return the id | It already does create-or-restore by name and maps duplicate-name errors. |
| Offline | **Online only; draft kept on the device** | No sync/duplicate logic. iOS has no Background Sync anyway. |
| Service worker | **None** | Not needed to install; offline is handled by the saved draft. Trade-off: launching the app with no signal at all shows the phone's own "no connection" screen. |
| Audio limits | **≤ 60 s, ≤ 1 MB of raw audio** | iOS AAC at ~64 kbps ≈ 480 KB/min. Requires raising the server-action body limit to 2 MB. |
| Rate limiting | **In-memory limit per household on the bot: 20 capture calls per minute, max 2 at once** | Cost per call is tiny; the import flow's DB budget reservation is built for bulk paid fallback and is overkill here. |

**The catalog** is the household's own lists the AI may choose from when it
fills the form: its categories and subcategories, its accounts, its credit
cards, and its categorization memory (merchant → category rules learned from
past corrections, the `categorization_memory` table). The bot needs these to
turn "85 no mercado no nubank" into *Mercado* + the *Nubank* card; it may
only return ids from this list.

The bot loads the catalog itself, as the member: the web sends only the
text and the signed actor (`actorUserId`, `scopeKey`), and the bot builds
the same catalog, account/card lists and memory store Telegram builds, via
`memberClient(actorUserId)` under RLS. Accepted trade-off: someone holding
the leaked shared secret and a member's user id could get drafts for that
household (category/account ids plus an explanation), not just spend AI
calls. Imports keep sending their catalog; capture differs on purpose.

## Architecture

```
Browser (capture sheet)
  ├─ suggestCaptureDraftAction(text)          ─┐
  ├─ transcribeCaptureAudioAction(formData)    ├─ web server actions: authorize member →
  ├─ createCategoryAction(formData)            │  sign (text + actor) → POST bot     
  └─ createManualTransactionAction(formData)   ┘
Bot (VPS, node:http)
  POST /internal/v1/capture-draft       → shared text pipeline → draft
  POST /internal/v1/capture-transcribe  → Whisper → text
```

### Bot (`apps/bot`)

- `server.ts`: add the two routes. Pull the existing HMAC / timestamp /
  nonce verification **and** the actor membership check
  (`resolveActorHouseholdId(actorUserId) === scopeKey`, else 403; lookup
  failure → 503) out of the import route into one shared function; all three
  routes use it. Body caps: draft 256 KB (the existing internal cap);
  transcribe 1.5 MB.
- New `capture.ts`: `createCaptureDraftHandler` and
  `createCaptureTranscribeHandler`, in the same style as
  `createImportSuggestionHandler` (zod-parse → rate-limit → work →
  `{status, body}`).
- Draft handler: builds the member's catalog with `memberClient(actorUserId)`
  (the same loaders `index.ts` uses for Telegram) and runs the Telegram text
  pipeline on it by calling `startConversation` unchanged with read-only
  deps (every write dep removed, `createTransaction` rejecting,
  `logInteraction` a no-op) and mapping the returned `ConversationState` to
  the draft contract. `startConversation` persists nothing itself; its only
  pre-confirmation writes go through those optional deps. Decided
  2026-10-20 in the implementation plan (decision `pipeline-reuse`, option C);
  this replaces the earlier extraction plan, so `conversation.ts` is not
  edited.

- Category runtime: the handler gets `categorizer` from the same
  `createCategoryRuntime(env)` instance `index.ts` builds, and the
  classifier from the same `withClassifierDeadline(...)` wiring. No new env.
- Categorization memory: the same DB-backed memory store Telegram uses,
  opened with the member client.
- Transcribe handler: reuses `audio.ts`. Add a buffer entry point next to
  `transcribeVoiceMessage`, which today takes a Telegram file ref; both share
  the temp-file + Whisper step. No `OPENAI_API_KEY` → 503.
- Latency: worst case is classifier deadline + Jev (2.5 s) + GPT fallback
  (4 s). The web shows a loading state on Preencher for the whole call (see
  UI).

### Contracts (closed schemas; `.strict()`)

Both requests carry the existing signing headers and
`version: 1, requestId: uuid, scopeKey: uuid (householdId), actorUserId: uuid`.
The bot rejects any request whose actor is not an active member of
`scopeKey` (403), same as imports v2.

**`capture-draft` request:**
```
today: "YYYY-MM-DD"
text: string, 1–500 chars, trimmed
```

**`capture-draft` response (200):**
```
{ ok: true,
  intent: "plain" | "card_installment",
  draft: {
    description: string, amountCents?: int>0, date: "YYYY-MM-DD",
    kind: "expense" | "income",
    categoryId?, subcategoryId?, accountId?, creditCardId?,
    installmentCount: int ≥1,
    candidates: [{ categoryId, subcategoryId?, explanation }]  // ≤3
    explanation: string,
    needsReview: boolean   // true → categoryId omitted, user must pick
  } }
```
Every returned id must belong to the member's household catalog; the
handler drops any that don't. `needsReview` is `false` on today's main; it becomes `true` when
memory reports conflicting rules (after the merchant-evidence branch).

**Errors (all routes):** `{ ok: false, error: code }` where code ∈
`invalid_request` (400), `non_financial` (422), `unsupported_intent` (422),
`rate_limited` (429), `unavailable` (503). Signature and membership failures
keep the import route's 401/403/409/503 behavior.

**`capture-transcribe` request:** `mimeType: "audio/webm" | "audio/mp4" |
"audio/mpeg" | "audio/ogg"`, `audioBase64` (decoded ≤ 1 MB).
**Response:** `{ ok: true, text: string ≤ 4000 }` or the errors above.

### Web (`apps/web`)

- Signing: generalize `imports/suggestion-client.ts` into
  `lib/bot-client.ts` (`signBotRequest`, `postToBot(path, body)`). The import
  flow moves onto it with no behavior change.
- `app/(app)/capture/actions.ts`:
  - `suggestCaptureDraftAction(text) → { ok: true, draft, intent } | { ok: false, error: string }`
  - `transcribeCaptureAudioAction(formData) → { ok: true, text } | { ok: false, error: string }`
  - Each authorizes the active household member first (same helper the
    import actions use), sends the text with the signed actor, and maps error codes to the
    pt-BR copy below. Raw bot/LLM errors are logged on the server, never
    returned.
- `categories/actions.ts`: `createCategoryAction` and
  `createSubcategoryAction` also return the created-or-restored id
  (`{ ok: true, message, id }`). The categories page ignores the new field.
  Create-or-restore by name already makes a retry after a network failure
  safe.
- `next.config`: `experimental.serverActions.bodySizeLimit = "2mb"`.
- Env: none new (reuses `IMPORT_SUGGESTION_URL` +
  `IMPORT_SUGGESTION_SHARED_SECRET`).

### UI

- `components/transaction-fields.tsx`: the field set extracted from
  `transactions/new-transaction-form.tsx`, which now uses it.
- `components/capture/capture-sheet.tsx`: AI box (text + mic + Preencher)
  above `TransactionFields`; a bottom sheet on phones, a modal on desktop.
- `components/capture/voice-button.tsx`: MediaRecorder, tap to start/stop,
  timer, auto-stop at 60 s. After stop it transcribes, then runs Preencher
  automatically.
- `app/(app)/capture/page.tsx`: the same sheet content as a full page
  (Android shortcut target).
- AppShell (`components/ui/app-shell.tsx`): the mobile bottom bar becomes
  Resumo / Transações / **+** / Cartões / Mais, with + in the center; a
  "Novo lançamento" button in the desktop sidebar. Both open the sheet.
- Preencher loading state: the button shows "Preenchendo…" and is disabled;
  the AI box and fields stay editable. A second Preencher while one is
  running is not possible.
- AI fill rules: fill only fields the user hasn't edited; category chips
  switch the category with one tap; the explanation shows in small text
  under the AI box. With `needsReview`, the category stays empty and the
  chips show the candidates.
- Draft: text + fields saved to localStorage (`ff-capture-draft`) as you
  type; cleared after a successful save.
- Save: button disabled while pending; on success close, toast, refresh.

### Installable app

- `app/manifest.ts`: `name`/`short_name` "Casa", `display: "standalone"`,
  `start_url: "/"`, Esmeralda background/theme colors, icons 192, 512 and 512
  maskable, `shortcuts: [{ name: "Novo lançamento", url: "/capture" }]`.
  The manifest is per origin, so it uses the product defaults, not a
  household's theme; relative URLs keep it valid on every allowlisted host.
- Icons generated once from PR #28's `apps/mobile/assets/casa-icon.png`
  (1024 px) and committed as PNGs.
- `app/layout.tsx`: `metadata.appleWebApp = { capable: true, title: "Casa",
  statusBarStyle: "default" }`; `generateViewport()` returns
  `viewportFit: "cover"` and a `themeColor` resolved the same way the root
  layout resolves the theme (household theme for members, `ff-theme`
  cookie otherwise).
- CSS: bottom bar `padding-bottom: env(safe-area-inset-bottom)`, header
  `padding-top: env(safe-area-inset-top)`.

## User-facing copy (pt-BR, verbatim)

| Where | Text |
|---|---|
| AI box placeholder | Ex.: 85 no mercado no nubank |
| AI button (idle / running) | Preencher / Preenchendo… |
| Mic (idle / recording) | Gravar / Parar |
| Transcribing | Transcrevendo… |
| New category option | + Nova categoria |
| Save success toast | Lançamento salvo |
| `needsReview` hint | Há regras conflitantes para este lugar — escolha a categoria |
| `unavailable` / bot unreachable | IA indisponível — preencha manualmente |
| `rate_limited` | Muitas tentativas — aguarde um minuto |
| `non_financial` | Não entendi como lançamento |
| `unsupported_intent` | Isso parece uma obrigação — use Obrigações (link to `/obligations`) |
| Transcription failure / too long | Não consegui transcrever — tente de novo ou digite |
| Mic permission denied | Permita o microfone nas configurações |
| Offline banner | Sem conexão — seu rascunho está salvo |

If the bot returns `unavailable` or can't be reached, nothing is
pre-filled; the user completes the form by hand. (A browser-side
deterministic fallback was considered and dropped: `parseExpenseText` lives
in `apps/bot` and would need a package move just to cover outages.)

## Risks

1. **Google sign-in inside the installed iOS app.** The installed app keeps
   its own cookies, separate from Safari's, and the OAuth hand-back is
   unreliable. **Task 1 checks this on a real iPhone** against a preview
   deploy with the manifest only. On failure, add Supabase email login with
   a 6-digit code typed into the app (a code, not a link, because links open
   Safari). Access stays decided by the household membership row bound to
   the verified email.
2. **State-shape coupling:** capture maps `ConversationState`, so a change
   to that shape on another branch can break the mapper. Capture tests lock
   the mapping; `conversation.ts` itself is not edited.
3. MediaRecorder formats differ: iOS gives `audio/mp4`, Chrome gives
   `audio/webm`. Both are on the allow-list; verify on both.

## Build order

1. iOS login check (manifest + icons + layout metadata only, preview
   deploy). Adds the email-code task if it fails.
2. Installable app: remaining pieces (safe areas, themeColor).
3. `lib/bot-client.ts` extraction; import flow moved onto it
   (refactor, no behavior change).
4. Bot: shared signature + membership check extracted from the import
   route (refactor, no behavior change).
5. Bot: `capture-draft` route + handler (calls `startConversation` with
   read-only deps).
6. Bot: `capture-transcribe` route + audio buffer entry point.
7. Web: `TransactionFields` extraction (refactor, no behavior change);
   category actions return the id.
8. Web: capture actions + capture sheet + `/capture` + AppShell entry
   points + draft storage + inline category.
9. Web: voice button.
10. Deploy docs: `deploy/README.md` (bot routes), `deploy/vercel.md` (body
    limit note).

Steps 3, 4→5→6, 4→7 and 8 are independent tracks; 9 needs 3, 6 and 8; 10
needs 7 and 9.

## Testing

- **Bot (vitest):** both routes: bad signature, stale timestamp, replayed
  nonce, over-size body, actor not a member of `scopeKey` → 403. Draft
  handler: plain expense, card installment, non-financial, obligation →
  `unsupported_intent`, unknown ids dropped, memory hit beats Jev, Jev
  unavailable → GPT fallback, rate limit. Transcribe handler: bad mime type,
  over-size audio, missing key → 503. Existing conversation tests pass
  unchanged and `conversation.ts` has no diff.
- **Web (vitest):** `bot-client` signing matches the bot's verifier (shared
  fixture); error-code → copy mapping; AI fill leaves user-edited fields
  alone; picking a chip applies the category; `needsReview` leaves the
  category empty; `createCategoryAction` called twice with the same name
  returns the same id; draft saved as you type and cleared after save;
  `new-transaction-form` still posts the same FormData after the extraction.
- **E2E (Playwright, bot stubbed, multi-tenant harness):** + → type →
  Preencher → edit category → Salvar → the transaction appears in
  `/transactions` for that household only.
- **Manual on real phones:** iOS login (Risk 1); install on iOS Safari and
  Android Chrome; voice on both; safe areas in installed mode.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`.

