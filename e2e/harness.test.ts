import {
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "./lib/users.js";
import { startFakeTelegram } from "./lib/fake-telegram.js";
import { startBot } from "./lib/bot-process.js";

const childProbe = vi.hoisted(() => ({
  child: undefined as ChildProcess | undefined,
  env: undefined as NodeJS.ProcessEnv | undefined,
  ignoreTerm: false,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const actualArgs = childProbe.ignoreTerm
        ? [
            "-e",
            `
        process.on('SIGTERM', () => {});
        require('node:http').createServer((req, res) => res.end('healthy'))
          .listen(Number(process.env.PORT), '127.0.0.1');
      `,
          ]
        : args;
      childProbe.child = actual.spawn(command, actualArgs, options);
      childProbe.env = options.env;
      return childProbe.child;
    },
  };
});

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

// These process regressions require no database or Docker stack.
describe("bot process lifecycle", () => {
  const testEnv = {
    SUPABASE_URL: "http://127.0.0.1:65534",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:65534",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SUPABASE_JWT_SECRET: "test-jwt-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: secret,
  };
  afterEach(async () => {
    vi.unstubAllEnvs();
    childProbe.ignoreTerm = false;
    const child = childProbe.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    childProbe.child = undefined;
    childProbe.env = undefined;
  });

  it("starts with inherited paid fallback enabled while isolating provider keys", async () => {
    vi.stubEnv("IMPORT_PAID_FALLBACK_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-parent-key");
    const fake = await startFakeTelegram();
    let bot: Awaited<ReturnType<typeof startBot>> | undefined;
    try {
      bot = await startBot({ ...testEnv, TELEGRAM_API_BASE_URL: fake.baseUrl });
      expect((await fetch(`${bot.url}/health`)).ok).toBe(true);
      expect(childProbe.env?.IMPORT_PAID_FALLBACK_ENABLED).toBe("false");
      expect(childProbe.env?.OPENAI_API_KEY).toBeUndefined();
      await Promise.all([bot.stop(), bot.stop()]);
    } finally {
      await bot?.stop();
      await fake.stop();
    }
  });

  it("returns promptly when the real child terminated before stop", async () => {
    const fake = await startFakeTelegram();
    try {
      const bot = await startBot({
        ...testEnv,
        TELEGRAM_API_BASE_URL: fake.baseUrl,
      });
      const child = childProbe.child!;
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      const started = Date.now();
      await bot.stop();
      await bot.stop();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await fake.stop();
    }
  }, 10_000);

  it("escalates a live child that ignores SIGTERM and shares concurrent stops", async () => {
    childProbe.ignoreTerm = true;
    const bot = await startBot(testEnv);
    const child = childProbe.child!;
    const started = Date.now();
    await Promise.all([bot.stop(), bot.stop()]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5000);
    await bot.stop();
  }, 10_000);
});
