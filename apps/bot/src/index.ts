/**
 * @family-finance/bot
 *
 * Telegram entry point. The bot is a THIN consumer of the shared core: it parses
 * a Portuguese message into a draft, asks the categorization engine
 * (@family-finance/categorization) for a suggestion, builds the transaction via
 * @family-finance/domain (default responsibility = the sender, createdByUserId =
 * the linked Telegram identity), and persists it via @family-finance/db — exactly
 * like the web app. It never re-implements transaction or categorization logic.
 *
 * Confirmation is ON by default: a message produces an editable summary and the
 * transaction is only saved after an explicit confirm. Conversation state is
 * persisted per chat through an injected ConversationStore (DB-backed in
 * production so conversations survive restarts; in-memory in tests).
 *
 * Identity: each update's Telegram user id is resolved against
 * `household_members.telegram_user_id` (via the injected resolveMember). An
 * unmatched sender gets one polite refusal and NOTHING is written — there is
 * no household to scope a row to.
 */

import {
  getBotServerEnv,
  getLlmConfig,
  getTranscriptionConfig,
} from "@family-finance/config";
import {
  createServiceRoleClient,
  createTransaction as dbCreateTransaction,
  createBotInteraction,
  createObligation as dbCreateObligation,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  findAccountsByHousehold,
  resolveTelegramMember,
  listCreditCards,
  listHouseholdMembers,
  listActiveCategorizationMemory,
  listObligations,
  materializeObligationPayment as dbMaterializeObligationPayment,
  listAllCategories as dbListAllCategories,
  createCategory as dbCreateCategory,
  restoreCategory as dbRestoreCategory,
  createCategorizationMemory,
  type AppSupabaseClient,
  type BotMemberIdentity,
} from "@family-finance/db";
import {
  suggestCategory,
  createAiCategorizer,
  type CategoryCatalog,
  type CategorizationContext,
  type CategorizationMemoryStore,
  type CategorizationMemoryEntry,
  type AiCategorizer,
} from "@family-finance/categorization";

import {
  createHttpTelegramClient,
  createNoopTelegramClient,
  parseTelegramCallback,
  parseTelegramUpdate,
  parseTelegramVoice,
  verifyWebhookSecret,
  webhookMissesCallbacks,
  fetchWebhookAllowedUpdates,
  type InlineKeyboardMarkup,
  type TelegramClient,
} from "./telegram.js";
import {
  startConversation,
  startConversationFromAudio,
  applyCallback,
  applyMessage,
  isBareConfirmation,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";
import {
  createHttpAudioDownloader,
  VoiceNoteTooLargeError,
  type AudioDownloader,
  type TranscribeDeps,
  type TranscriptionProvider,
} from "./audio.js";
import {
  createAnthropicCompletionClient,
  createOpenAiTranscriptionProvider,
} from "./providers.js";
import {
  createMessageClassifier,
  createTextInterpreter,
  type MessageClassifier,
  type TextInterpreter,
} from "./interpret.js";
import {
  createDbConversationStore,
  type ConversationStore,
} from "./store.js";
import {
  SESSION_EXPIRED_TOAST,
  DRAFT_NOT_YOURS_TOAST,
  ALREADY_SAVED_TOAST,
} from "./replies.js";

/** pt-BR refusal for a Telegram user no household member is linked to. */
const UNKNOWN_USER_REPLY =
  "Oi! Eu ainda não conheço você por aqui — peça pro Alvaro vincular seu Telegram nas Configurações.";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Telegram delivers webhook updates over parallel connections, so two taps in
// quick succession (a physical double-tap on ✅) can be in flight at once. The
// save-before-send ordering inside handleWebhook only protects SEQUENTIAL
// requests; without serialization both would load the same
// awaiting_confirmation state and both insert. This map chains processing per
// chat so the second request observes the first one's saved state. In-process
// only — the bot runs as a single process (see deploy/README.md).
const chatQueues = new Map<string, Promise<void>>();

async function withChatQueue<T>(
  chatId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chatQueues.set(chatId, tail);
  void tail.then(() => {
    if (chatQueues.get(chatId) === tail) {
      chatQueues.delete(chatId);
    }
  });
  return run;
}

/** Case- and accent-insensitive normalization for display-name matching. */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

/** Build a categorization memory store backed by the db, for one household. */
function memoryStoreFor(
  client: AppSupabaseClient,
): CategorizationMemoryStore {
  return {
    async findActiveByHousehold(
      householdId: string,
    ): Promise<CategorizationMemoryEntry[]> {
      const rows = await listActiveCategorizationMemory(client, householdId);
      return rows.map((row) => ({
        id: row.id,
        householdId: row.household_id,
        pattern: row.pattern,
        categoryId: row.category_id,
        subcategoryId: row.subcategory_id,
        confidence: row.confidence ?? 0.95,
        explanation: row.explanation ?? "",
        isActive: row.is_active,
      }));
    },
  };
}

/**
 * Build the conversation dependencies for a household by loading its catalog,
 * accounts, and cards from the database. Categorization and persistence are the
 * SAME shared services the web app uses.
 */
async function buildDeps(
  client: AppSupabaseClient,
  householdId: string,
  ai?: AiCategorizer,
  interpretText?: TextInterpreter,
  classifyMessage?: MessageClassifier,
): Promise<ConversationDeps> {
  const categories = await findCategoriesByHousehold(client, householdId);
  const subcategoryLists = await Promise.all(
    categories.map((c) => findSubcategoriesByCategory(client, householdId, c.id)),
  );
  const catalog: CategoryCatalog = {
    householdId,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    subcategories: subcategoryLists.flat().map((s) => ({
      id: s.id,
      categoryId: s.category_id,
      name: s.name,
    })),
  };

  const accounts = await findAccountsByHousehold(client, householdId);
  const checking =
    accounts.find((a) => a.kind === "checking") ?? accounts[0];
  const cards = await listCreditCards(client, householdId);
  const members = await listHouseholdMembers(client, householdId);
  const memoryStore = memoryStoreFor(client);

  return {
    householdId,
    catalog,
    // undefined (not "") when the household has no account — `persist` then
    // refuses a non-card lançamento with a clear message instead of building
    // an invalid empty accountId.
    defaultAccountId: checking?.id,
    resolveCardId: () => cards[0]?.id,
    resolveAccountId: () => checking?.id,
    // Map a spoken name ("responsável Karol") to an active member by
    // display_name, case- and accent-insensitively. No match — or an ambiguous
    // one — keeps the responsibility with the house (undefined).
    resolveResponsibleUserId: (name: string) => {
      const wanted = normalizeName(name);
      if (wanted.length === 0) {
        return undefined;
      }
      const matches = members.filter(
        (member) =>
          member.isActive &&
          member.displayName !== null &&
          normalizeName(member.displayName) === wanted,
      );
      return matches.length === 1 ? matches[0]?.userId : undefined;
    },
    // Show the responsible member's display name in the confirmation summary.
    memberDisplayName: (userId: string) =>
      members.find((member) => member.isActive && member.userId === userId)
        ?.displayName ?? undefined,
    // AI is the LAST resort inside the engine: it fires only when memory and
    // deterministic rules are uncertain. Omitted when no AI key is configured.
    suggestCategory: (context: CategorizationContext) =>
      suggestCategory(context, { catalog, memoryStore, ai }),
    createTransaction: async (draft) => {
      const persisted = await dbCreateTransaction(client, draft);
      return { id: persisted.id };
    },
    logInteraction: async (entry) => {
      await createBotInteraction(client, {
        household_id: householdId,
        channel: "telegram",
        user_id: entry.fromUserId,
        input_kind: entry.inputKind,
        message_text: entry.messageText,
        confidence: entry.confidence ?? null,
        explanation: entry.explanation ?? null,
        transaction_id: entry.transactionId ?? null,
      });
    },
    // LLM text interpretation (spec §3.4) — consulted on every new entry for a
    // clean description + category hint; the deterministic parser stays the
    // amount/date source. Result stays behind confirmation.
    interpretText,
    // Unified intent classifier (recurring obligations) — sees every NEW
    // message when configured; null falls back to the parser path above.
    classifyMessage,
    // Obligations (PR-1): create + mark-paid flows.
    listActiveObligations: async () =>
      (await listObligations(client, householdId)).map((row) => ({
        id: row.id,
        description: row.description,
        amountCents: row.amount_cents,
      })),
    createObligation: async (draft) => {
      const row = await dbCreateObligation(client, draft);
      return { id: row.id };
    },
    materializeObligationPayment: async ({ obligationId, month, paidOn }) => {
      const result = await dbMaterializeObligationPayment(client, {
        obligationId,
        month,
        paidOn,
      });
      return { alreadyPaid: result.already_paid };
    },
    // "conta Nubank" corrections + the confirmation's payment-source label.
    resolveAccountIdByName: (name: string) => {
      const wanted = normalizeName(name);
      if (wanted.length === 0) {
        return undefined;
      }
      const matches = accounts.filter(
        (account) => normalizeName(account.name) === wanted,
      );
      return matches.length === 1 ? matches[0]?.id : undefined;
    },
    accountNameById: (accountId: string) =>
      accounts.find((account) => account.id === accountId)?.name,
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
    restoreCategory: async (categoryId: string, categoryName: string) => {
      await dbRestoreCategory(client, householdId, categoryId);
      const known = catalog.categories.some((c) => c.id === categoryId);
      if (!known) {
        (catalog.categories as Array<{ id: string; name: string }>).push({
          id: categoryId,
          name: categoryName,
        });
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
  };
}

export type WebhookResult = {
  status: number;
  body: { ok: boolean; error?: string };
};

/**
 * Handle one Telegram webhook request. Verifies the secret, parses the update,
 * resolves the sender to a household member (unmatched senders get one polite
 * refusal and nothing is written), advances the per-chat conversation through
 * the injected store, and sends the reply via the injected Telegram client.
 * Returns an HTTP-style result so a small server can wrap it.
 */
export async function handleWebhook(args: {
  rawBody: unknown;
  secretHeader: string | undefined;
  configuredSecret: string | undefined;
  client: AppSupabaseClient;
  telegram: TelegramClient;
  /** Map a Telegram sender (id + optional @username) to a linked member. */
  resolveMember: (sender: {
    telegramUserId: string;
    telegramUsername?: string;
  }) => Promise<BotMemberIdentity | null>;
  /** Per-chat conversation persistence (DB-backed in production). */
  store: ConversationStore;
  /** Optional AI categorizer (categorization fallback). Omitted = none. */
  ai?: AiCategorizer;
  /** Optional LLM text interpretation fallback (spec §3.4). Omitted = none. */
  interpretText?: TextInterpreter;
  /** Optional unified intent classifier (obligations). Omitted = none. */
  classifyMessage?: MessageClassifier;
  /** Optional transcription wiring for voice notes. Omitted = audio rejected. */
  transcribe?: TranscribeDeps;
}): Promise<WebhookResult> {
  if (!verifyWebhookSecret(args.secretHeader, args.configuredSecret)) {
    return { status: 401, body: { ok: false, error: "invalid secret" } };
  }

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

    const { chatId, messageId, data, callbackQueryId } = callback;

    // Serialized per chat: two concurrent deliveries (physical double-tap)
    // must not both load the same awaiting_confirmation state.
    return withChatQueue(chatId, async (): Promise<WebhookResult> => {
      const existing = await args.store.load(chatId);
      if (existing === undefined) {
        // Draft expired past the 24h TTL (or never existed on this chat).
        await args.telegram.answerCallbackQuery(
          callbackQueryId,
          SESSION_EXPIRED_TOAST,
        );
        await strip(chatId, messageId);
        return { status: 200, body: { ok: true } };
      }

      // Same ownership rule as the typed path's belongsToSender: in a group
      // chat the store is keyed by chat id, so without this check another
      // member's tap on ✅ would confirm the creator's lançamento (or worse,
      // a member of a DIFFERENT household would run the draft against their
      // own catalog/household). Refuse the tap; keep the keyboard — the
      // creator still needs it.
      if (existing.draft.createdByUserId !== identity.userId) {
        await args.telegram.answerCallbackQuery(
          callbackQueryId,
          DRAFT_NOT_YOURS_TOAST,
        );
        return { status: 200, body: { ok: true } };
      }

      let deps: ConversationDeps | undefined;
      const getDeps = async (): Promise<ConversationDeps> => {
        deps ??= await buildDeps(
          args.client,
          identity.householdId,
          args.ai,
          args.interpretText,
          args.classifyMessage,
        );
        return deps;
      };
      const outcome = await applyCallback(existing, data, getDeps, {
        today: todayIso(),
      });

      // Persist FIRST: applyCallback may already have inserted a transaction
      // (e.g. cf/nca). If a later Telegram call throws (stale >15s callback,
      // network hiccup), the webhook still returns 200 to Telegram (no retry),
      // so the state MUST already be saved — otherwise a re-tap on a
      // still-"awaiting_confirmation" state with an unstripped keyboard would
      // insert a second transaction.
      await args.store.save(chatId, outcome.state);

      await args.telegram.answerCallbackQuery(callbackQueryId, outcome.toast);
      // The tapped message's buttons are spent either way (acted on or stale).
      await strip(chatId, messageId);

      if (outcome.silent !== true && outcome.reply.length > 0) {
        const sent = await args.telegram.sendMessage(
          chatId,
          outcome.reply,
          outcome.keyboard !== undefined
            ? { replyMarkup: outcome.keyboard }
            : undefined,
        );
        // Only record promptMessageId when a keyboard was actually attached —
        // a keyboard-less reply has nothing to strip later, and leaving a stale
        // promptMessageId around would cause editMessageReplyMarkup to target
        // the wrong (already-stripped) message on the next turn.
        if (outcome.keyboard !== undefined) {
          outcome.state.promptMessageId = sent?.messageId;
        } else {
          outcome.state.promptMessageId = undefined;
        }
        try {
          await args.store.save(chatId, outcome.state);
        } catch (error) {
          // Best-effort only: losing promptMessageId just means a future stale
          // tap won't get its keyboard stripped, which is already handled.
          console.warn("[bot] re-save after send failed:", error);
        }
      }
      return { status: 200, body: { ok: true } };
    });
  }

  const voice = parseTelegramVoice(args.rawBody);
  const message = voice === null ? parseTelegramUpdate(args.rawBody) : null;
  const incoming = voice ?? message;
  if (incoming === null) {
    // Nothing actionable (unsupported update) — acknowledge so Telegram does
    // not retry.
    return { status: 200, body: { ok: true } };
  }

  // Identity first: the sender's Telegram id must map to a household member.
  // Unmatched → one polite refusal; NOTHING is written (there is no household
  // to scope a bot_interactions row to), so we only log to the console.
  const identity = await args.resolveMember({
    telegramUserId: incoming.fromId,
    telegramUsername: incoming.fromUsername,
  });
  if (identity === null) {
    console.warn(
      `[bot] unmatched telegram user ${incoming.fromId} (chat ${incoming.chatId}) — refused.`,
    );
    await args.telegram.sendMessage(incoming.chatId, UNKNOWN_USER_REPLY);
    return { status: 200, body: { ok: true } };
  }

  const deps = await buildDeps(
    args.client,
    identity.householdId,
    args.ai,
    args.interpretText,
    args.classifyMessage,
  );

  // 1. Voice/audio: transcribe, then run the SAME confirmation flow as text.
  if (voice !== null) {
    const transcribe = args.transcribe;
    if (transcribe === undefined) {
      // Audio is unsupported without a transcription provider; ask for text.
      await args.telegram.sendMessage(
        voice.chatId,
        "Transcrição de áudio não está configurada. Envie o lançamento por texto, por favor.",
      );
      return { status: 200, body: { ok: true } };
    }
    // Serialized per chat (same rule as callbacks/text): a concurrent voice +
    // text confirm must not race load/save on the conversation store.
    return withChatQueue(voice.chatId, async (): Promise<WebhookResult> => {
      let outcome;
      try {
        outcome = await startConversationFromAudio(
          {
            voice: { fileId: voice.fileId, mimeType: voice.mimeType },
            fromUserId: identity.userId,
          },
          deps,
          transcribe,
          { today: todayIso() },
        );
      } catch (error) {
        // Download/transcription failed (timeout, provider error, or an oversize
        // note). Degrade gracefully: ask for text instead of failing the webhook.
        const reply =
          error instanceof VoiceNoteTooLargeError
            ? "Esse áudio é muito longo. Envie o lançamento por texto, por favor."
            : "Não consegui transcrever o áudio agora. Tente por texto, por favor.";
        await args.telegram.sendMessage(voice.chatId, reply);
        return { status: 200, body: { ok: true } };
      }
      // Persist FIRST: startConversationFromAudio may already have inserted a
      // transaction (auto-confirm paths). If sendMessage below throws, the
      // state must already reflect that so a retry/re-send can't double-insert.
      await args.store.save(voice.chatId, outcome.state);

      const sentVoice = await args.telegram.sendMessage(
        voice.chatId,
        outcome.reply,
        outcome.keyboard !== undefined
          ? { replyMarkup: outcome.keyboard }
          : undefined,
      );
      // Only record promptMessageId when a keyboard was actually attached.
      if (outcome.keyboard !== undefined) {
        outcome.state.promptMessageId = sentVoice?.messageId;
      } else {
        outcome.state.promptMessageId = undefined;
      }
      try {
        await args.store.save(voice.chatId, outcome.state);
      } catch (error) {
        console.warn("[bot] re-save after send failed:", error);
      }
      return { status: 200, body: { ok: true } };
    });
  }

  // 2. Text (incoming is the parsed text message here).
  if (message === null) {
    return { status: 200, body: { ok: true } };
  }

  // Serialized per chat (same rule as callbacks): two "sim" messages in
  // flight at once must not both load the same awaiting_confirmation state
  // and both insert.
  return withChatQueue(message.chatId, async (): Promise<WebhookResult> => {
    const existing = await args.store.load(message.chatId);

    // In a group chat the store is keyed by chat id, so a pending draft belongs
    // to whoever started it. If a DIFFERENT member now writes, do NOT feed their
    // message into the first member's draft — that would let B's "sim" confirm
    // A's lançamento (saved with A as responsável) or misread B's expense as a
    // correction to A's. Treat it as a fresh conversation for the new sender.
    const belongsToSender =
      existing !== undefined &&
      existing.draft.createdByUserId === identity.userId;

    // Duplicate typed confirm on an already-saved draft: friendly no-op,
    // parity with the callback path's ALREADY_SAVED_TOAST. Without this the
    // fresh-conversation branch below would parse "sim" as a new entry and
    // clobber the saved state with a bogus needs_amount draft. Only a BARE
    // confirm word — "ok, mercado 50 reais" is a real new lançamento.
    if (
      belongsToSender &&
      existing.status === "saved" &&
      isBareConfirmation(message.text)
    ) {
      await args.telegram.sendMessage(message.chatId, ALREADY_SAVED_TOAST);
      return { status: 200, body: { ok: true } };
    }

    let reply: string;
    let nextState: ConversationState;
    let keyboard: InlineKeyboardMarkup | undefined;
    if (
      existing === undefined ||
      !belongsToSender ||
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
    }

    // Persist FIRST: applyMessage/startConversation may already have inserted a
    // transaction (e.g. typed "confirmar"). If a Telegram call below throws,
    // the state must already be saved so a re-send/retry can't double-insert.
    await args.store.save(message.chatId, nextState);

    const shouldStripPreviousPrompt =
      existing !== undefined &&
      existing.status !== "saved" &&
      existing.status !== "cancelled" &&
      existing.promptMessageId !== undefined &&
      (keyboard !== undefined ||
        nextState.status === "saved" ||
        nextState.status === "cancelled" ||
        nextState !== existing);

    if (shouldStripPreviousPrompt && existing?.promptMessageId !== undefined) {
      try {
        await args.telegram.editMessageReplyMarkup(
          message.chatId,
          existing.promptMessageId,
        );
      } catch (error) {
        console.warn("[bot] editMessageReplyMarkup failed:", error);
      }
    }

    const sent = await args.telegram.sendMessage(
      message.chatId,
      reply,
      keyboard !== undefined ? { replyMarkup: keyboard } : undefined,
    );
    // Only record promptMessageId when a keyboard was actually attached — the
    // previous prompt was already stripped above, so a keyboard-less reply
    // (e.g. needs_amount) must not leave a stale promptMessageId behind (that
    // would cause editMessageReplyMarkup 400 + warn-noise on the next message).
    if (keyboard !== undefined) {
      nextState.promptMessageId = sent?.messageId;
    } else if (shouldStripPreviousPrompt) {
      nextState.promptMessageId = undefined;
    } else if (existing?.promptMessageId !== undefined) {
      nextState.promptMessageId = existing.promptMessageId;
    } else {
      nextState.promptMessageId = undefined;
    }
    try {
      await args.store.save(message.chatId, nextState);
    } catch (error) {
      console.warn("[bot] re-save after send failed:", error);
    }
    return { status: 200, body: { ok: true } };
  });
}

/**
 * Construct the production bot wiring from the environment. Returns a webhook
 * handler bound to a real Supabase client + Telegram client. Throws if required
 * configuration is missing (call this at server start, not at import time).
 */
export async function startBot(): Promise<{
  handle: (rawBody: unknown, secretHeader: string | undefined) => Promise<WebhookResult>;
}> {
  // Bot-scoped env parse: the container carries only the spec §3.5 vars, so
  // web-only settings (NEXT_PUBLIC_*, AUTHORIZED_EMAILS) must not be required.
  const env = getBotServerEnv();
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required to run the bot.");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the bot.");
  }
  const supabaseUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is required to run the bot.");
  }
  // Service-role client: bot_conversations and the pre-session member lookup
  // are unreachable through anon/RLS. Every repo call still passes an explicit
  // household_id, so the bot never queries unscoped.
  const client: AppSupabaseClient = createServiceRoleClient({
    supabaseUrl,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });

  const store = createDbConversationStore(client);
  const resolveMember = (sender: {
    telegramUserId: string;
    telegramUsername?: string;
  }) =>
    resolveTelegramMember(client, {
      telegramUserId: Number(sender.telegramUserId),
      telegramUsername: sender.telegramUsername ?? null,
    });

  const telegram: TelegramClient = env.TELEGRAM_BOT_TOKEN
    ? createHttpTelegramClient(env.TELEGRAM_BOT_TOKEN)
    : createNoopTelegramClient();

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

  // AI features — only when an Anthropic key is configured. ONE completion
  // client backs both the categorization fallback and the text interpretation
  // fallback (spec §3.4); no key = both features simply absent.
  const llm = getLlmConfig();
  const completionClient =
    llm.isConfigured && llm.apiKey !== undefined
      ? createAnthropicCompletionClient({
          apiKey: llm.apiKey,
          model: llm.model,
        })
      : undefined;
  const ai: AiCategorizer | undefined =
    completionClient !== undefined
      ? createAiCategorizer(completionClient)
      : undefined;
  const interpretText: TextInterpreter | undefined =
    completionClient !== undefined
      ? createTextInterpreter(completionClient)
      : undefined;
  const classifyMessage: MessageClassifier | undefined =
    completionClient !== undefined
      ? createMessageClassifier(completionClient)
      : undefined;

  // Voice transcription — only when both a bot token (to fetch the file) and a
  // transcription (OpenAI) key are configured. Raw audio is never persisted:
  // `transcribeVoiceMessage` deletes the temp file in a `finally`.
  const transcription = getTranscriptionConfig();
  let transcribe: TranscribeDeps | undefined;
  if (
    env.TELEGRAM_BOT_TOKEN &&
    transcription.isConfigured &&
    transcription.apiKey !== undefined
  ) {
    const downloader: AudioDownloader = createHttpAudioDownloader(
      env.TELEGRAM_BOT_TOKEN,
    );
    const provider: TranscriptionProvider = createOpenAiTranscriptionProvider({
      apiKey: transcription.apiKey,
      model: transcription.model,
    });
    transcribe = { downloader, provider };
  }

  return {
    handle: (rawBody, secretHeader) =>
      handleWebhook({
        rawBody,
        secretHeader,
        configuredSecret: env.TELEGRAM_WEBHOOK_SECRET,
        client,
        telegram,
        resolveMember,
        store,
        ai,
        interpretText,
        classifyMessage,
        transcribe,
      }),
  };
}

export {
  parseExpenseText,
  type ParsedExpense,
} from "./parser.js";
export {
  verifyWebhookSecret,
  parseTelegramUpdate,
  parseTelegramVoice,
  createHttpTelegramClient,
  type TelegramClient,
  type IncomingTextMessage,
  type IncomingVoiceMessage,
} from "./telegram.js";
export {
  startConversation,
  startConversationFromAudio,
  applyMessage,
  type ConversationState,
  type ConversationDeps,
  type ConversationOutcome,
  type BotInputKind,
} from "./conversation.js";
export {
  transcribeVoiceMessage,
  createHttpAudioDownloader,
  VoiceNoteTooLargeError,
  MAX_VOICE_NOTE_BYTES,
  MAX_VOICE_NOTE_DURATION_SECONDS,
  type AudioDownloader,
  type TranscriptionProvider,
  type TranscribeDeps,
  type TranscribeLimits,
  type VoiceMessageRef,
} from "./audio.js";
export {
  createAnthropicCompletionClient,
  createOpenAiTranscriptionProvider,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "./providers.js";
export {
  createInMemoryConversationStore,
  createDbConversationStore,
  CONVERSATION_TTL_MS,
  type ConversationStore,
} from "./store.js";
export {
  createTextInterpreter,
  buildInterpretationPrompt,
  createMessageClassifier,
  buildClassifierPrompt,
  type InterpretedExpense,
  type TextInterpreter,
  type InterpretedIntent,
  type InterpretedObligation,
  type MessageClassifier,
} from "./interpret.js";
