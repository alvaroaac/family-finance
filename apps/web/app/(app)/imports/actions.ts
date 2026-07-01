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
  confirmImport as confirmImportBatch,
  transactionInsertFromDraft,
  findHouseholdIdForCurrentUser,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  type ImportSource as DbImportSource,
  type ConfirmImportRowPayload,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the import pipeline.
 *
 * PRIVACY: the uploaded file is read into memory ONLY inside `previewImport`,
 * parsed into normalized rows, and then dropped — it is never written to disk or
 * persisted. The browser holds the resulting normalized rows between preview and
 * confirm; `confirmImport` receives those rows (not the file) and persists, in
 * ONE atomic transaction, a single `import_batch` summary (source, counts,
 * status), the kept transactions linked to that batch, and the per-row
 * `import_rows` audit trail. No raw file bytes ever reach the database.
 */

const SOURCE_TO_DB: Record<ImportSource, DbImportSource> = {
  "minhas-financas": "minhas_financas_csv",
  nubank: "nubank_csv",
  "mercado-pago": "mercado_pago_pdf",
};

function parseSource(value: FormDataEntryValue | null): ImportSource {
  if (value === "minhas-financas" || value === "nubank" || value === "mercado-pago") {
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
 *
 * Each selected row is validated into a transaction draft HERE (so the domain
 * rules and per-row error reporting stay in the app); the drafts plus a per-row
 * audit record are then handed to the `confirm_import` RPC, which — in ONE
 * atomic transaction — creates the `import_batch`, bulk-inserts the kept
 * transactions linked to it via `import_batch_id`, and writes the `import_rows`
 * audit trail (counts only — never the raw file). RLS / household isolation is
 * re-asserted inside the SECURITY DEFINER function.
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
    // One audit entry per selected row: rows that validate carry a transaction
    // payload (without import_batch_id — the RPC fills it from the batch it
    // inserts); rows that fail validation carry only the audit error message.
    const rowPayloads: ConfirmImportRowPayload[] = [];

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
        const message = draftResult.errors.map((e) => e.message).join("; ");
        writeErrors.push(`Linha ${row.sourceLine}: ${message}`);
        // Audit-only row: no transaction is produced, but the skip is recorded.
        rowPayloads.push({
          household_id: householdId,
          source_line: row.sourceLine,
          occurred_on: row.occurredOn,
          amount_cents:
            row.kind === "expense" ? -row.amount.cents : row.amount.cents,
          description: row.description,
          error_message: message,
          is_duplicate: false,
        });
        continue;
      }

      // The transaction payload the RPC bulk-inserts. `import_batch_id` is set
      // server-side from the batch the function creates in the same transaction.
      const { import_batch_id: _drop, ...transaction } =
        transactionInsertFromDraft(draftResult.value);
      rowPayloads.push({
        household_id: householdId,
        source_line: row.sourceLine,
        occurred_on: row.occurredOn,
        // Audit magnitude carries the row's signed direction (expense negative),
        // mirroring how the source file expressed it; import_rows forbids zero.
        amount_cents:
          row.kind === "expense" ? -row.amount.cents : row.amount.cents,
        description: row.description,
        error_message: null,
        is_duplicate: false,
        transaction,
      });
      imported += 1;
    }

    // Atomic write: batch + kept transactions (linked via import_batch_id) +
    // import_rows audit trail, all in one transaction. Counts mirror the old
    // summary (never the raw file).
    await confirmImportBatch(
      client,
      {
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
      },
      rowPayloads,
    );

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
