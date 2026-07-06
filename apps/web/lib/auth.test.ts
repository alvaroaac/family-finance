import { describe, expect, it } from "vitest";

import { evaluateAccess, type AccessDecision } from "./auth";

describe("evaluateAccess (auth/allowlist core)", () => {
  const allowlist = ["alvaro@example.com", "karol@example.com"];

  it("requires sign-in when there is no user", () => {
    const decision: AccessDecision = evaluateAccess(null, allowlist);
    expect(decision.status).toBe("unauthenticated");
  });

  it("requires sign-in when the user has no email", () => {
    const decision = evaluateAccess({ email: undefined }, allowlist);
    expect(decision.status).toBe("unauthenticated");
  });

  it("authorizes an allowlisted email", () => {
    const decision = evaluateAccess({ email: "alvaro@example.com" }, allowlist);
    expect(decision.status).toBe("authorized");
    if (decision.status === "authorized") {
      expect(decision.email).toBe("alvaro@example.com");
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    const decision = evaluateAccess({ email: "  Karol@Example.com " }, allowlist);
    expect(decision.status).toBe("authorized");
  });

  it("denies an authenticated email that is not on the allowlist", () => {
    const decision = evaluateAccess({ email: "stranger@example.com" }, allowlist);
    expect(decision.status).toBe("forbidden");
    if (decision.status === "forbidden") {
      expect(decision.email).toBe("stranger@example.com");
    }
  });

  it("denies everyone when the allowlist is empty", () => {
    const decision = evaluateAccess({ email: "alvaro@example.com" }, []);
    expect(decision.status).toBe("forbidden");
  });

  it("denies an empty-string email as forbidden-when-present is moot -> unauthenticated", () => {
    const decision = evaluateAccess({ email: "   " }, allowlist);
    // whitespace-only email is treated as no email -> must sign in
    expect(decision.status).toBe("unauthenticated");
  });
});
