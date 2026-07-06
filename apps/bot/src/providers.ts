/**
 * Edge provider clients for the bot (constructed ONLY at server start with real
 * config, NEVER imported by unit tests, which inject mocks).
 *
 * These implement the injectable interfaces the pure packages expose:
 *   - `AiCompletionClient` (@family-finance/categorization) — Anthropic Claude
 *     Messages API, used by `createAiCategorizer` for the categorization
 *     fallback and complex-message interpretation.
 *   - `TranscriptionProvider` (./audio) — OpenAI audio transcription (Whisper),
 *     used to turn a downloaded voice note into text.
 *
 * No AI SDK dependency is added: both clients use the global `fetch` (Node 22).
 * Keys are passed in from `@family-finance/config` getters (resolved from the
 * environment) and are NEVER hardcoded.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AiCompletionClient } from "@family-finance/categorization";

import {
  logAiCall,
  type AiCallLogger,
  type AiCallOutcome,
} from "./ai-telemetry.js";
import type { TranscriptionProvider } from "./audio.js";

/**
 * Default per-request network timeout (ms) for the provider `fetch` calls. The
 * provider APIs are best-effort enrichments on a chat flow, so a hung request
 * must NOT pin the webhook: on timeout the completion client degrades to the
 * deterministic categorizer (returns `null`) and the transcription provider
 * surfaces a clear error the caller turns into a "tente por texto" fallback.
 * Overridable per client via the `timeoutMs` arg.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * Run an async fetch under an abort-on-timeout signal, always clearing the timer
 * afterwards. The `signal` is forwarded to `fetch`, so a timeout rejects the
 * pending request with an `AbortError` instead of leaking a hung connection.
 */
async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Anthropic Claude completion client. Sends a single user prompt to the Messages
 * API and returns the concatenated text reply. Returns `null` on any error
 * (including a network timeout) so the categorization engine falls back to its
 * deterministic path.
 *
 * Every call funnels through the one `complete` seam below, which emits a single
 * {@link AiCallLogger} record — outcome, latency, and token usage — per call.
 * Prompt caching is intentionally NOT used: the largest prompt prefix (~600
 * tokens) is far below Haiku's ~4096-token cache minimum, so `cache_control`
 * would silently no-op. Revisit only if a stable prefix grows past that floor.
 */
export function createAnthropicCompletionClient(args: {
  apiKey: string;
  model: string;
  /** Per-request network timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Telemetry sink; defaults to {@link logAiCall}. Injected in tests. */
  logCall?: AiCallLogger;
}): AiCompletionClient {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const logCall = args.logCall ?? logAiCall;
  return {
    async complete(prompt, opts): Promise<string | null> {
      const startedAt = Date.now();
      let outcome: AiCallOutcome = "error";
      let status: number | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let error: string | undefined;
      try {
        const response = await withTimeout(timeoutMs, (signal) =>
          fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": args.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: args.model,
              max_tokens: 512,
              messages: [{ role: "user", content: prompt }],
            }),
            signal,
          }),
        );
        if (!response.ok) {
          outcome = "http_error";
          status = response.status;
          return null;
        }
        const json = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        inputTokens = json.usage?.input_tokens;
        outputTokens = json.usage?.output_tokens;
        const text = (json.content ?? [])
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text as string)
          .join("");
        // A 200 with no text is the model abstaining, not a failure.
        outcome = text.length > 0 ? "ok" : "abstain";
        return text.length > 0 ? text : null;
      } catch (caught) {
        // An abort surfaces as an AbortError; everything else is a network/parse
        // failure. Either way categorization degrades to its deterministic path.
        outcome =
          caught instanceof Error && caught.name === "AbortError"
            ? "timeout"
            : "error";
        error = caught instanceof Error ? caught.message : String(caught);
        return null;
      } finally {
        logCall({
          label: opts?.label ?? "unknown",
          model: args.model,
          outcome,
          latencyMs: Date.now() - startedAt,
          inputTokens,
          outputTokens,
          status,
          error,
        });
      }
    },
  };
}

/**
 * OpenAI audio transcription provider (Whisper). Reads the temp file and posts it
 * as multipart/form-data to the transcription endpoint. The caller
 * (`transcribeVoiceMessage`) deletes the temp file afterwards in its `finally`.
 *
 * On a network timeout the fetch is aborted and this throws a clear error so the
 * caller degrades to a "tente por texto" fallback (the temp file is still
 * cleaned up by `transcribeVoiceMessage`'s `finally`).
 *
 * Like the completion client, every call emits one {@link AiCallLogger} record
 * (outcome, latency, status) through the same telemetry seam. There are no token
 * counts to report — Whisper is billed by audio duration, not tokens — so those
 * fields are omitted.
 */
export function createOpenAiTranscriptionProvider(args: {
  apiKey: string;
  model: string;
  /** Per-request network timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Telemetry sink; defaults to {@link logAiCall}. Injected in tests. */
  logCall?: AiCallLogger;
}): TranscriptionProvider {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const logCall = args.logCall ?? logAiCall;
  return {
    async transcribe(filePath: string, mimeType?: string): Promise<string> {
      const startedAt = Date.now();
      let outcome: AiCallOutcome = "error";
      let status: number | undefined;
      let error: string | undefined;
      try {
        const bytes = await readFile(filePath);
        const form = new FormData();
        const blob = new Blob([new Uint8Array(bytes)], {
          type: mimeType ?? "audio/ogg",
        });
        form.append("file", blob, basename(filePath));
        form.append("model", args.model);
        let response: Response;
        try {
          response = await withTimeout(timeoutMs, (signal) =>
            fetch("https://api.openai.com/v1/audio/transcriptions", {
              method: "POST",
              headers: { authorization: `Bearer ${args.apiKey}` },
              body: form,
              signal,
            }),
          );
        } catch (caught) {
          // An abort surfaces as an AbortError; normalize it to a clear,
          // caller-friendly timeout error (the deeper cause is preserved).
          if (caught instanceof Error && caught.name === "AbortError") {
            outcome = "timeout";
            error = `Transcription timed out after ${timeoutMs}ms`;
            throw new Error(error, { cause: caught });
          }
          throw caught;
        }
        if (!response.ok) {
          outcome = "http_error";
          status = response.status;
          const body = await response.text().catch(() => "");
          throw new Error(`Transcription failed: ${response.status} ${body}`);
        }
        const json = (await response.json()) as { text?: string };
        outcome = "ok";
        return json.text ?? "";
      } catch (caught) {
        // Fill the error message for any path that didn't already set it.
        error ??= caught instanceof Error ? caught.message : String(caught);
        throw caught;
      } finally {
        logCall({
          label: "transcription",
          model: args.model,
          outcome,
          latencyMs: Date.now() - startedAt,
          status,
          error,
        });
      }
    },
  };
}
