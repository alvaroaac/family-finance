import { describe, expect, it, vi, afterEach } from "vitest";
import {
  apiDesignSystem,
  validateDesignSystem,
  themes,
} from "../src/design-system";
const design = {
  version: 1,
  tenantId: "casa-demo",
  theme: "esmeralda",
  tokens: themes.esmeralda,
};
afterEach(() => vi.unstubAllGlobals());
describe("tenant design system boundary", () => {
  it("accepts a versioned theme and preserves Casa identity", () =>
    expect(validateDesignSystem(design, "esmeralda").tokens.accent).toBe(
      "#d4af6a",
    ));
  it.each([
    { version: 2 },
    { theme: "salvia" },
    { tenantId: "" },
    { tokens: { ...themes.esmeralda, radius: -1 } },
    { tokens: { ...themes.esmeralda, accent: "url(unsafe)" } },
  ])("rejects malformed or mismatched configuration", (patch) =>
    expect(() =>
      validateDesignSystem({ ...design, ...patch }, "esmeralda"),
    ).toThrow(),
  );
  it("only uses bundled fonts", () =>
    expect(
      validateDesignSystem(
        {
          ...design,
          tokens: { ...themes.esmeralda, body: "arbitrary-remote-font" },
        },
        "esmeralda",
      ).tokens.body,
    ).toBe(themes.esmeralda.body));
  it("requests theme with session authentication and propagates cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => design });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await apiDesignSystem(
      "https://example.test",
      async () => "test-only-token",
    ).load("esmeralda", controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/api/mobile/v1/design-system?theme=esmeralda",
      {
        signal: controller.signal,
        headers: { Authorization: "Bearer test-only-token" },
      },
    );
  });
  it("reports an API failure for the provider to fall back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(
      apiDesignSystem(
        "https://example.test",
        async () => "test-only-token",
      ).load("esmeralda", new AbortController().signal),
    ).rejects.toThrow("Theme unavailable");
  });
});
