import { ImportError, type ToolName } from "@family-finance/import-service";
import {
  authenticateBearer,
  boundedJson,
  runTool,
  errorResponse,
} from "../../../../../lib/agent-import/runtime";
export const runtime = "nodejs";
const operations: Record<string, ToolName> = {
  entries: "append_import_entries",
  prepare: "prepare_import",
  categorize: "categorize_import",
  confirmation: "request_import_confirmation",
  confirm: "confirm_import",
  renew: "renew_import",
  cancel: "cancel_import",
};
async function handle(
  request: Request,
  context: { params: Promise<{ segments?: string[] }> },
) {
  try {
    const identity = await authenticateBearer(request);
    const segments = (await context.params).segments ?? [];
    let name: ToolName;
    let args: Record<string, unknown>;
    if (segments.length === 0 && request.method === "POST") {
      name = "create_import";
      args = (await boundedJson(request)) as Record<string, unknown>;
    } else if (segments.length === 1 && request.method === "GET") {
      name = "get_import";
      args = {};
    } else if (
      segments.length === 2 &&
      segments[1] === "rows" &&
      request.method === "GET"
    ) {
      name = "get_import_rows";
      const q = new URL(request.url).searchParams;
      for (const key of ["included", "issues_only"])
        if (q.has(key) && !["true", "false"].includes(q.get(key)!))
          throw new ImportError(
            "INVALID_REQUEST",
            "Boolean query values must be true or false.",
          );
      if (
        [...q.keys()].some(
          (k) =>
            ![
              "expected_revision",
              "limit",
              "cursor",
              "included",
              "issues_only",
            ].includes(k),
        )
      )
        throw new ImportError("INVALID_REQUEST", "Unknown query field.");
      args = {
        expected_revision: Number(q.get("expected_revision")),
        ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}),
        ...(q.has("cursor") ? { cursor: q.get("cursor") } : {}),
        ...(q.has("included")
          ? { included: q.get("included") === "true" }
          : {}),
        issues_only: q.get("issues_only") === "true",
      };
    } else if (segments.length === 1 && request.method === "PATCH") {
      name = "update_import";
      args = (await boundedJson(request)) as Record<string, unknown>;
    } else if (
      segments.length === 2 &&
      request.method === "POST" &&
      operations[segments[1]!]
    ) {
      name = operations[segments[1]!]!;
      args = (await boundedJson(request)) as Record<string, unknown>;
    } else throw new ImportError("NOT_FOUND", "Import operation not found.");
    if (!args || Array.isArray(args) || typeof args !== "object")
      throw new ImportError("INVALID_REQUEST", "Expected a JSON object.");
    if ("import_id" in args || "idempotency_key" in args)
      throw new ImportError(
        "INVALID_REQUEST",
        "Use the path and Idempotency-Key header for request identity.",
      );
    if (segments[0]) args.import_id = segments[0];
    if (request.method !== "GET")
      args.idempotency_key = request.headers.get("idempotency-key");
    const result = await runTool(identity, name, args);
    return Response.json(result, {
      status: result.error ? 409 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
