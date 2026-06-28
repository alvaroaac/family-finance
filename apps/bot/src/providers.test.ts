import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAnthropicCompletionClient,
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
});
