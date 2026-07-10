import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestImportSuggestions,
  signImportSuggestionRequest,
} from "./suggestion-client";

afterEach(() => vi.restoreAllMocks());

describe("signImportSuggestionRequest", () => {
  it("uses the documented timestamp nonce method path and body hash", () => {
    expect(
      signImportSuggestionRequest({
        body: '{"version":1}',
        secret: "shared-secret-with-more-than-32-characters",
        timestamp: 1_800_000_000,
        nonce: "12345678-1234-1234-1234-123456789012",
      }),
    ).toBe(
      "v1=9271ebb5f3cc66bf39612d2c966cd217e5b8f56aec9d6f9b4a4bb15d4cb92f8f",
    );
  });

  it("refuses redirects so signed financial payloads cannot leave the configured origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("redirect mode is set to error"));

    await expect(
      requestImportSuggestions({
        baseUrl: "https://bot.example.com",
        secret: "shared-secret-with-more-than-32-characters",
        body: { items: [{ description: "private" }] },
      }),
    ).rejects.toThrow("redirect");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects a response larger than the bounded internal protocol", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
    );

    await expect(
      requestImportSuggestions({
        baseUrl: "https://bot.example.com",
        secret: "shared-secret-with-more-than-32-characters",
        body: { version: 1 },
      }),
    ).rejects.toThrow("excedeu o limite");
  });
});
