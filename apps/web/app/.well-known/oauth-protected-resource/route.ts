import {
  assertEnabled,
  importOrigin,
  errorResponse,
} from "../../../lib/agent-import/runtime";
export function GET() {
  try {
    assertEnabled();
    return Response.json({
      resource: `${importOrigin()}/mcp`,
      authorization_servers: [
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`,
      ],
      scopes_supported: ["openid"],
      bearer_methods_supported: ["header"],
      resource_name: "Family Finance imports",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
