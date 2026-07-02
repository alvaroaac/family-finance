/**
 * Conversation stores for the Telegram bot.
 *
 * The state machine in conversation.ts is pure (state in, state out); the
 * store is the ONLY stateful piece around it. Two implementations share one
 * contract: an in-memory Map for unit tests, and a DB-backed store over
 * `bot_conversations` (service-role only — the table has RLS enabled with zero
 * policies) so conversations survive bot restarts.
 *
 * Staleness: a persisted row older than 24h is treated as absent on load and
 * deleted lazily — a half-finished draft from yesterday should never be what a
 * fresh "Uber 32 reais" message lands on. The persisted jsonb is validated
 * structurally on load; a malformed row is treated as absent (never thrown).
 */

import {
  loadBotConversation,
  saveBotConversation,
  deleteBotConversation,
  type AppSupabaseClient,
} from "@family-finance/db";

import type { ConversationState } from "./conversation.js";

export type ConversationStore = {
  /** Load a chat's conversation state, or undefined when absent/stale/malformed. */
  load(chatId: string): Promise<ConversationState | undefined>;
  /** Persist a chat's conversation state (upsert). */
  save(chatId: string, state: ConversationState): Promise<void>;
};

/** Conversations older than this are treated as abandoned (absent on load). */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory store — unit tests and local dry runs (state dies with the process). */
export function createInMemoryConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationState>();
  return {
    async load(chatId: string): Promise<ConversationState | undefined> {
      return conversations.get(chatId);
    },
    async save(chatId: string, state: ConversationState): Promise<void> {
      conversations.set(chatId, state);
    },
  };
}

/**
 * Structural check of a persisted state: it must at least carry a status and a
 * draft object. Anything else (old schema, corrupted jsonb) is treated as
 * absent so the bot starts a fresh conversation instead of crashing.
 */
function isConversationState(value: unknown): value is ConversationState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { status?: unknown; draft?: unknown };
  return (
    typeof candidate.status === "string" &&
    typeof candidate.draft === "object" &&
    candidate.draft !== null
  );
}

/**
 * DB-backed store over `bot_conversations`. Chat ids arrive as strings from
 * the Telegram parsing layer but the table keys on bigint, so they are
 * converted at this boundary.
 */
export function createDbConversationStore(
  client: AppSupabaseClient,
): ConversationStore {
  return {
    async load(chatId: string): Promise<ConversationState | undefined> {
      const row = await loadBotConversation(client, Number(chatId));
      if (row === null) {
        return undefined;
      }
      const ageMs = Date.now() - new Date(row.updatedAt).getTime();
      if (!Number.isFinite(ageMs) || ageMs > CONVERSATION_TTL_MS) {
        // Stale (or unparseable timestamp): treat as absent, clean up lazily.
        await deleteBotConversation(client, Number(chatId));
        return undefined;
      }
      if (!isConversationState(row.state)) {
        return undefined;
      }
      return row.state;
    },
    async save(chatId: string, state: ConversationState): Promise<void> {
      await saveBotConversation(client, Number(chatId), state);
    },
  };
}
