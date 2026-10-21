import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postToBot, signBotRequest } from "./bot-client";

const SECRET = "shared-secret-with-more-than-32-characters";
const IMPORT_PATH = "/internal/v1/import-category-suggestions";

beforeEach(() => {
  vi.stubEnv("IMPORT_SUGGESTION_URL", "https://bot.example.com");
  vi.stubEnv("IMPORT_SUGGESTION_SHARED_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signBotRequest", () => {
  it("produces the same headers the import suggestion channel always signed", () => {
    expect(
      signBotRequest({
        secret: SECRET,
        path: IMPORT_PATH,
        body: '{"version":1}',
        now: 1_800_000_000_000,
        nonce: "12345678-1234-1234-1234-123456789012",
      }),
    ).toEqual({
      "x-import-timestamp": "1800000000",
      "x-import-nonce": "12345678-1234-1234-1234-123456789012",
      "x-import-signature":
        "v1=9271ebb5f3cc66bf39612d2c966cd217e5b8f56aec9d6f9b4a4bb15d4cb92f8f",
    });
  });

  it("generates a fresh nonce and current timestamp by default", () => {
    const first = signBotRequest({ secret: SECRET, path: "/x", body: "{}" });
    const second = signBotRequest({ secret: SECRET, path: "/x", body: "{}" });

    expect(first["x-import-nonce"]).not.toBe(second["x-import-nonce"]);
    expect(Number(first["x-import-timestamp"])).toBeCloseTo(
      Date.now() / 1000,
      -1,
    );
  });
});

describe("postToBot", () => {
  it("posts the signed JSON body to the configured origin and returns the parsed response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }, { status: 200 }));

    const result = await postToBot("/internal/v1/capture-draft", { a: 1 });

    expect(result).toEqual({ ok: true, status: 200, json: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://bot.example.com/internal/v1/capture-draft",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: '{"a":1}',
      redirect: "error",
    });
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(Object.keys(init?.headers as object)).toEqual(
      expect.arrayContaining([
        "x-import-timestamp",
        "x-import-nonce",
        "x-import-signature",
      ]),
    );
  });

  it("returns a non-2xx status as ok so callers can map bot error codes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );

    await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
      ok: true,
      status: 403,
      json: { ok: false, error: "forbidden" },
    });
  });

  it.each([["IMPORT_SUGGESTION_URL"], ["IMPORT_SUGGESTION_SHARED_SECRET"]])(
    "is not_configured without a network call when %s is missing",
    async (name) => {
      vi.stubEnv(name, "");
      const fetchMock = vi.spyOn(globalThis, "fetch");

      await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
        ok: false,
        reason: "not_configured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("maps a network error to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );

    await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("maps an aborted request to timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    await expect(
      postToBot("/internal/v1/x", {}, { timeoutMs: 5 }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
  });
  it("maps an abort while reading the response body to timeout", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("aborted", "AbortError"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("signs the resolved URL pathname, not the raw path argument", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));

    await postToBot("/internal/v1/other/../x", { a: 1 });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe("/internal/v1/x");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-import-signature"]).toBe(
      signBotRequest({
        secret: SECRET,
        path: "/internal/v1/x",
        body: '{"a":1}',
        now: Number(headers["x-import-timestamp"]) * 1000,
        nonce: headers["x-import-nonce"],
      })["x-import-signature"],
    );
  });

  describe("response size cap (1 MB)", () => {
    const oversized = JSON.stringify({ pad: "x".repeat(1024 * 1024) });

    it("treats a declared content-length over the cap as an unknown body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(oversized, {
          status: 200,
          headers: { "content-length": String(oversized.length) },
        }),
      );

      await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
        ok: true,
        status: 200,
        json: null,
      });
    });

    it("stops reading a streamed body that grows past the cap", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(oversized, { status: 200 }),
      );

      await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
        ok: true,
        status: 200,
        json: null,
      });
    });

    it("still parses a body just under the cap", async () => {
      const body = { pad: "x".repeat(1024 * 1024 - 100) };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));

      await expect(postToBot("/internal/v1/x", {})).resolves.toEqual({
        ok: true,
        status: 200,
        json: body,
      });
    });
  });
});
