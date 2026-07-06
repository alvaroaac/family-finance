# Bot Inline Buttons + Category Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Telegram bot inline-keyboard buttons (confirm/cancel, category pick, responsável pick) and a category-creation path — both the AI "Petz" proposal one-tap accept and manual `nova categoria` — per the approved design at `docs/superpowers/specs/2026-07-04-bot-buttons-and-category-creation-design.md`.

**Architecture:** First-class callback events (approach B): `apps/bot/src/telegram.ts` learns to parse `callback_query` updates and send `reply_markup` keyboards; a new `applyCallback` in `apps/bot/src/conversation.ts` funnels structured tokens into the SAME internal transitions the typed path uses. Category creation is a new `createCategory` repo in `packages/db` plus optional conversation deps wired in `apps/bot/src/index.ts`. No framework migration; no changes to `packages/categorization` (it already returns `pending_new_category` + `pendingCategory` — the bot just stops dropping it).

**Tech Stack:** TypeScript (strict), zod, vitest, pnpm workspaces + turbo, Supabase (service-role client in the bot), plain `node:http` webhook server.

## Global Constraints

- Callback `data` is capped at **64 bytes** by Telegram — tokens only (`cf`, `cx`, `cats`, `ct:<uuid>`, `nc`, `nca`, `nocat`, `resp`, `rs:<uuid>`, `rs:house`); **never embed user-typed names** in callback data. Proposal names live in conversation state.
- All user-facing copy is **pt-BR**.
- Category name validation: **trimmed, non-empty, ≤ 40 chars**, pt-BR error messages.
- Memory seeding happens **ONLY** in the AI new-category proposal accept path (`nca` / typed confirm while a proposal is pending). Regular corrections never write memory.
- All existing typed commands keep working — buttons are additive. Message text keeps today's typed-command hints (progressive enhancement).
- Dedupe before category insert: case- **and accent-**insensitive match. Active match → assign (no dupe); inactive match → reactivate + assign.
- Subcategories stay web-managed; `valor`/`data` stay typed; no grid pagination; no new npm dependencies.
- New `ConversationDeps` members are **optional** (matches the existing `createObligation?` pattern) so existing tests/dep objects keep compiling; flows degrade gracefully when a dep is absent.
- Full gate before finishing: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` from the repo root `/Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance`.
- Branch: `feat/family-finance-mvp` (this worktree). Commit after every task.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/repositories.ts` (modify) | New `createCategory` repo (insert with `is_active: true`) |
| `packages/db/src/index.ts` (modify) | Export `createCategory` |
| `packages/db/src/repositories.test.ts` (modify) | Unit test for `createCategory` |
| `apps/bot/src/telegram.ts` (modify) | `callback_query` parsing, `InlineKeyboardMarkup` types, extended `TelegramClient` (send with keyboard + return `message_id`, `answerCallbackQuery`, `editMessageReplyMarkup`), webhook `allowed_updates` check helper |
| `apps/bot/src/telegram-callbacks.test.ts` (create) | Unit tests for the above |
| `apps/bot/src/keyboards.ts` (create) | Callback token constants + pure keyboard builders |
| `apps/bot/src/keyboards.test.ts` (create) | Keyboard payload-shape tests |
| `apps/bot/src/replies.ts` (modify) | Proposal summary line, ask-name prompt, created/reused messages, toasts, name-validation errors |
| `apps/bot/src/conversation.ts` (modify) | `applyCallback`, `awaiting_category_name` status, proposal state, category create/dedupe transitions, keyboards on outcomes |
| `apps/bot/src/conversation-callbacks.test.ts` (create) | Unit tests: every token, typed/tapped parity, stale states, name flow |
| `apps/bot/src/index.ts` (modify) | Callback routing in `handleWebhook`, new deps in `buildDeps`, `allowed_updates` warning in `startBot` |
| `apps/bot/src/bot.test.ts` (modify) | Extend `fakeTelegram` to the new `TelegramClient` interface (compile fix only) |
| `apps/bot/src/bot-callbacks.test.ts` (create) | Integration: full Petz flow + dedupe through `handleWebhook` |
| `deploy/README.md`, `docs/runbooks/local-mvp-verification.md` (modify) | `setWebhook` curl gains `callback_query` in `allowed_updates` |

---

### Task 1: Telegram transport — callback parsing + extended client

**Files:**
- Modify: `apps/bot/src/telegram.ts`
- Modify: `apps/bot/src/bot.test.ts` (the `fakeTelegram` helper only — keep it compiling)
- Test: `apps/bot/src/telegram-callbacks.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task):

```typescript
export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

export type IncomingCallbackQuery = {
  updateId: number;
  callbackQueryId: string;
  fromId: string;
  fromUsername?: string;
  /** Absent when Telegram omitted the origin message (e.g. too old). */
  chatId?: string;
  messageId?: number;
  /** The raw callback token. Absent for game/url callbacks. */
  data?: string;
};

export function parseTelegramCallback(raw: unknown): IncomingCallbackQuery | null;

export type SendMessageOptions = { replyMarkup?: InlineKeyboardMarkup };

export type TelegramClient = {
  /** Returns the sent message's id when the API provides it (HTTP client does). */
  sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ messageId?: number }>;
  /** ALWAYS called for a callback — stops the client spinner; text shows a toast. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Strip the inline keyboard from a previously sent message. */
  editMessageReplyMarkup(chatId: string, messageId: number): Promise<void>;
};

/** True when the webhook's allowed_updates will never deliver callback_query. */
export function webhookMissesCallbacks(allowedUpdates: string[] | undefined): boolean;

/** GET getWebhookInfo and return its allowed_updates (undefined on any failure). */
export function fetchWebhookAllowedUpdates(botToken: string): Promise<string[] | undefined>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/telegram-callbacks.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  parseTelegramCallback,
  createHttpTelegramClient,
  createNoopTelegramClient,
  webhookMissesCallbacks,
} from "./telegram.js";

function callbackUpdate(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 10,
    callback_query: {
      id: "cbq-1",
      from: { id: 777, username: "alvaro" },
      message: { message_id: 42, chat: { id: 555 } },
      data: "cf",
      ...overrides,
    },
  };
}

describe("parseTelegramCallback", () => {
  it("parses a well-formed callback_query into normalized strings", () => {
    const parsed = parseTelegramCallback(callbackUpdate());
    expect(parsed).toEqual({
      updateId: 10,
      callbackQueryId: "cbq-1",
      fromId: "777",
      fromUsername: "alvaro",
      chatId: "555",
      messageId: 42,
      data: "cf",
    });
  });

  it("returns null for a plain text update", () => {
    expect(
      parseTelegramCallback({
        update_id: 1,
        message: { chat: { id: 1 }, from: { id: 2 }, text: "oi" },
      }),
    ).toBeNull();
  });

  it("still returns the callback id when message/data are missing", () => {
    const parsed = parseTelegramCallback(
      callbackUpdate({ message: undefined, data: undefined }),
    );
    expect(parsed?.callbackQueryId).toBe("cbq-1");
    expect(parsed?.chatId).toBeUndefined();
    expect(parsed?.messageId).toBeUndefined();
    expect(parsed?.data).toBeUndefined();
  });

  it("returns null for garbage", () => {
    expect(parseTelegramCallback("nope")).toBeNull();
    expect(parseTelegramCallback({ update_id: 1 })).toBeNull();
  });
});

describe("createHttpTelegramClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendMessage posts reply_markup and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpTelegramClient("tok");
    const keyboard = { inline_keyboard: [[{ text: "✅", callback_data: "cf" }]] };
    const sent = await client.sendMessage("555", "oi", { replyMarkup: keyboard });

    expect(sent.messageId).toBe(99);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.reply_markup).toEqual(keyboard);
  });

  it("answerCallbackQuery posts the id and optional text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpTelegramClient("tok");
    await client.answerCallbackQuery("cbq-1", "Sessão expirada");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/answerCallbackQuery");
    const body = JSON.parse(String(init.body));
    expect(body.callback_query_id).toBe("cbq-1");
    expect(body.text).toBe("Sessão expirada");
  });

  it("editMessageReplyMarkup posts an EMPTY keyboard to strip buttons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpTelegramClient("tok");
    await client.editMessageReplyMarkup("555", 42);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/editMessageReplyMarkup");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("555");
    expect(body.message_id).toBe(42);
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe("noop client + allowed_updates check", () => {
  it("noop client satisfies the full interface", async () => {
    const client = createNoopTelegramClient();
    await expect(client.sendMessage("1", "x")).resolves.toEqual({});
    await expect(client.answerCallbackQuery("cbq")).resolves.toBeUndefined();
    await expect(client.editMessageReplyMarkup("1", 2)).resolves.toBeUndefined();
  });

  it("webhookMissesCallbacks flags a list without callback_query", () => {
    expect(webhookMissesCallbacks(["message"])).toBe(true);
    expect(webhookMissesCallbacks(["message", "callback_query"])).toBe(false);
    // undefined = Telegram default = ALL update types → callbacks arrive.
    expect(webhookMissesCallbacks(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- telegram-callbacks`
Expected: FAIL — `parseTelegramCallback` etc. are not exported.

- [ ] **Step 3: Implement in `apps/bot/src/telegram.ts`**

Add after the voice parsing section:

```typescript
// ---------------------------------------------------------------------------
// Callback query parsing (inline keyboard taps).
// ---------------------------------------------------------------------------

/** One inline-keyboard button. `callback_data` is capped at 64 bytes by Telegram. */
export type InlineKeyboardButton = { text: string; callback_data: string };

/** Telegram `reply_markup` payload for an inline keyboard. */
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

/** A normalized inbound callback (inline-button tap) from a Telegram update. */
export type IncomingCallbackQuery = {
  updateId: number;
  callbackQueryId: string;
  fromId: string;
  fromUsername?: string;
  /** Absent when Telegram omitted the origin message (e.g. too old). */
  chatId?: string;
  messageId?: number;
  /** The raw callback token. Absent for game/url callbacks. */
  data?: string;
};

const telegramCallbackSchema = z.object({
  update_id: z.number(),
  callback_query: z.object({
    id: z.string(),
    from: z.object({
      id: z.union([z.number(), z.string()]),
      username: z.string().optional(),
    }),
    message: z
      .object({
        message_id: z.number(),
        chat: z.object({ id: z.union([z.number(), z.string()]) }),
      })
      .optional(),
    data: z.string().optional(),
  }),
});

/**
 * Parse a raw Telegram update into a normalized callback, or `null` when the
 * update is not a callback_query. `chatId`/`messageId`/`data` stay optional so
 * the handler can still `answerCallbackQuery` (stop the spinner) on partial
 * payloads instead of leaving the client hanging.
 */
export function parseTelegramCallback(
  raw: unknown,
): IncomingCallbackQuery | null {
  const result = telegramCallbackSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const cb = result.data.callback_query;
  return {
    updateId: result.data.update_id,
    callbackQueryId: cb.id,
    fromId: String(cb.from.id),
    fromUsername: cb.from.username,
    chatId: cb.message !== undefined ? String(cb.message.chat.id) : undefined,
    messageId: cb.message?.message_id,
    data: cb.data,
  };
}
```

Replace the client section (`TelegramClient`, `createHttpTelegramClient`, `createNoopTelegramClient`) with:

```typescript
/** Options for an outgoing message (inline keyboard, when any). */
export type SendMessageOptions = { replyMarkup?: InlineKeyboardMarkup };

/** Minimal injectable Telegram client used to send replies and answer taps. */
export type TelegramClient = {
  /** Returns the sent message's id when the API provides it (HTTP client does). */
  sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ messageId?: number }>;
  /** ALWAYS called for a callback — stops the client spinner; text shows a toast. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Strip the inline keyboard from a previously sent message. */
  editMessageReplyMarkup(chatId: string, messageId: number): Promise<void>;
};

/**
 * Real Bot API client. Constructed only when a token is configured; never used
 * by unit tests (which pass a mock). Uses the global `fetch` (Node 22).
 */
export function createHttpTelegramClient(botToken: string): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Telegram ${method} failed: ${response.status} ${body}`);
    }
    return response.json().catch(() => undefined);
  }

  return {
    async sendMessage(
      chatId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<{ messageId?: number }> {
      const payload: Record<string, unknown> = { chat_id: chatId, text };
      if (options?.replyMarkup !== undefined) {
        payload.reply_markup = options.replyMarkup;
      }
      const data = (await call("sendMessage", payload)) as
        | { result?: { message_id?: number } }
        | undefined;
      return { messageId: data?.result?.message_id };
    },
    async answerCallbackQuery(
      callbackQueryId: string,
      text?: string,
    ): Promise<void> {
      const payload: Record<string, unknown> = {
        callback_query_id: callbackQueryId,
      };
      if (text !== undefined) {
        payload.text = text;
      }
      await call("answerCallbackQuery", payload);
    },
    async editMessageReplyMarkup(
      chatId: string,
      messageId: number,
    ): Promise<void> {
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    },
  };
}

/** A no-op client (useful for dry-run / unconfigured local environments). */
export function createNoopTelegramClient(): TelegramClient {
  return {
    async sendMessage(): Promise<{ messageId?: number }> {
      return {};
    },
    async answerCallbackQuery(): Promise<void> {
      // Intentionally does nothing.
    },
    async editMessageReplyMarkup(): Promise<void> {
      // Intentionally does nothing.
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook registration sanity check (spec §1: allowed_updates must include
// callback_query, or every button tap silently vanishes).
// ---------------------------------------------------------------------------

/** True when the webhook's allowed_updates will never deliver callback_query. */
export function webhookMissesCallbacks(
  allowedUpdates: string[] | undefined,
): boolean {
  // undefined = Telegram default = all update types except a few opt-ins,
  // which INCLUDES callback_query — only an explicit list can exclude it.
  if (allowedUpdates === undefined) {
    return false;
  }
  return !allowedUpdates.includes("callback_query");
}

/** GET getWebhookInfo and return its allowed_updates (undefined on any failure). */
export async function fetchWebhookAllowedUpdates(
  botToken: string,
): Promise<string[] | undefined> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`,
    );
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as {
      result?: { allowed_updates?: string[] };
    };
    return data.result?.allowed_updates;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Fix the existing `fakeTelegram` in `apps/bot/src/bot.test.ts`**

The interface change breaks the old fake. Replace the `fakeTelegram` function (around line 905) with:

```typescript
function fakeTelegram(): {
  telegram: TelegramClient;
  sent: { chatId: string; text: string }[];
} {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    telegram: {
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
        return { messageId: sent.length };
      },
      async answerCallbackQuery() {
        // Not exercised by these text-flow tests.
      },
      async editMessageReplyMarkup() {
        // Not exercised by these text-flow tests.
      },
    },
  };
}
```

- [ ] **Step 5: Run the bot test suite**

Run: `pnpm --filter @family-finance/bot test`
Expected: PASS (new callback tests + all existing tests).

Run: `pnpm --filter @family-finance/bot typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/telegram.ts apps/bot/src/telegram-callbacks.test.ts apps/bot/src/bot.test.ts
git commit -m "feat(bot): parse callback_query updates and extend the Telegram client with keyboards"
```

---

### Task 2: db — `createCategory` repository

**Files:**
- Modify: `packages/db/src/repositories.ts` (add after `restoreCategory`, ~line 587)
- Modify: `packages/db/src/index.ts` (add `createCategory` to the repositories export list, next to `restoreCategory` ~line 130)
- Test: `packages/db/src/repositories.test.ts`

**Interfaces:**
- Consumes: `AppSupabaseClient`, `CategoryRow` (existing).
- Produces: `createCategory(client, householdId, name): Promise<CategoryRow>` — used by Task 8's `buildDeps`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/repositories.test.ts` (follow the file's existing fake-client style, e.g. `fakeClientWithRow`):

```typescript
describe("createCategory", () => {
  it("inserts an ACTIVE category scoped to the household and returns the row", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = {
      from(table: string) {
        expect(table).toBe("categories");
        return {
          insert(payload: Record<string, unknown>) {
            captured = payload;
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: "cat-new",
                        household_id: "house-1",
                        name: "Pets",
                        is_active: true,
                        created_at: "2026-07-04T00:00:00Z",
                        updated_at: "2026-07-04T00:00:00Z",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    const row = await createCategory(client, "house-1", "Pets");

    expect(captured).toEqual({
      household_id: "house-1",
      name: "Pets",
      is_active: true,
    });
    expect(row.id).toBe("cat-new");
  });

  it("throws a named error when the insert fails", async () => {
    const client = {
      from() {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: null, error: { message: "boom" } };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    await expect(createCategory(client, "house-1", "Pets")).rejects.toThrow(
      /createCategory failed: boom/,
    );
  });
});
```

Add `createCategory` to the test file's imports from `./repositories.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @family-finance/db test -- -t createCategory`
Expected: FAIL — `createCategory` is not exported.

- [ ] **Step 3: Implement**

In `packages/db/src/repositories.ts`, right after `restoreCategory`:

```typescript
/**
 * Create a new ACTIVE macro category for a household. Used by the Telegram
 * bot's category-creation flows (AI proposal accept + "nova categoria"); the
 * bot dedupes case/accent-insensitively BEFORE calling this, so the repo stays
 * a plain insert. `is_active` is set explicitly: the design requires the new
 * category to be usable immediately, with no approval queue.
 */
export async function createCategory(
  client: AppSupabaseClient,
  householdId: string,
  name: string,
): Promise<CategoryRow> {
  const { data, error } = await client
    .from("categories")
    .insert({ household_id: householdId, name, is_active: true })
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createCategory failed: ${error.message}`);
  }
  return data as CategoryRow;
}
```

In `packages/db/src/index.ts`, add `createCategory,` right after `restoreCategory,` in the export block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/db test && pnpm --filter @family-finance/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories.ts packages/db/src/index.ts packages/db/src/repositories.test.ts
git commit -m "feat(db): createCategory repository for bot category creation"
```

---

### Task 3: Keyboards module — tokens + pure builders

**Files:**
- Create: `apps/bot/src/keyboards.ts`
- Test: `apps/bot/src/keyboards.test.ts`

**Interfaces:**
- Consumes: `InlineKeyboardMarkup` from `./telegram.js` (Task 1).
- Produces (used by Tasks 5–8):

```typescript
export const TOKENS: {
  confirm: "cf"; cancel: "cx"; categories: "cats"; newCategory: "nc";
  acceptProposal: "nca"; dropProposal: "nocat"; responsible: "resp";
  responsibleHouse: "rs:house";
};
export const CATEGORY_TOKEN_PREFIX = "ct:";
export const RESPONSIBLE_TOKEN_PREFIX = "rs:";

export function confirmationKeyboard(proposedCategoryName?: string): InlineKeyboardMarkup;
export function categoryGridKeyboard(categories: ReadonlyArray<{ id: string; name: string }>): InlineKeyboardMarkup;
export function responsibleGridKeyboard(members: ReadonlyArray<{ userId: string; displayName: string }>): InlineKeyboardMarkup;
export function cancelOnlyKeyboard(): InlineKeyboardMarkup;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/keyboards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import {
  TOKENS,
  CATEGORY_TOKEN_PREFIX,
  confirmationKeyboard,
  categoryGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
} from "./keyboards.js";

describe("confirmationKeyboard", () => {
  it("without a proposal: confirm/cancel + category/responsável rows", () => {
    expect(confirmationKeyboard()).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: "cf" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
        [
          { text: "📂 Categoria", callback_data: "cats" },
          { text: "👤 Responsável", callback_data: "resp" },
        ],
      ],
    });
  });

  it("with a proposal: accept-with-create / other / no-category / cancel", () => {
    expect(confirmationKeyboard("Pets")).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Confirmar (cria "Pets")', callback_data: "nca" },
          { text: "📂 Outra categoria", callback_data: "cats" },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: "nocat" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
      ],
    });
  });
});

describe("categoryGridKeyboard", () => {
  it("lists active categories alphabetically, 2 per row, ending with nova categoria", () => {
    const grid = categoryGridKeyboard([
      { id: "cat-t", name: "Transporte" },
      { id: "cat-a", name: "Alimentação" },
      { id: "cat-s", name: "Saúde" },
    ]);
    expect(grid).toEqual({
      inline_keyboard: [
        [
          { text: "Alimentação", callback_data: "ct:cat-a" },
          { text: "Saúde", callback_data: "ct:cat-s" },
        ],
        [{ text: "Transporte", callback_data: "ct:cat-t" }],
        [{ text: "➕ Nova categoria", callback_data: "nc" }],
      ],
    });
  });

  it("never embeds names in callback_data (64-byte cap)", () => {
    const grid = categoryGridKeyboard([
      { id: "11111111-2222-3333-4444-555555555555", name: "Nome enorme de categoria" },
    ]);
    for (const row of grid.inline_keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
    expect(grid.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `${CATEGORY_TOKEN_PREFIX}11111111-2222-3333-4444-555555555555`,
    );
  });
});

describe("responsibleGridKeyboard", () => {
  it("puts Casa first, then one button per member, 2 per row", () => {
    expect(
      responsibleGridKeyboard([
        { userId: "user-alvaro", displayName: "Alvaro" },
        { userId: "user-karol", displayName: "Karol" },
      ]),
    ).toEqual({
      inline_keyboard: [
        [{ text: "🏠 Casa", callback_data: "rs:house" }],
        [
          { text: "Alvaro", callback_data: "rs:user-alvaro" },
          { text: "Karol", callback_data: "rs:user-karol" },
        ],
      ],
    });
  });
});

describe("cancelOnlyKeyboard", () => {
  it("is a single cancel button", () => {
    expect(cancelOnlyKeyboard()).toEqual({
      inline_keyboard: [[{ text: "❌ Cancelar", callback_data: TOKENS.cancel }]],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- keyboards`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `apps/bot/src/keyboards.ts`**

```typescript
/**
 * Inline-keyboard builders + callback token constants for the Telegram bot.
 *
 * Pure module (no I/O): the conversation layer decides WHICH keyboard a state
 * gets; this module only knows how each keyboard is shaped. Telegram caps
 * callback_data at 64 BYTES, so tokens carry ids (uuid ≤ 39 bytes with the
 * prefix) and NEVER user-typed names — proposal names live in conversation
 * state instead.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram.js";

/** Fixed callback tokens (spec §1's table). */
export const TOKENS = {
  confirm: "cf",
  cancel: "cx",
  categories: "cats",
  newCategory: "nc",
  acceptProposal: "nca",
  dropProposal: "nocat",
  responsible: "resp",
  responsibleHouse: "rs:house",
} as const;

/** `ct:<uuid>` assigns an existing category. */
export const CATEGORY_TOKEN_PREFIX = "ct:";
/** `rs:<uuid>` assigns a responsável (`rs:house` = the house). */
export const RESPONSIBLE_TOKEN_PREFIX = "rs:";

/** Chunk buttons into rows of two (household-scale grids, no pagination). */
function twoPerRow(buttons: InlineKeyboardButton[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}

/**
 * The standard confirmation keyboard. With an AI category proposal pending,
 * the confirm button doubles as "create the category" (token `nca`) and a
 * `nocat` escape hatch drops the proposal.
 */
export function confirmationKeyboard(
  proposedCategoryName?: string,
): InlineKeyboardMarkup {
  if (proposedCategoryName !== undefined) {
    return {
      inline_keyboard: [
        [
          {
            text: `✅ Confirmar (cria "${proposedCategoryName}")`,
            callback_data: TOKENS.acceptProposal,
          },
          { text: "📂 Outra categoria", callback_data: TOKENS.categories },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: TOKENS.dropProposal },
          { text: "❌ Cancelar", callback_data: TOKENS.cancel },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: TOKENS.confirm },
        { text: "❌ Cancelar", callback_data: TOKENS.cancel },
      ],
      [
        { text: "📂 Categoria", callback_data: TOKENS.categories },
        { text: "👤 Responsável", callback_data: TOKENS.responsible },
      ],
    ],
  };
}

/**
 * Category-pick grid: active categories alphabetically (pt-BR collation),
 * 2 per row, ending with the new-category button. Household scale — tens of
 * categories, far below Telegram's 100-button cap.
 */
export function categoryGridKeyboard(
  categories: ReadonlyArray<{ id: string; name: string }>,
): InlineKeyboardMarkup {
  const sorted = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  const rows = twoPerRow(
    sorted.map((c) => ({
      text: c.name,
      callback_data: `${CATEGORY_TOKEN_PREFIX}${c.id}`,
    })),
  );
  rows.push([{ text: "➕ Nova categoria", callback_data: TOKENS.newCategory }]);
  return { inline_keyboard: rows };
}

/** Responsável grid: the house first, then one button per active member. */
export function responsibleGridKeyboard(
  members: ReadonlyArray<{ userId: string; displayName: string }>,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🏠 Casa", callback_data: TOKENS.responsibleHouse }],
      ...twoPerRow(
        members.map((m) => ({
          text: m.displayName,
          callback_data: `${RESPONSIBLE_TOKEN_PREFIX}${m.userId}`,
        })),
      ),
    ],
  };
}

/** Single-cancel keyboard for the "type the category name" prompt. */
export function cancelOnlyKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "❌ Cancelar", callback_data: TOKENS.cancel }]],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test -- keyboards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/keyboards.ts apps/bot/src/keyboards.test.ts
git commit -m "feat(bot): inline keyboard builders and callback tokens"
```

---

### Task 4: Replies — proposal summary line, prompts, toasts, validation copy

**Files:**
- Modify: `apps/bot/src/replies.ts`
- Test: `apps/bot/src/replies-category.test.ts` (create)

**Interfaces:**
- Consumes: existing `SummaryView`.
- Produces (used by Tasks 5–8):

```typescript
// SummaryView gains:
//   proposedNewCategory?: string;   // renders `Categoria: "Pets" (nova — sugerida)`
export function askCategoryNameMessage(): string;
export function categoryCreatedMessage(name: string): string;
export function categoryReusedMessage(name: string): string;
export function chooseCategoryMessage(): string;
export function chooseResponsibleMessage(): string;
export function invalidCategoryNameMessage(reason: "empty" | "too_long"): string;
export const SESSION_EXPIRED_TOAST: string; // "Sessão expirada — envie o gasto novamente."
export const ALREADY_SAVED_TOAST: string;   // "Já salvo ✅"
export const CATEGORY_NOT_FOUND_TOAST: string;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/replies-category.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import {
  confirmationMessage,
  askCategoryNameMessage,
  categoryCreatedMessage,
  categoryReusedMessage,
  chooseCategoryMessage,
  chooseResponsibleMessage,
  invalidCategoryNameMessage,
  SESSION_EXPIRED_TOAST,
  ALREADY_SAVED_TOAST,
} from "./replies.js";

const BASE_VIEW = {
  amountCents: 3250,
  description: "Petz",
  occurredOn: "2026-07-04",
  categoryLabel: "Sem categoria (a definir)",
  paymentLabel: "Conta",
  responsibleLabel: "Alvaro",
};

describe("confirmationMessage with an AI category proposal", () => {
  it("shows the proposed name marked as nova — sugerida", () => {
    const text = confirmationMessage({
      ...BASE_VIEW,
      proposedNewCategory: "Pets",
      categoryExplanation: "Petz é um pet shop.",
    });
    expect(text).toContain('Categoria: "Pets" (nova — sugerida)');
    expect(text).toContain("Sugestão: Petz é um pet shop.");
    // Typed-command hints stay: buttons are progressive enhancement.
    expect(text).toContain("confirmar");
    expect(text).toContain("cancelar");
  });

  it("keeps today's plain category label when there is no proposal", () => {
    const text = confirmationMessage(BASE_VIEW);
    expect(text).toContain("Categoria: Sem categoria (a definir)");
  });
});

describe("category-creation copy", () => {
  it("asks for a name with a cancel hint", () => {
    expect(askCategoryNameMessage()).toContain("nome da nova categoria");
    expect(askCategoryNameMessage()).toContain("cancelar");
  });

  it("confirms creation and reuse", () => {
    expect(categoryCreatedMessage("Pets")).toBe('Categoria "Pets" criada ✅');
    expect(categoryReusedMessage("Pets")).toContain('"Pets" já existia');
  });

  it("grid prompts", () => {
    expect(chooseCategoryMessage()).toBe("Escolha a categoria:");
    expect(chooseResponsibleMessage()).toBe("Quem é o responsável?");
  });

  it("validation errors in pt-BR", () => {
    expect(invalidCategoryNameMessage("empty")).toContain("vazio");
    expect(invalidCategoryNameMessage("too_long")).toContain("40");
  });

  it("toast constants", () => {
    expect(SESSION_EXPIRED_TOAST).toBe(
      "Sessão expirada — envie o gasto novamente.",
    );
    expect(ALREADY_SAVED_TOAST).toBe("Já salvo ✅");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- replies-category`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement in `apps/bot/src/replies.ts`**

Add `proposedNewCategory?: string;` to `SummaryView` (after `categoryExplanation`), with the doc comment `/** AI-proposed NEW category name — rendered as (nova — sugerida). */`.

In `confirmationMessage`, replace the category line:

```typescript
  if (view.proposedNewCategory !== undefined) {
    lines.push(`• Categoria: "${view.proposedNewCategory}" (nova — sugerida)`);
  } else {
    lines.push(`• Categoria: ${view.categoryLabel}`);
  }
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Inline buttons + category creation (2026-07-04 design).
// ---------------------------------------------------------------------------

/** Prompt when the bot is waiting for a new category's name. */
export function askCategoryNameMessage(): string {
  return [
    "Qual o nome da nova categoria?",
    'Responda com o nome, ou "cancelar" para voltar.',
  ].join("\n");
}

/** Success after a category is created (standalone or mid-draft). */
export function categoryCreatedMessage(name: string): string {
  return `Categoria "${name}" criada ✅`;
}

/** Dedupe outcome: an existing (or reactivated) category was used instead. */
export function categoryReusedMessage(name: string): string {
  return `A categoria "${name}" já existia — usei ela. ✅`;
}

/** Header for the category-pick grid message. */
export function chooseCategoryMessage(): string {
  return "Escolha a categoria:";
}

/** Header for the responsável-pick grid message. */
export function chooseResponsibleMessage(): string {
  return "Quem é o responsável?";
}

/** pt-BR validation errors for a typed category name. */
export function invalidCategoryNameMessage(
  reason: "empty" | "too_long",
): string {
  return reason === "empty"
    ? "O nome da categoria não pode ficar vazio. Tente de novo, ou responda \"cancelar\"."
    : "O nome da categoria precisa ter no máximo 40 caracteres. Tente um nome mais curto.";
}

/** Toast for a tap on an expired/mismatched conversation. */
export const SESSION_EXPIRED_TOAST =
  "Sessão expirada — envie o gasto novamente.";

/** Toast for a double-tap on ✅ after the draft was already persisted. */
export const ALREADY_SAVED_TOAST = "Já salvo ✅";

/** Toast when a tapped category id is no longer in the catalog. */
export const CATEGORY_NOT_FOUND_TOAST =
  "Categoria não encontrada — abra a lista de novo.";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test`
Expected: PASS (including existing `confirmationMessage` assertions elsewhere).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/replies.ts apps/bot/src/replies-category.test.ts
git commit -m "feat(bot): pt-BR copy for proposals, category creation, and callback toasts"
```

---

### Task 5: Conversation — callback core (`applyCallback`) + keyboards on outcomes

This task adds state plumbing and the tokens that map to EXISTING transitions (`cf`, `cx`, `cats`, `ct:<id>`, `resp`, `rs:*`), plus stale/double-tap handling. Proposal (`nca`/`nocat`) and name flow (`nc`) land in Tasks 6–7.

**Files:**
- Modify: `apps/bot/src/conversation.ts`
- Test: `apps/bot/src/conversation-callbacks.test.ts` (create)

**Interfaces:**
- Consumes: `keyboards.ts` builders + `TOKENS`/prefixes (Task 3), `InlineKeyboardMarkup` (Task 1), replies (Task 4).
- Produces (relied on by Tasks 6–9):

```typescript
// ConversationStatus gains: "awaiting_category_name"
// ConversationState gains:
//   proposedCategoryName?: string;
//   promptMessageId?: number;
//   standaloneCategoryCreation?: boolean;
// DraftInProgress gains:
//   categoryNameFallback?: string;   // label for a category not in the loaded catalog
// ConversationOutcome gains:
//   keyboard?: InlineKeyboardMarkup;
// ConversationDeps gains (ALL optional):
//   listAllCategories?: () => Promise<Array<{ id: string; name: string; isActive: boolean }>>;
//   createCategory?: (name: string) => Promise<{ id: string }>;
//   restoreCategory?: (categoryId: string) => Promise<void>;
//   seedCategorizationMemory?: (entry: { pattern: string; categoryId: string; confidence: number; explanation: string }) => Promise<void>;
//   listActiveMembers?: () => Array<{ userId: string; displayName: string }>;

export type ApplyCallbackOutcome = ConversationOutcome & {
  /** answerCallbackQuery toast (shown even when no message is sent). */
  toast?: string;
  /** True when NO new message should be sent (reply is ""). */
  silent?: boolean;
};

export function applyCallback(
  state: ConversationState,
  token: string,
  deps: ConversationDeps,
  options?: { today?: string },
): Promise<ApplyCallbackOutcome>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/conversation-callbacks.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";
import type { CategorizationResult } from "@family-finance/categorization";

const TODAY = "2026-07-04";

const CATALOG = {
  householdId: "house-1",
  categories: [
    { id: "cat-transport", name: "Transporte" },
    { id: "cat-food", name: "Alimentação" },
  ],
  subcategories: [],
};

const UNCATEGORIZED: CategorizationResult = {
  status: "uncategorized",
  suggestion: null,
  requiresConfirmation: true,
};

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  return {
    householdId: "house-1",
    catalog: CATALOG,
    defaultAccountId: "acct-1",
    resolveCardId: () => undefined,
    resolveAccountId: () => "acct-1",
    resolveResponsibleUserId: (name: string) =>
      name.trim().toLowerCase() === "karol" ? "user-karol" : undefined,
    memberDisplayName: (userId: string) =>
      userId === "user-karol" ? "Karol" : userId === "user-alvaro" ? "Alvaro" : undefined,
    suggestCategory: vi.fn(async () => UNCATEGORIZED),
    createTransaction: vi.fn(async () => ({ id: "tx-1" })),
    logInteraction: vi.fn(async () => undefined),
    listActiveMembers: () => [
      { userId: "user-alvaro", displayName: "Alvaro" },
      { userId: "user-karol", displayName: "Karol" },
    ],
    ...overrides,
  };
}

async function draftState(deps: ConversationDeps): Promise<ConversationState> {
  const outcome = await startConversation(
    { text: "Petz 90 reais", fromUserId: "user-alvaro" },
    deps,
    { today: TODAY },
  );
  return outcome.state;
}

describe("keyboards on text outcomes", () => {
  it("startConversation attaches the confirmation keyboard when awaiting confirmation", async () => {
    const deps = makeDeps();
    const outcome = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]).toEqual({
      text: "✅ Confirmar",
      callback_data: "cf",
    });
  });

  it("a typed correction re-attaches the confirmation keyboard", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyMessage(state, "valor 45,90", deps, { today: TODAY });
    expect(outcome.keyboard).toBeDefined();
  });
});

describe("applyCallback: cf / cx", () => {
  it("cf persists exactly like typed confirmar (parity)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(outcome.state.status).toBe("saved");
    expect(outcome.transactionId).toBe("tx-1");
    expect(outcome.reply).toContain("Lançamento salvo");
    expect(outcome.keyboard).toBeUndefined();
  });

  it("cx cancels exactly like typed cancelar", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cx", deps, { today: TODAY });
    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("não salvei");
  });

  it("typed and tapped confirm produce the same persisted draft", async () => {
    const depsA = makeDeps();
    const depsB = makeDeps();
    const stateA = await draftState(depsA);
    const stateB = await draftState(depsB);
    await applyMessage(stateA, "confirmar", depsA, { today: TODAY });
    await applyCallback(stateB, "cf", depsB, { today: TODAY });
    const draftA = (depsA.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const draftB = (depsB.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(draftB).toEqual(draftA);
  });
});

describe("applyCallback: grids and picks", () => {
  it("cats replies with the category grid and keeps the state", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cats", deps, { today: TODAY });
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.reply).toBe("Escolha a categoria:");
    const flat = outcome.keyboard?.inline_keyboard.flat() ?? [];
    expect(flat.map((b) => b.callback_data)).toEqual([
      "ct:cat-food",
      "ct:cat-transport",
      "nc",
    ]);
  });

  it("ct:<id> assigns the category and re-sends the summary (parity with typed)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "ct:cat-food", deps, { today: TODAY });
    expect(outcome.state.draft.categoryId).toBe("cat-food");
    expect(outcome.reply).toContain("Categoria: Alimentação");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
  });

  it("ct with an unknown id answers a toast and keeps the state", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "ct:cat-nope", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("não encontrada");
    expect(outcome.state.draft.categoryId).toBeUndefined();
  });

  it("resp replies with the responsável grid (Casa + members)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "resp", deps, { today: TODAY });
    const flat = outcome.keyboard?.inline_keyboard.flat() ?? [];
    expect(flat.map((b) => b.callback_data)).toEqual([
      "rs:house",
      "rs:user-alvaro",
      "rs:user-karol",
    ]);
  });

  it("rs:house moves responsibility to the house; rs:<id> to the member", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const house = await applyCallback(state, "rs:house", deps, { today: TODAY });
    expect(house.state.draft.responsibleUserId).toBeUndefined();
    expect(house.reply).toContain("Responsável: Casa");

    const karol = await applyCallback(state, "rs:user-karol", deps, { today: TODAY });
    expect(karol.state.draft.responsibleUserId).toBe("user-karol");
    expect(karol.reply).toContain("Responsável: Karol");
  });
});

describe("applyCallback: stale states and double-taps", () => {
  it("double-tap on cf after saved answers Já salvo, no second insert", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const first = await applyCallback(state, "cf", deps, { today: TODAY });
    const second = await applyCallback(first.state, "cf", deps, { today: TODAY });
    expect(second.silent).toBe(true);
    expect(second.toast).toBe("Já salvo ✅");
    expect(deps.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("any token on a cancelled conversation answers Sessão expirada", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const cancelled = await applyCallback(state, "cx", deps, { today: TODAY });
    const late = await applyCallback(cancelled.state, "ct:cat-food", deps, { today: TODAY });
    expect(late.silent).toBe(true);
    expect(late.toast).toContain("Sessão expirada");
  });

  it("an unknown token never crashes — answers Sessão expirada and ignores", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "wat:???", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("Sessão expirada");
    expect(outcome.state).toBe(state);
  });

  it("tokens on obligation states answer Sessão expirada (buttons are expense-only)", async () => {
    const deps = makeDeps();
    const state: ConversationState = {
      status: "awaiting_obligation_confirmation",
      draft: (await draftState(deps)).draft,
    };
    const outcome = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("Sessão expirada");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- conversation-callbacks`
Expected: FAIL — `applyCallback` not exported, `keyboard` missing from outcomes.

- [ ] **Step 3: Implement in `apps/bot/src/conversation.ts`**

3a. Imports — add:

```typescript
import type { InlineKeyboardMarkup } from "./telegram.js";
import {
  TOKENS,
  CATEGORY_TOKEN_PREFIX,
  RESPONSIBLE_TOKEN_PREFIX,
  confirmationKeyboard,
  categoryGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
} from "./keyboards.js";
```

and extend the `./replies.js` import with `chooseCategoryMessage, chooseResponsibleMessage, SESSION_EXPIRED_TOAST, ALREADY_SAVED_TOAST, CATEGORY_NOT_FOUND_TOAST` (Task 6/7 add the rest).

3b. Types — extend:

```typescript
export type ConversationStatus =
  | "awaiting_confirmation"
  | "needs_amount"
  | "saved"
  | "cancelled"
  | "awaiting_obligation_confirmation"
  | "awaiting_mark_paid_choice"
  /** Waiting for the user to TYPE a new category's name (nc button / bare "nova categoria"). */
  | "awaiting_category_name";
```

`DraftInProgress` gains (after `categoryExplanation`):

```typescript
  /**
   * Display name for a category the loaded catalog does not carry (created or
   * reactivated mid-conversation). Labels fall back to this when the id is
   * not found in `deps.catalog`.
   */
  categoryNameFallback?: string;
```

`ConversationState` gains:

```typescript
  /** AI-proposed NEW category name (spec §3) — never placed in callback data. */
  proposedCategoryName?: string;
  /** message_id of the last keyboard-bearing prompt (to strip stale buttons). */
  promptMessageId?: number;
  /** True when awaiting_category_name was entered with NO expense draft. */
  standaloneCategoryCreation?: boolean;
```

`ConversationOutcome` gains:

```typescript
  /** Inline keyboard to attach to the reply (buttons are additive to the text hints). */
  keyboard?: InlineKeyboardMarkup;
```

`ConversationDeps` gains (all optional, after `accountNameById`):

```typescript
  /** ALL categories (active + archived) for create-dedupe (bot category creation). */
  listAllCategories?: () => Promise<
    Array<{ id: string; name: string; isActive: boolean }>
  >;
  /** Create an ACTIVE category (db createCategory); impl must also expose it in `catalog`. */
  createCategory?: (name: string) => Promise<{ id: string }>;
  /** Reactivate an archived category (db restoreCategory). */
  restoreCategory?: (categoryId: string) => Promise<void>;
  /** Seed categorization_memory — ONLY the AI new-category accept path calls this. */
  seedCategorizationMemory?: (entry: {
    pattern: string;
    categoryId: string;
    confidence: number;
    explanation: string;
  }) => Promise<void>;
  /** Active members for the responsável grid. */
  listActiveMembers?: () => Array<{ userId: string; displayName: string }>;
```

3c. Label fallback — change `categoryLabel` to accept it and thread through:

```typescript
function categoryLabel(
  catalog: CategoryCatalog,
  categoryId: string | undefined,
  subcategoryId: string | undefined,
  fallbackName?: string,
): string {
  if (categoryId === undefined) {
    return "Sem categoria (a definir)";
  }
  const category = catalog.categories.find((c) => c.id === categoryId);
  const macro = category?.name ?? fallbackName ?? "Categoria";
  // ... rest unchanged
```

Update its call sites: in `summaryView` pass `draft.categoryNameFallback`; in `persist`'s `savedMessage` pass `draft.categoryNameFallback`; `obligationSummaryView` passes `undefined` implicitly (no change).

3d. Summary + keyboard helpers — replace `replyForDraft` and add `keyboardForState`:

```typescript
function summaryView(
  draft: DraftInProgress,
  deps: ConversationDeps,
  proposedNewCategory?: string,
): SummaryView {
  return {
    // ...existing fields, plus:
    categoryLabel: categoryLabel(
      deps.catalog,
      draft.categoryId,
      draft.subcategoryId,
      draft.categoryNameFallback,
    ),
    proposedNewCategory,
    // ...
  };
}

function replyForState(
  state: ConversationState,
  deps: ConversationDeps,
): string {
  if (state.draft.amountCents === undefined) {
    return needsAmountMessage(state.draft.description);
  }
  return confirmationMessage(
    summaryView(state.draft, deps, state.proposedCategoryName),
  );
}

/** The keyboard each state's prompt carries (undefined = no buttons). */
function keyboardForState(
  state: ConversationState,
): InlineKeyboardMarkup | undefined {
  if (state.status === "awaiting_confirmation") {
    return confirmationKeyboard(state.proposedCategoryName);
  }
  if (state.status === "awaiting_category_name") {
    return cancelOnlyKeyboard();
  }
  return undefined;
}
```

Keep a thin `replyForDraft(draft, deps)` delegating to `replyForState({status: statusForDraft(draft), draft}, deps)` or update its ~4 call sites directly — prefer updating call sites and deleting `replyForDraft`.

3e. Attach keyboards to existing outcomes:

- `startConversation` final return → `return { state, reply: replyForState(state, deps), keyboard: keyboardForState(state) };`
- `applyMessage` correction return → `return { state: next, reply, keyboard: keyboardForState(next) };`
- Terminal/no-change branches (`saved`, `cancelled`, `notUnderstood`) return no keyboard. Obligation flows unchanged (no keyboards, out of scope).

3f. `applyCallback` — add at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Apply an inline-button tap: structured tokens through the SAME transitions
// as typed messages (approach B — no text-spoofing into the regex parser).
// ---------------------------------------------------------------------------

export type ApplyCallbackOutcome = ConversationOutcome & {
  /** answerCallbackQuery toast (shown even when no message is sent). */
  toast?: string;
  /** True when NO new message should be sent (reply is ""). */
  silent?: boolean;
};

function expiredOutcome(state: ConversationState): ApplyCallbackOutcome {
  return { state, reply: "", silent: true, toast: SESSION_EXPIRED_TOAST };
}

function summaryOutcome(
  state: ConversationState,
  deps: ConversationDeps,
  prefix?: string,
): ApplyCallbackOutcome {
  const body = replyForState(state, deps);
  return {
    state,
    reply: prefix !== undefined ? `${prefix}\n\n${body}` : body,
    keyboard: keyboardForState(state),
  };
}

export async function applyCallback(
  state: ConversationState,
  token: string,
  deps: ConversationDeps,
  options: { today?: string } = {},
): Promise<ApplyCallbackOutcome> {
  const today = options.today ?? state.draft.occurredOn;

  // Terminal states: a confirm double-tap is a friendly no-op; anything else
  // is a stale button. Never crash, never double-insert.
  if (state.status === "saved") {
    if (token === TOKENS.confirm || token === TOKENS.acceptProposal) {
      return { state, reply: "", silent: true, toast: ALREADY_SAVED_TOAST };
    }
    return expiredOutcome(state);
  }
  if (state.status === "cancelled") {
    return expiredOutcome(state);
  }

  // Obligation flows and mark-paid choices never get keyboards (out of scope),
  // so any token landing there is stale.
  if (
    state.status === "awaiting_obligation_confirmation" ||
    state.status === "awaiting_mark_paid_choice"
  ) {
    return expiredOutcome(state);
  }

  // awaiting_category_name: only ❌ (cx) is wired — Task 7 fills this in.
  if (state.status === "awaiting_category_name") {
    if (token === TOKENS.cancel) {
      return cancelCategoryName(state, deps);
    }
    return expiredOutcome(state);
  }

  // awaiting_confirmation / needs_amount.
  if (token === TOKENS.confirm) {
    const outcome = await confirmDraft(state, deps, "confirmar (botão)", today);
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
  }
  if (token === TOKENS.cancel) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
  if (token === TOKENS.categories) {
    return {
      state,
      reply: chooseCategoryMessage(),
      keyboard: categoryGridKeyboard(deps.catalog.categories),
    };
  }
  if (token.startsWith(CATEGORY_TOKEN_PREFIX)) {
    const categoryId = token.slice(CATEGORY_TOKEN_PREFIX.length);
    const category = deps.catalog.categories.find((c) => c.id === categoryId);
    if (category === undefined) {
      return { state, reply: "", silent: true, toast: CATEGORY_NOT_FOUND_TOAST };
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: category.id,
      subcategoryId: undefined,
      categoryNameFallback: category.name,
      categoryExplanation: "Categoria escolhida manualmente.",
    };
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
      proposedCategoryName: undefined,
    };
    return summaryOutcome(next, deps, correctionAppliedMessage("a categoria"));
  }
  if (token === TOKENS.responsible) {
    return {
      state,
      reply: chooseResponsibleMessage(),
      keyboard: responsibleGridKeyboard(deps.listActiveMembers?.() ?? []),
    };
  }
  if (token === TOKENS.responsibleHouse) {
    const draft: DraftInProgress = { ...state.draft, responsibleUserId: undefined };
    const next: ConversationState = { ...state, status: statusForDraft(draft), draft };
    return summaryOutcome(next, deps, correctionAppliedMessage("o responsável"));
  }
  if (token.startsWith(RESPONSIBLE_TOKEN_PREFIX)) {
    const userId = token.slice(RESPONSIBLE_TOKEN_PREFIX.length);
    const member = deps.listActiveMembers?.().find((m) => m.userId === userId);
    if (member === undefined) {
      return expiredOutcome(state);
    }
    const draft: DraftInProgress = { ...state.draft, responsibleUserId: userId };
    const next: ConversationState = { ...state, status: statusForDraft(draft), draft };
    return summaryOutcome(next, deps, correctionAppliedMessage("o responsável"));
  }

  // TOKENS.newCategory / acceptProposal / dropProposal land in Tasks 6–7;
  // until then (and for any future/unknown token) answer-and-ignore.
  return expiredOutcome(state);
}
```

For this task, `confirmDraft` is a thin alias so the `cf` path compiles (Task 6 gives it the proposal logic):

```typescript
/** Confirm the draft. Task 6 extends this with the AI new-category proposal. */
async function confirmDraft(
  state: ConversationState,
  deps: ConversationDeps,
  messageText: string,
  _today: string,
): Promise<ConversationOutcome> {
  return persist(state, deps, messageText);
}
```

And `cancelCategoryName` a placeholder Task 7 completes:

```typescript
/** ❌ while typing a category name — Task 7 wires the full flow. */
function cancelCategoryName(
  state: ConversationState,
  deps: ConversationDeps,
): ApplyCallbackOutcome {
  const next: ConversationState = {
    ...state,
    status: "awaiting_confirmation",
    standaloneCategoryCreation: undefined,
  };
  return summaryOutcome(next, deps);
}
```

Also switch the typed `CONFIRM_RE` branch in `applyMessage` from `persist(state, deps, message)` to `confirmDraft(state, deps, message, today)` — typed/tapped parity from day one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`
Expected: PASS — new suite green, existing conversation/obligation suites untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/conversation.ts apps/bot/src/conversation-callbacks.test.ts
git commit -m "feat(bot): applyCallback state machine — confirm/cancel/category/responsavel via inline buttons"
```

---

### Task 6: Conversation — AI new-category proposal (the "Petz" case)

**Files:**
- Modify: `apps/bot/src/conversation.ts`
- Test: `apps/bot/src/conversation-callbacks.test.ts` (extend)

**Interfaces:**
- Consumes: `CategorizationResult.pendingCategory` (already returned by `@family-finance/categorization` — **no engine change needed**), deps from Task 5.
- Produces: `confirmDraft` handling proposals; `createOrReuseCategory(name, deps)` internal helper reused by Task 7:

```typescript
async function createOrReuseCategory(
  name: string,
  deps: ConversationDeps,
): Promise<{ categoryId: string; reused: boolean } | null>; // null = deps not wired
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/src/conversation-callbacks.test.ts`:

```typescript
const PROPOSAL: CategorizationResult = {
  status: "pending_new_category",
  suggestion: { confidence: 0.9, explanation: "Petz é um pet shop.", source: "ai" },
  pendingCategory: {
    categoryName: "Pets",
    subcategoryName: null,
    confidence: 0.9,
    explanation: "Petz é um pet shop.",
  },
  requiresConfirmation: true,
};

function proposalDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  return makeDeps({
    suggestCategory: vi.fn(async () => PROPOSAL),
    listAllCategories: vi.fn(async () => [
      { id: "cat-transport", name: "Transporte", isActive: true },
      { id: "cat-food", name: "Alimentação", isActive: true },
    ]),
    createCategory: vi.fn(async () => ({ id: "cat-pets" })),
    restoreCategory: vi.fn(async () => undefined),
    seedCategorizationMemory: vi.fn(async () => undefined),
    ...overrides,
  });
}

describe("AI new-category proposal", () => {
  it("startConversation surfaces the proposal in state, summary, and keyboard", async () => {
    const deps = proposalDeps();
    const outcome = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.state.proposedCategoryName).toBe("Pets");
    expect(outcome.reply).toContain('Categoria: "Pets" (nova — sugerida)');
    expect(outcome.reply).toContain("Sugestão: Petz é um pet shop.");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]).toEqual({
      text: '✅ Confirmar (cria "Pets")',
      callback_data: "nca",
    });
  });

  it("nca creates the category, seeds memory, and persists the transaction", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(start.state, "nca", deps, { today: TODAY });

    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(deps.seedCategorizationMemory).toHaveBeenCalledWith({
      pattern: "petz",
      categoryId: "cat-pets",
      confidence: 0.95,
      explanation: `criada pelo usuário via bot em ${TODAY}`,
    });
    expect(outcome.state.status).toBe("saved");
    const draft = (deps.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(draft.category).toEqual({ categoryId: "cat-pets", subcategoryId: undefined });
    expect(outcome.reply).toContain("Pets");
  });

  it("typed confirmar with a pending proposal behaves exactly like nca (parity)", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(start.state, "confirmar", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(deps.seedCategorizationMemory).toHaveBeenCalledTimes(1);
    expect(outcome.state.status).toBe("saved");
  });

  it("dedupe: an ACTIVE case/accent-insensitive match is assigned, not duplicated", async () => {
    const deps = proposalDeps({
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-x", name: "PÉTS", isActive: true },
      ]),
    });
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyCallback(start.state, "nca", deps, { today: TODAY });
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(deps.restoreCategory).not.toHaveBeenCalled();
    const seeded = (deps.seedCategorizationMemory as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(seeded.categoryId).toBe("cat-pets-x");
  });

  it("dedupe: an INACTIVE match is reactivated and assigned", async () => {
    const deps = proposalDeps({
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-old", name: "pets", isActive: false },
      ]),
    });
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyCallback(start.state, "nca", deps, { today: TODAY });
    expect(deps.restoreCategory).toHaveBeenCalledWith("cat-pets-old");
    expect(deps.createCategory).not.toHaveBeenCalled();
  });

  it("nocat drops the proposal and returns to the plain confirmation", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(start.state, "nocat", deps, { today: TODAY });
    expect(outcome.state.proposedCategoryName).toBeUndefined();
    expect(outcome.reply).toContain("Categoria: Sem categoria (a definir)");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
    // Dropping the proposal never writes memory or creates anything.
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(deps.seedCategorizationMemory).not.toHaveBeenCalled();
  });

  it("a regular ct:<id> pick clears the proposal and seeds NOTHING", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const picked = await applyCallback(start.state, "ct:cat-food", deps, { today: TODAY });
    expect(picked.state.proposedCategoryName).toBeUndefined();
    await applyCallback(picked.state, "cf", deps, { today: TODAY });
    expect(deps.seedCategorizationMemory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- conversation-callbacks`
Expected: FAIL — proposal not surfaced (`proposedCategoryName` undefined), `nca`/`nocat` answer "Sessão expirada".

- [ ] **Step 3: Implement in `apps/bot/src/conversation.ts`**

3a. Surface the proposal in `startConversation` — after the existing `suggestCategory` block (~line 662), add:

```typescript
  // AI new-category proposal (spec §3): the engine returns pending_new_category
  // with a proposed NAME; it lives in conversation state (never callback data)
  // until the user accepts, picks another, or drops it.
  let proposedCategoryName: string | undefined;
  if (
    result.status === "pending_new_category" &&
    result.pendingCategory !== undefined
  ) {
    proposedCategoryName = result.pendingCategory.categoryName;
    draft.categoryExplanation = result.pendingCategory.explanation;
    draft.needsAttention = true;
  }
```

and thread it into the returned state:

```typescript
  const state: ConversationState = {
    status: statusForDraft(draft),
    draft,
    proposedCategoryName,
  };
  return { state, reply: replyForState(state, deps), keyboard: keyboardForState(state) };
```

3b. Create-or-reuse helper (above `confirmDraft`):

```typescript
/**
 * Dedupe-then-create (spec §3): case- and accent-insensitive match against ALL
 * categories. Active match → assign as-is; inactive match → reactivate; no
 * match → create (active immediately). Returns null when the category-creation
 * deps are not wired (flow degrades to "not understood").
 */
async function createOrReuseCategory(
  name: string,
  deps: ConversationDeps,
): Promise<{ categoryId: string; reused: boolean } | null> {
  if (deps.listAllCategories === undefined || deps.createCategory === undefined) {
    return null;
  }
  const wanted = normalizeText(name);
  const existing = await deps.listAllCategories();
  const match = existing.find((c) => normalizeText(c.name) === wanted);
  if (match !== undefined) {
    if (!match.isActive) {
      await deps.restoreCategory?.(match.id);
    }
    return { categoryId: match.id, reused: true };
  }
  const created = await deps.createCategory(name);
  return { categoryId: created.id, reused: false };
}
```

3c. Replace the Task 5 `confirmDraft` stub:

```typescript
/**
 * Confirm the draft. With a pending AI category proposal and no category yet:
 * create/reuse the category, assign it, seed categorization_memory (the ONLY
 * path that seeds — spec §3), then persist through the normal `persist`.
 */
async function confirmDraft(
  state: ConversationState,
  deps: ConversationDeps,
  messageText: string,
  today: string,
): Promise<ConversationOutcome> {
  let working = state;
  if (
    state.proposedCategoryName !== undefined &&
    state.draft.categoryId === undefined &&
    state.draft.amountCents !== undefined
  ) {
    const resolved = await createOrReuseCategory(
      state.proposedCategoryName,
      deps,
    );
    if (resolved === null) {
      // Category creation is not wired here — keep the draft, explain.
      return { state, reply: notUnderstoodMessage() };
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: resolved.categoryId,
      subcategoryId: undefined,
      categoryNameFallback: state.proposedCategoryName,
    };
    working = { ...state, draft, proposedCategoryName: undefined };

    // Seed memory so the next identical merchant resolves instantly. Pattern =
    // the interpreter's normalized merchant token (the draft description).
    const pattern = normalizeText(draft.description);
    if (deps.seedCategorizationMemory !== undefined && pattern.length > 0) {
      await deps.seedCategorizationMemory({
        pattern,
        categoryId: resolved.categoryId,
        confidence: 0.95,
        explanation: `criada pelo usuário via bot em ${today}`,
      });
    }
  }
  return persist(working, deps, messageText);
}
```

3d. Wire `nca` and `nocat` in `applyCallback` — replace the fall-through before the final `expiredOutcome` with:

```typescript
  if (token === TOKENS.acceptProposal) {
    if (state.proposedCategoryName === undefined) {
      return expiredOutcome(state);
    }
    const outcome = await confirmDraft(
      state,
      deps,
      `confirmar (botão, nova categoria "${state.proposedCategoryName}")`,
      today,
    );
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
  }
  if (token === TOKENS.dropProposal) {
    if (state.proposedCategoryName === undefined) {
      return expiredOutcome(state);
    }
    const next: ConversationState = { ...state, proposedCategoryName: undefined };
    return summaryOutcome(next, deps);
  }
```

Note `ct:<id>` (Task 5) already clears `proposedCategoryName` — the proposal dies when another category is picked; no memory write happens there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/conversation.ts apps/bot/src/conversation-callbacks.test.ts
git commit -m "feat(bot): one-tap accept of AI-proposed categories with dedupe and memory seeding"
```

---

### Task 7: Conversation — manual category creation (`nova categoria` + `nc` button)

**Files:**
- Modify: `apps/bot/src/conversation.ts`
- Test: `apps/bot/src/conversation-callbacks.test.ts` (extend)

**Interfaces:**
- Consumes: `createOrReuseCategory` (Task 6), `askCategoryNameMessage`/`categoryCreatedMessage`/`categoryReusedMessage`/`invalidCategoryNameMessage` (Task 4).
- Produces: `awaiting_category_name` handling in `applyMessage`; `NEW_CATEGORY_RE` command in both `startConversation` and `applyMessage`. **No memory seeding anywhere in this task** (spec: seeding is §3-only).

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/src/conversation-callbacks.test.ts`:

```typescript
describe("manual category creation", () => {
  it("typed `nova categoria Pets` mid-draft creates + assigns + re-shows the summary", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const outcome = await applyMessage(state, "nova categoria Pets", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft.categoryId).toBe("cat-pets");
    expect(outcome.reply).toContain('Categoria "Pets" criada ✅');
    expect(outcome.reply).toContain("Categoria: Pets");
    // Manual creation NEVER seeds memory.
    expect(deps.seedCategorizationMemory).not.toHaveBeenCalled();
  });

  it("typed `nova categoria Pets` with NO active conversation creates standalone", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const outcome = await startConversation(
      { text: "nova categoria Pets", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(outcome.reply).toBe('Categoria "Pets" criada ✅');
    // Terminal: the next message starts a fresh conversation.
    expect(["saved", "cancelled"]).toContain(outcome.state.status);
  });

  it("nc button enters awaiting_category_name with a cancel keyboard", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "nc", deps, { today: TODAY });
    expect(outcome.state.status).toBe("awaiting_category_name");
    expect(outcome.reply).toContain("nome da nova categoria");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cx");
  });

  it("the next text in name-mode becomes the category (create + assign)", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const asking = await applyCallback(state, "nc", deps, { today: TODAY });
    const outcome = await applyMessage(asking.state, "Pets", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(outcome.state.draft.categoryId).toBe("cat-pets");
    expect(outcome.state.status).toBe("awaiting_confirmation");
  });

  it("name-mode wins: a command word like `confirmar` is a NAME", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const asking = await applyCallback(state, "nc", deps, { today: TODAY });
    const outcome = await applyMessage(asking.state, "confirmar", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("confirmar");
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(outcome.state.status).toBe("awaiting_confirmation");
  });

  it("`cancelar` (typed) in name-mode returns to awaiting_confirmation", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const asking = await applyCallback(state, "nc", deps, { today: TODAY });
    const outcome = await applyMessage(asking.state, "cancelar", deps, { today: TODAY });
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
  });

  it("❌ button (cx) in name-mode also returns to awaiting_confirmation", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const asking = await applyCallback(state, "nc", deps, { today: TODAY });
    const outcome = await applyCallback(asking.state, "cx", deps, { today: TODAY });
    expect(outcome.state.status).toBe("awaiting_confirmation");
  });

  it("validates the name: empty and >40 chars re-ask with pt-BR errors", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const state = await draftState(deps);
    const asking = await applyCallback(state, "nc", deps, { today: TODAY });

    const tooLong = await applyMessage(asking.state, "x".repeat(41), deps, { today: TODAY });
    expect(tooLong.state.status).toBe("awaiting_category_name");
    expect(tooLong.reply).toContain("40");
    expect(deps.createCategory).not.toHaveBeenCalled();
  });

  it("dedupe applies to manual creation too (reuse message)", async () => {
    const deps = proposalDeps({
      suggestCategory: vi.fn(async () => UNCATEGORIZED),
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-x", name: "pets", isActive: true },
      ]),
    });
    const state = await draftState(deps);
    const outcome = await applyMessage(state, "nova categoria Pets", deps, { today: TODAY });
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(outcome.state.draft.categoryId).toBe("cat-pets-x");
    expect(outcome.reply).toContain("já existia");
  });

  it("bare `nova categoria` with no draft enters standalone name-mode; the name creates and ends", async () => {
    const deps = proposalDeps({ suggestCategory: vi.fn(async () => UNCATEGORIZED) });
    const asking = await startConversation(
      { text: "nova categoria", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(asking.state.status).toBe("awaiting_category_name");
    expect(asking.state.standaloneCategoryCreation).toBe(true);

    const outcome = await applyMessage(asking.state, "Pets", deps, { today: TODAY });
    expect(outcome.reply).toBe('Categoria "Pets" criada ✅');
    expect(["saved", "cancelled"]).toContain(outcome.state.status);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- conversation-callbacks`
Expected: FAIL — `nova categoria` parses as an expense; `nc` answers "Sessão expirada".

- [ ] **Step 3: Implement in `apps/bot/src/conversation.ts`**

3a. Import the Task 4 copy: `askCategoryNameMessage, categoryCreatedMessage, categoryReusedMessage, invalidCategoryNameMessage`.

3b. Command + validation helpers (near `CONFIRM_RE`):

```typescript
/** "nova categoria" [name] — manual category creation (spec §4). */
const NEW_CATEGORY_RE = /^\s*nova\s+categoria\b\s*(.*)$/i;

/** Trimmed, non-empty, ≤ 40 chars (spec §4 validation). */
function validateCategoryName(
  raw: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, error: invalidCategoryNameMessage("empty") };
  }
  if (name.length > 40) {
    return { ok: false, error: invalidCategoryNameMessage("too_long") };
  }
  return { ok: true, name };
}
```

3c. Assign-after-create helper (used by name-mode and the inline command):

```typescript
/** Create/reuse `name`, assign it to the draft, and re-show the confirmation. */
async function createCategoryForDraft(
  state: ConversationState,
  name: string,
  deps: ConversationDeps,
): Promise<ConversationOutcome> {
  const resolved = await createOrReuseCategory(name, deps);
  if (resolved === null) {
    return { state, reply: notUnderstoodMessage() };
  }
  const draft: DraftInProgress = {
    ...state.draft,
    categoryId: resolved.categoryId,
    subcategoryId: undefined,
    categoryNameFallback: name,
    categoryExplanation: "Categoria criada pelo usuário.",
  };
  const next: ConversationState = {
    status: statusForDraft(draft),
    draft,
    proposedCategoryName: undefined,
  };
  const created = resolved.reused
    ? categoryReusedMessage(name)
    : categoryCreatedMessage(name);
  return {
    state: next,
    reply: `${created}\n\n${replyForState(next, deps)}`,
    keyboard: keyboardForState(next),
  };
}
```

3d. Name-mode handler — first branch in `applyMessage` (before the terminal-status check is fine too, but the terminal check returns early for saved/cancelled anyway; put it right after the `today` line, alongside the other status routers):

```typescript
  if (state.status === "awaiting_category_name") {
    return applyCategoryName(state, message, deps);
  }
```

```typescript
/**
 * awaiting_category_name: NAME-MODE WINS — anything except "cancelar" is a
 * category name (so "confirmar" can be a category). Keeps the state machine
 * unambiguous (spec §5).
 */
async function applyCategoryName(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
): Promise<ConversationOutcome> {
  if (/^\s*(cancelar|cancela)\s*$/i.test(message)) {
    if (state.standaloneCategoryCreation === true) {
      return {
        state: { status: "cancelled", draft: state.draft },
        reply: cancelledMessage(),
      };
    }
    const back: ConversationState = {
      ...state,
      status: "awaiting_confirmation",
      standaloneCategoryCreation: undefined,
    };
    return {
      state: back,
      reply: replyForState(back, deps),
      keyboard: keyboardForState(back),
    };
  }

  const validated = validateCategoryName(message);
  if (!validated.ok) {
    return { state, reply: validated.error, keyboard: cancelOnlyKeyboard() };
  }

  if (state.standaloneCategoryCreation === true) {
    const resolved = await createOrReuseCategory(validated.name, deps);
    if (resolved === null) {
      return { state, reply: notUnderstoodMessage() };
    }
    // Terminal: the category exists; no transaction draft is open.
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: resolved.reused
        ? categoryReusedMessage(validated.name)
        : categoryCreatedMessage(validated.name),
    };
  }
  return createCategoryForDraft(state, validated.name, deps);
}
```

3e. Inline command in `applyMessage` (awaiting_confirmation/needs_amount) — right BEFORE the `CANCEL_RE` check:

```typescript
  const newCategoryMatch = NEW_CATEGORY_RE.exec(message);
  if (newCategoryMatch !== null) {
    const rawName = (newCategoryMatch[1] ?? "").trim();
    if (rawName.length === 0) {
      const next: ConversationState = {
        ...state,
        status: "awaiting_category_name",
      };
      return {
        state: next,
        reply: askCategoryNameMessage(),
        keyboard: cancelOnlyKeyboard(),
      };
    }
    const validated = validateCategoryName(rawName);
    if (!validated.ok) {
      return { state, reply: validated.error };
    }
    return createCategoryForDraft(state, validated.name, deps);
  }
```

3f. Standalone command in `startConversation` — FIRST thing in the function body (before the classifier; "nova categoria" must never reach the LLM/parser):

```typescript
  // Manual category creation with NO active conversation (spec §4).
  const newCategoryMatch = NEW_CATEGORY_RE.exec(input.text);
  if (newCategoryMatch !== null) {
    const ballast = placeholderDraft(input, inputKind, options.today);
    const rawName = (newCategoryMatch[1] ?? "").trim();
    if (rawName.length === 0) {
      return {
        state: {
          status: "awaiting_category_name",
          draft: ballast,
          standaloneCategoryCreation: true,
        },
        reply: askCategoryNameMessage(),
        keyboard: cancelOnlyKeyboard(),
      };
    }
    const validated = validateCategoryName(rawName);
    if (!validated.ok) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: validated.error,
      };
    }
    const resolved = await createOrReuseCategory(validated.name, deps);
    if (resolved === null) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: notUnderstoodMessage(),
      };
    }
    await deps.logInteraction({
      fromUserId: input.fromUserId,
      inputKind,
      messageText: input.text,
    });
    return {
      state: { status: "cancelled", draft: ballast },
      reply: resolved.reused
        ? categoryReusedMessage(validated.name)
        : categoryCreatedMessage(validated.name),
    };
  }
```

(`inputKind` is computed at the top of `startConversation` already — move `const inputKind` above this block.)

3g. Wire the `nc` token in `applyCallback` — before the final fall-through:

```typescript
  if (token === TOKENS.newCategory) {
    const next: ConversationState = { ...state, status: "awaiting_category_name" };
    return {
      state: next,
      reply: askCategoryNameMessage(),
      keyboard: cancelOnlyKeyboard(),
    };
  }
```

Also update the Task 5 `cancelCategoryName` to route standalone mode to a full cancel:

```typescript
function cancelCategoryName(
  state: ConversationState,
  deps: ConversationDeps,
): ApplyCallbackOutcome {
  if (state.standaloneCategoryCreation === true) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
  const next: ConversationState = {
    ...state,
    status: "awaiting_confirmation",
    standaloneCategoryCreation: undefined,
  };
  return summaryOutcome(next, deps);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`
Expected: PASS — including the existing obligation/classifier tests (`nova categoria` short-circuits before the classifier, so none of their fixtures collide).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/conversation.ts apps/bot/src/conversation-callbacks.test.ts
git commit -m "feat(bot): manual category creation via nova categoria command and grid button"
```

---

### Task 8: Webhook wiring — callback routing, deps, allowed_updates, docs

**Files:**
- Modify: `apps/bot/src/index.ts`
- Modify: `deploy/README.md` (~line 104) and `docs/runbooks/local-mvp-verification.md` (~line 151)
- Test: `apps/bot/src/bot-callbacks.test.ts` (create — handler-level tests; the full integration flow is Task 9 in the same file)

**Interfaces:**
- Consumes: `parseTelegramCallback`, extended `TelegramClient` (Task 1), `applyCallback` (Tasks 5–7), `createCategory` from `@family-finance/db` (Task 2).
- Produces: `handleWebhook` routes callbacks; `buildDeps` provides `listAllCategories`/`createCategory`/`restoreCategory`/`seedCategorizationMemory`/`listActiveMembers`; `startBot` warns when the webhook misses callbacks; `handleWebhook` persists `promptMessageId` and strips stale keyboards.

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/bot-callbacks.test.ts` with the shared fixtures (copy the `fakeQueryBuilder`/`fakeSupabase`/`resolveMemberFake`/`textUpdate`/`SECRET` helpers from `bot.test.ts` verbatim — they are module-private there) plus a richer `fakeTelegram`:

```typescript
import { describe, it, expect } from "vitest";

import { handleWebhook } from "./index.js";
import { createInMemoryConversationStore } from "./store.js";
import type { TelegramClient, InlineKeyboardMarkup } from "./telegram.js";
import type { AppSupabaseClient, BotMemberIdentity } from "@family-finance/db";
import type { AiCategorizer } from "@family-finance/categorization";

// ⟨paste fakeQueryBuilder, fakeSupabase, resolveMemberFake, textUpdate, SECRET
//  from bot.test.ts here — unchanged⟩

type SentMessage = {
  chatId: string;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

function fakeTelegram(): {
  telegram: TelegramClient;
  sent: SentMessage[];
  answered: { id: string; text?: string }[];
  stripped: { chatId: string; messageId: number }[];
} {
  const sent: SentMessage[] = [];
  const answered: { id: string; text?: string }[] = [];
  const stripped: { chatId: string; messageId: number }[] = [];
  return {
    sent,
    answered,
    stripped,
    telegram: {
      async sendMessage(chatId, text, options) {
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup });
        return { messageId: 1000 + sent.length };
      },
      async answerCallbackQuery(id, text) {
        answered.push({ id, text });
      },
      async editMessageReplyMarkup(chatId, messageId) {
        stripped.push({ chatId, messageId });
      },
    },
  };
}

function callbackUpdate(
  fromId: number,
  data: string,
  chatId = 555,
  messageId = 1001,
): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: `cbq-${data}`,
      from: { id: fromId },
      message: { message_id: messageId, chat: { id: chatId } },
      data,
    },
  };
}

describe("handleWebhook: callback routing", () => {
  it("text draft reply carries the confirmation keyboard and records promptMessageId", async () => {
    const { client } = fakeSupabase();
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();

    await handleWebhook({
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(sent[0]?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
    const state = await store.load("555");
    expect(state?.promptMessageId).toBe(1001);
  });

  it("cf tap: answers the callback, strips the tapped keyboard, saves the transaction", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, sent, answered, stripped } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const base = {
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    };

    await handleWebhook({ ...base, rawBody: textUpdate(777, "Uber 32 reais ontem") });
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") });

    expect(answered).toHaveLength(1);
    expect(stripped).toContainEqual({ chatId: "555", messageId: 1001 });
    expect(tables.transactions).toHaveLength(1);
    expect(sent.at(-1)?.text).toContain("Lançamento salvo");
  });

  it("a tap with NO stored conversation answers Sessão expirada and strips", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, answered, stripped, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();

    await handleWebhook({
      rawBody: callbackUpdate(777, "cf", 555, 77),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(answered[0]?.text).toContain("Sessão expirada");
    expect(stripped).toContainEqual({ chatId: "555", messageId: 77 });
    expect(sent).toHaveLength(0);
    expect(tables.transactions).toHaveLength(0);
  });

  it("an unmatched telegram user's tap is answered (spinner stops) and writes NOTHING", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, answered, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();

    await handleWebhook({
      rawBody: callbackUpdate(999, "cf"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(answered).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(tables.transactions).toHaveLength(0);
  });

  it("rejects a callback with a bad webhook secret", async () => {
    const { client } = fakeSupabase();
    const { telegram, answered } = fakeTelegram();
    const result = await handleWebhook({
      rawBody: callbackUpdate(777, "cf"),
      secretHeader: "wrong",
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store: createInMemoryConversationStore(),
    });
    expect(result.status).toBe(401);
    expect(answered).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/bot test -- bot-callbacks`
Expected: FAIL — callbacks fall through `parseTelegramUpdate` as unactionable; no keyboard on text replies.

- [ ] **Step 3: Implement in `apps/bot/src/index.ts`**

3a. Imports: add `parseTelegramCallback, webhookMissesCallbacks, fetchWebhookAllowedUpdates` to the `./telegram.js` import; `applyCallback` to the `./conversation.js` import; `listAllCategories as dbListAllCategories, createCategory as dbCreateCategory, restoreCategory as dbRestoreCategory` to the `@family-finance/db` import; `SESSION_EXPIRED_TOAST` from `./replies.js`.

3b. `buildDeps` — append to the returned object:

```typescript
    // Category creation (inline buttons + nova categoria design, 2026-07-04).
    listAllCategories: async () =>
      (await dbListAllCategories(client, householdId)).map((c) => ({
        id: c.id,
        name: c.name,
        isActive: c.is_active,
      })),
    createCategory: async (name: string) => {
      const row = await dbCreateCategory(client, householdId, name);
      // Make the new category visible to labels/grids within THIS webhook call
      // (deps are rebuilt per update, so this never leaks across requests).
      (catalog.categories as Array<{ id: string; name: string }>).push({
        id: row.id,
        name: row.name,
      });
      return { id: row.id };
    },
    restoreCategory: async (categoryId: string) => {
      await dbRestoreCategory(client, householdId, categoryId);
      const known = catalog.categories.some((c) => c.id === categoryId);
      if (!known) {
        const all = await dbListAllCategories(client, householdId);
        const row = all.find((c) => c.id === categoryId);
        if (row !== undefined) {
          (catalog.categories as Array<{ id: string; name: string }>).push({
            id: row.id,
            name: row.name,
          });
        }
      }
    },
    seedCategorizationMemory: async (entry) => {
      await createCategorizationMemory(client, {
        household_id: householdId,
        pattern: entry.pattern,
        category_id: entry.categoryId,
        subcategory_id: null,
        confidence: entry.confidence,
        explanation: entry.explanation,
        is_active: true,
      });
    },
    listActiveMembers: () =>
      members
        .filter((m) => m.isActive && m.displayName !== null)
        .map((m) => ({ userId: m.userId, displayName: m.displayName as string })),
```

(`createCategorizationMemory` is already imported in this file's db import list — verify; add if missing.)

3c. `handleWebhook` — callback branch FIRST (right after the secret check):

```typescript
  // 0. Inline-button tap: ALWAYS answer the callback (stops the client
  // spinner), then advance the conversation through applyCallback.
  const callback = parseTelegramCallback(args.rawBody);
  if (callback !== null) {
    const strip = async (chatId: string, messageId: number): Promise<void> => {
      try {
        await args.telegram.editMessageReplyMarkup(chatId, messageId);
      } catch (error) {
        // A already-stripped/deleted message must not fail the webhook.
        console.warn("[bot] editMessageReplyMarkup failed:", error);
      }
    };

    // Partial payload (no message/data): answer and ignore.
    if (
      callback.chatId === undefined ||
      callback.messageId === undefined ||
      callback.data === undefined
    ) {
      await args.telegram.answerCallbackQuery(callback.callbackQueryId);
      return { status: 200, body: { ok: true } };
    }

    const identity = await args.resolveMember({
      telegramUserId: callback.fromId,
      telegramUsername: callback.fromUsername,
    });
    if (identity === null) {
      console.warn(
        `[bot] unmatched telegram user ${callback.fromId} tapped a button — refused.`,
      );
      await args.telegram.answerCallbackQuery(callback.callbackQueryId);
      return { status: 200, body: { ok: true } };
    }

    const existing = await args.store.load(callback.chatId);
    if (existing === undefined) {
      // Draft expired past the 24h TTL (or never existed on this chat).
      await args.telegram.answerCallbackQuery(
        callback.callbackQueryId,
        SESSION_EXPIRED_TOAST,
      );
      await strip(callback.chatId, callback.messageId);
      return { status: 200, body: { ok: true } };
    }

    const deps = await buildDeps(
      args.client,
      identity.householdId,
      args.ai,
      args.interpretText,
      args.classifyMessage,
    );
    const outcome = await applyCallback(existing, callback.data, deps, {
      today: todayIso(),
    });

    await args.telegram.answerCallbackQuery(
      callback.callbackQueryId,
      outcome.toast,
    );
    // The tapped message's buttons are spent either way (acted on or stale).
    await strip(callback.chatId, callback.messageId);

    if (outcome.silent !== true && outcome.reply.length > 0) {
      const sent = await args.telegram.sendMessage(
        callback.chatId,
        outcome.reply,
        outcome.keyboard !== undefined
          ? { replyMarkup: outcome.keyboard }
          : undefined,
      );
      outcome.state.promptMessageId = sent?.messageId;
    }
    await args.store.save(callback.chatId, outcome.state);
    return { status: 200, body: { ok: true } };
  }
```

3d. Text/audio paths — attach keyboards and track `promptMessageId`. Replace the two send-and-save endings:

Audio (end of the voice branch):

```typescript
    const sentVoice = await args.telegram.sendMessage(
      voice.chatId,
      outcome.reply,
      outcome.keyboard !== undefined
        ? { replyMarkup: outcome.keyboard }
        : undefined,
    );
    outcome.state.promptMessageId = sentVoice?.messageId;
    await args.store.save(voice.chatId, outcome.state);
    return { status: 200, body: { ok: true } };
```

Text (end of `handleWebhook`) — also strip the PREVIOUS prompt's now-stale keyboard when a typed message advances the conversation:

```typescript
  let reply: string;
  let nextState: ConversationState;
  let keyboard: InlineKeyboardMarkup | undefined;
  if (
    existing === undefined ||
    existing.status === "saved" ||
    existing.status === "cancelled"
  ) {
    const outcome = await startConversation(
      { text: message.text, fromUserId: identity.userId },
      deps,
      { today: todayIso() },
    );
    nextState = outcome.state;
    reply = outcome.reply;
    keyboard = outcome.keyboard;
  } else {
    const outcome = await applyMessage(existing, message.text, deps, {
      today: todayIso(),
    });
    nextState = outcome.state;
    reply = outcome.reply;
    keyboard = outcome.keyboard;
    if (existing.promptMessageId !== undefined) {
      try {
        await args.telegram.editMessageReplyMarkup(
          message.chatId,
          existing.promptMessageId,
        );
      } catch (error) {
        console.warn("[bot] editMessageReplyMarkup failed:", error);
      }
    }
  }

  const sent = await args.telegram.sendMessage(
    message.chatId,
    reply,
    keyboard !== undefined ? { replyMarkup: keyboard } : undefined,
  );
  nextState.promptMessageId = sent?.messageId;
  await args.store.save(message.chatId, nextState);
  return { status: 200, body: { ok: true } };
```

(Import `InlineKeyboardMarkup` as a type from `./telegram.js`. Note the save now happens AFTER the send so `promptMessageId` lands in the store; a Telegram send failure loses one state write, but the webhook already answers 200 on handler errors, matching today's failure envelope.)

3e. `startBot` — after the `telegram` client is built:

```typescript
  // Spec §1: the webhook registration must deliver callback_query, or every
  // button tap silently vanishes. Warn loudly — the fix is a one-line curl
  // (see deploy/README.md).
  if (env.TELEGRAM_BOT_TOKEN) {
    void fetchWebhookAllowedUpdates(env.TELEGRAM_BOT_TOKEN).then((allowed) => {
      if (webhookMissesCallbacks(allowed)) {
        console.warn(
          '[bot] webhook allowed_updates does not include "callback_query" — ' +
            "inline buttons will NOT work. Re-run setWebhook with " +
            'allowed_updates=["message","callback_query"] (deploy/README.md).',
        );
      }
    });
  }
```

3f. Docs — in `deploy/README.md` (~line 107) and `docs/runbooks/local-mvp-verification.md` (~line 151), change the `setWebhook` curl's

```
-d "allowed_updates=[\"message\"]"
```

to

```
-d "allowed_updates=[\"message\",\"callback_query\"]"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/index.ts apps/bot/src/bot-callbacks.test.ts deploy/README.md docs/runbooks/local-mvp-verification.md
git commit -m "feat(bot): route callback_query updates through handleWebhook with keyboards and category deps"
```

---

### Task 9: Integration — full Petz flow + dedupe (fake store + fake telegram)

**Files:**
- Test: `apps/bot/src/bot-callbacks.test.ts` (extend — reuses Task 8's fixtures)

**Interfaces:**
- Consumes: everything. No production code should change in this task — if a test fails, fix the earlier task's module and note it in the commit.

- [ ] **Step 1: Write the integration tests**

Append to `apps/bot/src/bot-callbacks.test.ts`:

```typescript
describe("integration: the Petz flow (spec §6)", () => {
  const petsAi: AiCategorizer = {
    async categorize() {
      return {
        categoryName: "Pets",
        subcategoryName: null,
        confidence: 0.9,
        explanation: "Petz é um pet shop.",
      };
    },
  };

  function petzHarness() {
    const { client, tables } = fakeSupabase();
    const { telegram, sent, answered, stripped } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const base = {
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      ai: petsAi,
    };
    return { base, tables, sent, answered, stripped };
  }

  it("text in → proposal keyboard out → nca tap → created + saved + seeded → memory hit next time", async () => {
    const { base, tables, sent } = petzHarness();

    // 1. New expense for an unknown merchant: proposal keyboard.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Petz 90 reais") });
    const proposal = sent.at(-1);
    expect(proposal?.text).toContain('Categoria: "Pets" (nova — sugerida)');
    expect(proposal?.replyMarkup?.inline_keyboard[0]?.[0]).toEqual({
      text: '✅ Confirmar (cria "Pets")',
      callback_data: "nca",
    });

    // 2. One tap: category created (active), transaction saved, memory seeded.
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "nca", 555, 1001),
    });
    const category = tables.categories.find((c) => c.name === "Pets");
    expect(category).toBeDefined();
    expect(category?.is_active).toBe(true);
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions[0]?.category_id).toBe(category?.id);
    expect(tables.categorization_memory).toHaveLength(1);
    expect(tables.categorization_memory[0]).toMatchObject({
      pattern: "petz",
      category_id: category?.id,
      confidence: 0.95,
    });
    expect(String(tables.categorization_memory[0]?.explanation)).toContain(
      "criada pelo usuário via bot",
    );
    expect(sent.at(-1)?.text).toContain("Lançamento salvo");

    // 3. Same merchant again: memory resolves it — no proposal this time.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Petz 55 reais") });
    const second = sent.at(-1);
    expect(second?.text).not.toContain("(nova — sugerida)");
    expect(second?.text).toContain("Categoria: Pets");
  });

  it("dedupe: proposing 'pets' when 'Pets' exists assigns, not duplicates", async () => {
    const { base, tables, sent } = petzHarness();
    tables.categories.push({
      id: "cat-pets-existing",
      household_id: "house-1",
      name: "Pets",
      is_active: true,
    });
    // The catalog now contains "Pets", so the engine resolves the AI's
    // suggestion to the EXISTING id — no proposal, no creation.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "petz 30 reais") });
    expect(sent.at(-1)?.text).not.toContain("(nova — sugerida)");
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf", 555, 1001) });
    expect(
      tables.categories.filter((c) => String(c.name).toLowerCase() === "pets"),
    ).toHaveLength(1);
    expect(tables.transactions[0]?.category_id).toBe("cat-pets-existing");
  });

  it("dedupe at accept-time: an ARCHIVED 'pets' is reactivated by nca, not duplicated", async () => {
    const { base, tables } = petzHarness();
    tables.categories.push({
      id: "cat-pets-archived",
      household_id: "house-1",
      name: "pets",
      is_active: false,
    });
    // Archived categories are NOT in the engine catalog → the AI proposal
    // still fires; the accept path must find and reactivate the archived row.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Petz 90 reais") });
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "nca", 555, 1001) });

    const rows = tables.categories.filter(
      (c) => String(c.name).toLowerCase() === "pets",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_active).toBe(true);
    expect(tables.transactions[0]?.category_id).toBe("cat-pets-archived");
  });

  it("manual: nova categoria via grid button, end to end", async () => {
    const { base, tables, sent } = petzHarness();
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Uber 32 reais ontem") });
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cats", 555, 1001) });
    expect(sent.at(-1)?.text).toBe("Escolha a categoria:");
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "nc", 555, 1002) });
    expect(sent.at(-1)?.text).toContain("nome da nova categoria");
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Viagens") });
    expect(tables.categories.some((c) => c.name === "Viagens")).toBe(true);
    // Manual creation seeds NO memory.
    expect(tables.categorization_memory).toHaveLength(0);
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf", 555, 1004) });
    expect(tables.transactions).toHaveLength(1);
  });
});
```

> Fake-store note: `fakeSupabase`'s `insert` (copied from `bot.test.ts`) does not set `is_active`, but the real `createCategory` payload now includes `is_active: true` explicitly, so `findCategoriesByHousehold`'s `.eq("is_active", true)` filter sees new rows. The archived-reactivation test relies on `restoreCategory`'s `update` — the copied `fakeQueryBuilder` has no `update` method, so **extend the copied builder** with:

```typescript
    update(patch: FakeRow) {
      // Applied on finish(), like delete: mutate the filtered rows in place.
      for (const row of filtered) {
        Object.assign(row, patch);
      }
      return api;
    },
```

(add it inside `fakeQueryBuilder`'s `api` object in this test file's copy; `update().eq().eq()` then works because `eq` filters and the mutation already happened — to keep ordering correct, apply the patch lazily: store `patchMode` like `deleteMode` and apply in `finish()` after the `eq` filters run. Concretely:)

```typescript
  let patch: FakeRow | null = null;
  // in finish(), before returning:
  //   if (patch !== null) { for (const row of filtered) Object.assign(row, patch); }
  // and in api:
    update(payload: FakeRow) {
      patch = payload;
      return api;
    },
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @family-finance/bot test -- bot-callbacks`
Expected: PASS. If a failure exposes a bug in Tasks 5–8, fix it in the owning module (not by weakening the test).

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/bot-callbacks.test.ts
git commit -m "test(bot): end-to-end Petz proposal, dedupe/reactivation, and manual-creation flows"
```

---

### Task 10: Full gate

- [ ] **Step 1: Run the complete gate from the repo root**

```bash
cd /Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

Expected: all four green. Typical stragglers:
- `apps/bot/dist/` stale `.d.ts` conflicts → `rm -rf apps/bot/dist` and rebuild.
- Web app compiling against the widened `SummaryView`/`TelegramClient` — web does not import them; if turbo surfaces an unrelated cache issue, re-run with `--force`.

- [ ] **Step 2: Fix anything red, re-run until green**

- [ ] **Step 3: Final commit (only if fixes were needed)**

```bash
git add -A
git commit -m "chore(bot): green full gate for inline buttons + category creation"
```

---

## Self-Review (done at planning time)

**Spec coverage:** §1 transport → Task 1 (+ Task 8 allowed_updates warning + docs). §2 state machine/keyboards → Tasks 3, 5, 7. §3 AI proposal + dedupe + memory seed → Task 6 (+ integration Task 9; no `packages/categorization` change needed — `pending_new_category`/`pendingCategory` already exist and are consumed as-is). §4 manual creation → Task 7. §5 edge cases → Tasks 5 (stale/double-tap/unknown tokens), 7 (command-word names), 4+8 (keyboard-less degradation: text keeps hints; send options are additive). §6 testing → each task is TDD'd; integration in Task 9; full gate Task 10. Out-of-scope list respected (no subcategory flows, no valor/data buttons, no pagination, no web changes beyond none, no memory on regular corrections).

**Known judgment calls (approved-design-consistent):**
- Typed `confirmar` while a proposal is pending creates the category (parity with the `nca` button label "Confirmar (cria …)").
- The accept path seeds memory even when dedupe reused an existing/reactivated category — the user confirmed merchant→category, which is exactly what memory records.
- Standalone category creation terminates in status `cancelled` (terminal, nothing else pending); the reply is the creation confirmation.
- `applyCallback` on obligation states answers "Sessão expirada" — obligation keyboards are out of scope.
