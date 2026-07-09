# Task 08: Bot Audio + AI Fallback

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 8)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (AI Services: "Transcrição de áudio e interpretação de mensagens complexas"; "IA quando houver ambiguidade"; "Confiança baixa pede confirmação")

**Owner:** agent (bot)

**Started:** 2026-06-22

**Completed:** 2026-06-22

> Historical task record. Current state (2026-07-09): the default model is
> `claude-haiku-4-5`; text interpretation runs on every new message when AI is
> configured; provider timeouts and voice size/duration guards are implemented;
> and production telemetry has verified successful Anthropic and Whisper HTTP
> responses. The historical scope and acceptance criteria below describe the
> original Task 08 delivery, not today's complete bot behavior.

## Scope

- Telegram VOICE/AUDIO entry: download to a TEMP path, transcribe behind an
  injectable provider, DELETE the temp file (always), then run the transcription
  through the SAME `startConversation` confirmation flow as text.
- LLM categorization AI fallback: a concrete `AiCategorizer` implementing the
  existing categorization interface, behind an injected completion-client
  interface (package stays PURE).
- Provider-agnostic, lazy, build-safe AI config (`packages/config/src/ai.ts`):
  original default LLM = Anthropic Claude (`claude-opus-4-8`, later changed to
  `claude-haiku-4-5`); transcription = OpenAI.
- Out of scope: direct-save toggle; persisting conversation state; a real
  webhook HTTP entry point; exercising real Telegram/Anthropic/OpenAI round trips.

## Progress

- [x] `packages/config/src/ai.ts` — `getLlmConfig` (Anthropic default, model
      override via `ANTHROPIC_MODEL`), `getTranscriptionConfig` (OpenAI/Whisper),
      original `DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"` (historical; now
      `claude-haiku-4-5`). Lazy, never throws.
      Re-exported from config `index.ts`. `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`
      added to `envSchema` (optional) and documented in `.env.example`.
- [x] `packages/categorization/src/ai.ts` — `createAiCategorizer(client)` returns
      the existing `AiCategorizer` interface; builds a catalog-aware pt-BR prompt,
      parses + zod-validates the JSON reply, clamps confidence, returns
      `AiCategorySuggestion | null`. Provider behind `AiCompletionClient`
      interface; NO SDK import (package stays pure: zod + siblings only).
      Re-exported from categorization `index.ts`.
- [x] `apps/bot/src/audio.ts` — `transcribeVoiceMessage(voice, { downloader,
      provider })` writes bytes to an OS-temp file and DELETES the temp dir in a
      `finally` (even on download/transcribe error). `AudioDownloader` +
      `TranscriptionProvider` interfaces; `createHttpAudioDownloader` (edge).
- [x] `apps/bot/src/providers.ts` (new helper) — edge `AiCompletionClient`
      (Anthropic Messages API) + `TranscriptionProvider` (OpenAI Whisper), both
      `fetch`-based (no new deps), constructed only at server start.
- [x] `apps/bot/src/conversation.ts` — added `BotInputKind` ("text" | "audio"),
      `inputKind` on the draft, `startConversationFromAudio` (transcribe ->
      `startConversation` with `inputKind:"audio"`); audio always sets
      `needsAttention`; `logInteraction` now logs the real input kind.
- [x] `apps/bot/src/telegram.ts` — `parseTelegramVoice` (voice/audio file_id +
      mime_type) added alongside `parseTelegramUpdate`.
- [x] `apps/bot/src/index.ts` — `buildDeps` threads an optional `ai`;
      `handleWebhook` routes voice -> transcribe -> confirmation (rejects audio
      politely when transcription unconfigured); `startBot` builds the AI
      categorizer + transcription deps from config (only when keys present).
- [x] `apps/bot/src/bot.test.ts` + `apps/bot/src/audio.test.ts` +
      `packages/categorization/src/ai.test.ts` (TDD, all MOCKED, no network).

## Acceptance Criteria

- [x] Audio NEVER bypasses confirmation (audio reuses `startConversation`; tests
      assert `awaiting_confirmation` and that nothing is saved on first message).
- [x] Temporary audio handling does not persist raw audio: temp file deleted in
      `finally` (verified on success, on transcribe error, and on download error);
      documented in `audio.ts` header and `.env.example`.
- [x] AI fallback used ONLY when deterministic parsing/categorization is uncertain
      (engine reaches AI only after memory + rules miss; test asserts a
      high-confidence rule does NOT call the AI client).
- [x] Every AI suggestion carries confidence + explanation; novel categories stay
      PENDING (never auto-created) — covered by categorization tests.
- [x] AI result still requires confirmation (low-confidence test asserts
      `requiresConfirmation` / `needsAttention`).

## QA

```txt
Command: pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/categorization test && pnpm typecheck
Result:  bot -> 27 passed (2 files: audio.test.ts 3, bot.test.ts 24);
         categorization -> 22 passed (2 files: ai.test.ts 8, categorization.test.ts 14);
         pnpm typecheck -> 12 successful, 12 total (FULL TURBO). EXIT_CODE=0.
Notes:   Also `pnpm --filter @family-finance/bot build` -> tsc clean (BUILD_EXIT=0).
         No network in tests: Telegram download, transcription provider, AI
         completion client, db, and categorization are all mocked/injected.
```

## Review

### Findings

- None outstanding.

### Final Review State

approved (self-verified)

## Decisions Made During Task

- AI/transcription providers live BEHIND injected interfaces. The pure packages
  (`categorization`, `config`) never import an AI SDK; concrete clients live at
  the bot edge (`apps/bot/src/providers.ts`) and use the global `fetch` (no new
  runtime deps). `categorization/ai.ts` depends only on zod + siblings.
- Original LLM provider = Anthropic Claude, model id `claude-opus-4-8`
  (historical; current default is `claude-haiku-4-5`)
  (overridable via `ANTHROPIC_MODEL`). Transcription reuses `OPENAI_API_KEY`
  (Whisper). All AI keys are OPTIONAL in `envSchema`; absence disables the
  feature gracefully (AI fallback off; voice notes politely rejected).
- Audio is NOT a separate write path: `startConversationFromAudio` transcribes
  then delegates to `startConversation` with `inputKind:"audio"`, so audio always
  yields an editable confirmation. Audio entries set `needsAttention` (imperfect
  transcription) and log `input_kind:"audio"` to `bot_interactions`.
- Raw audio is written ONLY to a unique OS-temp dir and removed in a `finally`
  (download error, transcribe error, success). Nothing audio-related is persisted
  to the DB.
- Any AI failure (client throw, empty/non-JSON reply, missing fields) degrades to
  `null`, so the deterministic path always remains the safe fallback.

## Follow-Ups

### Tech Debt

- Resolved after this task: live provider response parsing, request timeouts,
  and voice size/duration guards are now exercised or implemented.
- Still open: measure semantic correctness and user-correction rate across a
  representative pt-BR evaluation set before choosing the production model.

### Ideas

- Implemented after this task: complex and ordinary text messages now pass
  through the configured interpreter before the confirmation flow.

### Risks Or Blockers

- Same as Task 7: no real Telegram + Supabase webhook round trip exercised here.
  Historical note: real-provider verification happened after this task. See
  `memory/risks-and-blockers.md` for the current quality risk.

## Handoff Notes

- Final integration (Task 11): a voice note becomes a confirmed transaction via
  `startConversationFromAudio`; a complex text triggers the AI categorization
  fallback only when rules/memory miss. Both require confirmation.
- To enable AI/audio locally: set `ANTHROPIC_API_KEY` (+ optional
  `ANTHROPIC_MODEL`), `OPENAI_API_KEY`, and `TELEGRAM_BOT_TOKEN`. With keys
  absent, the bot runs deterministic-only and rejects audio politely.
- Historical note: the standalone HTTP webhook server and production deployment
  were implemented after this task.
