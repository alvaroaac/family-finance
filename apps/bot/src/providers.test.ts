import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAnthropicCompletionClient,
  createOpenAiCompletionClient,
  createOpenAiTranscriptionProvider,
} from "./providers.js";

// ---------------------------------------------------------------------------
// Provider fetch timeouts. The LIVE API parsing path is intentionally untested
// (no keys); these cover the abort/timeout behavior with a mocked global fetch.
//
// The fake fetch honors the AbortSignal forwarded by the client: it never
// resolves on its own, but rejects with an AbortError as soon as the signal
// fires — exactly how Node's fetch behaves on `controller.abort()`.
// ---------------------------------------------------------------------------

/** A fetch that hangs until its AbortSignal fires, then rejects like Node does. */
function hangingFetch(): typeof fetch {
  return vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined) {
        return; // never settles
      }
      signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createAnthropicCompletionClient (timeout)", () => {
  it("returns null when the request times out (degrades to deterministic path)", async () => {
    globalThis.fetch = hangingFetch();
    const client = createAnthropicCompletionClient({
      apiKey: "sk-test",
      model: "claude-test",
      timeoutMs: 5,
    });

    const result = await client.complete("Uber 32 reais");

    // A hung Anthropic call must never block categorization: it yields null so
    // the engine falls back to its deterministic rules.
    expect(result).toBeNull();
  });
});

/** A fetch that resolves once with the given status and JSON body. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("createAnthropicCompletionClient (telemetry)", () => {
  it("emits one ok record with token usage and the caller label", async () => {
    globalThis.fetch = jsonFetch(200, {
      status: "completed",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const logCall = vi.fn();
    const client = createAnthropicCompletionClient({
      apiKey: "sk-test",
      model: "claude-test",
      logCall,
    });

    const result = await client.complete("Uber 32 reais", {
      label: "classifier",
    });

    expect(result).toBe("hello");
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "classifier",
        model: "claude-test",
        outcome: "ok",
        inputTokens: 42,
        outputTokens: 7,
        latencyMs: expect.any(Number),
      }),
    );
  });

  it("records a 200-with-no-text call as an abstention, not a failure", async () => {
    globalThis.fetch = jsonFetch(200, { content: [], usage: {} });
    const logCall = vi.fn();
    const client = createAnthropicCompletionClient({
      apiKey: "sk-test",
      model: "claude-test",
      logCall,
    });

    const result = await client.complete("noise", { label: "interpreter" });

    expect(result).toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "abstain", label: "interpreter" }),
    );
  });

  it("records the status on an http_error and defaults an unlabeled call", async () => {
    globalThis.fetch = jsonFetch(529, { error: "overloaded" });
    const logCall = vi.fn();
    const client = createAnthropicCompletionClient({
      apiKey: "sk-test",
      model: "claude-test",
      logCall,
    });

    const result = await client.complete("mercado 230");

    expect(result).toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "http_error",
        status: 529,
        label: "unknown",
      }),
    );
  });

  it("records a timeout as its own outcome", async () => {
    globalThis.fetch = hangingFetch();
    const logCall = vi.fn();
    const client = createAnthropicCompletionClient({
      apiKey: "sk-test",
      model: "claude-test",
      timeoutMs: 5,
      logCall,
    });

    const result = await client.complete("farmácia 45", {
      label: "categorizer",
    });

    expect(result).toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timeout", label: "categorizer" }),
    );
  });
});

describe("createOpenAiCompletionClient", () => {
  it("uses non-stored JSON Responses output and records usage", async () => {
    globalThis.fetch = jsonFetch(200, {
      status: "completed",
      output: [
        { content: [{ type: "output_text", text: '{"items":[]}' }] },
      ],
      usage: { input_tokens: 80, output_tokens: 12 },
    });
    const logCall = vi.fn();
    const client = createOpenAiCompletionClient({
      apiKey: "sk-test",
      model: "gpt-5.4",
      outputSchema: { type: "object", additionalProperties: false },
      logCall,
    });

    await expect(
      client.complete("categorize", { label: "import_category_paid_fallback" }),
    ).resolves.toBe('{"items":[]}');
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(String(fetchCall?.[1]?.body)) as {
      store?: boolean;
      text?: {
        format?: { type?: string; strict?: boolean; schema?: unknown };
      };
    };
    expect(body).toMatchObject({
      store: false,
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: { type: "object", additionalProperties: false },
        },
      },
    });
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        outcome: "ok",
        inputTokens: 80,
        outputTokens: 12,
      }),
    );
  });

  it("returns null and records an HTTP failure without response contents", async () => {
    globalThis.fetch = jsonFetch(429, { error: { message: "secret detail" } });
    const logCall = vi.fn();
    const client = createOpenAiCompletionClient({
      apiKey: "sk-test",
      model: "gpt-5.4",
      outputSchema: { type: "object" },
      logCall,
    });

    await expect(client.complete("categorize")).resolves.toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "http_error", status: 429 }),
    );
    expect(JSON.stringify(logCall.mock.calls)).not.toContain("secret detail");
  });

  it("returns null and records a timeout", async () => {
    globalThis.fetch = hangingFetch();
    const logCall = vi.fn();
    const client = createOpenAiCompletionClient({
      apiKey: "sk-test",
      model: "gpt-5.4",
      outputSchema: { type: "object" },
      timeoutMs: 5,
      logCall,
    });

    await expect(client.complete("categorize")).resolves.toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timeout" }),
    );
  });

  it("rejects output text from an incomplete 200 response", async () => {
    globalThis.fetch = jsonFetch(200, {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { content: [{ type: "output_text", text: '{"items":[]}' }] },
      ],
      usage: { input_tokens: 80, output_tokens: 1600 },
    });
    const logCall = vi.fn();
    const client = createOpenAiCompletionClient({
      apiKey: "sk-test",
      model: "gpt-5.4",
      outputSchema: { type: "object" },
      logCall,
    });

    await expect(client.complete("categorize")).resolves.toBeNull();
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        error: "OpenAI response did not complete",
      }),
    );
    expect(JSON.stringify(logCall.mock.calls)).not.toContain(
      "max_output_tokens",
    );
  });
});

describe("createOpenAiTranscriptionProvider (timeout)", () => {
  let dir = "";
  let filePath = "";

  afterEach(async () => {
    if (dir !== "") {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function tempAudioFile(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "ff-providers-test-"));
    filePath = join(dir, "voice.ogg");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    return filePath;
  }

  it("throws a clear timeout error when the request times out (caller -> tente por texto)", async () => {
    globalThis.fetch = hangingFetch();
    const provider = createOpenAiTranscriptionProvider({
      apiKey: "sk-test",
      model: "whisper-1",
      timeoutMs: 5,
    });
    const path = await tempAudioFile();

    // A timeout surfaces as a descriptive error (not a raw AbortError) so the
    // bot can degrade to asking for text.
    await expect(provider.transcribe(path, "audio/ogg")).rejects.toThrow(
      /timed out/i,
    );
  });

  it("emits one ok record with the transcription label (no token counts)", async () => {
    globalThis.fetch = jsonFetch(200, { text: "olá mundo" });
    const logCall = vi.fn();
    const provider = createOpenAiTranscriptionProvider({
      apiKey: "sk-test",
      model: "whisper-1",
      logCall,
    });
    const path = await tempAudioFile();

    const result = await provider.transcribe(path, "audio/ogg");

    expect(result).toBe("olá mundo");
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "transcription",
        model: "whisper-1",
        outcome: "ok",
        latencyMs: expect.any(Number),
      }),
    );
    // No token counts for audio transcription (billed by duration).
    const record = logCall.mock.calls.at(0)?.at(0);
    expect(record).not.toHaveProperty("inputTokens");
    expect(record).not.toHaveProperty("outputTokens");
  });

  it("records status on an http_error and still throws", async () => {
    globalThis.fetch = jsonFetch(500, { error: "boom" });
    const logCall = vi.fn();
    const provider = createOpenAiTranscriptionProvider({
      apiKey: "sk-test",
      model: "whisper-1",
      logCall,
    });
    const path = await tempAudioFile();

    await expect(provider.transcribe(path, "audio/ogg")).rejects.toThrow(
      /Transcription failed: 500/,
    );
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "http_error", status: 500 }),
    );
  });

  it("records a timeout outcome before rethrowing", async () => {
    globalThis.fetch = hangingFetch();
    const logCall = vi.fn();
    const provider = createOpenAiTranscriptionProvider({
      apiKey: "sk-test",
      model: "whisper-1",
      timeoutMs: 5,
      logCall,
    });
    const path = await tempAudioFile();

    await expect(provider.transcribe(path, "audio/ogg")).rejects.toThrow(
      /timed out/i,
    );
    expect(logCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timeout", label: "transcription" }),
    );
  });
});
