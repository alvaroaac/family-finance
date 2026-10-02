import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemberClient } from "./index.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const JWT_SECRET = "test-jwt-secret";

function payloadFrom(request: Request): Record<string, unknown> {
  const token =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const [header, payload, signature] = token.split(".");
  expect(header).toBeDefined();
  expect(payload).toBeDefined();
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  expect(signature).toBe(expected);
  expect(
    JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
  ).toEqual({
    alg: "HS256",
    typ: "JWT",
  });
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createMemberClient", () => {
  it("sends an HS256 authenticated user token and anon API key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(new Request(input, init));
        return jsonResponse([]);
      }),
    );

    const client = createMemberClient({
      supabaseUrl: "https://supabase.example.test",
      anonKey: "anon-test-key",
      jwtSecret: JWT_SECRET,
      userId: USER_ID,
    });
    const { error } = await client.from("categories").select("id");

    expect(error).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("apikey")).toBe("anon-test-key");
    expect(payloadFrom(requests[0]!)).toMatchObject({
      sub: USER_ID,
      role: "authenticated",
      aud: "authenticated",
      exp: 1790683500,
    });
  });

  it("retries an expired token once with a newly signed token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(new Request(input, init));
        if (requests.length === 1) {
          vi.setSystemTime(new Date("2026-09-29T12:00:02Z"));
          return jsonResponse(
            { code: "PGRST301", message: "JWT expired" },
            401,
          );
        }
        return jsonResponse([]);
      }),
    );

    const client = createMemberClient({
      supabaseUrl: "https://supabase.example.test",
      anonKey: "anon-test-key",
      jwtSecret: JWT_SECRET,
      userId: USER_ID,
      ttlSeconds: 1,
    });
    const { error } = await client.from("categories").select("id");

    expect(error).toBeNull();
    expect(requests).toHaveLength(2);
    expect(payloadFrom(requests[0]!).exp).toBe(1790683201);
    expect(payloadFrom(requests[1]!).exp).toBe(1790683203);
  });

  it("returns an error after the one expired-token retry fails", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ code: "PGRST301", message: "JWT expired" }, 401),
    );
    vi.stubGlobal("fetch", fetch);
    const client = createMemberClient({
      supabaseUrl: "https://supabase.example.test",
      anonKey: "anon-test-key",
      jwtSecret: JWT_SECRET,
      userId: USER_ID,
    });

    const { error } = await client.from("categories").select("id");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error?.message).toMatch(/JWT expired/);
  });
});
