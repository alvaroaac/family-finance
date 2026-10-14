import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import {
  createAgentImportPool,
  withAgentImportTransaction,
  type AgentIdentity,
  type AgentImportDatabase,
} from "@family-finance/db";
import {
  executeImport,
  ImportError,
  LIMITS,
  type ToolName,
  type ServiceOptions,
  type Draft,
  type Catalog,
  type Suggestion,
} from "@family-finance/import-service";
import { createServerSupabaseClient } from "../supabase";
import { requestImportSuggestions } from "../../app/(app)/imports/suggestion-client";
import { z } from "zod";

let pool: ReturnType<typeof createAgentImportPool> | undefined;
export function importOrigin(): string {
  const url = new URL(required("NEXT_PUBLIC_SITE_URL"));
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("HTTPS is required");
  return url.origin;
}
function required(key: string): string {
  const v = process.env[key];
  if (!v)
    throw new ImportError(
      "TEMPORARY_FAILURE",
      "Agent imports are not configured.",
    );
  return v;
}
export function assertEnabled(): void {
  if (process.env.AGENT_IMPORT_ENABLED !== "true")
    throw new ImportError("NOT_FOUND", "Agent imports are not enabled.");
}
export function challengeHeader(): string {
  return `Bearer resource_metadata="${importOrigin()}/.well-known/oauth-protected-resource/mcp", scope="openid"`;
}
export async function authenticateBearer(
  request: Request,
): Promise<AgentIdentity> {
  assertEnabled();
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ") || auth.length > 16384)
    throw new ImportError(
      "AUTH_REQUIRED",
      "Connect Family Finance using OAuth.",
    );
  const token = auth.slice(7);
  const issuer =
    required("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "") + "/auth/v1";
  const supabase = createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user)
    throw new ImportError("AUTH_REQUIRED", "Reconnect Family Finance.");
  let claims;
  try {
    claims = decodeJwt(token);
  } catch {
    throw new ImportError("AUTH_REQUIRED", "Invalid access token.");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    claims.sub !== data.user.id ||
    typeof claims.exp !== "number" ||
    claims.exp <= Date.now() / 1000 ||
    !audiences.includes(`${importOrigin()}/mcp`) ||
    typeof claims.client_id !== "string" ||
    claims.role !== "authenticated"
  )
    throw new ImportError(
      "AUTH_REQUIRED",
      "The OAuth token is not valid for this resource.",
    );
  return { userId: data.user.id, clientId: claims.client_id, browser: false };
}
export async function authenticateBrowser(): Promise<AgentIdentity> {
  assertEnabled();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user)
    throw new ImportError("AUTH_REQUIRED", "Sign in to Family Finance.");
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token || decodeJwt(token).client_id)
    throw new ImportError(
      "AUTH_REQUIRED",
      "A first-party browser session is required.",
    );
  return {
    userId: data.user.id,
    clientId: "family-finance-web",
    browser: true,
  };
}
export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== importOrigin())
    throw new ImportError("AUTH_REQUIRED", "Invalid request origin.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new ImportError(
      "AUTH_REQUIRED",
      "Cross-site approval is not allowed.",
    );
}
export async function transaction<T>(
  identity: AgentIdentity,
  fn: (db: AgentImportDatabase) => Promise<T>,
): Promise<T> {
  pool ??= createAgentImportPool(required("AGENT_IMPORT_DATABASE_URL"));
  return withAgentImportTransaction(pool, identity, fn);
}
const suggestionsSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string(),
        candidates: z
          .array(
            z.object({
              categoryId: z.string(),
              subcategoryId: z.string().nullable(),
              explanation: z.string().max(1000),
              confidence: z.number().min(0).max(1),
            }),
          )
          .max(3),
      }),
    )
    .max(25),
});
async function suggest(draft: Draft, catalog: Catalog): Promise<Suggestion[]> {
  const baseUrl = process.env.IMPORT_SUGGESTION_URL;
  const secret = process.env.IMPORT_SUGGESTION_SHARED_SECRET;
  if (!baseUrl || !secret) throw new Error("AI unavailable");
  const eligible = draft.rows
    .filter(
      (r) =>
        r.proposed.kind === "expense" &&
        !r.category_explicit &&
        !r.category_id &&
        r.category_source === "uncategorized" &&
        r.proposed.occurred_on &&
        r.proposed.amount_cents &&
        r.included,
    )
    .slice(0, 50);
  const result: Suggestion[] = [];
  for (let offset = 0; offset < eligible.length; offset += 25) {
    const rows = eligible.slice(offset, offset + 25);
    const raw = await requestImportSuggestions({
      baseUrl,
      secret,
      timeoutMs: 6000,
      body: {
        version: 2,
        requestId: crypto.randomUUID(),
        scopeKey: draft.household_id,
        budgetKey: draft.lineage_id,
        actorUserId: draft.user_id,
        catalog: {
          categories: catalog.categories.filter((c) => c.kind === "expense"),
          subcategories: catalog.subcategories.map((s) => ({
            id: s.id,
            categoryId: s.category_id,
            name: s.name,
          })),
        },
        items: rows.map((r) => ({
          key: r.id,
          description:
            r.proposed.purchase_description ?? r.observed.description_original,
          amountCents: r.proposed.amount_cents,
          occurredOn: r.proposed.occurred_on,
        })),
      },
    });
    for (const item of suggestionsSchema.parse(raw).items) {
      const best = item.candidates[0];
      if (best)
        result.push({
          row_id: item.key,
          category_id: best.categoryId,
          subcategory_id: best.subcategoryId,
          explanation: best.explanation,
          confidence: best.confidence,
        });
    }
  }
  return result;
}
export function serviceOptions(): ServiceOptions {
  return { origin: importOrigin(), suggest };
}
export async function runTool(
  identity: AgentIdentity,
  name: ToolName,
  args: unknown,
): Promise<Record<string, unknown>> {
  return transaction(identity, (db) =>
    executeImport(db, name, args, serviceOptions()),
  );
}
export async function boundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ImportError("INVALID_REQUEST", "Use application/json.");
  const declared = Number(request.headers.get("content-length"));
  if (declared > LIMITS.request_bytes)
    throw new ImportError("LIMIT_EXCEEDED", "Request exceeds 2 MiB.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ImportError("INVALID_REQUEST", "JSON body is required.");
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > LIMITS.request_bytes) {
      await reader.cancel();
      throw new ImportError("LIMIT_EXCEEDED", "Request exceeds 2 MiB.");
    }
    chunks.push(part.value);
  }
  const body = Buffer.concat(chunks);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ImportError("INVALID_REQUEST", "Malformed JSON.");
  }
}
export function errorResponse(error: unknown): Response {
  const e =
    error instanceof ImportError
      ? error
      : (error as { code?: string })?.code === "MEMBERSHIP_REQUIRED"
        ? new ImportError(
            "MEMBERSHIP_REQUIRED",
            "Exactly one active household membership is required.",
          )
        : new ImportError(
            "TEMPORARY_FAILURE",
            "The operation could not finish. Fetch import status before retrying.",
          );
  const status =
    e.code === "AUTH_REQUIRED"
      ? 401
      : e.code === "SCOPE_REQUIRED" || e.code === "MEMBERSHIP_REQUIRED"
        ? 403
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "TEMPORARY_FAILURE"
            ? 503
            : e.code === "LIMIT_EXCEEDED"
              ? 413
              : e.code === "INVALID_REQUEST"
                ? 400
                : 409;
  return Response.json(
    { error: { code: e.code, message: e.message, ...e.details } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 401 ? { "WWW-Authenticate": challengeHeader() } : {}),
        ...(status === 503 ? { "Retry-After": "5" } : {}),
      },
    },
  );
}

export async function boundedForm(request: Request): Promise<URLSearchParams> {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new ImportError("INVALID_REQUEST", "Unsupported form encoding.");
  const reader = request.body?.getReader();
  if (!reader) throw new ImportError("INVALID_REQUEST", "Form required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const p = await reader.read();
    if (p.done) break;
    size += p.value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new ImportError("LIMIT_EXCEEDED", "Form exceeds limit.");
    }
    chunks.push(p.value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
