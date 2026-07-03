import { describe, it, expect, vi, beforeEach } from "vitest";

import { parseExpenseText } from "./parser.js";
import {
  verifyWebhookSecret,
  parseTelegramUpdate,
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
  transcribeVoiceMessage,
  type AudioDownloader,
  type TranscribeDeps,
  type TranscriptionProvider,
} from "./audio.js";
import {
  suggestCategory,
  createAiCategorizer,
  CONFIDENCE,
} from "@family-finance/categorization";
import type { AppSupabaseClient, BotMemberIdentity } from "@family-finance/db";
import { existsSync } from "node:fs";

import { handleWebhook } from "./index.js";
import type { TextInterpreter } from "./interpret.js";
import {
  createInMemoryConversationStore,
  createDbConversationStore,
} from "./store.js";

/** Read the first argument of the first call to a vitest mock (typed). */
function firstCallArg(mock: ReturnType<typeof vi.fn>): unknown {
  const calls = mock.mock.calls;
  const first = calls[0];
  return first ? first[0] : undefined;
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic — no real personal financial data).
// ---------------------------------------------------------------------------

const CATALOG = {
  householdId: "house-1",
  categories: [
    { id: "cat-transport", name: "Transporte" },
    { id: "cat-food", name: "Alimentação" },
  ],
  subcategories: [
    { id: "sub-app", categoryId: "cat-transport", name: "Aplicativo" },
  ],
};

const TODAY = "2026-06-22";

// ---------------------------------------------------------------------------
// parser.ts
// ---------------------------------------------------------------------------

describe("parseExpenseText", () => {
  it("extracts a plain integer value in reais", () => {
    const parsed = parseExpenseText("Uber 32 reais ontem", { today: TODAY });
    expect(parsed.amountCents).toBe(3200);
    expect(parsed.description.toLowerCase()).toContain("uber");
    expect(parsed.occurredOn).toBe("2026-06-21");
  });

  it("extracts a decimal value written as R$ 32,50", () => {
    const parsed = parseExpenseText("Mercado R$ 32,50 hoje", { today: TODAY });
    expect(parsed.amountCents).toBe(3250);
    expect(parsed.occurredOn).toBe("2026-06-22");
  });

  it("parses an explicit DD/MM date hint", () => {
    const parsed = parseExpenseText("Padaria 10 reais 12/03", { today: TODAY });
    expect(parsed.amountCents).toBe(1000);
    expect(parsed.occurredOn).toBe("2026-03-12");
  });

  it("detects a card hint and an account hint", () => {
    const card = parseExpenseText("Almoço 40 reais no cartão", { today: TODAY });
    expect(card.cardHint).toBe(true);
    const acct = parseExpenseText("Almoço 40 reais no débito", { today: TODAY });
    expect(acct.accountHint).toBe(true);
  });

  it("marks value as uncertain when no number is present", () => {
    const parsed = parseExpenseText("Uber ontem", { today: TODAY });
    expect(parsed.amountCents).toBeUndefined();
    expect(parsed.uncertainFields).toContain("amount");
  });

  it("marks date as uncertain (defaults to today) when no date hint is present", () => {
    const parsed = parseExpenseText("Uber 32 reais", { today: TODAY });
    expect(parsed.occurredOn).toBe(TODAY);
    expect(parsed.uncertainFields).toContain("date");
  });
});

// ---------------------------------------------------------------------------
// telegram.ts
// ---------------------------------------------------------------------------

describe("verifyWebhookSecret", () => {
  it("accepts a matching secret token header", () => {
    expect(verifyWebhookSecret("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("rejects a missing or mismatched secret token", () => {
    expect(verifyWebhookSecret(undefined, "s3cr3t")).toBe(false);
    expect(verifyWebhookSecret("nope", "s3cr3t")).toBe(false);
  });

  it("rejects everything when no secret is configured (fail closed)", () => {
    expect(verifyWebhookSecret("anything", undefined)).toBe(false);
  });
});

describe("parseTelegramUpdate", () => {
  it("extracts a text message into a normalized shape", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 555 },
        from: { id: 777, is_bot: false },
        text: "Uber 32 reais ontem",
      },
    };
    const parsed = parseTelegramUpdate(update);
    expect(parsed).not.toBeNull();
    expect(parsed?.chatId).toBe("555");
    expect(parsed?.fromId).toBe("777");
    expect(parsed?.text).toBe("Uber 32 reais ontem");
  });

  it("returns null for an update without a text message", () => {
    expect(parseTelegramUpdate({ update_id: 2 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// conversation.ts — confirmation state machine + persistence
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<ConversationDeps> = {}): {
  deps: ConversationDeps;
  createTransaction: ReturnType<typeof vi.fn>;
  logInteraction: ReturnType<typeof vi.fn>;
} {
  const createTransaction = vi.fn(async (draft: unknown) => ({
    id: "txn-1",
    draft,
  }));
  const logInteraction = vi.fn(async () => undefined);

  const deps: ConversationDeps = {
    householdId: "house-1",
    catalog: CATALOG,
    // Default account used when no card/account is resolved.
    defaultAccountId: "acct-1",
    resolveCardId: () => "card-1",
    resolveAccountId: () => "acct-1",
    resolveResponsibleUserId: () => undefined,
    suggestCategory: async () => ({
      status: "matched" as const,
      suggestion: {
        macroCategoryId: "cat-transport",
        subcategoryId: "sub-app",
        confidence: 0.9,
        explanation: 'descrição contém "uber" -> Transporte > Aplicativo',
        source: "rule" as const,
      },
      requiresConfirmation: false,
    }),
    createTransaction,
    logInteraction,
    ...overrides,
  };
  return { deps, createTransaction, logInteraction };
}

describe("conversation: text -> confirmed transaction", () => {
  let deps: ConversationDeps;
  let createTransaction: ReturnType<typeof vi.fn>;
  let logInteraction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ deps, createTransaction, logInteraction } = buildDeps());
  });

  it("asks for confirmation before saving (does NOT persist on first message)", async () => {
    const { state, reply } = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("awaiting_confirmation");
    expect(createTransaction).not.toHaveBeenCalled();
    // The reply is an editable confirmation summary.
    expect(reply).toMatch(/confirm/i);
    expect(reply).toContain("32,00");
  });

  it("persists the transaction only after an explicit confirm", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const confirmed = await applyMessage(started.state, "confirmar", deps);

    expect(confirmed.state.status).toBe("saved");
    expect(createTransaction).toHaveBeenCalledTimes(1);

    const savedDraft = firstCallArg(createTransaction) as {
      createdByUserId: string;
      responsibility: { scope: string };
      amount: { cents: number };
      category: { categoryId?: string };
      payment: { type: string };
    };
    // createdByUserId is the linked Telegram identity.
    expect(savedDraft.createdByUserId).toBe("user-alvaro");
    // Responsibility defaults to the house.
    expect(savedDraft.responsibility.scope).toBe("household");
    expect(savedDraft.amount.cents).toBe(3200);
    expect(savedDraft.category.categoryId).toBe("cat-transport");
    // Success reply confirms the save.
    expect(confirmed.reply).toMatch(/salv|registrad/i);
    // The interaction is logged for auditing.
    expect(logInteraction).toHaveBeenCalled();
  });

  it("applies a value correction before saving", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const corrected = await applyMessage(
      started.state,
      "valor 45,90",
      deps,
    );
    expect(corrected.state.status).toBe("awaiting_confirmation");
    expect(corrected.state.draft.amountCents).toBe(4590);
    expect(createTransaction).not.toHaveBeenCalled();

    await applyMessage(corrected.state, "sim", deps);
    const savedDraft = firstCallArg(createTransaction) as {
      amount: { cents: number };
    };
    expect(savedDraft.amount.cents).toBe(4590);
  });

  it("applies a date correction before saving", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(started.state, "data 15/01", deps);
    expect(corrected.state.draft.occurredOn).toBe("2026-01-15");
  });

  it("applies a responsible-person correction before saving", async () => {
    const resolveResponsibleUserId = vi.fn((name: string) =>
      name.toLowerCase().includes("karol") ? "user-karol" : undefined,
    );
    ({ deps, createTransaction } = buildDeps({ resolveResponsibleUserId }));

    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(
      started.state,
      "responsável Karol",
      deps,
    );
    expect(corrected.state.draft.responsibleUserId).toBe("user-karol");

    await applyMessage(corrected.state, "confirmar", deps);
    const savedDraft = firstCallArg(createTransaction) as {
      responsibility: { scope: string; userId?: string };
    };
    expect(savedDraft.responsibility.scope).toBe("user");
    expect(savedDraft.responsibility.userId).toBe("user-karol");
  });

  it("supports a category correction before saving", async () => {
    const started = await startConversation(
      { text: "Almoço 40 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(
      started.state,
      "categoria Alimentação",
      deps,
    );
    expect(corrected.state.draft.categoryId).toBe("cat-food");
  });

  it("cancels without persisting", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const cancelled = await applyMessage(started.state, "cancelar", deps);
    expect(cancelled.state.status).toBe("cancelled");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not save when the amount is missing; asks for the value", async () => {
    const started = await startConversation(
      { text: "Uber ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("needs_amount");
    const confirmAttempt = await applyMessage(
      started.state,
      "confirmar",
      deps,
    );
    // Still cannot save without a value.
    expect(createTransaction).not.toHaveBeenCalled();
    expect(confirmAttempt.reply).toMatch(/valor/i);
  });
});

// ---------------------------------------------------------------------------
// audio.ts — temp-file lifecycle (download -> transcribe -> ALWAYS delete)
// ---------------------------------------------------------------------------

describe("transcribeVoiceMessage (temp audio handling)", () => {
  function downloaderReturning(bytes: Uint8Array): AudioDownloader {
    return { async download() { return bytes; } };
  }

  it("deletes the temporary audio file after transcription (no raw audio retained)", async () => {
    let tempPath = "";
    const provider: TranscriptionProvider = {
      async transcribe(filePath: string) {
        tempPath = filePath;
        expect(existsSync(filePath)).toBe(true);
        return "Mercado 50 reais hoje";
      },
    };
    const text = await transcribeVoiceMessage(
      { fileId: "v1", mimeType: "audio/ogg" },
      { downloader: downloaderReturning(new Uint8Array([1, 2, 3])), provider },
    );
    expect(text).toBe("Mercado 50 reais hoje");
    expect(existsSync(tempPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// conversation.ts — audio entry goes through the SAME confirmation flow.
// ---------------------------------------------------------------------------

describe("audio entry: transcription -> confirmation (never bypasses confirm)", () => {
  let deps: ConversationDeps;
  let createTransaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ deps, createTransaction } = buildDeps());
  });

  function transcribeDeps(text: string): TranscribeDeps {
    return {
      downloader: { async download() { return new Uint8Array([7, 7]); } },
      provider: { async transcribe() { return text; } },
    };
  }

  it("a voice note produces an editable confirmation and does NOT auto-save", async () => {
    const outcome = await startConversationFromAudio(
      { voice: { fileId: "v-audio-1" }, fromUserId: "user-alvaro" },
      deps,
      transcribeDeps("Uber 32 reais ontem"),
      { today: TODAY },
    );

    // Same confirmation state as text — audio never bypasses confirmation.
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft.inputKind).toBe("audio");
    expect(createTransaction).not.toHaveBeenCalled();
    expect(outcome.reply).toMatch(/confirm/i);
    expect(outcome.reply).toContain("32,00");
  });

  it("logs the saved audio transaction with inputKind 'audio'", async () => {
    const logInteraction = vi.fn(async () => undefined);
    ({ deps, createTransaction } = buildDeps({ logInteraction }));

    const started = await startConversationFromAudio(
      { voice: { fileId: "v-audio-2" }, fromUserId: "user-alvaro" },
      deps,
      transcribeDeps("Uber 32 reais ontem"),
      { today: TODAY },
    );
    const confirmed = await applyMessage(started.state, "confirmar", deps);

    expect(confirmed.state.status).toBe("saved");
    expect(createTransaction).toHaveBeenCalledTimes(1);
    const logged = firstCallArg(logInteraction) as { inputKind: string };
    expect(logged.inputKind).toBe("audio");
  });
});

// ---------------------------------------------------------------------------
// AI fallback wired through the conversation's categorization dependency.
// The engine + concrete categorizer are exercised together with a MOCKED AI
// completion client (no network). Covers: high-confidence rule does NOT call AI;
// low-confidence/novel deterministic parse triggers AI; AI result still
// requires confirmation.
// ---------------------------------------------------------------------------

describe("AI fallback in the bot flow", () => {
  // A small real catalog so the categorization engine resolves names to ids.
  const aiCatalog = {
    householdId: "house-1",
    categories: [
      { id: "cat-transport", name: "Transporte" },
      { id: "cat-food", name: "Alimentação" },
    ],
    subcategories: [
      { id: "sub-delivery", categoryId: "cat-food", name: "Delivery" },
    ],
  };

  it("high-confidence deterministic rule does NOT call AI", async () => {
    const complete = vi.fn(async () => "{}");
    const ai = createAiCategorizer({ complete });
    const { deps, createTransaction } = buildDeps({
      catalog: aiCatalog,
      suggestCategory: (context) =>
        suggestCategory(context, { catalog: aiCatalog, ai }),
    });

    // "IFOOD" is a deterministic rule -> AI must never be reached.
    const outcome = await startConversation(
      { text: "IFOOD lanche 40 reais hoje", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(outcome.state.draft.categoryId).toBe("cat-food");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("low-confidence deterministic parse triggers AI fallback, and the AI result still requires confirmation", async () => {
    // No deterministic rule matches this description -> engine reaches AI.
    const complete = vi.fn(async () =>
      JSON.stringify({
        categoryName: "Transporte",
        subcategoryName: null,
        confidence: CONFIDENCE.LOW, // deliberately low
        explanation: "IA achou que é transporte, com baixa confiança.",
      }),
    );
    const ai = createAiCategorizer({ complete });
    const { deps, createTransaction } = buildDeps({
      catalog: aiCatalog,
      suggestCategory: (context) =>
        suggestCategory(context, { catalog: aiCatalog, ai }),
    });

    const outcome = await startConversation(
      { text: "transacao obscura 9981 50 reais hoje", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    // AI was consulted, the suggestion was applied, but confirmation is needed.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcome.state.draft.categoryId).toBe("cat-transport");
    expect(outcome.state.draft.needsAttention).toBe(true);
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(createTransaction).not.toHaveBeenCalled();
  });
});

describe("LLM text interpretation fallback (parser miss -> interpretText)", () => {
  it("NEVER calls the interpreter when the deterministic parser found an amount", async () => {
    const interpretText = vi.fn<TextInterpreter>(
      async () => null,
    );
    const { deps } = buildDeps({ interpretText });

    const outcome = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(interpretText).not.toHaveBeenCalled();
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft.amountCents).toBe(3200);
  });

  it("parser miss + interpreter success -> awaiting_confirmation with the interpreted fields (still no save)", async () => {
    const interpretText = vi.fn<TextInterpreter>(
      async () => ({
        amountCents: 4590,
        description: "Mercadinho da esquina",
        occurredOn: "2026-06-21",
        categoryHint: "Alimentação",
        responsibleHint: "Karol",
      }),
    );
    const suggestCategorySpy = vi.fn(async () => ({
      status: "uncategorized" as const,
      suggestion: null,
      requiresConfirmation: true,
    }));
    const { deps, createTransaction } = buildDeps({
      interpretText,
      suggestCategory: suggestCategorySpy,
      resolveResponsibleUserId: (name: string) =>
        name.toLowerCase() === "karol" ? "user-karol" : undefined,
    });

    // No digits anywhere -> the deterministic parser cannot extract an amount.
    const outcome = await startConversation(
      { text: "gastei uma nota no mercadinho da esquina ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    // The interpreter saw the ORIGINAL text.
    expect(interpretText).toHaveBeenCalledTimes(1);
    expect(interpretText).toHaveBeenCalledWith(
      "gastei uma nota no mercadinho da esquina ontem",
      { today: TODAY },
    );

    // The interpreted fields land in the same confirmation draft path.
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft.amountCents).toBe(4590);
    expect(outcome.state.draft.description).toBe("Mercadinho da esquina");
    expect(outcome.state.draft.occurredOn).toBe("2026-06-21");
    // responsibleHint went through resolveResponsibleUserId (not trusted raw).
    expect(outcome.state.draft.responsibleUserId).toBe("user-karol");
    // LLM-derived drafts always merit a closer look.
    expect(outcome.state.draft.needsAttention).toBe(true);

    // categoryHint reaches the categorization engine as context description
    // text — NEVER as a category id.
    const context = firstCallArg(suggestCategorySpy) as { description: string };
    expect(context.description).toContain("Mercadinho da esquina");
    expect(context.description).toContain("Alimentação");
    expect(outcome.state.draft.categoryId).toBeUndefined();

    // The AI never saves anything directly — the user must confirm.
    expect(createTransaction).not.toHaveBeenCalled();
    expect(outcome.reply).toMatch(/confirm/i);
    expect(outcome.reply).toContain("45,90");
  });

  it("interpreter returns null -> today's rephrase behavior (needs_amount)", async () => {
    const interpretText = vi.fn<TextInterpreter>(
      async () => null,
    );
    const { deps, createTransaction } = buildDeps({ interpretText });

    const outcome = await startConversation(
      { text: "gastei um dinheirinho no mercado", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(interpretText).toHaveBeenCalledTimes(1);
    expect(outcome.state.status).toBe("needs_amount");
    expect(outcome.reply).toMatch(/Não identifiquei o valor/);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("no interpreter configured -> behavior unchanged (needs_amount)", async () => {
    const { deps } = buildDeps();

    const outcome = await startConversation(
      { text: "gastei um dinheirinho no mercado", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("needs_amount");
    expect(outcome.reply).toMatch(/Não identifiquei o valor/);
  });

  it("interpreter throwing is treated as null (rephrase, webhook never breaks)", async () => {
    const interpretText: TextInterpreter = async () => {
      throw new Error("provider exploded");
    };
    const { deps } = buildDeps({ interpretText });

    const outcome = await startConversation(
      { text: "gastei um dinheirinho no mercado", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("needs_amount");
  });
});

// ---------------------------------------------------------------------------
// Fake Supabase client for handleWebhook tests: a tiny in-memory table store
// supporting exactly the query chains the bot repositories use
// (select/eq/order/limit/maybeSingle/single, insert().select().single(),
// upsert keyed by chat_id, delete().eq()). No network, no real Supabase.
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>;

function fakeQueryBuilder(rows: FakeRow[]) {
  let filtered = [...rows];
  let deleteMode = false;
  const finish = (): { data: FakeRow[]; error: null } => {
    if (deleteMode) {
      for (const row of filtered) {
        const index = rows.indexOf(row);
        if (index >= 0) {
          rows.splice(index, 1);
        }
      }
    }
    return { data: filtered, error: null };
  };
  const api = {
    select() {
      return api;
    },
    insert(payload: FakeRow) {
      const row = { id: `row-${rows.length + 1}`, ...payload };
      rows.push(row);
      filtered = [row];
      return api;
    },
    upsert(payload: FakeRow) {
      const index = rows.findIndex((r) => r.chat_id === payload.chat_id);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...payload };
        filtered = [rows[index] as FakeRow];
      } else {
        rows.push(payload);
        filtered = [payload];
      }
      return api;
    },
    delete() {
      deleteMode = true;
      filtered = [...rows];
      return api;
    },
    eq(column: string, value: unknown) {
      filtered = filtered.filter((r) => r[column] === value);
      return api;
    },
    order() {
      return api;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return api;
    },
    async single() {
      const result = finish();
      const first = result.data[0];
      return first !== undefined
        ? { data: first, error: null }
        : { data: null, error: { message: "no rows" } };
    },
    async maybeSingle() {
      const result = finish();
      return { data: result.data[0] ?? null, error: null };
    },
    then(
      onFulfilled: (value: { data: FakeRow[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(finish()).then(onFulfilled, onRejected);
    },
  };
  return api;
}

function fakeSupabase(seed: Record<string, FakeRow[]> = {}): {
  client: AppSupabaseClient;
  tables: Record<string, FakeRow[]>;
} {
  const tables: Record<string, FakeRow[]> = {
    categories: [
      {
        id: "cat-transport",
        household_id: "house-1",
        name: "Transporte",
        is_active: true,
      },
    ],
    subcategories: [],
    accounts: [
      { id: "acct-1", household_id: "house-1", kind: "checking", name: "Conta" },
    ],
    credit_cards: [],
    categorization_memory: [],
    household_members: [
      {
        id: "member-1",
        household_id: "house-1",
        user_id: "user-alvaro",
        display_name: "Alvaro",
        telegram_user_id: 777,
        is_active: true,
        role: "owner",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "member-2",
        household_id: "house-1",
        user_id: "user-karol",
        display_name: "Karol",
        telegram_user_id: 888,
        is_active: true,
        role: "member",
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
    transactions: [],
    bot_interactions: [],
    bot_conversations: [],
    ...seed,
  };
  const client = {
    from(table: string) {
      return fakeQueryBuilder(tables[table] ?? []);
    },
  } as unknown as AppSupabaseClient;
  return { client, tables };
}

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
      },
    },
  };
}

const IDENTITIES: Record<string, BotMemberIdentity> = {
  "777": { householdId: "house-1", userId: "user-alvaro", displayName: "Alvaro" },
  "888": { householdId: "house-1", userId: "user-karol", displayName: "Karol" },
  "@karolzinha": {
    householdId: "house-1",
    userId: "user-karol",
    displayName: "Karol",
  },
};

const resolveMemberFake = async (sender: {
  telegramUserId: string;
  telegramUsername?: string;
}): Promise<BotMemberIdentity | null> =>
  IDENTITIES[sender.telegramUserId] ??
  (sender.telegramUsername !== undefined
    ? (IDENTITIES[`@${sender.telegramUsername.toLowerCase()}`] ?? null)
    : null);

function textUpdate(
  fromId: number,
  text: string,
  chatId = 555,
  fromUsername?: string,
): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId },
      from: { id: fromId, username: fromUsername },
      text,
    },
  };
}

const SECRET = "s3cr3t";

// ---------------------------------------------------------------------------
// handleWebhook — real Telegram identity + persistent conversations (Task 9).
// ---------------------------------------------------------------------------

describe("handleWebhook: telegram identity", () => {
  it("politely refuses an unmatched telegram user and writes NOTHING", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();

    const result = await handleWebhook({
      rawBody: textUpdate(999, "Uber 32 reais ontem"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(result.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/não conheço/i);
    // No transaction, no interaction row: there is no household to scope to.
    expect(tables.transactions).toHaveLength(0);
  });

  it("resolves the sender by @username when the numeric id is not linked yet", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();

    const result = await handleWebhook({
      rawBody: textUpdate(999, "mercado 54,30", 555, "KarolZinha"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(result.status).toBe(200);
    expect(sent).toHaveLength(1);
    // Known member via username → the normal confirmation flow, not a refusal.
    expect(sent[0]?.text).not.toMatch(/não conheço/i);
    expect(tables.transactions).toHaveLength(0);
    expect(tables.bot_interactions).toHaveLength(0);
  });

  it("creates the draft with the MATCHED member's user_id (not the telegram id)", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const base = {
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    };

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });
    const pending = await store.load("555");
    expect(pending?.status).toBe("awaiting_confirmation");
    expect(pending?.draft.createdByUserId).toBe("user-alvaro");

    // Conversation SURVIVES across two webhook calls sharing the store.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "confirmar") });
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions?.[0]?.created_by_user_id).toBe("user-alvaro");
  });

  it("resolves responsável by display_name, case- and accent-insensitively", async () => {
    const { client } = fakeSupabase();
    const { telegram } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const base = {
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    };

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });

    // Case-insensitive: "KAROL" matches display_name "Karol".
    await handleWebhook({ ...base, rawBody: textUpdate(777, "responsável KAROL") });
    let state = await store.load("555");
    expect(state?.draft.responsibleUserId).toBe("user-karol");

    // Accent-insensitive: "Álvaro" matches display_name "Alvaro".
    await handleWebhook({ ...base, rawBody: textUpdate(777, "responsável Álvaro") });
    state = await store.load("555");
    expect(state?.draft.responsibleUserId).toBe("user-alvaro");

    // Unknown name → back to the house (undefined).
    await handleWebhook({ ...base, rawBody: textUpdate(777, "responsável Zeca") });
    state = await store.load("555");
    expect(state?.draft.responsibleUserId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// store.ts — conversation stores (in-memory + DB-backed with 24h staleness).
// ---------------------------------------------------------------------------

function sampleState(): ConversationState {
  return {
    status: "awaiting_confirmation",
    draft: {
      amountCents: 3200,
      description: "Uber",
      occurredOn: TODAY,
      kind: "expense",
      createdByUserId: "user-alvaro",
      inputKind: "text",
      needsAttention: false,
    },
  };
}

describe("conversation stores", () => {
  it("in-memory store round-trips state per chat", async () => {
    const store = createInMemoryConversationStore();
    expect(await store.load("555")).toBeUndefined();
    await store.save("555", sampleState());
    expect((await store.load("555"))?.draft.description).toBe("Uber");
    expect(await store.load("556")).toBeUndefined();
  });

  it("db store round-trips state through bot_conversations", async () => {
    const { client, tables } = fakeSupabase();
    const store = createDbConversationStore(client);
    await store.save("555", sampleState());
    expect(tables.bot_conversations).toHaveLength(1);
    const loaded = await store.load("555");
    expect(loaded?.status).toBe("awaiting_confirmation");
    expect(loaded?.draft.createdByUserId).toBe("user-alvaro");
  });

  it("treats a stale (>24h) row as absent and deletes it lazily", async () => {
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { client, tables } = fakeSupabase({
      bot_conversations: [
        { chat_id: 555, state: sampleState(), updated_at: staleAt },
      ],
    });
    const store = createDbConversationStore(client);
    expect(await store.load("555")).toBeUndefined();
    // Lazily deleted.
    expect(tables.bot_conversations).toHaveLength(0);
  });

  it("treats a malformed persisted state as absent", async () => {
    const { client } = fakeSupabase({
      bot_conversations: [
        {
          chat_id: 555,
          state: { whatever: true },
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const store = createDbConversationStore(client);
    expect(await store.load("555")).toBeUndefined();
  });
});
