import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { startBot } from "./lib/bot-process.js";
import { startFakeTelegram, type SentMessage } from "./lib/fake-telegram.js";
import {
  adminClient,
  members,
  provisionMultiTenantFixtures,
  testPassword,
} from "./lib/multi-tenant-fixtures.js";

const secret = "e2e-webhook-secret";
const refusal =
  "Oi! Eu ainda não conheço você por aqui. Abra Configurações no Family Finance, toque em Vincular Telegram e me envie o código que aparecer.";
const forbidden = /Alvaro|Álvaro|Karol|alvaroekarol/i;

async function rows(householdId: string) {
  const { data, error } = await adminClient()
    .from("transactions")
    .select(
      "id, household_id, created_by_user_id, responsible_user_id, description, amount_cents",
    )
    .eq("household_id", householdId);
  if (error) throw error;
  return data ?? [];
}

async function rowCount(
  table: "transactions" | "bot_interactions" | "bot_conversations",
) {
  const { count, error } = await adminClient()
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count;
}

async function writeCounts() {
  return Promise.all(
    (["transactions", "bot_interactions", "bot_conversations"] as const).map(
      rowCount,
    ),
  );
}

async function ensureAccount(householdId: string) {
  const admin = adminClient();
  const { data, error } = await admin
    .from("accounts")
    .select("id")
    .eq("household_id", householdId)
    .limit(1);
  if (error) throw error;
  if (data.length === 0) {
    const inserted = await admin.from("accounts").insert({
      household_id: householdId,
      kind: "checking",
      name: "Conta e2e",
    });
    if (inserted.error) throw inserted.error;
  }
}

describe("real bot webhook across households", () => {
  beforeAll(async () => {
    await provisionMultiTenantFixtures();
  });

  it("separates writes, group drafts, callback ownership, recent expenses and member attribution", async () => {
    const { ids, azul, verde } = await provisionMultiTenantFixtures();
    await ensureAccount(azul);
    await ensureAccount(verde);
    const telegram = {
      ana: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
      carla: Math.floor(Math.random() * 1_000_000_000) + 2_000_000_000,
      outsider: Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000,
    };
    const admin = adminClient();
    for (const [userId, telegramId] of [
      [ids.ana, telegram.ana],
      [ids.carla, telegram.carla],
    ] as const) {
      const { error } = await admin
        .from("household_members")
        .update({ telegram_user_id: telegramId })
        .eq("user_id", userId);
      if (error) throw error;
    }
    const beforeBlue = await rows(azul);
    const beforeGreen = await rows(verde);
    const fake = await startFakeTelegram();
    const bot = await startBot({
      TELEGRAM_API_BASE_URL: fake.baseUrl,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_WEBHOOK_SECRET: secret,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET!,
    });
    let updateId = 1;
    async function send(from: number, chat: number, text: string) {
      const response = await fetch(`${bot.url}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify({
          update_id: updateId++,
          message: {
            chat: { id: chat, type: "private" },
            from: { id: from },
            text,
          },
        }),
      });
      expect(response.status).toBe(200);
    }
    async function tap(from: number, chat: number, messageId: number) {
      const response = await fetch(`${bot.url}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify({
          update_id: updateId++,
          callback_query: {
            id: randomUUID(),
            from: { id: from },
            data: "cf",
            message: { message_id: messageId, chat: { id: chat } },
          },
        }),
      });
      expect(response.status).toBe(200);
    }
    function latest(chat: number): SentMessage {
      const message = [...fake.sent]
        .reverse()
        .find((sent) => sent.method === "sendMessage" && sent.chatId === chat);
      if (!message) throw new Error(`No Telegram reply in ${chat}`);
      return message;
    }
    try {
      await send(telegram.ana, 3001, "mercado 50");
      await send(telegram.carla, 3002, "mercado 50");
      expect((await rows(azul)).length).toBe(beforeBlue.length);
      expect((await rows(verde)).length).toBe(beforeGreen.length);
      await send(telegram.ana, 3001, "confirmar");
      await send(telegram.carla, 3002, "confirmar");
      expect(
        (await rows(azul)).filter(
          (row) =>
            row.description.toLowerCase().includes("mercado") &&
            !beforeBlue.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          household_id: azul,
          created_by_user_id: ids.ana,
          amount_cents: 5000,
        }),
      ]);
      expect(
        (await rows(verde)).filter(
          (row) =>
            row.description.toLowerCase().includes("mercado") &&
            !beforeGreen.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          household_id: verde,
          created_by_user_id: ids.carla,
          amount_cents: 5000,
        }),
      ]);

      const chat = 4001;
      await send(telegram.ana, chat, "pizza azul 71");
      const anaPrompt = latest(chat);
      const promptMessageId = fake.sent.indexOf(anaPrompt) + 1;
      await send(telegram.carla, chat, "pizza verde 93");
      await tap(telegram.carla, chat, promptMessageId);
      expect(fake.sent.at(-1)?.method).toBe("answerCallbackQuery");
      expect(fake.sent.at(-1)?.text).toContain("só quem criou");
      expect(
        (await rows(azul)).some((row) =>
          row.description.includes("pizza azul"),
        ),
      ).toBe(false);
      expect(
        (await rows(verde)).some((row) =>
          row.description.includes("pizza verde"),
        ),
      ).toBe(false);
      await send(telegram.carla, chat, "confirmar");
      await send(telegram.ana, chat, "confirmar");
      expect(
        (await rows(azul)).filter(
          (row) =>
            row.description === "pizza azul" &&
            !beforeBlue.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          description: "pizza azul",
          amount_cents: 7100,
          created_by_user_id: ids.ana,
        }),
      ]);
      expect(
        (await rows(verde)).filter(
          (row) =>
            row.description === "pizza verde" &&
            !beforeGreen.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          description: "pizza verde",
          amount_cents: 9300,
          created_by_user_id: ids.carla,
        }),
      ]);

      await send(telegram.ana, 5001, "últimos 10");
      expect(latest(5001).text).toContain("pizza azul");
      expect(latest(5001).text).not.toContain("pizza verde");

      await send(telegram.ana, 6001, "Bruno comprou pizza 80");
      await send(telegram.ana, 6001, "confirmar");
      expect(await rows(azul)).toContainEqual(
        expect.objectContaining({
          responsible_user_id: ids.bruno,
          created_by_user_id: ids.ana,
          amount_cents: 8000,
        }),
      );
      await send(telegram.carla, 6002, "Bruno comprou pizza 80");
      await send(telegram.carla, 6002, "confirmar");
      const greenPizza = (await rows(verde)).filter(
        (row) =>
          row.amount_cents === 8000 &&
          !beforeGreen.some((old) => old.id === row.id),
      );
      expect(greenPizza).toHaveLength(1);
      expect(
        greenPizza.every((row) => row.responsible_user_id !== ids.bruno),
      ).toBe(true);

      const prior = await writeCounts();
      await send(telegram.outsider, 7001, "mercado 50");
      expect(latest(7001).text).toBe(refusal);
      expect(await writeCounts()).toEqual(prior);
      for (const reply of fake.sent.filter((sent) => sent.text))
        expect(reply.text).not.toMatch(forbidden);
    } finally {
      await bot.stop();
      await fake.stop();
    }
  }, 180_000);

  it("links only the code owner and rejects expired, missing, and already-bound codes", async () => {
    const { ids, azul, verde } = await provisionMultiTenantFixtures();
    await ensureAccount(azul);
    await ensureAccount(verde);
    const admin = adminClient();
    const linkedId = Math.floor(Math.random() * 1_000_000_000) + 4_000_000_000;
    const outsiderId = linkedId + 1;
    const userId = linkedId + 2;
    const reset = await admin
      .from("household_members")
      .update({ telegram_user_id: null, telegram_username: null })
      .eq("user_id", ids.ana);
    if (reset.error) throw reset.error;
    const bindB = await admin
      .from("household_members")
      .update({ telegram_user_id: linkedId })
      .eq("user_id", ids.carla);
    if (bindB.error) throw bindB.error;
    async function codeFor(email: string) {
      const client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_ANON_KEY!,
      );
      const signed = await client.auth.signInWithPassword({
        email,
        password: testPassword,
      });
      if (signed.error) throw signed.error;
      const result = await client.rpc("create_telegram_link_code");
      if (result.error) throw result.error;
      return result.data as string;
    }
    const fake = await startFakeTelegram();
    const bot = await startBot({
      TELEGRAM_API_BASE_URL: fake.baseUrl,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_WEBHOOK_SECRET: secret,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET!,
    });
    let updateId = 1000;
    async function send(from: number, text: string, chatType = "private") {
      const response = await fetch(`${bot.url}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify({
          update_id: updateId++,
          message: {
            chat: { id: from, type: chatType },
            from: { id: from },
            text,
          },
        }),
      });
      expect(response.status).toBe(200);
      return fake.sent.at(-1)?.text;
    }
    try {
      const code = await codeFor(members.ana.email);
      expect(await send(outsiderId, `/vincular ${code}`, "group")).toContain(
        "só funciona no chat privado",
      );
      expect(
        (await admin.from("telegram_link_codes").select("member_id")).data,
      ).toHaveLength(1);
      expect(await send(linkedId, `/vincular ${code}`)).toContain(
        "Não consegui vincular",
      );
      expect(
        (await admin.from("telegram_link_codes").select("member_id")).data,
      ).toHaveLength(0);
      const freshCode = await codeFor(members.ana.email);
      expect(await send(userId, `/vincular ${freshCode}`)).toContain(
        "Pronto, Ana!",
      );
      expect(await send(userId, "mercado 50")).not.toBe(refusal);
      expect(await send(outsiderId, `/vincular ${freshCode}`)).toContain(
        "Não consegui vincular",
      );
      expect(await send(outsiderId, "mercado 50")).toBe(refusal);
      expect(await send(outsiderId, "/vincular")).toContain(
        "Não consegui vincular",
      );

      const codeB = await codeFor(members.carla.email);
      expect(await send(userId, `/start ${codeB}`)).toContain(
        "Não consegui vincular",
      );
      const { data: links } = await admin
        .from("household_members")
        .select("user_id,telegram_user_id")
        .in("user_id", [ids.ana, ids.carla]);
      expect(
        links?.find((row) => row.user_id === ids.ana)?.telegram_user_id,
      ).toBe(userId);
      expect(
        links?.find((row) => row.user_id === ids.carla)?.telegram_user_id,
      ).toBe(linkedId);

      const expiredCode = await codeFor(members.ana.email);
      const expiredHash = createHash("sha256")
        .update(expiredCode)
        .digest("hex");
      const expiration = await admin
        .from("telegram_link_codes")
        .update({ expires_at: "2000-01-01T00:00:00Z" })
        .eq("code_hash", expiredHash);
      if (expiration.error) throw expiration.error;
      expect(await send(outsiderId, `/vincular ${expiredCode}`)).toContain(
        "Não consegui vincular",
      );
      expect(await send(outsiderId, "mercado 70")).toBe(refusal);
    } finally {
      await bot.stop();
      await fake.stop();
    }
  }, 180_000);
});
