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
 * Anthropic Claude completion client. Sends a single user prompt to the Messages
 * API and returns the concatenated text reply. Returns `null` on any error so
 * the categorization engine falls back to its deterministic path.
 */
export function createAnthropicCompletionClient(args: {
  apiKey: string;
  model: string;
}): AiCompletionClient {
  return {
    async complete(prompt: string): Promise<string | null> {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        });
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
 */
export function createOpenAiTranscriptionProvider(args: {
  apiKey: string;
  model: string;
}): TranscriptionProvider {
  return {
    async transcribe(filePath: string, mimeType?: string): Promise<string> {
      const bytes = await readFile(filePath);
      const form = new FormData();
      const blob = new Blob([new Uint8Array(bytes)], {
        type: mimeType ?? "audio/ogg",
      });
      form.append("file", blob, basename(filePath));
      form.append("model", args.model);
      const response = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { authorization: `Bearer ${args.apiKey}` },
          body: form,
        },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Transcription failed: ${response.status} ${body}`);
      }
      const json = (await response.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
