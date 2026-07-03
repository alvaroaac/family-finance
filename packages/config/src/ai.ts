/**
 * Provider-agnostic AI configuration/selection for the Family Finance apps.
 *
 * IMPORTANT: like the rest of `@family-finance/config`, NOTHING here validates
 * or throws at import/module-load time. These are LAZY getters — call them at
 * request time. A missing key never breaks the build; it just yields
 * `isConfigured: false` so the caller can fall back to deterministic behavior.
 *
 * Two independent concerns:
 *   - LLM text interpretation (interpreting complex/ambiguous messages and the
 *     categorization AI fallback). Default provider: ANTHROPIC Claude.
 *   - Audio transcription (voice notes -> text). Default provider: OPENAI
 *     (Whisper), reusing the already-configured OPENAI_API_KEY.
 *
 * Keys are NEVER hardcoded. They are resolved from the environment only.
 */

/**
 * Current default Anthropic Claude model id for text interpretation. Override
 * per environment via `ANTHROPIC_MODEL` without touching code.
 *
 * Haiku is deliberate: the workload is closed-choice categorization and small
 * structured extraction with a deterministic fallback, so the cheapest tier
 * is sufficient (~$1/mo at ~20 tx/day vs ~$6 on Opus).
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

/** Default OpenAI transcription model (Whisper). */
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

export type LlmProvider = "anthropic";
export type TranscriptionProvider = "openai";

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  /** Resolved API key, or undefined when not configured. */
  apiKey: string | undefined;
  /** True only when a usable key is present. */
  isConfigured: boolean;
};

export type TranscriptionConfig = {
  provider: TranscriptionProvider;
  model: string;
  apiKey: string | undefined;
  isConfigured: boolean;
};

/**
 * Resolve the LLM text-interpretation config. Defaults to Anthropic Claude with
 * {@link DEFAULT_ANTHROPIC_MODEL}; the model can be overridden via
 * `ANTHROPIC_MODEL`. The key comes from `ANTHROPIC_API_KEY`. Build-safe: returns
 * `isConfigured: false` (never throws) when the key is absent.
 */
export function getLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig {
  const apiKey = nonEmpty(env.ANTHROPIC_API_KEY);
  const model = nonEmpty(env.ANTHROPIC_MODEL) ?? DEFAULT_ANTHROPIC_MODEL;
  return {
    provider: "anthropic",
    model,
    apiKey,
    isConfigured: apiKey !== undefined,
  };
}

/**
 * Resolve the audio-transcription config. Defaults to OpenAI Whisper using the
 * shared `OPENAI_API_KEY`. Build-safe: never throws.
 */
export function getTranscriptionConfig(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionConfig {
  const apiKey = nonEmpty(env.OPENAI_API_KEY);
  return {
    provider: "openai",
    model: DEFAULT_TRANSCRIPTION_MODEL,
    apiKey,
    isConfigured: apiKey !== undefined,
  };
}

/** Trim and treat an empty string the same as undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
