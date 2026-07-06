import { describe, it, expect, vi, afterEach } from "vitest";

import {
  parseTelegramCallback,
  createHttpTelegramClient,
  createNoopTelegramClient,
  webhookMissesCallbacks,
  fetchWebhookAllowedUpdates,
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

  it("fetchWebhookAllowedUpdates returns allowed_updates on the happy path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { allowed_updates: ["message", "callback_query"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWebhookAllowedUpdates("tok")).resolves.toEqual([
      "message",
      "callback_query",
    ]);
  });

  it("fetchWebhookAllowedUpdates falls back to undefined when result is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      }),
    );

    await expect(fetchWebhookAllowedUpdates("tok")).resolves.toBeUndefined();
  });

  it("fetchWebhookAllowedUpdates falls back to undefined on non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false }),
      }),
    );

    await expect(fetchWebhookAllowedUpdates("tok")).resolves.toBeUndefined();
  });

  it("fetchWebhookAllowedUpdates falls back to undefined on network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(fetchWebhookAllowedUpdates("tok")).resolves.toBeUndefined();
  });
});
