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
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { getBotServerEnv, getLlmConfig } from "@family-finance/config";
import { claimImportSuggestionNonce } from "@family-finance/db";

import { startBot, type WebhookResult } from "./index.js";
import { createImportSuggestionHandler } from "./import-suggestions.js";
import { createAnthropicCompletionClient } from "./providers.js";

/** Telegram updates are small; anything above this is not a real update. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INTERNAL_BODY_BYTES = 256 * 1024;
const IMPORT_SUGGESTION_PATH = "/internal/v1/import-category-suggestions";

const DEFAULT_PORT = 8787;

/** Timestamp of the last received webhook (module-level, surfaced by /health). */
let lastUpdateAt: Date | null = null;

type WebhookHandle = (
  rawBody: unknown,
  secretHeader: string | undefined,
) => Promise<WebhookResult>;

export type ImportSuggestionHandle = (
  body: unknown,
) => Promise<{ status: number; body: unknown }>;

export type ImportSuggestionRoute = {
  secret: string;
  handle: ImportSuggestionHandle;
  claimNonce: (nonce: string, expiresAt: Date) => Promise<boolean>;
  now?: () => number;
};

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
function readBody(
  request: http.IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
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
export function createBotServer(
  handle: WebhookHandle,
  options?: { importSuggestions?: ImportSuggestionRoute },
): http.Server {
  return http.createServer((request, response) => {
    void routeRequest(handle, request, response, options?.importSuggestions);
  });
}

async function routeRequest(
  handle: WebhookHandle,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  importSuggestions?: ImportSuggestionRoute,
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

  if (request.method === "POST" && path === IMPORT_SUGGESTION_PATH) {
    if (importSuggestions === undefined) {
      sendJson(response, 404, { ok: false, error: "not found" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(request, MAX_INTERNAL_BODY_BYTES);
    } catch {
      sendJson(response, 413, { ok: false, error: "body too large" });
      return;
    }
    const now = importSuggestions.now?.() ?? Date.now();
    const timestampHeader = request.headers["x-import-timestamp"];
    const nonceHeader = request.headers["x-import-nonce"];
    const signatureHeader = request.headers["x-import-signature"];
    const timestampRaw = Array.isArray(timestampHeader)
      ? timestampHeader[0]
      : timestampHeader;
    const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    const timestamp = Number(timestampRaw);
    if (
      timestampRaw === undefined ||
      !Number.isInteger(timestamp) ||
      Math.abs(Math.floor(now / 1000) - timestamp) > 60 ||
      nonce === undefined ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      signature === undefined
    ) {
      sendJson(response, 401, { ok: false, error: "invalid signature" });
      return;
    }
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const canonical = `${timestamp}\n${nonce}\nPOST\n${IMPORT_SUGGESTION_PATH}\n${bodyHash}`;
    const expected = `v1=${createHmac("sha256", importSuggestions.secret)
      .update(canonical)
      .digest("hex")}`;
    const supplied = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (
      supplied.length !== wanted.length ||
      !timingSafeEqual(supplied, wanted)
    ) {
      sendJson(response, 401, { ok: false, error: "invalid signature" });
      return;
    }
    try {
      if (
        !(await importSuggestions.claimNonce(nonce, new Date(now + 120_000)))
      ) {
        sendJson(response, 409, { ok: false, error: "replayed request" });
        return;
      }
    } catch (error) {
      console.error("[bot:server] nonce claim failed:", error);
      sendJson(response, 503, {
        ok: false,
        error: "replay protection unavailable",
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid json" });
      return;
    }
    try {
      const result = await importSuggestions.handle(parsed);
      sendJson(response, result.status, result.body);
    } catch (error) {
      console.error("[bot:server] import suggestion handler failed:", error);
      sendJson(response, 503, { ok: false, error: "suggestions unavailable" });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

/** Production entry point: real bot wiring + listen on PORT. */
async function main(): Promise<void> {
  const { handle, client } = await startBot();
  const env = getBotServerEnv();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const llm = getLlmConfig();
  const haikuClient =
    llm.isConfigured && llm.apiKey !== undefined
      ? createAnthropicCompletionClient({
          apiKey: llm.apiKey,
          model: llm.model,
          timeoutMs: 8_000,
        })
      : undefined;
  const importSuggestions =
    env.IMPORT_SUGGESTION_SHARED_SECRET === undefined
      ? undefined
      : {
          secret: env.IMPORT_SUGGESTION_SHARED_SECRET,
          claimNonce: (nonce: string, expiresAt: Date) =>
            claimImportSuggestionNonce(client, nonce, expiresAt),
          handle: createImportSuggestionHandler({
            codexEnabled: env.CODEX_ENABLED === "true",
            codexModel: env.CODEX_MODEL ?? "gpt-5.5",
            codexTimeoutMs: env.CODEX_TIMEOUT_MS ?? 12_000,
            codexHome: "/var/lib/family-finance-codex",
            haikuClient,
          }),
        };
  const server = createBotServer(handle, { importSuggestions });
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
