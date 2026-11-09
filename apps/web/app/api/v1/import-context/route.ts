import {
  authenticateBearer,
  runTool,
  errorResponse,
} from "../../../../lib/agent-import/runtime";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(
      await runTool(
        await authenticateBearer(request),
        "get_import_context",
        {},
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
