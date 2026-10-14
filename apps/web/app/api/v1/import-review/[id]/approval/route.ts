import { approveImport, ImportError } from "@family-finance/import-service";
import {
  boundedForm,
  authenticateBrowser,
  transaction,
  requireSameOrigin,
  serviceOptions,
  errorResponse,
  importOrigin,
} from "../../../../../../lib/agent-import/runtime";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    if (Number(request.headers.get("content-length")) > 4096)
      throw new ImportError("LIMIT_EXCEEDED", "Form too large.");
    const identity = await authenticateBrowser();
    const { id } = await context.params;
    const form = await boundedForm(request);
    if (form.get("reviewed") !== "yes")
      throw new ImportError(
        "APPROVAL_REQUIRED",
        "Explicit review is required.",
      );
    await transaction(identity, (db) =>
      approveImport(
        db,
        id,
        Number(form.get("revision")),
        String(form.get("challenge")),
        serviceOptions(),
      ),
    );
    return Response.redirect(
      `${importOrigin()}/imports/agent/${id}?approved=1`,
      303,
    );
  } catch (e) {
    return errorResponse(e);
  }
}
