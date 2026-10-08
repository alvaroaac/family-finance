import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createTestUser } from "./lib/users.js";
import { startFakeTelegram } from "./lib/fake-telegram.js";
import { startBot } from "./lib/bot-process.js";

const api = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const secret = "e2e-webhook-secret";
const root = fileURLToPath(new URL("../", import.meta.url));

function developerContainers(): string[] {
  return execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (name) =>
        name.startsWith("supabase_db_family-finance") &&
        !name.startsWith("supabase_db_family-finance-e2e"),
    )
    .sort();
}

describe("isolated end-to-end harness", () => {
  it("starts beside developer stacks and resets migrations plus seed on a second up", () => {
    const before = developerContainers();
    execFileSync("pnpm", ["e2e:up"], { cwd: root, stdio: "pipe" });
    expect(developerContainers()).toEqual(before);
    const db = "supabase_db_family-finance-e2e";
    const sql = (query: string) =>
      execFileSync(
        "docker",
        ["exec", db, "psql", "-U", "postgres", "-At", "-c", query],
        { encoding: "utf8" },
      ).trim();
    expect(
      sql("select count(*) from supabase_migrations.schema_migrations"),
    ).toBe(
      execFileSync(
        "bash",
        ["-c", "find supabase/migrations -name '*.sql' | wc -l"],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    );
    expect(
      sql(
        "select name from households where id='00000000-0000-0000-0000-000000000001'",
      ),
    ).toBe("Casa");
    sql("insert into households(name) values ('Reset marker')");
    execFileSync("pnpm", ["e2e:up"], { cwd: root, stdio: "pipe" });
    expect(
      sql("select count(*) from households where name='Reset marker'"),
    ).toBe("0");
    expect(developerContainers()).toEqual(before);
  }, 180_000);

  it("creates an unallowlisted confirmed auth user without membership", async () => {
    const email = `outside-${randomUUID()}@example.test`;
    const { userId } = await createTestUser(email, "Test-password-123!");
    const admin = createClient(api, serviceKey);
    const { data: user } = await admin.auth.admin.getUserById(userId);
    expect(user.user?.email_confirmed_at).toBeTruthy();
    const { data, error } = await admin
      .from("household_members")
      .select("user_id")
      .eq("user_id", userId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("routes a linked member's reply to fake Telegram and writes their transaction under RLS", async () => {
    const fake = await startFakeTelegram();
    const admin = createClient(api, serviceKey);
    const email = `bot-${randomUUID()}@example.test`;
    const { error: allowError } = await admin.from("allowed_emails").insert({
      email,
      household_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(allowError).toBeNull();
    const { userId } = await createTestUser(email, "Test-password-123!");
    const telegramId =
      Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000;
    const { error: linkError } = await admin
      .from("household_members")
      .update({ telegram_user_id: telegramId })
      .eq("user_id", userId);
    expect(linkError).toBeNull();
    const { error: accountError } = await admin.from("accounts").insert({
      household_id: "00000000-0000-0000-0000-000000000001",
      kind: "checking",
      name: "Conta de teste",
    });
    expect(accountError).toBeNull();
    const bot = await startBot({
      TELEGRAM_API_BASE_URL: fake.baseUrl,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_WEBHOOK_SECRET: secret,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET!,
    });
    try {
      const response = await fetch(`${bot.url}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            chat: { id: 12345 },
            from: { id: telegramId },
            text: "oi",
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(
        fake.sent.some(
          (message) =>
            message.method === "sendMessage" && message.chatId === 12345,
        ),
      ).toBe(true);
      for (const text of ["Uber 32 reais ontem", "confirmar"]) {
        const writeResponse = await fetch(`${bot.url}/webhook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify({
            update_id: text === "confirmar" ? 3 : 2,
            message: {
              chat: { id: 12346 },
              from: { id: telegramId },
              text,
            },
          }),
        });
        expect(writeResponse.status).toBe(200);
      }
      const { data: written, error: writeError } = await admin
        .from("transactions")
        .select("household_id, created_by_user_id, amount_cents")
        .eq("created_by_user_id", userId);
      expect(writeError).toBeNull();
      expect(written).toContainEqual({
        household_id: "00000000-0000-0000-0000-000000000001",
        created_by_user_id: userId,
        amount_cents: 3200,
      });
    } finally {
      await bot.stop();
      await fake.stop();
    }
  }, 30_000);
});
