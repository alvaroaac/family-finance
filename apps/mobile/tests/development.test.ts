import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  [true, "true", true],
  [true, "false", false],
  [true, undefined, false],
  [false, "true", false],
])("development=%s flag=%s enables preview=%s", async (dev, flag, expected) => {
  vi.stubGlobal("__DEV__", dev);
  vi.stubEnv("EXPO_PUBLIC_DEVELOPMENT_MODE", flag);
  const { developmentPreview } = await import("../src/development");
  expect(developmentPreview).toBe(expected);
});
