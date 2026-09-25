# Installable web app + quick capture — design

**Status:** design approved section by section by Alvaro on 2026-09-25; spec
pending review.
**Replaces:** PR #28 (`codex/mobile-expo-prototype`, React Native/Expo app +
`/api/mobile/v1`). PR #28 is closed with a link to this work; its branch is
kept.

## Problem

We want Casa on our phones with fast transaction entry: type or say
"85 no mercado no nubank" and get a filled form. PR #28 did this as a native
Expo app, which costs a second UI, a parallel mobile API, a session bridge in
every server action, and an app-store/EAS pipeline — for two users. The web
app is already responsive (AppShell with mobile bottom nav), so we make it
installable and bring the capture features to it instead.

## Scope

In:
1. Installable web app (manifest, icons, iOS metadata, safe areas).
2. AI quick capture: free text → AI-filled, editable form → save.
3. Voice capture: record → transcribe → same AI flow.
4. Inline category creation from the capture form.

Out (deliberately): cash-flow simulation (later round), offline queue,
service worker, push notifications, install-prompt banner, share-sheet
target, `packages/intake` extraction, any `/api/mobile` surface.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Where AI runs | **On the bot (VPS), called by the web over the existing signed channel** | OpenAI/Anthropic keys never go to Vercel. `deploy/vercel.md` keeps Vercel to low-power secrets only; a leaked `IMPORT_SUGGESTION_SHARED_SECRET` can only call the bot's suggestion routes. The signed channel (HMAC, ±60 s timestamp, nonce replay protection) already exists for import suggestions. |
| Catalog source | **Web sends it in the request** (same as imports) | The web reads it under RLS for the logged-in user; the bot never loads household data based on a caller-supplied scope. |
| Classifier | **Same pipeline as Telegram text messages** (classifier with deadline + fallback, then `suggestCategory` with memory) | Telegram and web categorize the same way; model env (`OPENAI_MODEL`, `OPENAI_FALLBACK_MODEL`, Anthropic last resort) stays in one place. |
| Save path | **Existing `createManualTransactionAction`**, unchanged | Already handles card installments, subcategory, and responsible member; one validation path. |
| Form | **One shared field set** extracted from `new-transaction-form.tsx` | The "Novo lançamento" modal and the capture sheet can't drift apart. |
| Offline | **Online only; draft kept on the device** | No sync/duplicate logic. iOS has no Background Sync anyway. |
| Service worker | **None** | Not needed to install; offline is handled by the saved draft. Trade-off: launching the app with no signal at all shows the phone's own "no connection" screen. |
| Audio limits | **≤ 60 s, ≤ 1 MB of raw audio** | iOS AAC at ~64 kbps ≈ 480 KB/min. Requires raising the server-action body limit to 2 MB. |
| Rate limiting | **In-memory limit per household on the bot: 20 capture calls per minute, max 2 at once** | Cost per call is tiny; the import flow's DB budget reservation is built for bulk paid fallback and is overkill here. (Part 4 of the design said "Limite de IA atingido hoje"; replaced by the per-minute message below.) |

## Architecture

```
Browser (capture sheet)
  ├─ suggestCaptureDraftAction(text)          ─┐
  ├─ transcribeCaptureAudioAction(formData)    ├─ web server actions: requireAuthorizedUser →
  └─ createManualTransactionAction(formData)   │  load catalog (RLS) → sign → POST bot
                                               ┘
Bot (VPS, node:http)
  POST /internal/v1/capture-draft       → classifier + suggestCategory → draft
  POST /internal/v1/capture-transcribe  → Whisper → text
```

### Bot (`apps/bot`)

- `server.ts`: add the two routes. Pull the existing HMAC/timestamp/nonce
  verification out of the import route into one shared function; all three
  routes use it. Body caps: draft 256 KB (the existing internal cap);
  transcribe 1.5 MB.
- New `capture.ts`: `createCaptureDraftHandler` and
  `createCaptureTranscribeHandler`, in the same style as
  `createImportSuggestionHandler` (zod-parse → rate-limit → work →
  `{status, body}`).
- Draft handler: runs the same classifier plus `suggestCategory` composition
  the Telegram text path uses (wired in `index.ts`), against the catalog in
  the request instead of a DB lookup. Account/card matching reuses the bot's
  existing matching.
- Transcribe handler: reuses `audio.ts`. Add a buffer entry point next to
  `transcribeVoiceMessage`, which today takes a Telegram file ref; both share
  the temp-file + Whisper step. No `OPENAI_API_KEY` → 503.
- **Dependency:** the main checkout has uncommitted bot work touching
  `codex.ts`, `providers.ts`, `index.ts` (branch
  `codex/drop-legacy-obligation-payment-overload`). Land or rebase over that
  before the bot tasks start.

### Contracts (closed schemas; `.strict()`)

Both requests carry the existing signing headers and
`version: 1, requestId: uuid, scopeKey: uuid (householdId), actorUserId: uuid`.

**`capture-draft` request:**
```
today: "YYYY-MM-DD"
text: string, 1–500 chars, trimmed
catalog: {
  categories:    [{ id, name, kind: "expense" | "income" }]
  subcategories: [{ id, categoryId, name }]
  accounts:      [{ id, name }]
  creditCards:   [{ id, name }]
  memory:        [{ merchantKey, categoryId, subcategoryId? }]   // active rules only
}
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
    explanation: string
  } }
```
Every returned id must exist in the request catalog; the handler drops any
that don't.

**Errors (all routes):** `{ ok: false, error: code }` where code ∈
`invalid_request` (400), `non_financial` (422), `unsupported_intent` (422),
`rate_limited` (429), `unavailable` (503). Signature failures keep the
existing 401/409 behavior.

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
  - Each checks the user first, loads the catalog under RLS for
    `suggestCaptureDraftAction`, calls the bot, and maps error codes to the pt-BR copy
    below. Raw bot/LLM errors are logged on the server, never returned.
  - `createCaptureCategoryAction(name, kind) → { ok: true, categoryId } | { ok: false, error: string }`:
    new (the web has no create-category action today). Find-or-create by
    normalized name via `createCategory` from `@family-finance/db`, so a
    retry after a network failure never creates a duplicate.
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
- AppShell: a center **+** in the mobile bottom nav; a "Novo lançamento"
  button in the desktop sidebar. Both open the sheet.
- AI fill rules: fill only fields the user hasn't edited; category chips
  switch the category with one tap; the explanation shows in small text
  under the AI box.
- Draft: text + fields saved to localStorage (`ff-capture-draft`) as you
  type; cleared after a successful save.
- Save: button disabled while pending; on success close, toast, refresh.

### Installable app

- `app/manifest.ts`: `name`/`short_name` "Casa", `display: "standalone"`,
  `start_url: "/"`, Esmeralda background/theme colors, icons 192, 512 and 512
  maskable, `shortcuts: [{ name: "Novo lançamento", url: "/capture" }]`.
- Icons generated once from PR #28's `apps/mobile/assets/casa-icon.png`
  (1024 px) and committed as PNGs.
- `app/layout.tsx`: `metadata.appleWebApp = { capable: true, title: "Casa",
  statusBarStyle: "default" }`; `generateViewport()` returns
  `viewportFit: "cover"` and a `themeColor` from the `ff-theme` cookie.
- CSS: bottom nav `padding-bottom: env(safe-area-inset-bottom)`, header
  `padding-top: env(safe-area-inset-top)`.

## User-facing copy (pt-BR, verbatim)

| Where | Text |
|---|---|
| AI box placeholder | Ex.: 85 no mercado no nubank |
| AI button | Preencher |
| Mic (idle / recording) | Gravar / Parar |
| Transcribing | Transcrevendo… |
| New category option | + Nova categoria |
| Save success toast | Lançamento salvo |
| `unavailable` / bot unreachable | IA indisponível — preencha manualmente |
| `rate_limited` | Muitas tentativas — aguarde um minuto |
| `non_financial` | Não entendi como lançamento |
| `unsupported_intent` | Isso parece um compromisso — use Compromissos (link to `/obligations`) |
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
   a 6-digit code typed into the app (still limited by `AUTHORIZED_EMAILS`;
   a code, not a link, because links open Safari).
2. The uncommitted bot work (see Bot → Dependency) conflicts with the bot
   tasks if it isn't landed first.
3. MediaRecorder formats differ: iOS gives `audio/mp4`, Chrome gives
   `audio/webm`. Both are on the allow-list; verify on both.

## Build order

1. iOS login check (manifest + icons + layout metadata only, preview
   deploy). Adds the email-code task if it fails.
2. Installable app: remaining pieces (safe areas, themeColor).
3. `lib/bot-client.ts` extraction; import flow moved onto it
   (refactor, no behavior change).
4. Bot: shared signature check + `capture-draft` route + handler.
5. Bot: `capture-transcribe` route + audio buffer entry point.
6. Web: `TransactionFields` extraction (refactor, no behavior change).
7. Web: capture actions + capture sheet + `/capture` + AppShell entry
   points + draft storage + inline category.
8. Web: voice button.
9. Deploy docs: `deploy/README.md` (bot routes), `deploy/vercel.md` (body
   limit note), then close PR #28.

Steps 3–5 and 6 are independent; 7 needs 3, 4 and 6; 8 needs 5 and 7.

## Testing

- **Bot (vitest):** both routes: bad signature, stale timestamp, replayed
  nonce, over-size body. Draft handler: plain expense, card installment,
  non-financial, obligation → `unsupported_intent`, unknown ids dropped,
  rate limit. Transcribe handler: bad mime type, over-size audio, missing
  key → 503.
- **Web (vitest):** `bot-client` signing matches the bot's verifier (shared
  fixture); error-code → copy mapping; AI fill leaves user-edited fields
  alone; picking a chip applies the category; `createCaptureCategoryAction`
  called twice with the same name returns the same id; draft saved as you type and
  cleared after save; `new-transaction-form` still posts the same FormData
  after the extraction.
- **E2E (Playwright, bot stubbed):** + → type → Preencher → edit category →
  Salvar → the transaction appears in `/transactions`.
- **Manual on real phones:** iOS login (Risk 1); install on iOS Safari and
  Android Chrome; voice on both; safe areas in installed mode.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`.
