# Task 07: Bot Text Flow

**Status:** done

**Plan reference:** `docs/superpowers/plans/2026-06-22-family-finance-mvp-agent-plan.md` (Task 7)

**Spec reference:** `docs/specs/2026-06-22-family-finance-mvp-spec.html` (Lançamento via Telegram)

**Owner:** agent (bot)

**Started:** 2026-06-22

**Completed:** 2026-06-22

## Scope

- Telegram TEXT entry only: webhook handling, pt-BR expense parsing, a
  confirmation-before-save state machine with corrections, and persistence
  through the SHARED domain + db services (no logic re-implemented in the bot).
- Out of scope: audio + AI fallback (Task 8), direct-save toggle, a generic
  web transactions screen, a Telegram names→user-id mapping table.

## Progress

- [x] `parser.ts` — pure pt-BR parser (value, date hints, card/account hints,
      uncertain-field flags).
- [x] `telegram.ts` — `verifyWebhookSecret` (fail-closed), `parseTelegramUpdate`,
      injectable `TelegramClient` (+ HTTP and no-op impls).
- [x] `conversation.ts` — confirmation state machine: start → editable summary
      → confirm/correct/cancel; persists only on explicit confirm.
- [x] `replies.ts` — pt-BR confirmation / correction / success / cancel messages.
- [x] `index.ts` — wires real db (catalog/accounts/cards/memory), categorization
      `suggestCategory`, `createTransaction`, and `bot_interactions` logging.
- [x] `.env.example` — documented `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`.
- [x] `bot.test.ts` (TDD, 19 tests) — mocks Telegram + db + categorization.

## Acceptance Criteria

- [x] A text message can become a confirmed transaction.
- [x] The saved transaction records `createdByUserId` (linked Telegram identity).
- [x] Responsibility defaults to the house unless a responsible person is given.
- [x] Confirmation is required before any save (spec default).
- [x] Corrections for value, date, category, and responsible person update the
      draft in place before saving.

## QA

```txt
Command: pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck && pnpm typecheck
Result:  bot test -> 19 passed (1 file); bot typecheck -> clean;
         pnpm typecheck -> 12 successful, 12 total (>>> FULL TURBO). EXIT_CODE=0.
Notes:   Also confirmed `pnpm --filter @family-finance/bot build` -> tsc clean.
         No network in tests: Telegram client, db, and categorization are mocked.
```

## Review

### Findings

- None outstanding.

### Final Review State

approved (self-verified)

## Decisions Made During Task

- The bot is a THIN consumer: domain `createTransactionDraft` builds the draft,
  `@family-finance/db createTransaction` persists, `@family-finance/categorization
  suggestCategory` suggests — exactly the web app's services. No rules duplicated.
- Confirmation ON by default. State machine: `awaiting_confirmation` |
  `needs_amount` | `saved` | `cancelled`. A message without a value goes to
  `needs_amount` and cannot be confirmed until a value is supplied.
- Webhook secret verification FAILS CLOSED: unset secret rejects all requests.
- `bot_interactions` is written via a direct client insert inside the injected
  `logInteraction` dep (no dedicated db repo existed; kept the boundary by
  injecting it through `ConversationDeps`).
- Conversation state is an in-memory per-chat `Map` in `index.ts` for the MVP.

## Follow-Ups

### Tech Debt

- In-memory conversation store (per-chat `Map`) does not survive a restart and is
  not multi-instance safe. Revisit if the bot is deployed serverless/multi-replica
  (persist conversation state, e.g. a `bot_conversations` table or Redis).
- No dedicated `createBotInteraction` repo in `packages/db`; the bot inserts into
  `bot_interactions` directly via the injected client. Consider adding a repo for
  consistency with other write paths.
- `resolveResponsibleUserId` returns `undefined` in production wiring (no
  display-name → member-id mapping yet), so "responsável <nome>" corrections are
  no-ops live (they ARE exercised in tests via an injected resolver). Wire a
  household-members name map when member display names exist.
- Parser is deterministic-only; ambiguous/complex messages need Task 8 AI fallback.

### Ideas

- A direct-save toggle (spec: configurable later) once the command contract is stable.

### Risks Or Blockers

- Webhook/route handler not exercised against a real Telegram + Supabase round
  trip (no network/secrets here). `handleWebhook` is structured to be wrapped by a
  Next.js route or a small server; `startBot()` assembles the production wiring.

## Handoff Notes

- Task 8 extends `conversation.ts`/`bot.test.ts`: add `input_kind` audio path and
  AI fallback. The conversation already threads `confidence`/`explanation` into
  `logInteraction`; audio should reuse `startConversation`/`applyMessage` after
  transcription so audio never bypasses confirmation.
- Reuse `ConversationDeps` injection for new I/O; keep the bot free of domain rules.
