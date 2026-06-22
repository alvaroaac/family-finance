/**
 * Telegram voice/audio intake for the bot.
 *
 * Audio is NOT a separate write path. This module only turns a Telegram voice
 * note into TEXT (a transcription); the resulting text is then fed through the
 * SAME `startConversation` flow as a typed message (see `conversation.ts` /
 * `index.ts`), so audio still produces an editable confirmation and never
 * bypasses confirmation.
 *
 * RAW AUDIO IS NEVER PERSISTED. The voice file is downloaded to a TEMP path
 * (OS temp dir), handed to an injected transcription provider, and then DELETED
 * in a `finally` block — even when the download or transcription throws. Nothing
 * audio-related is written to the database; only the transcribed text (and the
 * usual interaction audit metadata) flows onward.
 *
 * Both the downloader (Telegram file fetch) and the transcription provider are
 * INTERFACES, injected by the caller. Unit tests pass mocks, so there is no real
 * network and no real provider call.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A Telegram voice/audio attachment to transcribe. */
export type VoiceMessageRef = {
  /** Telegram file_id of the voice/audio attachment. */
  fileId: string;
  /** Optional MIME type (e.g. "audio/ogg") used to pick a temp file extension. */
  mimeType?: string;
};

/**
 * Downloads a Telegram file's bytes. INTERFACE only — the HTTP implementation
 * (Bot API getFile + file download) is constructed at the edge with a real bot
 * token; tests inject a mock so no network is hit.
 */
export type AudioDownloader = {
  download(fileId: string): Promise<Uint8Array>;
};

/**
 * Transcribes an audio file at `filePath` into text. INTERFACE only — a real
 * implementation wraps a provider (e.g. OpenAI Whisper via OPENAI_API_KEY)
 * behind this boundary; tests inject a mock.
 */
export type TranscriptionProvider = {
  transcribe(filePath: string, mimeType?: string): Promise<string>;
};

export type TranscribeDeps = {
  downloader: AudioDownloader;
  provider: TranscriptionProvider;
};

/** Choose a temp file extension from the MIME type (best-effort, cosmetic). */
function extensionFor(mimeType: string | undefined): string {
  if (mimeType === undefined) {
    return "ogg";
  }
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  return "ogg";
}

/**
 * Download a Telegram voice/audio file to a temporary path, transcribe it, and
 * delete the temp file (always — even on error). Returns the transcription text.
 *
 * The temp file lives under the OS temp dir in a unique `family-finance-audio-*`
 * directory and is removed in `finally`, so no raw audio remains on disk.
 */
export async function transcribeVoiceMessage(
  voice: VoiceMessageRef,
  deps: TranscribeDeps,
): Promise<string> {
  // Unique temp dir so concurrent voice notes never collide.
  const dir = await mkdtemp(join(tmpdir(), "family-finance-audio-"));
  const filePath = join(dir, `voice.${extensionFor(voice.mimeType)}`);

  try {
    const bytes = await deps.downloader.download(voice.fileId);
    await writeFile(filePath, bytes);
    return await deps.provider.transcribe(filePath, voice.mimeType);
  } finally {
    // Never persist raw audio: remove the file and its temp dir, even on error.
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Edge implementations (constructed only with real config; never used in tests).
// ---------------------------------------------------------------------------

/**
 * HTTP downloader for Telegram files: resolves the file path via `getFile`, then
 * downloads the bytes from the file endpoint. Uses the global `fetch` (Node 22).
 * Constructed only when a real bot token is configured.
 */
export function createHttpAudioDownloader(botToken: string): AudioDownloader {
  const apiBase = `https://api.telegram.org/bot${botToken}`;
  const fileBase = `https://api.telegram.org/file/bot${botToken}`;
  return {
    async download(fileId: string): Promise<Uint8Array> {
      const meta = await fetch(`${apiBase}/getFile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!meta.ok) {
        throw new Error(`Telegram getFile failed: ${meta.status}`);
      }
      const json = (await meta.json()) as {
        ok: boolean;
        result?: { file_path?: string };
      };
      const path = json.result?.file_path;
      if (!json.ok || path === undefined) {
        throw new Error("Telegram getFile returned no file_path");
      }
      const fileResponse = await fetch(`${fileBase}/${path}`);
      if (!fileResponse.ok) {
        throw new Error(
          `Telegram file download failed: ${fileResponse.status}`,
        );
      }
      return new Uint8Array(await fileResponse.arrayBuffer());
    },
  };
}
