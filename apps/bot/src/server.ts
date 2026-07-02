/**
 * Standalone webhook server for the Telegram bot (spec §3.1).
 *
 * Plain `node:http` — no framework. Two routes:
 *   POST /webhook  — reads the body (1MB cap), JSON-parses it, and hands it to
 *                    the injected `handle` together with the verbatim
 *                    `x-telegram-bot-api-secret-token` header. Invalid JSON and
 *                    handler errors both answer 200 {ok:true} so Telegram stops
 *                    retrying; the secret check itself lives in `handleWebhook`.
 *   GET  /health   — 200 {"ok":true,"lastUpdateAt":<ISO|null>} where
 *                    lastUpdateAt is the time the last webhook was received.
 *
 * `main()` wires the production bot (startBot) and listens on PORT (default
 * 8787); it only runs when this file is executed directly.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

import { startBot, type WebhookResult } from "./index.js";

/** Telegram updates are small; anything above this is not a real update. */
const MAX_BODY_BYTES = 1024 * 1024;

const DEFAULT_PORT = 8787;

/** Timestamp of the last received webhook (module-level, surfaced by /health). */
let lastUpdateAt: Date | null = null;

type WebhookHandle = (
  rawBody: unknown,
  secretHeader: string | undefined,
) => Promise<WebhookResult>;

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

/** Read the full request body, rejecting anything above the byte cap. */
function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Build the HTTP server around an injected webhook handler (tests pass a fake;
 * production passes `startBot().handle`).
 */
export function createBotServer(handle: WebhookHandle): http.Server {
  return http.createServer((request, response) => {
    void routeRequest(handle, request, response);
  });
}

async function routeRequest(
  handle: WebhookHandle,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = request.url ?? "/";
  const path = url.split("?")[0] ?? url;

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, {
      ok: true,
      lastUpdateAt: lastUpdateAt === null ? null : lastUpdateAt.toISOString(),
    });
    return;
  }

  if (request.method === "POST" && path === "/webhook") {
    lastUpdateAt = new Date();

    let raw: string;
    try {
      raw = await readBody(request);
    } catch (error) {
      // Oversize or aborted body — never a legitimate Telegram update.
      console.error("[bot:server] failed to read webhook body:", error);
      sendJson(response, 200, { ok: true });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Invalid JSON: acknowledge so Telegram stops retrying garbage.
      sendJson(response, 200, { ok: true });
      return;
    }

    const secretHeader = request.headers["x-telegram-bot-api-secret-token"];
    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;

    try {
      const result = await handle(parsed, secret);
      sendJson(response, result.status, result.body);
    } catch (error) {
      // A handler crash must not trigger a Telegram retry storm.
      console.error("[bot:server] webhook handler failed:", error);
      sendJson(response, 200, { ok: true });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

/** Production entry point: real bot wiring + listen on PORT. */
async function main(): Promise<void> {
  const { handle } = await startBot();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createBotServer(handle);
  server.listen(port, () => {
    console.log(`[bot:server] listening on :${port}`);
  });
}

// Run only when executed directly (`tsx src/server.ts`), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[bot:server] fatal startup error:", error);
    process.exit(1);
  });
}
