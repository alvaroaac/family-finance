/**
 * Conversation stores for the Telegram bot.
 *
 * The state machine in conversation.ts is pure (state in, state out); the
 * store is the ONLY stateful piece around it. Two implementations share one
 * contract: an in-memory Map for unit tests, and a DB-backed store over
 * `bot_conversations` (service-role only — the table has RLS enabled with zero
 * policies) so conversations survive bot restarts.
 *
 * Staleness: an ordinary persisted row older than 24h is treated as absent on
 * load and deleted lazily — a half-finished draft from yesterday should never
 * be what a fresh "Uber 32 reais" message lands on. Post-write installment
 * uncertainty is retained until it is explicitly reconciled: its stable
 * idempotency key is the only safe way to retry without duplicating a purchase.
 * The persisted jsonb is validated structurally on load; a malformed row is
 * treated as absent (never thrown).
 */

import {
  loadBotConversation,
  saveBotConversation,
  deleteBotConversation,
  type AppSupabaseClient,
} from "@family-finance/db";

import type { ConversationState, ConversationStatus } from "./conversation.js";

export type ConversationStore = {
  /** Load a chat's conversation state, or undefined when absent/stale/malformed. */
  load(
    chatId: string,
    telegramUserId: string,
    householdId: string,
  ): Promise<ConversationState | undefined>;
  /** Persist a chat's conversation state (upsert). */
  save(
    chatId: string,
    telegramUserId: string,
    householdId: string,
    state: ConversationState,
  ): Promise<void>;
  delete(chatId: string, telegramUserId: string): Promise<void>;
  /** Whether another sender owns the draft attached to this Telegram message. */
  hasOtherPrompt(
    chatId: string,
    telegramUserId: string,
    messageId: number,
  ): Promise<boolean>;
};

/** Conversations older than this are treated as abandoned (absent on load). */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

const DURABLE_INSTALLMENT_STATUSES = [
  "installment_submission_started",
  "installment_outcome_uncertain",
  "installment_recovery_required",
] as const satisfies readonly ConversationStatus[];

const CONVERSATION_STATUSES = [
  "awaiting_confirmation",
  "needs_amount",
  "saved",
  "cancelled",
  "awaiting_obligation_confirmation",
  "awaiting_installment_confirmation",
  "installment_submission_started",
  "installment_outcome_uncertain",
  "installment_recovery_required",
  "awaiting_card_bill_confirmation",
  "awaiting_mark_paid_choice",
  "awaiting_payment_choice",
  "awaiting_category_name",
] as const satisfies readonly ConversationStatus[];

function isConversationStatus(value: unknown): value is ConversationStatus {
  return (
    typeof value === "string" &&
    CONVERSATION_STATUSES.includes(value as ConversationStatus)
  );
}

function isDurableInstallmentStatus(status: ConversationStatus): boolean {
  return DURABLE_INSTALLMENT_STATUSES.includes(
    status as (typeof DURABLE_INSTALLMENT_STATUSES)[number],
  );
}

function requiresInstallmentIdentity(status: ConversationStatus): boolean {
  return (
    status === "awaiting_installment_confirmation" ||
    isDurableInstallmentStatus(status)
  );
}

function hasInstallmentIdentity(state: ConversationState): boolean {
  return (
    typeof state.installmentDraft?.idempotencyKey === "string" &&
    state.installmentDraft.idempotencyKey.length > 0
  );
}

function isDurableConversationState(state: ConversationState): boolean {
  return (
    isDurableInstallmentStatus(state.status) ||
    (state.status === "awaiting_installment_confirmation" &&
      hasInstallmentIdentity(state))
  );
}

/** In-memory store — unit tests and local dry runs (state dies with the process). */
export function createInMemoryConversationStore(): ConversationStore {
  const conversations = new Map<
    string,
    { householdId: string; state: ConversationState }
  >();
  const key = (chatId: string, telegramUserId: string) =>
    `${chatId}:${telegramUserId}`;
  return {
    async load(
      chatId: string,
      telegramUserId: string,
      householdId: string,
    ): Promise<ConversationState | undefined> {
      const stored = conversations.get(key(chatId, telegramUserId));
      if (stored !== undefined && stored.householdId !== householdId) {
        conversations.delete(key(chatId, telegramUserId));
        return undefined;
      }
      return stored?.state;
    },
    async save(
      chatId: string,
      telegramUserId: string,
      householdId: string,
      state: ConversationState,
    ): Promise<void> {
      conversations.set(key(chatId, telegramUserId), { householdId, state });
    },
    async delete(chatId: string, telegramUserId: string): Promise<void> {
      conversations.delete(key(chatId, telegramUserId));
    },
    async hasOtherPrompt(
      chatId: string,
      telegramUserId: string,
      messageId: number,
    ): Promise<boolean> {
      for (const [storedKey, { state }] of conversations) {
        if (
          storedKey.startsWith(`${chatId}:`) &&
          storedKey !== key(chatId, telegramUserId) &&
          state.promptMessageId === messageId
        ) {
          return true;
        }
      }
      return false;
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
  const candidate = value as {
    status?: unknown;
    draft?: unknown;
    installmentDraft?: unknown;
  };
  if (!isConversationStatus(candidate.status)) {
    return false;
  }
  const status = candidate.status;
  const baseStateIsValid =
    typeof candidate.draft === "object" && candidate.draft !== null;
  if (!baseStateIsValid) {
    return false;
  }
  if (!requiresInstallmentIdentity(status)) {
    return true;
  }

  if (
    typeof candidate.installmentDraft !== "object" ||
    candidate.installmentDraft === null
  ) {
    return false;
  }
  return true;
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
    async load(
      chatId: string,
      telegramUserId: string,
      householdId: string,
    ): Promise<ConversationState | undefined> {
      const row = await loadBotConversation(
        client,
        Number(chatId),
        Number(telegramUserId),
      );
      if (row === null) {
        return undefined;
      }
      if (row.householdId !== householdId) {
        await deleteBotConversation(
          client,
          Number(chatId),
          Number(telegramUserId),
        );
        return undefined;
      }
      if (!isConversationState(row.state)) {
        return undefined;
      }
      if (
        requiresInstallmentIdentity(row.state.status) &&
        row.state.installmentDraft !== undefined &&
        !hasInstallmentIdentity(row.state)
      ) {
        const recoveryState: ConversationState = {
          ...row.state,
          status: "installment_recovery_required",
        };
        await saveBotConversation(
          client,
          Number(chatId),
          Number(telegramUserId),
          row.householdId,
          recoveryState,
        );
        return recoveryState;
      }
      const ageMs = Date.now() - new Date(row.updatedAt).getTime();
      if (
        (!Number.isFinite(ageMs) || ageMs > CONVERSATION_TTL_MS) &&
        !isDurableConversationState(row.state)
      ) {
        // Ordinary stale (or unparseable timestamp) state is abandoned. The
        // post-write safety states and a keyed pre-write state remain available
        // until explicit reconciliation, so a committed RPC can always be
        // retried with the same identity after a later state-save failure.
        await deleteBotConversation(
          client,
          Number(chatId),
          Number(telegramUserId),
        );
        return undefined;
      }
      return row.state;
    },
    async save(
      chatId: string,
      telegramUserId: string,
      householdId: string,
      state: ConversationState,
    ): Promise<void> {
      await saveBotConversation(
        client,
        Number(chatId),
        Number(telegramUserId),
        householdId,
        state,
      );
    },
    async delete(chatId: string, telegramUserId: string): Promise<void> {
      await deleteBotConversation(
        client,
        Number(chatId),
        Number(telegramUserId),
      );
    },
    async hasOtherPrompt(
      chatId: string,
      telegramUserId: string,
      messageId: number,
    ): Promise<boolean> {
      const { data, error } = await client
        .from("bot_conversations")
        .select("telegram_user_id, state")
        .eq("chat_id", Number(chatId));
      if (error) {
        throw new Error(`hasOtherPrompt failed: ${error.message}`);
      }
      return (data ?? []).some(
        (row) =>
          String(row.telegram_user_id) !== telegramUserId &&
          typeof row.state === "object" &&
          row.state !== null &&
          (row.state as { promptMessageId?: unknown }).promptMessageId ===
            messageId,
      );
    },
  };
}
