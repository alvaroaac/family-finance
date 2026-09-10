import { transcribeMobileAudio } from "../../../../../lib/mobile/audio";
import { NextResponse } from "next/server";
import { z } from "zod";
import { actionSchema, monthSchema } from "@family-finance/mobile-contracts";
import { themes } from "@family-finance/mobile-contracts/design-system";
import {
  authenticateMobile,
  withMobileContext,
  MobileError,
} from "../../../../../lib/mobile/context";
import {
  validateActionReferences,
  runExtraAction,
} from "../../../../../lib/mobile/actions";
import {
  loadMobileData,
  loadMobileProjection,
} from "../../../../../lib/mobile/data";
import { saveMobileEntry } from "../../../../../lib/mobile/entries";
import { suggestMobileDraft } from "../../../../../lib/mobile/draft";
import * as accounts from "../../../../(app)/accounts/actions";
import * as cards from "../../../../(app)/cards/actions";
import * as categories from "../../../../(app)/categories/actions";
import * as investments from "../../../../(app)/investments/actions";
import * as obligations from "../../../../(app)/obligations/actions";
import * as transactions from "../../../../(app)/transactions/actions";
import * as imports from "../../../../(app)/imports/actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const actions: Record<string, (form: FormData) => Promise<unknown>> = {
  "accounts.create": accounts.createAccountAction,
  "accounts.update": accounts.updateAccountAction,
  "accounts.delete": accounts.deleteAccountAction,
  "cards.create": cards.createCardAction,
  "cards.update": cards.updateCardAction,
  "cards.delete": cards.deleteCardAction,
  "categories.archive": categories.archiveCategoryAction,
  "categories.restore": categories.restoreCategoryAction,
  "categories.merge": categories.mergeCategoryAction,
  "memory.create": categories.createMemoryAction,
  "memory.disable": categories.disableMemoryAction,
  "memory.enable": categories.enableMemoryAction,
  "investments.create": investments.createBucketAction,
  "investments.update": investments.updateBucketAction,
  "investments.balance": investments.updateBucketBalanceAction,
  "investments.delete": investments.deleteBucketAction,
  "obligations.create": obligations.createObligationAction,
  "obligations.update": obligations.updateObligationAction,
  "obligations.cancel": obligations.cancelObligationAction,
  "obligations.pay": obligations.markObligationPaidAction,
  "transactions.update": transactions.updateTransactionAction,
  "transactions.delete": transactions.deleteTransactionAction,
};
async function handle(
  request: Request,
  route: { params: Promise<{ path: string[] }> },
) {
  try {
    const context = await authenticateMobile(request);
    return await withMobileContext(context, async () => {
      const path = (await route.params).path.join("/");
      const url = new URL(request.url);
      let result: unknown;
      if (request.method === "GET" && path === "bootstrap")
        result = await loadMobileData(
          context,
          monthSchema
            .optional()
            .parse(url.searchParams.get("month") ?? undefined),
        );
      else if (request.method === "GET" && path === "imports/history") {
        const { data, error } = await context.client
          .from("import_batches")
          .select(
            "id, source, created_at, total_rows, imported_rows, duplicate_rows, error_rows",
          )
          .eq("household_id", context.householdId)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error)
          throw new MobileError(503, "Não foi possível carregar o histórico.");
        result = data;
      } else if (request.method === "GET" && path === "projection")
        result = await loadMobileProjection(context);
      else if (request.method === "GET" && path === "design-system") {
        const theme = z
          .enum(["esmeralda", "salvia"])
          .parse(url.searchParams.get("theme") ?? "esmeralda");
        result = {
          version: 1,
          tenantId: context.householdId,
          theme,
          tokens: themes[theme],
        };
      } else if (request.method === "POST" && path === "imports/preview") {
        if (Number(request.headers.get("content-length")) > 22 * 1024 * 1024)
          throw new MobileError(413, "Arquivo muito grande.");
        result = await imports.previewImport(await request.formData());
      } else if (request.method === "POST" && path === "audio") {
        if (Number(request.headers.get("content-length")) > 9 * 1024 * 1024)
          throw new MobileError(413, "Áudio muito grande.");
        result = await transcribeMobileAudio(await request.formData());
      } else if (request.method === "POST") {
        if (Number(request.headers.get("content-length")) > 8 * 1024 * 1024)
          throw new MobileError(413, "Solicitação muito grande.");
        const body: unknown = await request.json();
        if (path === "entries") result = await saveMobileEntry(context, body);
        else if (path === "draft")
          result = await suggestMobileDraft(
            context,
            z
              .object({ text: z.string().trim().min(1).max(4000) })
              .strict()
              .parse(body).text,
          );
        else if (path === "actions") {
          const input = actionSchema.parse(body);
          const action = actions[input.action];
          await validateActionReferences(context, input);
          const form = new FormData();
          for (const [key, value] of Object.entries(input.fields))
            if (value !== null) form.set(key, String(value));
          if (await runExtraAction(context, input, form)) result = { ok: true };
          else if (action) result = (await action(form)) ?? { ok: true };
          else throw new MobileError(404, "Ação indisponível.");
        } else if (path === "imports/resolve")
          result = await imports.resolveImportTargets(
            body as Parameters<typeof imports.resolveImportTargets>[0],
          );
        else if (path === "imports/suggest")
          result = await imports.suggestImportCategories(
            body as Parameters<typeof imports.suggestImportCategories>[0],
          );
        else if (path === "imports/confirm")
          result = await imports.confirmImport(
            body as Parameters<typeof imports.confirmImport>[0],
          );
        else throw new MobileError(404, "Recurso indisponível.");
      } else throw new MobileError(404, "Recurso indisponível.");
      return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return NextResponse.json(
        {
          error: error.issues[0]?.message ?? "Dados inválidos.",
          code: "invalid_input",
        },
        { status: 422 },
      );
    if (error instanceof MobileError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    // Never include database messages, credentials, or financial text in responses/logs.
    return NextResponse.json(
      {
        error:
          "Não foi possível concluir. Atualize os dados antes de tentar novamente.",
        code: "request_failed",
      },
      { status: 503 },
    );
  }
}
export const GET = handle;
export const POST = handle;
