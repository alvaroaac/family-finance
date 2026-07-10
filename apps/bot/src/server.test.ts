import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";

import {
  createBotServer,
  type ImportSuggestionRoute,
} from "./server.js";
import type { WebhookResult } from "./index.js";

type Handle = (
  rawBody: unknown,
  secretHeader: string | undefined,
) => Promise<WebhookResult>;

/** Start the server on an ephemeral port and return its base URL. */
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("createBotServer", () => {
  const openServers: http.Server[] = [];

  async function startServer(
    handle: Handle,
    importSuggestions?: ImportSuggestionRoute,
  ): Promise<string> {
    const server = createBotServer(handle, { importSuggestions });
    openServers.push(server);
    return listen(server);
  }

  afterEach(async () => {
    while (openServers.length > 0) {
      const server = openServers.pop();
      if (server !== undefined) {
        await closeServer(server);
      }
    }
  });

  it("returns 404 for unknown paths", async () => {
    const handle = vi.fn<Handle>();
    const base = await startServer(handle);

    const response = await fetch(`${base}/nope`);

    expect(response.status).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  it("GET /health returns ok with a lastUpdateAt field", async () => {
    const handle = vi.fn<Handle>();
    const base = await startServer(handle);

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      lastUpdateAt: string | null;
    };
    expect(body.ok).toBe(true);
    expect("lastUpdateAt" in body).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it("POST /webhook passes the parsed body to the handler and mirrors its result", async () => {
    const handle = vi
      .fn<Handle>()
      .mockResolvedValue({ status: 200, body: { ok: true } });
    const base = await startServer(handle);

    const update = { update_id: 7, message: { text: "mercado 50" } };
    const response = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toEqual(update);
  });

  it("POST /webhook mirrors a non-200 handler status (e.g. bad secret)", async () => {
    const handle = vi.fn<Handle>().mockResolvedValue({
      status: 401,
      body: { ok: false, error: "invalid secret" },
    });
    const base = await startServer(handle);

    const response = await fetch(`${base}/webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid secret",
    });
  });

  it("forwards the x-telegram-bot-api-secret-token header verbatim", async () => {
    const handle = vi
      .fn<Handle>()
      .mockResolvedValue({ status: 200, body: { ok: true } });
    const base = await startServer(handle);

    await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "s3gredo-Verbatim" },
      body: JSON.stringify({ update_id: 2 }),
    });

    expect(handle.mock.calls[0]?.[1]).toBe("s3gredo-Verbatim");
  });

  it("passes undefined when the secret header is absent", async () => {
    const handle = vi
      .fn<Handle>()
      .mockResolvedValue({ status: 200, body: { ok: true } });
    const base = await startServer(handle);

    await fetch(`${base}/webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 3 }),
    });

    expect(handle.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("answers 200 ok on invalid JSON so Telegram stops retrying", async () => {
    const handle = vi.fn<Handle>();
    const base = await startServer(handle);

    const response = await fetch(`${base}/webhook`, {
      method: "POST",
      body: "{not json",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers 200 ok when the handler throws (logged, no retry storm)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const handle = vi.fn<Handle>().mockRejectedValue(new Error("boom"));
    const base = await startServer(handle);

    const response = await fetch(`${base}/webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 4 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("updates /health lastUpdateAt after a webhook is received", async () => {
    const handle = vi
      .fn<Handle>()
      .mockResolvedValue({ status: 200, body: { ok: true } });
    const base = await startServer(handle);

    await fetch(`${base}/webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 5 }),
    });
    const response = await fetch(`${base}/health`);

    const body = (await response.json()) as {
      ok: boolean;
      lastUpdateAt: string | null;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.lastUpdateAt).toBe("string");
    // ISO 8601 round-trip.
    expect(new Date(body.lastUpdateAt as string).toISOString()).toBe(
      body.lastUpdateAt,
    );
  });

  function signedHeaders(body: string, secret: string, timestamp: number, nonce = randomUUID()) {
    const path = "/internal/v1/import-category-suggestions";
    const hash = createHash("sha256").update(body).digest("hex");
    const canonical = `${timestamp}\n${nonce}\nPOST\n${path}\n${hash}`;
    return {
      "x-import-timestamp": String(timestamp),
      "x-import-nonce": nonce,
      "x-import-signature": `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    };
  }

  it("accepts a fresh signed internal suggestion request", async () => {
    const handle = vi.fn<Handle>();
    const internal = vi.fn().mockResolvedValue({
      status: 200,
      body: { version: 1, outcome: "success" },
    });
    const secret = "a".repeat(32);
    const now = 1_800_000_000_000;
    const base = await startServer(handle, {
      secret,
      handle: internal,
      now: () => now,
    });
    const body = JSON.stringify({ version: 1 });
    const response = await fetch(
      `${base}/internal/v1/import-category-suggestions`,
      {
        method: "POST",
        headers: signedHeaders(body, secret, Math.floor(now / 1000)),
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(internal).toHaveBeenCalledWith({ version: 1 });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects invalid, stale, and replayed internal signatures", async () => {
    const handle = vi.fn<Handle>();
    const internal = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const secret = "b".repeat(32);
    const now = 1_800_000_000_000;
    const base = await startServer(handle, {
      secret,
      handle: internal,
      now: () => now,
    });
    const body = JSON.stringify({ version: 1 });
    const current = Math.floor(now / 1000);
    const nonce = randomUUID();
    const headers = signedHeaders(body, secret, current, nonce);

    const invalid = await fetch(`${base}/internal/v1/import-category-suggestions`, {
      method: "POST",
      headers: { ...headers, "x-import-signature": "v1=bad" },
      body,
    });
    expect(invalid.status).toBe(401);

    const stale = await fetch(`${base}/internal/v1/import-category-suggestions`, {
      method: "POST",
      headers: signedHeaders(body, secret, current - 61),
      body,
    });
    expect(stale.status).toBe(401);

    const first = await fetch(`${base}/internal/v1/import-category-suggestions`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    const replay = await fetch(`${base}/internal/v1/import-category-suggestions`, {
      method: "POST",
      headers,
      body,
    });
    expect(replay.status).toBe(409);
    expect(internal).toHaveBeenCalledTimes(1);
  });
});
