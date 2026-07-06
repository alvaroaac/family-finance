# Bot inline buttons + category creation — design

**Date:** 2026-07-04 · **Status:** approved by user · **Scope:** apps/bot + packages/categorization (+ packages/db repo reuse)

## Problem

Three gaps, one root: the bot is text-command-only.

1. When categorization finds no fit (e.g. "Petz"), the AI may propose a new
   category, but the bot has no path to act on it — the expense lands as
   "Sem categoria (a definir)" and the proposal dies.
2. Categories can only be created in the web /settings page; correcting a
   category in the bot means typing `categoria X` and hoping the name matches.
3. Every answer is typed + regex-parsed ("confirmar", "categoria Alimentação") —
   error-prone and slow on a phone.

The bot is **Telegram** (not WhatsApp), which has native inline keyboards —
tap-to-answer buttons attached to a message. That's the mechanism for all three.

## Decisions (user's picks)

- **New-category proposal:** bot asks, one tap creates it (active immediately)
  and assigns the expense. No web-approval queue, no silent auto-create.
- **Manual creation:** both a typed command (`nova categoria Pets`) and a
  `[➕ Nova categoria]` button at the end of the category-pick grid.
- **Button scope:** confirm/cancel, category pick, responsável pick,
  new-category proposal. `valor`/`data` stay typed (free-form input).
  All existing typed commands keep working — buttons are additive.
- **Subcategories:** stay web-managed. Bot flows are category-level only.
- **Architecture:** first-class callback events (approach B) — structured
  callback tokens, not text-spoofing into the existing regex parser; no
  framework migration (grammY/Telegraf rejected, codebase stays dependency-light).

## 1. Telegram transport: callbacks + keyboards

`apps/bot/src/telegram.ts` gains:

- **Parse `callback_query` updates** alongside text messages: extract
  `callback_query.id`, `from`, `message.chat.id`, `message.message_id`, `data`.
  The webhook registration (`setWebhook`) must list `allowed_updates:
  ["message", "callback_query"]` — verify this on `startBot`.
- **`sendMessage` with optional `reply_markup`** (`inline_keyboard`).
- **`answerCallbackQuery(id, text?)`** — always called, stops the client spinner;
  the optional text shows a toast (used for "Sessão expirada" etc.).
- **`editMessageReplyMarkup(chatId, messageId)`** — strips the keyboard from a
  message after it's been acted on, so stale buttons can't fire twice.

**Callback data tokens** (Telegram caps `data` at 64 bytes — never embed
user-typed names):

| Token | Meaning |
|---|---|
| `cf` / `cx` | confirm / cancel draft |
| `cats` | show category-pick grid |
| `ct:<uuid>` | assign existing category |
| `nc` | start manual new-category flow (asks for name) |
| `nca` | accept AI-proposed category (name lives in conversation state) |
| `nocat` | drop the AI proposal, keep draft uncategorized (back to plain confirmation) |
| `resp` | show responsável grid |
| `rs:<uuid>` / `rs:house` | assign responsável |

## 2. Conversation state machine

`apps/bot/src/conversation.ts`:

- New `applyCallback(state, token)` sibling of `applyMessage` — both funnel into
  the same internal transition functions (confirm, cancel, set category, set
  responsável), so typed and tapped paths can't drift.
- New status **`awaiting_category_name`**: entered by the `nc` button (or typed
  `nova categoria` with no name). The next text message is taken as the category
  name; `cancelar` (typed or ❌ button) returns to `awaiting_confirmation`.
- Conversation state gains `proposedCategoryName?: string` (from the categorizer,
  see §3) and `promptMessageId?: number` (the message whose keyboard to strip).

**Keyboards per state:**

- `awaiting_confirmation`, no proposal:
  `[✅ Confirmar] [❌ Cancelar]` / `[📂 Categoria] [👤 Responsável]`
- `awaiting_confirmation`, AI proposed "Pets":
  `[✅ Confirmar (cria "Pets")] [📂 Outra categoria]` / `[🚫 Sem categoria] [❌ Cancelar]`
- Category grid (on `cats` or `📂`): active categories, 2 per row, alphabetical,
  ending with `[➕ Nova categoria]`. No pagination — household scale (tens, not
  hundreds); revisit if it ever overflows Telegram's 100-button cap.
- Responsável grid: `[🏠 Casa]` + one button per active member.

Picking from a grid edits the draft and re-sends the confirmation summary with
the standard keyboard (same behavior as today's typed corrections).

## 3. AI new-category proposal (the "Petz" case)

`packages/categorization` already returns a `pending_new_category`-style result
with a proposed name that the bot currently drops on the floor. Now:

- Engine result carries `proposedCategoryName` + explanation to the bot.
- Confirmation summary shows: `Categoria: "Pets" (nova — sugerida)` + the
  existing "Sugestão: …" explanation line, with the proposal keyboard above.
- **`✅ Confirmar (cria "Pets")` / `nca`:** create the category
  (`is_active = true`) via the existing db repo used by web /settings, assign it
  to the draft, persist the transaction, and **seed `categorization_memory`**
  (pattern = the interpreter's normalized merchant token, e.g. `petz`;
  confidence 0.95; explanation "criada pelo usuário via bot em 2026-07-04") so
  the next Petz charge resolves from memory instantly.
- Dedupe before insert: case/accent-insensitive match against existing
  categories. If an **active** one matches, assign it instead (no dupe); if an
  **inactive** one matches, reactivate and assign.

Memory seeding happens ONLY in this new-category path. Regular corrections
(typed or button) keep today's semantics — no silent memory writes.

## 4. Manual category creation

- **Typed:** `nova categoria Pets`. With an active draft → create + assign +
  re-show confirmation. With no active conversation → create and reply
  `Categoria "Pets" criada ✅`. Same dedupe/reactivation rules as §3.
- **Button:** `[➕ Nova categoria]` in the grid → `awaiting_category_name` →
  user types the name → create + assign + confirmation.
- **Validation:** trimmed, non-empty, ≤ 40 chars, pt-BR error messages.

## 5. Error handling / edge cases

- **Stale callback** (draft expired past the 24h TTL, already saved, or state
  doesn't match the token): `answerCallbackQuery` with "Sessão expirada — envie
  o gasto novamente." and strip that message's keyboard. Never crash on unknown
  tokens — answer + ignore.
- **Double-tap race on ✅:** first tap strips the keyboard; if a second slips
  through, the state is already `saved` → answer "Já salvo ✅", no double insert.
- **Category name is a command word** ("confirmar" as a name while in
  `awaiting_category_name`): name-mode wins — anything except `cancelar` is a
  name. Keeps the state machine unambiguous.
- **Keyboard send failure:** message text always contains the typed-command
  hints (today's format), so a keyboard-less message still works — buttons are
  progressive enhancement.

## 6. Testing (TDD)

- **telegram.ts unit:** callback_query parsing (well-formed, missing fields),
  keyboard payload shape, answerCallbackQuery/editMessageReplyMarkup calls.
- **conversation unit:** every token through `applyCallback` (confirm, cancel,
  ct, nca, nocat, rs, nc → name → create); typed/tapped parity (same transition,
  same result); stale-state tokens; `awaiting_category_name` including
  "cancelar" and command-word names.
- **categorization unit:** proposal surfaced to the caller; memory seed row
  shape (pattern, confidence, explanation).
- **integration (fake store + fake telegram):** full Petz flow — text in →
  proposal keyboard out → `nca` tap → category created, transaction saved,
  memory seeded → same merchant again resolves from memory. Dedupe: propose
  "pets" when "Pets" exists → assigned, not duplicated.
- Full gate: typecheck, all tests, lint, build.

## Out of scope

Subcategories in bot flows, category rename/deactivate via bot, buttons for
valor/data, memory seeding on regular corrections, web app changes, grid
pagination, WhatsApp anything (bot is Telegram), framework migration.
