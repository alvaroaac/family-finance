/**
 * Telegram transport for the bot: webhook secret verification, update payload
 * parsing, and an injectable Bot API client.
 *
 * The client is an INTERFACE so tests (and the conversation orchestration) can
 * mock outgoing calls — no real network is required for unit tests. The HTTP
 * implementation is only constructed when a real bot token is configured.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Webhook secret verification.
// ---------------------------------------------------------------------------

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header against the configured
 * `TELEGRAM_WEBHOOK_SECRET`. Fails CLOSED: if no secret is configured, every
 * request is rejected so an unconfigured deployment cannot accept writes.
 *
 * Uses a length-aware constant-time-ish comparison to avoid trivially leaking
 * the secret length difference through early exit.
 */
export function verifyWebhookSecret(
  headerToken: string | undefined | null,
  configuredSecret: string | undefined | null,
): boolean {
  if (!configuredSecret) {
    return false;
  }
  if (!headerToken) {
    return false;
  }
  if (headerToken.length !== configuredSecret.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < headerToken.length; i += 1) {
    diff |= headerToken.charCodeAt(i) ^ configuredSecret.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Update payload parsing.
// ---------------------------------------------------------------------------

/** A normalized inbound text message extracted from a Telegram update. */
export type IncomingTextMessage = {
  updateId: number;
  /** Telegram chat id, as a string (chat ids can exceed 32-bit ints). */
  chatId: string;
  /** Telegram user id of the sender, as a string. */
  fromId: string;
  /** Telegram @username of the sender (without "@"), when they have one. */
  fromUsername?: string;
  /** The message text. */
  text: string;
};

const telegramFileSchema = z.object({
  file_id: z.string(),
  mime_type: z.string().optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number().optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z
        .object({
          id: z.union([z.number(), z.string()]),
          username: z.string().optional(),
        })
        .optional(),
      text: z.string().optional(),
      voice: telegramFileSchema.optional(),
      audio: telegramFileSchema.optional(),
    })
    .optional(),
});

/**
 * Parse a raw Telegram update into a normalized text message, or `null` when the
 * update does not carry a usable text message (e.g. audio-only, edited, or a
 * callback — those are handled elsewhere / in Task 8).
 */
export function parseTelegramUpdate(raw: unknown): IncomingTextMessage | null {
  const result = telegramUpdateSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const update = result.data;
  const message = update.message;
  if (
    message === undefined ||
    message.text === undefined ||
    message.text.trim().length === 0 ||
    message.from === undefined
  ) {
    return null;
  }
  return {
    updateId: update.update_id,
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    fromUsername: message.from.username,
    text: message.text,
  };
}

/** A normalized inbound voice/audio message extracted from a Telegram update. */
export type IncomingVoiceMessage = {
  updateId: number;
  chatId: string;
  fromId: string;
  /** Telegram @username of the sender (without "@"), when they have one. */
  fromUsername?: string;
  /** Telegram file_id of the voice/audio attachment. */
  fileId: string;
  /** Optional MIME type (e.g. "audio/ogg"). */
  mimeType?: string;
};

/**
 * Parse a raw Telegram update into a normalized voice/audio message, or `null`
 * when the update carries no usable voice/audio (e.g. text-only). Audio is then
 * transcribed and routed through the SAME confirmation flow as text.
 */
export function parseTelegramVoice(raw: unknown): IncomingVoiceMessage | null {
  const result = telegramUpdateSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const message = result.data.message;
  if (message === undefined || message.from === undefined) {
    return null;
  }
  const file = message.voice ?? message.audio;
  if (file === undefined) {
    return null;
  }
  return {
    updateId: result.data.update_id,
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    fromUsername: message.from.username,
    fileId: file.file_id,
    mimeType: file.mime_type,
  };
}

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

// ---------------------------------------------------------------------------
// Outgoing client interface + HTTP implementation.
// ---------------------------------------------------------------------------

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
