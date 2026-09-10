import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAiTranscriptionProvider } from "@family-finance/intake/providers";
import { MobileError } from "./context";
export async function transcribeMobileAudio(form: FormData) {
  if (!process.env.OPENAI_API_KEY)
    throw new MobileError(
      503,
      "A transcrição ainda não está disponível. Use texto ou o ditado do teclado.",
    );
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > 8 * 1024 * 1024)
    throw new MobileError(422, "Envie um áudio de até 8 MB.");
  const mime = file.type.split(";")[0]!;
  const extension: Record<string, string> = {
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  if (!extension[mime])
    throw new MobileError(422, "Formato de áudio não suportado.");
  const directory = await mkdtemp(join(tmpdir(), "casa-audio-"));
  try {
    const path = join(directory, `voice.${extension[mime]}`);
    await writeFile(path, new Uint8Array(await file.arrayBuffer()));
    const provider = createOpenAiTranscriptionProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "whisper-1",
      timeoutMs: 20000,
      logCall: () => {},
    });
    const text = await provider.transcribe(path, mime);
    if (!text.trim())
      throw new MobileError(
        422,
        "Não foi possível ouvir. Tente gravar novamente ou use texto.",
      );
    return { text: text.slice(0, 4000) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
