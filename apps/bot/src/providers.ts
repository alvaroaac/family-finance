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
 */
export function createAnthropicCompletionClient(args: {
  apiKey: string;
  model: string;
  /** Per-request network timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number;
}): AiCompletionClient {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return {
    async complete(prompt: string): Promise<string | null> {
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
          return null;
        }
        const json = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = (json.content ?? [])
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text as string)
          .join("");
        return text.length > 0 ? text : null;
      } catch {
        return null;
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
 */
export function createOpenAiTranscriptionProvider(args: {
  apiKey: string;
  model: string;
  /** Per-request network timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number;
}): TranscriptionProvider {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return {
    async transcribe(filePath: string, mimeType?: string): Promise<string> {
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
      } catch (error) {
        // An abort surfaces as an AbortError; normalize it to a clear,
        // caller-friendly timeout error (the deeper cause is preserved).
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            `Transcription timed out after ${timeoutMs}ms`,
            { cause: error },
          );
        }
        throw error;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Transcription failed: ${response.status} ${body}`);
      }
      const json = (await response.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
