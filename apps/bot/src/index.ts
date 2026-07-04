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
  parseTelegramUpdate,
  parseTelegramVoice,
  verifyWebhookSecret,
  type TelegramClient,
} from "./telegram.js";
import {
  startConversation,
  startConversationFromAudio,
  applyMessage,
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

/** pt-BR refusal for a Telegram user no household member is linked to. */
const UNKNOWN_USER_REPLY =
  "Oi! Eu ainda não conheço você por aqui — peça pro Alvaro vincular seu Telegram nas Configurações.";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
    if (args.transcribe === undefined) {
      // Audio is unsupported without a transcription provider; ask for text.
      await args.telegram.sendMessage(
        voice.chatId,
        "Transcrição de áudio não está configurada. Envie o lançamento por texto, por favor.",
      );
      return { status: 200, body: { ok: true } };
    }
    let outcome;
    try {
      outcome = await startConversationFromAudio(
        {
          voice: { fileId: voice.fileId, mimeType: voice.mimeType },
          fromUserId: identity.userId,
        },
        deps,
        args.transcribe,
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
    await args.store.save(voice.chatId, outcome.state);
    await args.telegram.sendMessage(voice.chatId, outcome.reply);
    return { status: 200, body: { ok: true } };
  }

  // 2. Text (incoming is the parsed text message here).
  if (message === null) {
    return { status: 200, body: { ok: true } };
  }

  const existing = await args.store.load(message.chatId);

  let reply: string;
  let nextState: ConversationState;
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
  } else {
    const outcome = await applyMessage(existing, message.text, deps, {
      today: todayIso(),
    });
    nextState = outcome.state;
    reply = outcome.reply;
  }
  await args.store.save(message.chatId, nextState);

  await args.telegram.sendMessage(message.chatId, reply);
  return { status: 200, body: { ok: true } };
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
