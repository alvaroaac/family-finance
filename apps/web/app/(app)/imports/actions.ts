"use server";

import { revalidatePath } from "next/cache";

import {
  getImportAdapter,
  buildImportPreview,
  type ImportSource,
  type ImportPreview,
  type NormalizedImportRow,
} from "@family-finance/importers";
import { createTransactionDraft } from "@family-finance/domain";
import {
  createImportBatch,
  createTransaction,
  findHouseholdIdForCurrentUser,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  type ImportSource as DbImportSource,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the import pipeline.
 *
 * PRIVACY: the uploaded file is read into memory ONLY inside `previewImport`,
 * parsed into normalized rows, and then dropped — it is never written to disk or
 * persisted. The browser holds the resulting normalized rows between preview and
 * confirm; `confirmImport` receives those rows (not the file) and writes one
 * transaction per kept row plus a single `import_batch` summary (source, counts,
 * status). No raw file bytes ever reach the database.
 */

const SOURCE_TO_DB: Record<ImportSource, DbImportSource> = {
  "minhas-financas": "minhas_financas_csv",
  nubank: "nubank_csv",
};

function parseSource(value: FormDataEntryValue | null): ImportSource {
  if (value === "minhas-financas" || value === "nubank") {
    return value;
  }
  throw new Error("Fonte de importação inválida.");
}

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

async function authed(): Promise<{
  householdId: string;
  client: ServerSupabaseClient;
}> {
  await requireAuthorizedUser();
  const { createServerSupabaseClient } = await import("../../../lib/supabase");
  const client = await createServerSupabaseClient();
  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) {
    throw new Error("Nenhuma casa ativa para o usuário atual.");
  }
  return { householdId, client };
}

export type AccountOption = { id: string; name: string; kind: string };
export type CategoryOption = { id: string; name: string };
export type SubcategoryOption = {
  id: string;
  categoryId: string;
  name: string;
};

export type PreviewState = {
  ok: true;
  preview: ImportPreview;
  accounts: AccountOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
};

export type PreviewError = { ok: false; message: string };

/**
 * Parse an uploaded file into a normalized preview WITHOUT persisting anything.
 * The file is consumed in-memory and discarded; only normalized rows, errors,
 * duplicate candidates, and the household catalog (accounts/categories for
 * mapping) are returned for the user to review before any write.
 */
export async function previewImport(
  formData: FormData,
): Promise<PreviewState | PreviewError> {
  try {
    const { client, householdId } = await authed();
    const source = parseSource(formData.get("source"));

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: "Selecione um arquivo CSV para importar." };
    }

    // Read the transient file into memory; it is not written anywhere.
    const fileText = await file.text();

    const adapter = getImportAdapter(source);
    if (adapter === undefined) {
      return { ok: false, message: "Fonte de importação não suportada." };
    }

    const { rows, errors } = await adapter.parse(fileText);
    const preview = buildImportPreview({ source, rows, errors });

    // Load the household catalog so the UI can offer account + category mapping.
    const [accounts, categories] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
    ]);
    const subLists = await Promise.all(
      categories.map((c) =>
        findSubcategoriesByCategory(client, householdId, c.id),
      ),
    );
    const subcategories = subLists.flat();

    return {
      ok: true,
      preview,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      subcategories: subcategories.map((s) => ({
        id: s.id,
        categoryId: s.category_id,
        name: s.name,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível gerar o preview da importação.",
    };
  }
}

export type ConfirmInput = {
  source: ImportSource;
  /** The normalized rows from the preview (the file is already discarded). */
  rows: NormalizedImportRow[];
  /** Target account every imported transaction is booked against. */
  accountId: string;
  /** rowIndex -> chosen category/subcategory (optional; may be uncategorized). */
  mapping: Record<number, { categoryId?: string; subcategoryId?: string }>;
  /** Indices (into rows) the user chose to import (duplicates excluded by UI). */
  selectedIndices: number[];
  /** Reviewed preview counts, for the persisted batch summary. */
  totalRows: number;
  errorRows: number;
  duplicateRows: number;
  /** Optional minimal note (e.g. original filename) — never the file bytes. */
  notes?: string;
};

export type ConfirmResult = {
  ok: boolean;
  message: string;
  importedRows?: number;
  duplicateRows?: number;
  errorRows?: number;
};

/**
 * Persist the reviewed import. Receives the normalized rows the user confirmed
 * (the file is already gone), the target account, and a per-row category map.
 * Writes one transaction per kept row and a single `import_batch` summary
 * (counts only — never the raw file). RLS scopes every write to the household.
 */
export async function confirmImport(input: ConfirmInput): Promise<ConfirmResult> {
  try {
    const { client, householdId } = await authed();

    if (typeof input.accountId !== "string" || input.accountId.length === 0) {
      return {
        ok: false,
        message: "Escolha a conta de destino antes de confirmar.",
      };
    }

    // Resolve the current user id for `created_by_user_id` (lançado por).
    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      return { ok: false, message: "Sessão inválida. Faça login novamente." };
    }
    const createdByUserId = user.id;

    const selected = new Set(input.selectedIndices);
    let imported = 0;
    const writeErrors: string[] = [];

    for (let index = 0; index < input.rows.length; index += 1) {
      if (!selected.has(index)) {
        continue;
      }
      const row = input.rows[index];
      if (row === undefined) {
        continue;
      }
      const map = input.mapping[index] ?? {};

      const draftResult = createTransactionDraft({
        householdId,
        kind: row.kind,
        amount: row.amount,
        occurredOn: row.occurredOn,
        description: row.description,
        createdByUserId,
        payment: { type: "account", accountId: input.accountId },
        category: {
          categoryId: map.categoryId,
          subcategoryId: map.subcategoryId,
        },
      });

      if (!draftResult.ok) {
        writeErrors.push(
          `Linha ${row.sourceLine}: ${draftResult.errors
            .map((e) => e.message)
            .join("; ")}`,
        );
        continue;
      }

      await createTransaction(client, draftResult.value);
      imported += 1;
    }

    // Persist the batch summary — counts only, never the raw file.
    await createImportBatch(client, {
      household_id: householdId,
      source: SOURCE_TO_DB[input.source],
      status: "confirmed",
      total_rows: input.totalRows,
      imported_rows: imported,
      duplicate_rows: input.duplicateRows,
      error_rows: input.errorRows + writeErrors.length,
      notes:
        typeof input.notes === "string" && input.notes.trim().length > 0
          ? input.notes.trim().slice(0, 200)
          : null,
      created_by_user_id: createdByUserId,
    });

    revalidatePath("/imports");
    revalidatePath("/dashboard");

    return {
      ok: writeErrors.length === 0,
      message:
        writeErrors.length === 0
          ? `Importação confirmada: ${imported} transações gravadas. Arquivo original descartado.`
          : `Importadas ${imported}; ${writeErrors.length} linha(s) com erro.`,
      importedRows: imported,
      duplicateRows: input.duplicateRows,
      errorRows: input.errorRows + writeErrors.length,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível confirmar a importação.",
    };
  }
}
