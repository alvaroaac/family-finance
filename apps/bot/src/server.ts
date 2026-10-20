import { DEFAULT_OPENAI_MODEL } from "@family-finance/config";
import { createCategoryRuntime } from "./category-runtime.js";
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
import { z } from "zod";

import { getBotServerEnv, type BotEnv } from "@family-finance/config";
import type { AiCompletionClient } from "@family-finance/categorization";
import {
  claimImportSuggestionNonce,
  findHouseholdIdForCurrentUser,
  recordImportAiPaidResult,
  reserveImportAiPaidItems,
} from "@family-finance/db";

import { startBot, buildDeps, type WebhookResult } from "./index.js";
import {
  CAPTURE_DRAFT_PATH,
  createCaptureDraftHandler,
  createCaptureRateLimiter,
} from "./capture.js";
export { CAPTURE_DRAFT_PATH } from "./capture.js";
import {
  createImportSuggestionHandler,
  IMPORT_SUGGESTION_OUTPUT_SCHEMA,
  importSuggestionRequestSchema,
} from "./import-suggestions.js";
import { createOpenAiCompletionClient } from "./providers.js";

/** Telegram updates are small; anything above this is not a real update. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INTERNAL_BODY_BYTES = 256 * 1024;
const IMPORT_SUGGESTION_PATH = "/internal/v1/import-category-suggestions";

const DEFAULT_PORT = 8787;

type PaidFallbackFactories = {
  openai: typeof createOpenAiCompletionClient;
  /** Historical injection seam; production never constructs Anthropic. */
  anthropic?: unknown;
};

export function createPaidFallbackClient(
  env: BotEnv,
  factories: PaidFallbackFactories = { openai: createOpenAiCompletionClient },
): AiCompletionClient | undefined {
  if (
    env.IMPORT_PAID_FALLBACK_ENABLED !== "true" ||
    (env.IMPORT_PAID_FALLBACK_PROVIDER !== undefined &&
      env.IMPORT_PAID_FALLBACK_PROVIDER !== "openai") ||
    !env.OPENAI_API_KEY
  )
    return undefined;
  return factories.openai({
    apiKey: env.OPENAI_API_KEY,
    model:
      env.IMPORT_PAID_FALLBACK_MODEL ??
      env.OPENAI_MODEL ??
      DEFAULT_OPENAI_MODEL,
    outputSchema: IMPORT_SUGGESTION_OUTPUT_SCHEMA,
    timeoutMs: 8_000,
  });
}

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
  resolveActorHouseholdId: (userId: string) => Promise<string | null>;
  now?: () => number;
};

export type SignedRouteDeps = {
  secret: string;
  claimNonce: (nonce: string) => Promise<boolean>;
  resolveActorHouseholdId: (actorUserId: string) => Promise<string | null>;
  now?: () => number;
};

export type InternalRouteHandler = (
  json: unknown,
  actor: { userId: string; householdId: string },
) => Promise<{ status: number; body: unknown }>;

export type InternalRoute = {
  path: string;
  maxBodyBytes: number;
  handle: InternalRouteHandler;
};

type BotServerOptions = {
  importSuggestions?: ImportSuggestionRoute;
  internalRoutes?: InternalRoute[];
  signed?: SignedRouteDeps;
};

const signedActorSchema = z.object({
  actorUserId: z.string().uuid(),
  scopeKey: z.string().uuid(),
});

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

/** Read the full request body, rejecting anything above the byte cap. */
function readBody(
  request: http.IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
  destroyOnLimit = true,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        // Internal routes need the socket open to deliver their 413 response.
        if (destroyOnLimit) request.destroy();
        chunks.length = 0;
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
  options?: BotServerOptions,
): http.Server {
  return http.createServer((request, response) => {
    void routeRequest(handle, request, response, options);
  });
}

async function routeRequest(
  handle: WebhookHandle,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options?: BotServerOptions,
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

  const importSuggestions =
    path === IMPORT_SUGGESTION_PATH ? options?.importSuggestions : undefined;
  const internalRoute = options?.internalRoutes?.find(
    (route) => route.path === path,
  );
  const signed = options?.signed;
  if (
    request.method === "POST" &&
    (importSuggestions !== undefined ||
      (internalRoute !== undefined && signed !== undefined))
  ) {
    // The import adapter keeps its 120 s nonce expiry; an internal route's
    // SignedRouteDeps.claimNonce owns its own expiry.
    const deps = importSuggestions ?? {
      ...signed!,
      claimNonce: (nonce: string) => signed!.claimNonce(nonce),
    };
    const verified = await verifySignedRequest(
      request,
      response,
      path,
      importSuggestions === undefined
        ? internalRoute!.maxBodyBytes
        : MAX_INTERNAL_BODY_BYTES,
      deps,
      importSuggestions !== undefined,
    );
    if (verified === null) return;

    if (importSuggestions !== undefined) {
      try {
        const result = await importSuggestions.handle(verified.json);
        sendJson(response, result.status, result.body);
      } catch (error) {
        console.error("[bot:server] import suggestion handler failed:", error);
        sendJson(response, 503, {
          ok: false,
          error: "suggestions unavailable",
        });
      }
    } else {
      try {
        const result = await internalRoute!.handle(
          verified.json,
          verified.actor,
        );
        sendJson(response, result.status, result.body);
      } catch (error) {
        console.error("[bot:server] internal route handler failed:", error);
        sendJson(response, 503, { ok: false, error: "unavailable" });
      }
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

/** The sole verification path for import suggestions and registered internal routes. */
async function verifySignedRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  path: string,
  maxBodyBytes: number,
  deps: Omit<ImportSuggestionRoute, "handle">,
  validateImport: boolean,
): Promise<{
  json: unknown;
  actor: { userId: string; householdId: string };
} | null> {
  let raw: string;
  try {
    raw = await readBody(request, maxBodyBytes, false);
  } catch {
    // Don't drain an oversized upload: answer, then drop the connection.
    response.on("finish", () => request.destroy());
    sendJson(
      response,
      413,
      { ok: false, error: "body too large" },
      { connection: "close" },
    );
    return null;
  }
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
    nonce === undefined ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    signature === undefined
  ) {
    sendJson(response, 401, { ok: false, error: "invalid signature" });
    return null;
  }
  const bodyHash = createHash("sha256").update(raw).digest("hex");
  const canonical = `${timestamp}\n${nonce}\nPOST\n${path}\n${bodyHash}`;
  const expected = `v1=${createHmac("sha256", deps.secret)
    .update(canonical)
    .digest("hex")}`;
  const supplied = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    sendJson(response, 401, { ok: false, error: "invalid signature" });
    return null;
  }
  const now = deps.now?.() ?? Date.now();
  if (Math.abs(Math.floor(now / 1000) - timestamp) > 60) {
    sendJson(response, 401, { ok: false, error: "invalid signature" });
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { ok: false, error: "invalid json" });
    return null;
  }
  if (validateImport) {
    const suggestionRequest = importSuggestionRequestSchema.safeParse(json);
    if (!suggestionRequest.success) {
      sendJson(response, 400, { ok: false, error: "invalid request" });
      return null;
    }
    // Preserve the import route's legacy response even without an actor UUID.
    if (suggestionRequest.data.version !== 2) {
      sendJson(response, 403, { ok: false, error: "member scope required" });
      return null;
    }
  }
  const actor = signedActorSchema.safeParse(json);
  if (!actor.success) {
    sendJson(response, 400, { ok: false, error: "invalid request" });
    return null;
  }
  try {
    if (!(await deps.claimNonce(nonce, new Date(now + 120_000)))) {
      sendJson(response, 409, { ok: false, error: "replayed request" });
      return null;
    }
  } catch (error) {
    console.error("[bot:server] nonce claim failed:", error);
    sendJson(response, 503, {
      ok: false,
      error: "replay protection unavailable",
    });
    return null;
  }
  try {
    const actorHouseholdId = await deps.resolveActorHouseholdId(
      actor.data.actorUserId,
    );
    if (actorHouseholdId !== actor.data.scopeKey) {
      sendJson(response, 403, { ok: false, error: "household access denied" });
      return null;
    }
  } catch (error) {
    console.error("[bot:server] internal member lookup failed:", error);
    sendJson(response, 503, {
      ok: false,
      error: "member lookup unavailable",
    });
    return null;
  }
  return {
    json,
    actor: { userId: actor.data.actorUserId, householdId: actor.data.scopeKey },
  };
}

/** Production entry point: real bot wiring + listen on PORT. */
async function main(): Promise<void> {
  const {
    handle,
    client,
    memberClient,
    categorizer,
    interpretText,
    classifyMessage,
  } = await startBot();
  const env = getBotServerEnv();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const paidFallbackClient = createPaidFallbackClient(env);
  const { jev } = createCategoryRuntime(env);
  const importSuggestions =
    env.IMPORT_SUGGESTION_SHARED_SECRET === undefined
      ? undefined
      : {
          secret: env.IMPORT_SUGGESTION_SHARED_SECRET,
          claimNonce: (nonce: string, expiresAt: Date) =>
            claimImportSuggestionNonce(client, nonce, expiresAt),
          resolveActorHouseholdId: (userId: string) =>
            findHouseholdIdForCurrentUser(memberClient({ userId })),
          handle: createImportSuggestionHandler({
            jevPrimary: true,
            jevClient: jev,
            jevModel: env.JEV_MODEL,
            codexEnabled: false,
            codexModel: env.CODEX_MODEL ?? "gpt-6-sol",
            codexTimeoutMs: env.CODEX_TIMEOUT_MS ?? 12_000,
            codexHome: "/var/lib/family-finance-codex",
            paidFallbackEnabled: env.IMPORT_PAID_FALLBACK_ENABLED === "true",
            paidFallbackMaxItems: env.IMPORT_PAID_FALLBACK_MAX_ITEMS,
            paidFallbackProvider: "openai",
            paidFallbackModel:
              env.IMPORT_PAID_FALLBACK_MODEL ??
              env.OPENAI_MODEL ??
              DEFAULT_OPENAI_MODEL,
            paidFallbackClient,
            reservePaidItems: (input) =>
              reserveImportAiPaidItems(client, input),
            recordPaidResult: (input) =>
              recordImportAiPaidResult(client, input),
          }),
        };
  const signed: SignedRouteDeps | undefined =
    importSuggestions === undefined
      ? undefined
      : {
          secret: importSuggestions.secret,
          resolveActorHouseholdId: importSuggestions.resolveActorHouseholdId,
          claimNonce: (nonce) =>
            importSuggestions.claimNonce(nonce, new Date(Date.now() + 120_000)),
        };
  const internalRoutes: InternalRoute[] =
    importSuggestions === undefined
      ? []
      : [
          {
            path: CAPTURE_DRAFT_PATH,
            maxBodyBytes: MAX_INTERNAL_BODY_BYTES,
            handle: createCaptureDraftHandler({
              buildCaptureDeps: ({ userId, householdId }) =>
                buildDeps(
                  memberClient({ userId }),
                  householdId,
                  categorizer,
                  interpretText,
                  classifyMessage,
                ),
              limiter: createCaptureRateLimiter(),
              log: (event, fields) => console.error(`[bot:${event}]`, fields),
            }),
          },
        ];
  const server = createBotServer(handle, {
    importSuggestions,
    internalRoutes,
    signed,
  });
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
