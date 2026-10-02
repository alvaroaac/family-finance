import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: "casa.example.com",
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: state.host, "x-forwarded-proto": "http" }),
}));
vi.mock("next/navigation", () => ({
  redirect: state.redirect,
}));
vi.mock("../lib/auth", () => ({
  getAuthState: async () => ({ status: "unauthenticated" }),
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabaseClient: async () => ({
    auth: {
      signInWithOAuth: state.signInWithOAuth,
      exchangeCodeForSession: state.exchangeCodeForSession,
    },
  }),
}));

import LoginPage from "../app/login/page";
import { GET } from "../app/auth/callback/route";

function findFormAction(node: ReactNode): () => Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) {
      try {
        return findFormAction(child);
      } catch {
        // Keep looking through sibling elements.
      }
    }
  }
  if (
    isValidElement<{ action?: () => Promise<void>; children?: ReactNode }>(node)
  ) {
    if (node.type === "form" && node.props.action) return node.props.action;
    return findFormAction(node.props.children);
  }
  throw new Error("login form not found");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.host = "casa.example.com";
  process.env.NEXT_PUBLIC_SITE_URL = "https://family-finance.example.dev";
  process.env.ALLOWED_WEB_HOSTS = "casa.example.com,family-finance.example.dev";
  state.signInWithOAuth.mockResolvedValue({
    data: { url: "https://oauth.example.test" },
    error: null,
  });
  state.exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe("Google login", () => {
  it("uses the allowed request origin for the OAuth callback", async () => {
    const action = findFormAction(
      await LoginPage({ searchParams: Promise.resolve({}) }),
    );
    await action();
    expect(state.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://casa.example.com/auth/callback" },
    });
  });

  it("falls back to the canonical origin for an unknown request host", async () => {
    state.host = "evil.test";
    const action = findFormAction(
      await LoginPage({ searchParams: Promise.resolve({}) }),
    );
    await action();
    expect(state.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://family-finance.example.dev/auth/callback",
      },
    });
  });
});

describe("OAuth callback", () => {
  function request(next: string, host = "casa.example.com") {
    const url = new URL("https://internal.example.test/auth/callback");
    url.searchParams.set("code", "auth-code");
    url.searchParams.set("next", next);
    return new NextRequest(url, {
      headers: { host, "x-forwarded-proto": "http" },
    });
  }

  it("redirects to a same-origin path on the allowed arrival host", async () => {
    expect(
      (await GET(request("/imports?tab=pending"))).headers.get("location"),
    ).toBe("https://casa.example.com/imports?tab=pending");
  });

  it("uses the canonical origin for an unknown arrival host", async () => {
    expect(
      (await GET(request("/dashboard", "evil.test"))).headers.get("location"),
    ).toBe("https://family-finance.example.dev/dashboard");
  });

  it.each([
    "//evil.test",
    "/\\evil.test",
    "https://evil.test",
    "/safe\\evil",
    "/safe\npath",
  ])("replaces hostile next value %s with the dashboard", async (next) => {
    expect((await GET(request(next))).headers.get("location")).toBe(
      "https://casa.example.com/dashboard",
    );
  });

  it("uses the arrival origin on OAuth errors too", async () => {
    state.exchangeCodeForSession.mockResolvedValue({
      error: new Error("bad code"),
    });
    expect((await GET(request("/dashboard"))).headers.get("location")).toBe(
      "https://casa.example.com/login?error=oauth",
    );
  });
});
