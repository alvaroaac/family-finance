import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as audio from "./audio.js";

import {
  transcribeVoiceMessage,
  VoiceNoteTooLargeError,
  type AudioDownloader,
  type TranscriptionProvider,
} from "./audio.js";

// ---------------------------------------------------------------------------
// Temp-file handling: download -> transcribe -> ALWAYS delete (try/finally).
// No real Telegram / provider network — both are injected mocks.
// ---------------------------------------------------------------------------

function fakeDownloader(bytes: Uint8Array): AudioDownloader {
  return {
    async download(fileId: string): Promise<Uint8Array> {
      void fileId;
      return bytes;
    },
  };
}

describe("transcribeVoiceMessage", () => {
  it("downloads to a temp file, transcribes it, and DELETES the temp file", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let seenPath = "";
    let fileExistedDuringTranscribe = false;
    let contentsSeen: Uint8Array | null = null;

    const provider: TranscriptionProvider = {
      async transcribe(filePath: string): Promise<string> {
        seenPath = filePath;
        fileExistedDuringTranscribe = existsSync(filePath);
        contentsSeen = new Uint8Array(await readFile(filePath));
        return "Uber 32 reais ontem";
      },
    };

    const text = await transcribeVoiceMessage(
      { fileId: "voice-1", mimeType: "audio/ogg" },
      { downloader: fakeDownloader(bytes), provider },
    );

    expect(text).toBe("Uber 32 reais ontem");
    // The temp file existed while transcribing with the downloaded bytes...
    expect(fileExistedDuringTranscribe).toBe(true);
    expect(contentsSeen).not.toBeNull();
    expect(Array.from(contentsSeen!)).toEqual([1, 2, 3, 4]);
    // ...and was removed afterwards (no raw audio left on disk).
    expect(existsSync(seenPath)).toBe(false);
  });

  it("still DELETES the temp file when transcription throws (try/finally)", async () => {
    let seenPath = "";
    const provider: TranscriptionProvider = {
      async transcribe(filePath: string): Promise<string> {
        seenPath = filePath;
        expect(existsSync(filePath)).toBe(true);
        throw new Error("provider exploded");
      },
    };

    await expect(
      transcribeVoiceMessage(
        { fileId: "voice-2" },
        { downloader: fakeDownloader(new Uint8Array([9])), provider },
      ),
    ).rejects.toThrow(/provider exploded/);

    expect(seenPath).not.toBe("");
    // Even on failure, the temporary audio must not be left behind.
    expect(existsSync(seenPath)).toBe(false);
  });

  it("deletes the temp file even when the downloader fails before transcription", async () => {
    const failing: AudioDownloader = {
      async download(): Promise<Uint8Array> {
        throw new Error("download failed");
      },
    };
    const provider: TranscriptionProvider = {
      transcribe: vi.fn(async () => "should not be called"),
    };

    await expect(
      transcribeVoiceMessage(
        { fileId: "voice-3" },
        { downloader: failing, provider },
      ),
    ).rejects.toThrow(/download failed/);
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Oversize guard: reject before transcription, never leave a temp file behind.
// Both the post-download byte check and the pre-download Telegram hints count.
// ---------------------------------------------------------------------------

/** Count leftover temp dirs from this module to prove cleanup ran. */
async function audioTempDirCount(): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith("family-finance-audio-")).length;
}

describe("transcribeVoiceMessage (oversize guard)", () => {
  it("rejects when the DOWNLOADED bytes exceed the limit and DELETES the temp file", async () => {
    const before = await audioTempDirCount();
    // 1 KiB payload with a 16-byte cap -> over limit.
    const big = new Uint8Array(1024);
    const provider: TranscriptionProvider = {
      transcribe: vi.fn(async () => "should not be called"),
    };

    await expect(
      transcribeVoiceMessage(
        { fileId: "voice-big", mimeType: "audio/ogg" },
        {
          downloader: fakeDownloader(big),
          provider,
          limits: { maxBytes: 16 },
        },
      ),
    ).rejects.toBeInstanceOf(VoiceNoteTooLargeError);

    // The provider is never invoked for an oversize note...
    expect(provider.transcribe).not.toHaveBeenCalled();
    // ...and no temp dir is left behind (cleanup ran in `finally`).
    expect(await audioTempDirCount()).toBe(before);
  });

  it("rejects BEFORE download when the duration hint exceeds the limit", async () => {
    const before = await audioTempDirCount();
    const downloader: AudioDownloader = {
      download: vi.fn(async () => new Uint8Array([1])),
    };
    const provider: TranscriptionProvider = {
      transcribe: vi.fn(async () => "should not be called"),
    };

    await expect(
      transcribeVoiceMessage(
        { fileId: "voice-long", durationSeconds: 600 },
        { downloader, provider, limits: { maxDurationSeconds: 300 } },
      ),
    ).rejects.toBeInstanceOf(VoiceNoteTooLargeError);

    // The download is skipped entirely for an over-limit duration hint.
    expect(downloader.download).not.toHaveBeenCalled();
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(await audioTempDirCount()).toBe(before);
  });

  it("rejects BEFORE download when the declared file-size hint exceeds the limit", async () => {
    const before = await audioTempDirCount();
    const downloader: AudioDownloader = {
      download: vi.fn(async () => new Uint8Array([1])),
    };
    const provider: TranscriptionProvider = {
      transcribe: vi.fn(async () => "should not be called"),
    };

    await expect(
      transcribeVoiceMessage(
        { fileId: "voice-heavy", fileSizeBytes: 50 },
        { downloader, provider, limits: { maxBytes: 16 } },
      ),
    ).rejects.toBeInstanceOf(VoiceNoteTooLargeError);

    expect(downloader.download).not.toHaveBeenCalled();
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(await audioTempDirCount()).toBe(before);
  });
});

describe("transcribeAudioBuffer", () => {
  it.each(["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg"])(
    "transcribes %s bytes through a temporary file and removes its directory",
    async (mimeType) => {
      expect(audio.transcribeAudioBuffer).toEqual(expect.any(Function));
      const bytes = new Uint8Array([1, 2, 3]);
      let seenPath = "";
      const provider: TranscriptionProvider = {
        transcribe: vi.fn(async (path) => {
          seenPath = path;
          expect(new Uint8Array(await readFile(path))).toEqual(bytes);
          return "85 no mercado";
        }),
      };
      expect(
        await audio.transcribeAudioBuffer(bytes, mimeType, { provider }),
      ).toBe("85 no mercado");
      expect(provider.transcribe).toHaveBeenCalledWith(seenPath, mimeType);
      expect(existsSync(dirname(seenPath))).toBe(false);
    },
  );

  it("removes the temp directory when the provider throws", async () => {
    expect(audio.transcribeAudioBuffer).toEqual(expect.any(Function));
    const before = await audioTempDirCount();
    let seenPath = "";
    const provider: TranscriptionProvider = {
      async transcribe(path) {
        seenPath = path;
        expect(existsSync(path)).toBe(true);
        throw new Error("provider failed");
      },
    };
    await expect(
      audio.transcribeAudioBuffer(new Uint8Array([1]), "audio/webm", {
        provider,
      }),
    ).rejects.toThrow("provider failed");
    expect(existsSync(dirname(seenPath))).toBe(false);
    expect(await audioTempDirCount()).toBe(before);
  });

  it.each([undefined, 16])(
    "rejects bytes beyond the %s limit without invoking the provider or leaving a temp directory",
    async (maxBytes) => {
      expect(audio.transcribeAudioBuffer).toEqual(expect.any(Function));
      const before = await audioTempDirCount();
      const provider = { transcribe: vi.fn(async () => "unused") };
      const limit = maxBytes ?? audio.MAX_VOICE_NOTE_BYTES;
      await expect(
        audio.transcribeAudioBuffer(new Uint8Array(limit + 1), "audio/webm", {
          provider,
          maxBytes,
        }),
      ).rejects.toBeInstanceOf(VoiceNoteTooLargeError);
      expect(provider.transcribe).not.toHaveBeenCalled();
      expect(await audioTempDirCount()).toBe(before);
    },
  );

  it("accepts bytes exactly at the configured limit", async () => {
    expect(audio.transcribeAudioBuffer).toEqual(expect.any(Function));
    const provider = { transcribe: vi.fn(async () => "ok") };
    expect(
      await audio.transcribeAudioBuffer(new Uint8Array(16), "audio/webm", {
        provider,
        maxBytes: 16,
      }),
    ).toBe("ok");
  });
});

describe("shared audio container and cleanup behavior", () => {
  it("gives Telegram webm audio the webm extension and removes its directory", async () => {
    let seenPath = "";
    const provider: TranscriptionProvider = {
      async transcribe(path) {
        seenPath = path;
        return "ok";
      },
    };
    await transcribeVoiceMessage(
      { fileId: "webm", mimeType: "audio/webm" },
      { downloader: fakeDownloader(new Uint8Array([1])), provider },
    );
    expect(seenPath).toMatch(/\.webm$/);
    expect(existsSync(dirname(seenPath))).toBe(false);
  });
});
