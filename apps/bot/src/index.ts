/**
 * @family-finance/bot
 *
 * Telegram entry point. The bot is a THIN consumer of the shared core: it parses
 * a Portuguese message into a draft, asks the categorization engine
 * (@family-finance/categorization) for a suggestion, builds the transaction via
 * @family-finance/domain (default responsibility = the house, createdByUserId =
 * the linked Telegram identity), and persists it via @family-finance/db — exactly
 * like the web app. It never re-implements transaction or categorization logic.
 *
 * Confirmation is ON by default: a message produces an editable summary and the
 * transaction is only saved after an explicit confirm. Conversation state is
 * kept per chat in an in-memory store for the MVP (single small household).
 */

import { getServerEnv } from "@family-finance/config";
import {
  createDatabaseClient,
  createTransaction as dbCreateTransaction,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  findHouseholdIdForCurrentUser,
  findAccountsByHousehold,
  listCreditCards,
  listActiveCategorizationMemory,
  type AppSupabaseClient,
} from "@family-finance/db";
import {
  suggestCategory,
  type CategoryCatalog,
  type CategorizationContext,
  type CategorizationMemoryStore,
  type CategorizationMemoryEntry,
} from "@family-finance/categorization";

import {
  createHttpTelegramClient,
  createNoopTelegramClient,
  parseTelegramUpdate,
  verifyWebhookSecret,
  type TelegramClient,
} from "./telegram.js";
import {
  startConversation,
  applyMessage,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";

/** Per-chat in-memory conversation store (MVP — one small household). */
const conversations = new Map<string, ConversationState>();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  const memoryStore = memoryStoreFor(client);

  return {
    householdId,
    catalog,
    defaultAccountId: checking?.id ?? "",
    resolveCardId: () => cards[0]?.id,
    resolveAccountId: () => checking?.id,
    // The MVP has two known users; mapping a free-text name to a user id is a
    // household-membership lookup. Without a names table we leave it to the house
    // unless a future task wires display names -> member ids.
    resolveResponsibleUserId: () => undefined,
    suggestCategory: (context: CategorizationContext) =>
      suggestCategory(context, { catalog, memoryStore }),
    createTransaction: async (draft) => {
      const persisted = await dbCreateTransaction(client, draft);
      return { id: persisted.id };
    },
    logInteraction: async (entry) => {
      await client.from("bot_interactions").insert({
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
  };
}

export type WebhookResult = {
  status: number;
  body: { ok: boolean; error?: string };
};

/**
 * Handle one Telegram webhook request. Verifies the secret, parses the update,
 * advances the per-chat conversation, and sends the reply via the injected
 * Telegram client. Returns an HTTP-style result so a Next.js route or a small
 * server can wrap it.
 */
export async function handleWebhook(args: {
  rawBody: unknown;
  secretHeader: string | undefined;
  configuredSecret: string | undefined;
  client: AppSupabaseClient;
  telegram: TelegramClient;
  householdId: string;
}): Promise<WebhookResult> {
  if (!verifyWebhookSecret(args.secretHeader, args.configuredSecret)) {
    return { status: 401, body: { ok: false, error: "invalid secret" } };
  }

  const message = parseTelegramUpdate(args.rawBody);
  if (message === null) {
    // Nothing actionable (non-text / unsupported update) — acknowledge so
    // Telegram does not retry.
    return { status: 200, body: { ok: true } };
  }

  const deps = await buildDeps(args.client, args.householdId);
  const existing = conversations.get(message.chatId);

  let reply: string;
  let nextState: ConversationState;
  if (
    existing === undefined ||
    existing.status === "saved" ||
    existing.status === "cancelled"
  ) {
    const outcome = await startConversation(
      { text: message.text, fromUserId: message.fromId },
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
  conversations.set(message.chatId, nextState);

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
  const env = getServerEnv();
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required to run the bot.");
  }
  const client = createDatabaseClient({
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }) as AppSupabaseClient;

  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) {
    throw new Error("No household is available for the bot identity.");
  }

  const telegram: TelegramClient = env.TELEGRAM_BOT_TOKEN
    ? createHttpTelegramClient(env.TELEGRAM_BOT_TOKEN)
    : createNoopTelegramClient();

  return {
    handle: (rawBody, secretHeader) =>
      handleWebhook({
        rawBody,
        secretHeader,
        configuredSecret: env.TELEGRAM_WEBHOOK_SECRET,
        client,
        telegram,
        householdId,
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
  createHttpTelegramClient,
  type TelegramClient,
  type IncomingTextMessage,
} from "./telegram.js";
export {
  startConversation,
  applyMessage,
  type ConversationState,
  type ConversationDeps,
  type ConversationOutcome,
} from "./conversation.js";
