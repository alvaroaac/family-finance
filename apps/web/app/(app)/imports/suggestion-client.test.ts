import { describe, expect, it } from "vitest";

import { signImportSuggestionRequest } from "./suggestion-client";

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
});
