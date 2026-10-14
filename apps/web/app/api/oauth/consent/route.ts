import { SCOPES, ImportError } from "@family-finance/import-service";
import {
  boundedForm,
  authenticateBrowser,
  requireSameOrigin,
  transaction,
  errorResponse,
} from "../../../../lib/agent-import/runtime";
import { createServerSupabaseClient } from "../../../../lib/supabase";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const identity = await authenticateBrowser();
    const form = await boundedForm(request);
    const id = String(form.get("authorization_id"));
    const supabase = await createServerSupabaseClient();
    const details = await supabase.auth.oauth.getAuthorizationDetails(id);
    if (details.error || !details.data || !("client" in details.data))
      throw new ImportError(
        "INVALID_REQUEST",
        "Request a fresh authorization.",
      );
    let result;
    if (form.get("decision") === "approve") {
      const scopes = form.getAll("scopes").map(String);
      if (scopes.some((s) => !SCOPES.includes(s as (typeof SCOPES)[number])))
        throw new ImportError("INVALID_REQUEST", "Invalid permissions.");
      await transaction(
        { ...identity, clientId: details.data.client.id },
        (db) => db.grant(scopes),
      );
      result = await supabase.auth.oauth.approveAuthorization(id, {
        skipBrowserRedirect: true,
      });
    } else
      result = await supabase.auth.oauth.denyAuthorization(id, {
        skipBrowserRedirect: true,
      });
    if (result.error || !result.data)
      throw new ImportError(
        "TEMPORARY_FAILURE",
        "Authorization could not finish.",
      );
    return Response.redirect(result.data.redirect_url, 303);
  } catch (e) {
    return errorResponse(e);
  }
}
