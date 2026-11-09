import {
  boundedForm,
  authenticateBrowser,
  transaction,
  requireSameOrigin,
  errorResponse,
  importOrigin,
} from "../../../../lib/agent-import/runtime";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const identity = await authenticateBrowser();
    const form = await boundedForm(request);
    await transaction(identity, (db) =>
      db.revoke(String(form.get("client_id"))),
    );
    return Response.redirect(`${importOrigin()}/oauth/connections`, 303);
  } catch (e) {
    return errorResponse(e);
  }
}
