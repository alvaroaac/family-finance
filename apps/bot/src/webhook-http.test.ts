/**
 * True HTTP-level end-to-end exercise of
 * the inline-button flows. Real node HTTP server (createBotServer) + real
 * handleWebhook + in-memory Supabase/Telegram fakes. Drives the wire format
 * Telegram actually POSTs.
 */
import { describe, it, expect, afterEach } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

import { handleWebhook } from "./index.js";
import { createBotServer } from "./server.js";
import { createInMemoryConversationStore } from "./store.js";
import type { TelegramClient, InlineKeyboardMarkup } from "./telegram.js";
import type { AppSupabaseClient, BotMemberIdentity } from "@family-finance/db";

type FakeRow = Record<string, unknown>;

function fakeQueryBuilder(rows: FakeRow[]) {
  let filtered = [...rows];
  let deleteMode = false;
  let patch: FakeRow | null = null;
  const finish = (): { data: FakeRow[]; error: null } => {
    if (deleteMode) {
      for (const row of filtered) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
    }
    if (patch !== null) {
      for (const row of filtered) Object.assign(row, patch);
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

function fakeSupabase() {
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
    ],
    transactions: [],
    bot_interactions: [],
    bot_conversations: [],
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
};

const resolveMemberFake = async (sender: {
  telegramUserId: string;
}): Promise<BotMemberIdentity | null> =>
  IDENTITIES[sender.telegramUserId] ?? null;

type SentMessage = {
  chatId: string;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

function fakeTelegram() {
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
    } satisfies TelegramClient,
  };
}

const SECRET = "s3cr3t";

describe("HTTP e2e smoke: buttons over the wire", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((res, rej) =>
        s.close((e) => (e ? rej(e) : res())),
      );
    }
  });

  async function boot() {
    const { client, tables } = fakeSupabase();
    const tg = fakeTelegram();
    const store = createInMemoryConversationStore();
    const server = createBotServer((rawBody, secretHeader) =>
      handleWebhook({
        rawBody,
        secretHeader,
        configuredSecret: SECRET,
        client,
        telegram: tg.telegram,
        resolveMember: resolveMemberFake,
        store,
      }),
    );
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = async (
      update: unknown,
      secret: string | undefined = SECRET,
    ) => {
      const response = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret !== undefined
            ? { "x-telegram-bot-api-secret-token": secret }
            : {}),
        },
        body: JSON.stringify(update),
      });
      return response;
    };
    return { post, tables, tg };
  }

  const text = (t: string, mid = 1) => ({
    update_id: mid,
    message: {
      message_id: mid,
      chat: { id: 555 },
      from: { id: 777 },
      text: t,
    },
  });

  const tap = (data: string, messageId: number) => ({
    update_id: 99,
    callback_query: {
      id: `cbq-${data}-${messageId}`,
      from: { id: 777 },
      message: { message_id: messageId, chat: { id: 555 } },
      data,
    },
  });

  it("wrong secret is rejected with 401 over HTTP", async () => {
    const { post, tables } = await boot();
    const response = await post(text("Uber 32 reais ontem"), "wrong");
    expect(response.status).toBe(401);
    expect(tables.transactions).toHaveLength(0);
  });

  it("full happy path: draft → pick category via buttons → confirm → saved once", async () => {
    const { post, tables, tg } = await boot();

    expect((await post(text("Uber 32 reais ontem"))).status).toBe(200);
    const draft = tg.sent.at(-1);
    expect(draft?.replyMarkup).toBeDefined();
    const promptId = 1000 + tg.sent.length;

    // open category list
    expect((await post(tap("cats", promptId))).status).toBe(200);
    const catMsg = tg.sent.at(-1);
    const catButtons = catMsg?.replyMarkup?.inline_keyboard.flat() ?? [];
    const transportBtn = catButtons.find((b) =>
      b.callback_data?.startsWith("ct:"),
    );
    expect(transportBtn?.callback_data).toBe("ct:cat-transport");
    const catsMsgId = 1000 + tg.sent.length;

    // pick Transporte
    expect(
      (await post(tap(transportBtn!.callback_data!, catsMsgId))).status,
    ).toBe(200);
    const updatedId = 1000 + tg.sent.length;

    // confirm
    expect((await post(tap("cf", updatedId))).status).toBe(200);
    expect(tables.transactions).toHaveLength(1);
    expect(tg.sent.at(-1)?.text).toContain("salvo");

    // double-tap confirm on the SAME message: no second insert
    expect((await post(tap("cf", updatedId))).status).toBe(200);
    expect(tables.transactions).toHaveLength(1);
    const lastToast = tg.answered.at(-1)?.text ?? "";
    expect(lastToast.toLowerCase()).toContain("salvo");
  });

  it("manual new-category path over HTTP: nc → typed name → nca creates and assigns", async () => {
    const { post, tables, tg } = await boot();

    await post(text("Racao 80 reais"));
    const promptId = 1000 + tg.sent.length;
    await post(tap("cats", promptId));
    const catsMsgId = 1000 + tg.sent.length;
    await post(tap("nc", catsMsgId));

    // bot asks for the name; user types it
    await post(text("Pets", 2));
    const confirmId = 1000 + tg.sent.length;
    // accept the creation
    await post(tap("nca", confirmId));

    const created = tables.categories!.find((c) => c.name === "Pets");
    expect(created).toBeDefined();
    expect(created?.is_active).toBe(true);

    // finally confirm the transaction
    const afterId = 1000 + tg.sent.length;
    await post(tap("cf", afterId));
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions![0]?.category_id).toBe(created?.id);
  });

  it("stale token after restart (empty store) → Sessão expirada toast + strip", async () => {
    const { post, tg, tables } = await boot();
    await post(tap("cf", 4242));
    expect(tg.answered.at(-1)?.text).toContain("Sessão expirada");
    expect(tg.stripped).toContainEqual({ chatId: "555", messageId: 4242 });
    expect(tables.transactions).toHaveLength(0);
  });

  it("garbage callback data on a live draft does not crash or write", async () => {
    const { post, tg, tables } = await boot();
    await post(text("Uber 32 reais ontem"));
    const promptId = 1000 + tg.sent.length;
    const response = await post(tap("zz:whatever", promptId));
    expect(response.status).toBe(200);
    expect(tables.transactions).toHaveLength(0);
    expect(tg.answered.length).toBeGreaterThan(0);
  });
});
