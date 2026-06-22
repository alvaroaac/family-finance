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
  /** The message text. */
  text: string;
};

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number().optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z
        .object({ id: z.union([z.number(), z.string()]) })
        .optional(),
      text: z.string().optional(),
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
    text: message.text,
  };
}

// ---------------------------------------------------------------------------
// Outgoing client interface + HTTP implementation.
// ---------------------------------------------------------------------------

/** Minimal injectable Telegram client used to send replies. */
export type TelegramClient = {
  sendMessage(chatId: string, text: string): Promise<void>;
};

/**
 * Real Bot API client. Constructed only when a token is configured; never used
 * by unit tests (which pass a mock). Uses the global `fetch` (Node 22).
 */
export function createHttpTelegramClient(botToken: string): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;
  return {
    async sendMessage(chatId: string, text: string): Promise<void> {
      const response = await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Telegram sendMessage failed: ${response.status} ${body}`,
        );
      }
    },
  };
}

/** A no-op client (useful for dry-run / unconfigured local environments). */
export function createNoopTelegramClient(): TelegramClient {
  return {
    async sendMessage(): Promise<void> {
      // Intentionally does nothing.
    },
  };
}
