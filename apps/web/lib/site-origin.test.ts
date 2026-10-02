import { describe, expect, it } from "vitest";

import { resolveSiteOrigin, safeCallbackPath } from "./site-origin";

const env = {
  NEXT_PUBLIC_SITE_URL: "https://family-finance.example.dev/some/path",
  ALLOWED_WEB_HOSTS:
    "casa.example.com, family-finance.example.dev, localhost:3100, 127.0.0.1:3100",
};

describe("resolveSiteOrigin", () => {
  it("uses an allowed request host and preserves its port", () => {
    expect(
      resolveSiteOrigin(
        { host: "casa.example.com", forwardedProto: "http" },
        env,
      ),
    ).toBe("https://casa.example.com");
    expect(
      resolveSiteOrigin({ host: "localhost:3100", forwardedProto: null }, env),
    ).toBe("http://localhost:3100");
    expect(
      resolveSiteOrigin(
        { host: "127.0.0.1:3100", forwardedProto: "https" },
        env,
      ),
    ).toBe("https://127.0.0.1:3100");
  });

  it("matches hosts without regard to case or a trailing dot", () => {
    expect(
      resolveSiteOrigin(
        { host: "CASA.EXAMPLE.COM.", forwardedProto: null },
        env,
      ),
    ).toBe("https://casa.example.com");
    expect(
      resolveSiteOrigin({ host: "LOCALHOST.:3100", forwardedProto: null }, env),
    ).toBe("http://localhost:3100");
  });

  it("falls back to the configured canonical origin for unknown or empty hosts", () => {
    for (const host of ["evil.test", "", null, "casa.example.com:444"]) {
      expect(resolveSiteOrigin({ host, forwardedProto: "http" }, env)).toBe(
        "https://family-finance.example.dev",
      );
    }
  });

  it("rejects malformed host headers even when they contain an allowed host", () => {
    for (const host of [
      "evil.test@casa.example.com",
      "casa.example.com/path",
      "casa.example.com\\evil.test",
      "casa.example.com?x=1",
      "casa.example.com#fragment",
      "casa.example.com\n.evil.test",
      " casa.example.com",
    ]) {
      expect(resolveSiteOrigin({ host, forwardedProto: "https" }, env)).toBe(
        "https://family-finance.example.dev",
      );
    }
  });

  it("uses only the canonical host when the allowlist is unset", () => {
    const defaults = {
      NEXT_PUBLIC_SITE_URL: "https://family-finance.example.dev",
    };
    expect(
      resolveSiteOrigin(
        { host: "casa.example.com", forwardedProto: null },
        defaults,
      ),
    ).toBe("https://family-finance.example.dev");
    expect(
      resolveSiteOrigin(
        { host: "FAMILY-FINANCE.EXAMPLE.DEV.", forwardedProto: "http" },
        defaults,
      ),
    ).toBe("https://family-finance.example.dev");
  });

  it("treats an empty allowlist as unset", () => {
    expect(
      resolveSiteOrigin(
        { host: "localhost:3100", forwardedProto: null },
        {
          NEXT_PUBLIC_SITE_URL: "http://localhost:3100",
          ALLOWED_WEB_HOSTS: "",
        },
      ),
    ).toBe("http://localhost:3100");
  });
});

describe("safeCallbackPath", () => {
  it("accepts a same-origin path starting with one slash", () => {
    expect(safeCallbackPath("/imports?tab=pending#new")).toBe(
      "/imports?tab=pending#new",
    );
  });

  it("replaces external, malformed, and control-character paths", () => {
    for (const next of [
      null,
      "//evil.test",
      "/\\evil.test",
      "https://evil.test",
      "dashboard",
      "/safe\\evil.test",
      "/safe\npath",
      "/safe\u0000path",
      "/safe\u007fpath",
    ]) {
      expect(safeCallbackPath(next)).toBe("/dashboard");
    }
  });
});
