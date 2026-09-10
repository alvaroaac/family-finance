import { describe, it, expect } from "vitest";

import { handleWebhook } from "./index.js";
import { createInMemoryConversationStore } from "./store.js";
import type { TelegramClient, InlineKeyboardMarkup } from "./telegram.js";
import type { AppSupabaseClient, BotMemberIdentity } from "@family-finance/db";
import type { AiCategorizer } from "@family-finance/categorization";
import type { TranscribeDeps } from "./audio.js";

// ---------------------------------------------------------------------------
// Fixtures copied verbatim from bot.test.ts (module-private there).
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>;

function fakeQueryBuilder(rows: FakeRow[]) {
  let filtered = [...rows];
  let deleteMode = false;
  let patch: FakeRow | null = null;
  const finish = (): { data: FakeRow[]; error: null } => {
    if (deleteMode) {
      for (const row of filtered) {
        const index = rows.indexOf(row);
        if (index >= 0) {
          rows.splice(index, 1);
        }
      }
    }
    if (patch !== null) {
      for (const row of filtered) {
        Object.assign(row, patch);
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
    update(payload: FakeRow) {
      patch = payload;
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
        kind: "expense",
        is_active: true,
      },
    ],
    subcategories: [],
    accounts: [
      {
        id: "acct-1",
        household_id: "house-1",
        kind: "checking",
        name: "Conta",
      },
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

const IDENTITIES: Record<string, BotMemberIdentity> = {
  "777": {
    householdId: "house-1",
    userId: "user-alvaro",
    displayName: "Alvaro",
  },
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

function voiceUpdate(fromId: number, fileId: string, chatId = 555): unknown {
  return {
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: chatId },
      from: { id: fromId },
      voice: { file_id: fileId, mime_type: "audio/ogg" },
    },
  };
}

const SECRET = "s3cr3t";

// ---------------------------------------------------------------------------
// Richer fakeTelegram + callback update builder for this file's tests.
// ---------------------------------------------------------------------------

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

    expect(sent[0]?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe(
      "cf",
    );
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

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") });

    expect(answered).toHaveLength(1);
    expect(stripped).toContainEqual({ chatId: "555", messageId: 1001 });
    expect(tables.transactions).toHaveLength(1);
    expect(sent.at(-1)?.text).toContain("Lançamento salvo");
  });

  it("gibberish typed while awaiting confirmation keeps the previous buttons tappable", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, sent, stripped } = fakeTelegram();
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
    await handleWebhook({ ...base, rawBody: textUpdate(777, "blarg nada") });

    expect(stripped).not.toContainEqual({ chatId: "555", messageId: 1001 });
    expect(sent.at(-1)?.replyMarkup).toBeUndefined();

    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "cf", 555, 1001),
    });
    expect(tables.transactions).toHaveLength(1);
  });

  it("typed correction that advances strips the previous keyboard and records the new one", async () => {
    const { client } = fakeSupabase();
    const { telegram, sent, stripped } = fakeTelegram();
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
    await handleWebhook({ ...base, rawBody: textUpdate(777, "valor 45,90") });

    expect(stripped).toContainEqual({ chatId: "555", messageId: 1001 });
    expect(
      sent.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data,
    ).toBe("cf");
    expect((await store.load("555"))?.promptMessageId).toBe(1002);
  });

  it("voice draft reply carries the confirmation keyboard and records promptMessageId", async () => {
    const { client } = fakeSupabase();
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const transcribe: TranscribeDeps = {
      downloader: { download: async () => new Uint8Array([1]) },
      provider: { transcribe: async () => "Uber 32 reais ontem" },
    };

    await handleWebhook({
      rawBody: voiceUpdate(777, "voice-1"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      transcribe,
    });

    expect(sent[0]?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe(
      "cf",
    );
    const state = await store.load("555");
    expect(state?.draft.inputKind).toBe("audio");
    expect(state?.promptMessageId).toBe(1001);
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

  it("partial callback payload is answered and ignored without side effects", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, answered, sent, stripped } = fakeTelegram();
    const store = createInMemoryConversationStore();

    const result = await handleWebhook({
      rawBody: {
        update_id: 2,
        callback_query: {
          id: "cbq-partial",
          from: { id: 777 },
        },
      },
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
    });

    expect(result.status).toBe(200);
    expect(answered).toEqual([{ id: "cbq-partial", text: undefined }]);
    expect(sent).toHaveLength(0);
    expect(stripped).toHaveLength(0);
    expect(tables.transactions).toHaveLength(0);
    expect(tables.bot_interactions).toHaveLength(0);
    expect(tables.bot_conversations).toHaveLength(0);
  });

  it("state is saved before the Telegram send, so a throwing answerCallbackQuery can't reopen a double-insert window", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, sent, answered } = fakeTelegram();
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

    // Make answerCallbackQuery throw exactly once, simulating a Telegram 400
    // on a stale (>15s-old) callback. The webhook's caller (the real server)
    // catches this, but here we call handleWebhook directly and catch any
    // rejection ourselves to assert the state was already saved beforehand.
    let thrown = false;
    const flakyTelegram: TelegramClient = {
      ...telegram,
      async answerCallbackQuery(id, text) {
        if (!thrown) {
          thrown = true;
          throw new Error("Telegram 400: query is too old");
        }
        return telegram.answerCallbackQuery(id, text);
      },
    };

    await expect(
      handleWebhook({
        ...base,
        telegram: flakyTelegram,
        rawBody: callbackUpdate(777, "cf"),
      }),
    ).rejects.toThrow("Telegram 400");

    // Despite the throw, applyCallback already inserted the transaction and
    // the state must already have been persisted as "saved" BEFORE the
    // throwing Telegram call — otherwise a second tap would insert again.
    expect(tables.transactions).toHaveLength(1);

    // The throw happened in answerCallbackQuery, BEFORE sendMessage — so the
    // "Lançamento salvo" confirmation was never sent for the first tap. That
    // is fine: the transaction row (the money-affecting side effect) is what
    // must not duplicate, and it hasn't.
    expect(sent.some((s) => s.text.includes("Lançamento salvo"))).toBe(false);

    // A second tap must be a no-op double-tap (state already "saved" →
    // "Já salvo" toast), NOT a second insert.
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") });
    expect(tables.transactions).toHaveLength(1);
    expect(answered.at(-1)?.text).toBe("Já salvo ✅");
  });

  it("already-saved double-tap answers without rebuilding conversation deps", async () => {
    const { client, tables } = fakeSupabase();
    const { telegram, answered } = fakeTelegram();
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
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") });
    expect(tables.transactions).toHaveLength(1);

    const throwingClient = {
      from(table: string) {
        throw new Error(`unexpected query for ${table}`);
      },
    } as unknown as AppSupabaseClient;

    await handleWebhook({
      ...base,
      client: throwingClient,
      rawBody: callbackUpdate(777, "cf", 555, 1001),
    });

    expect(answered.at(-1)?.text).toBe("Já salvo ✅");
    expect(tables.transactions).toHaveLength(1);
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
    const category = tables.categories!.find((c) => c.name === "Pets");
    expect(category).toBeDefined();
    expect(category?.is_active).toBe(true);
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions![0]?.category_id).toBe(category?.id);
    expect(tables.categorization_memory).toHaveLength(1);
    expect(tables.categorization_memory![0]).toMatchObject({
      pattern: "petz",
      category_id: category?.id,
      confidence: 0.95,
    });
    expect(String(tables.categorization_memory![0]?.explanation)).toContain(
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
    tables.categories!.push({
      id: "cat-pets-existing",
      household_id: "house-1",
      name: "Pets",
      kind: "expense",
      is_active: true,
    });
    // The catalog now contains "Pets", so the engine resolves the AI's
    // suggestion to the EXISTING id — no proposal, no creation.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "petz 30 reais") });
    expect(sent.at(-1)?.text).not.toContain("(nova — sugerida)");
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "cf", 555, 1001),
    });
    expect(
      tables.categories!.filter((c) => String(c.name).toLowerCase() === "pets"),
    ).toHaveLength(1);
    expect(tables.transactions![0]?.category_id).toBe("cat-pets-existing");
  });

  it("dedupe at accept-time: an ARCHIVED 'pets' is reactivated by nca, not duplicated", async () => {
    const { base, tables } = petzHarness();
    tables.categories!.push({
      id: "cat-pets-archived",
      household_id: "house-1",
      name: "pets",
      kind: "expense",
      is_active: false,
    });
    // Archived categories are NOT in the engine catalog → the AI proposal
    // still fires; the accept path must find and reactivate the archived row.
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Petz 90 reais") });
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "nca", 555, 1001),
    });

    const rows = tables.categories!.filter(
      (c) => String(c.name).toLowerCase() === "pets",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_active).toBe(true);
    expect(tables.transactions![0]?.category_id).toBe("cat-pets-archived");
  });

  it("manual: nova categoria via grid button, end to end", async () => {
    const { base, tables, sent } = petzHarness();
    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "cats", 555, 1001),
    });
    expect(sent.at(-1)?.text).toBe("Escolha a categoria:");
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "nc", 555, 1002),
    });
    expect(sent.at(-1)?.text).toContain("nome da nova categoria");
    await handleWebhook({ ...base, rawBody: textUpdate(777, "Viagens") });
    expect(tables.categories!.some((c) => c.name === "Viagens")).toBe(true);
    // Manual creation seeds NO memory.
    expect(tables.categorization_memory).toHaveLength(0);
    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(777, "cf", 555, 1004),
    });
    expect(tables.transactions).toHaveLength(1);
  });
});

describe("callback ownership + concurrency (review findings F1-F3)", () => {
  function harness() {
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
    return { base, tables, sent, answered, stripped };
  }

  it("another member's tap on ✅ does NOT confirm the creator's draft (belongsToSender parity)", async () => {
    const { base, tables, answered, stripped, sent } = harness();

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });
    const sentBefore = sent.length;

    // Karol (888) taps confirm on Alvaro's (777) draft.
    await handleWebhook({ ...base, rawBody: callbackUpdate(888, "cf") });

    expect(tables.transactions).toHaveLength(0);
    expect(answered.at(-1)?.text).toContain("outra pessoa");
    // The creator still needs the buttons: nothing stripped, nothing sent.
    expect(stripped).toHaveLength(0);
    expect(sent).toHaveLength(sentBefore);

    // The creator's own tap still works afterwards.
    await handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") });
    expect(tables.transactions).toHaveLength(1);
  });

  it("another member's tap cannot cancel or re-categorize the creator's draft", async () => {
    const { base, tables } = harness();
    const store = base.store;
    tables.categories!.push({
      id: "cat-food",
      household_id: "house-1",
      name: "Alimentação",
      kind: "expense",
      is_active: true,
    });

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });

    await handleWebhook({ ...base, rawBody: callbackUpdate(888, "cx") });
    expect((await store.load("555"))?.status).toBe("awaiting_confirmation");

    await handleWebhook({
      ...base,
      rawBody: callbackUpdate(888, "ct:cat-food"),
    });
    expect((await store.load("555"))?.draft.categoryId).not.toBe("cat-food");
    expect(tables.transactions).toHaveLength(0);
  });

  it("two CONCURRENT deliveries of a double-tapped ✅ insert exactly one transaction", async () => {
    const { base, tables, answered } = harness();

    await handleWebhook({
      ...base,
      rawBody: textUpdate(777, "Uber 32 reais ontem"),
    });

    await Promise.all([
      handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") }),
      handleWebhook({ ...base, rawBody: callbackUpdate(777, "cf") }),
    ]);

    expect(tables.transactions).toHaveLength(1);
    // One of the two taps was the no-op double-tap.
    expect(answered.some((a) => a.text === "Já salvo ✅")).toBe(true);
  });
});
