import { describe, it, expect } from "vitest";

import {
  DEFAULT_ANTHROPIC_MODEL,
  getLlmConfig,
  getTranscriptionConfig,
} from "./ai.js";

describe("getLlmConfig", () => {
  it("defaults to the Anthropic Claude provider and a current model id", () => {
    const cfg = getLlmConfig({} as NodeJS.ProcessEnv);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(DEFAULT_ANTHROPIC_MODEL).toMatch(/^claude-/);
    // No key configured -> not usable, but never throws.
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.isConfigured).toBe(false);
  });

  it("reports configured when ANTHROPIC_API_KEY is present and allows model override", () => {
    const cfg = getLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: "claude-test-model",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe("sk-ant-test");
    expect(cfg.model).toBe("claude-test-model");
    expect(cfg.isConfigured).toBe(true);
  });

  it("never throws at import or call time when env is empty (build-safe)", () => {
    expect(() => getLlmConfig({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("getTranscriptionConfig", () => {
  it("uses the OpenAI key for audio transcription and is unconfigured when absent", () => {
    const empty = getTranscriptionConfig({} as NodeJS.ProcessEnv);
    expect(empty.provider).toBe("openai");
    expect(empty.apiKey).toBeUndefined();
    expect(empty.isConfigured).toBe(false);

    const configured = getTranscriptionConfig({
      OPENAI_API_KEY: "sk-openai-test",
    } as unknown as NodeJS.ProcessEnv);
    expect(configured.apiKey).toBe("sk-openai-test");
    expect(configured.model).toMatch(/whisper/i);
    expect(configured.isConfigured).toBe(true);
  });
});
