import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

// Provider-agnostic AI config/selection (lazy, build-safe). Re-exported so
// `@family-finance/config` is the single entry point.
export {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  getLlmConfig,
  getTranscriptionConfig,
} from "./ai.js";
export type {
  LlmConfig,
  LlmProvider,
  TranscriptionConfig,
  TranscriptionProvider,
} from "./ai.js";

/**
 * Environment schema for the Family Finance apps.
 *
 * IMPORTANT: nothing in this module validates or throws at import/module-load
 * time. Builds (e.g. `next build`) must compile without real secrets, so env
 * access is exposed through lazy getters that callers invoke at request time.
 */
export const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  // Bot-side Supabase URL (the bot container carries no NEXT_PUBLIC_* build
  // context); consumers fall back to NEXT_PUBLIC_SUPABASE_URL when unset.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  // AI providers (all optional so builds compile without secrets):
  // - ANTHROPIC_API_KEY powers the default LLM text-interpretation provider
  //   (Anthropic Claude); OPENAI_API_KEY powers audio transcription (e.g. Whisper).
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  CODEX_ENABLED: z.enum(["true", "false"]).optional(),
  CODEX_MODEL: z.string().min(1).optional(),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).optional(),
  // Import previews are signed by the web app; AI category batches are sent to
  // the bot VPS over a separately authenticated internal endpoint.
  IMPORT_PREVIEW_SIGNING_SECRET: z.string().min(32).optional(),
  IMPORT_SUGGESTION_URL: z.string().url().optional(),
  IMPORT_SUGGESTION_SHARED_SECRET: z.string().min(32).optional(),
  IMPORT_PAID_FALLBACK_ENABLED: z.enum(["true", "false"]).default("false"),
  IMPORT_PAID_FALLBACK_PROVIDER: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.enum(["anthropic", "openai"]).optional(),
  ),
  IMPORT_PAID_FALLBACK_MODEL: optionalNonEmptyString,
  IMPORT_PAID_FALLBACK_MAX_ITEMS: z.coerce
    .number()
    .int()
    .min(0)
    .max(25)
    .default(10),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AUTHORIZED_EMAILS: z.string().min(1),
  HOUSEHOLD_SLUG: z.string().min(1).default("casa"),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Bot-container environment (spec §3.5): the webhook server ships without any
 * web-only configuration, so the NEXT_PUBLIC_* pair and AUTHORIZED_EMAILS are
 * optional here. `SUPABASE_URL` (or the NEXT_PUBLIC fallback) plus the
 * service-role key are enforced by `startBot` itself.
 */
export const botEnvSchema = envSchema.extend({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  AUTHORIZED_EMAILS: z.string().min(1).optional(),
});

export type BotEnv = z.infer<typeof botEnvSchema>;

/**
 * Parse + validate the bot container's environment. Same lazy-call contract as
 * `getServerEnv` — invoke at server start, never at module scope.
 */
export function getBotServerEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  const parsed = botEnvSchema.parse(env);
  if (
    parsed.IMPORT_PAID_FALLBACK_ENABLED === "true" &&
    (parsed.IMPORT_PAID_FALLBACK_PROVIDER === undefined ||
      parsed.IMPORT_PAID_FALLBACK_MODEL === undefined)
  ) {
    throw new Error(
      "IMPORT_PAID_FALLBACK_PROVIDER and IMPORT_PAID_FALLBACK_MODEL are required when paid fallback is enabled",
    );
  }
  if (
    parsed.IMPORT_PAID_FALLBACK_ENABLED === "true" &&
    parsed.IMPORT_PAID_FALLBACK_PROVIDER === "anthropic" &&
    parsed.ANTHROPIC_API_KEY === undefined
  ) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for the Anthropic paid fallback",
    );
  }
  if (
    parsed.IMPORT_PAID_FALLBACK_ENABLED === "true" &&
    parsed.IMPORT_PAID_FALLBACK_PROVIDER === "openai" &&
    parsed.OPENAI_API_KEY === undefined
  ) {
    throw new Error("OPENAI_API_KEY is required for the OpenAI paid fallback");
  }
  return parsed;
}

/**
 * Parse + validate the full environment. Call this lazily (inside a request or
 * action), never at module scope, so a missing secret never breaks the build.
 */
export function getServerEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(env);
}

/**
 * Safe accessor for the Supabase public config. Returns empty strings when the
 * env is not populated (e.g. during `next build`) instead of throwing, so the
 * client can be constructed for type-checking/compilation without real secrets.
 */
export function getSupabasePublicConfig(env: NodeJS.ProcessEnv = process.env): {
  supabaseUrl: string;
  supabaseAnonKey: string;
} {
  return {
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };
}

/**
 * The household slug for the single MVP workspace ("casa").
 */
export function getHouseholdSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOUSEHOLD_SLUG?.trim() || "casa";
}

/**
 * Normalize a raw `AUTHORIZED_EMAILS` value (comma/semicolon/whitespace
 * separated) into a deduplicated, lowercased list of allowed emails. Returns an
 * empty array when unset; this never throws so it is safe to call at build time.
 */
export function parseAuthorizedEmails(
  raw: string | undefined | null,
): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) {
      seen.add(email);
    }
  }
  return [...seen];
}

/**
 * Lazily read the authorized-email allowlist from the environment.
 */
export function getAuthorizedEmails(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return parseAuthorizedEmails(env.AUTHORIZED_EMAILS);
}

/**
 * Decide whether an email is on the allowlist. Comparison is case-insensitive
 * and trims surrounding whitespace. An empty/undefined email is never allowed.
 */
export function isEmailAuthorized(
  email: string | undefined | null,
  allowlist: readonly string[],
): boolean {
  if (!email) {
    return false;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return allowlist.some(
    (allowed) => allowed.trim().toLowerCase() === normalized,
  );
}
