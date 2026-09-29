import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { getBotServerEnv, getServerEnv } from "./index.js";

/** Walk up from cwd to the repo root (works whether vitest runs from the
 * package dir or the workspace root — no import.meta, tsc emits CJS). */
function findRepoFile(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate ${relative} above ${process.cwd()}`);
}

/**
 * Minimal .env parser (KEY=VALUE lines, # comments) — enough to read the
 * checked-in template exactly as docker compose `env_file` would.
 */
function parseEnvExample(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return env;
}

describe("getBotServerEnv", () => {
  const templatePath = findRepoFile(path.join("deploy", "bot", ".env.example"));

  it("accepts exactly the deploy/bot/.env.example variable set (spec §3.5)", () => {
    const env = parseEnvExample(templatePath) as NodeJS.ProcessEnv;
    // Guard against template drift: the web-only vars must NOT be needed.
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeUndefined();
    expect(env.AUTHORIZED_EMAILS).toBeUndefined();

    const parsed = getBotServerEnv(env);
    expect(parsed.SUPABASE_URL).toBe("https://supabase.alvaroekarol.com.br");
    expect(parsed.SUPABASE_SERVICE_ROLE_KEY).toBeTruthy();
    expect(parsed.SUPABASE_ANON_KEY).toBeTruthy();
    expect(parsed.SUPABASE_JWT_SECRET).toBeTruthy();
    expect(parsed.TELEGRAM_WEBHOOK_SECRET).toBeTruthy();
    expect(parsed.IMPORT_PAID_FALLBACK_ENABLED).toBe("false");
    expect(parsed.IMPORT_PAID_FALLBACK_MAX_ITEMS).toBe(10);
  });

  it("still rejects a malformed SUPABASE_URL", () => {
    const env = parseEnvExample(templatePath);
    env.SUPABASE_URL = "not-a-url";
    expect(() => getBotServerEnv(env as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects retired Anthropic fallback configuration", () => {
    const env = parseEnvExample(templatePath);
    env.IMPORT_PAID_FALLBACK_ENABLED = "true";
    env.IMPORT_PAID_FALLBACK_PROVIDER = "anthropic";
    env.IMPORT_PAID_FALLBACK_MODEL = "claude-sonnet-4-5";
    expect(() => getBotServerEnv(env as NodeJS.ProcessEnv)).toThrow();
  });

  it("accepts OpenAI only with its matching API key", () => {
    const env = parseEnvExample(templatePath);
    env.IMPORT_PAID_FALLBACK_ENABLED = "true";
    env.IMPORT_PAID_FALLBACK_PROVIDER = "openai";
    env.IMPORT_PAID_FALLBACK_MODEL = "gpt-5.4";
    delete env.OPENAI_API_KEY;
    expect(() => getBotServerEnv(env as NodeJS.ProcessEnv)).toThrow(
      /OPENAI_API_KEY/,
    );

    env.OPENAI_API_KEY = "sk-test";
    expect(getBotServerEnv(env as NodeJS.ProcessEnv)).toMatchObject({
      IMPORT_PAID_FALLBACK_PROVIDER: "openai",
      IMPORT_PAID_FALLBACK_MODEL: "gpt-5.4",
    });
  });

  it("getServerEnv (web) keeps requiring the NEXT_PUBLIC_* vars", () => {
    const env = parseEnvExample(templatePath);
    expect(() => getServerEnv(env as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("retired email gate", () => {
  const baseEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:56321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  };

  it("parses web config without the retired email variable", () => {
    expect(getServerEnv(baseEnv).NEXT_PUBLIC_SUPABASE_URL).toBe(
      baseEnv.NEXT_PUBLIC_SUPABASE_URL,
    );
  });

  it("ignores the retired email variable when present", () => {
    const parsed = getServerEnv({
      ...baseEnv,
      AUTHORIZED_EMAILS: "someone@example.com",
    });
    expect(parsed).not.toHaveProperty("AUTHORIZED_EMAILS");
  });
});

describe("web host configuration", () => {
  it("accepts an optional comma-separated host list", () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:56321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NEXT_PUBLIC_SITE_URL: "https://family-finance.example.dev",
      ALLOWED_WEB_HOSTS: "casa.example.com,localhost:3100",
    };
    expect(getServerEnv(env)).toMatchObject(env);
    expect(
      getServerEnv({ ...env, ALLOWED_WEB_HOSTS: "" }).ALLOWED_WEB_HOSTS,
    ).toBeUndefined();
  });
});
