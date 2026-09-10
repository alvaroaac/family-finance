import { access, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeMobileAudio } from "./audio";
const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), provider: vi.fn() }));
vi.mock("@family-finance/intake/providers", () => ({
  createOpenAiTranscriptionProvider: mocks.provider,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  mocks.provider.mockReturnValue({ transcribe: mocks.transcribe });
});
afterEach(() => vi.unstubAllEnvs());
function form(type = "audio/mp4") {
  const data = new FormData();
  data.append("file", new File(["test audio"], "voice.m4a", { type }));
  return data;
}
describe("native audio lifecycle", () => {
  it("transcribes the temporary file and removes it after completion", async () => {
    let path = "";
    mocks.transcribe.mockImplementation(async (p: string) => {
      path = p;
      expect((await readFile(p)).toString()).toBe("test audio");
      return "Gastei 10 no café";
    });
    await expect(transcribeMobileAudio(form())).resolves.toEqual({
      text: "Gastei 10 no café",
    });
    await expect(access(path)).rejects.toThrow();
  });
  it("removes the temporary file when the provider fails", async () => {
    let path = "";
    mocks.transcribe.mockImplementation(async (p: string) => {
      path = p;
      throw new Error("provider failed");
    });
    await expect(transcribeMobileAudio(form())).rejects.toThrow(
      "provider failed",
    );
    await expect(access(path)).rejects.toThrow();
  });
  it("rejects unsupported files before calling a paid provider", async () => {
    await expect(
      transcribeMobileAudio(form("text/plain")),
    ).rejects.toMatchObject({ status: 422 });
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("offers text entry when transcription is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(transcribeMobileAudio(form())).rejects.toMatchObject({
      status: 503,
    });
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
