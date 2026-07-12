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
    expect(parsed.TELEGRAM_WEBHOOK_SECRET).toBeTruthy();
    expect(parsed.IMPORT_PAID_FALLBACK_ENABLED).toBe("false");
    expect(parsed.IMPORT_PAID_FALLBACK_MAX_ITEMS).toBe(10);
  });

  it("still rejects a malformed SUPABASE_URL", () => {
    const env = parseEnvExample(templatePath);
    env.SUPABASE_URL = "not-a-url";
    expect(() => getBotServerEnv(env as NodeJS.ProcessEnv)).toThrow();
  });

  it("requires an explicit paid provider and model when enabled", () => {
    const env = parseEnvExample(templatePath);
    env.IMPORT_PAID_FALLBACK_ENABLED = "true";
    expect(() => getBotServerEnv(env as NodeJS.ProcessEnv)).toThrow(
      /IMPORT_PAID_FALLBACK_PROVIDER/,
    );

    env.IMPORT_PAID_FALLBACK_PROVIDER = "anthropic";
    env.IMPORT_PAID_FALLBACK_MODEL = "claude-sonnet-4-5";
    expect(getBotServerEnv(env as NodeJS.ProcessEnv)).toMatchObject({
      IMPORT_PAID_FALLBACK_PROVIDER: "anthropic",
      IMPORT_PAID_FALLBACK_MODEL: "claude-sonnet-4-5",
    });
  });

  it("getServerEnv (web) keeps requiring the NEXT_PUBLIC_* vars", () => {
    const env = parseEnvExample(templatePath);
    expect(() => getServerEnv(env as NodeJS.ProcessEnv)).toThrow();
  });
});
