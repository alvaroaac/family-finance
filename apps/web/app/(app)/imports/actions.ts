"use server";

import { revalidatePath } from "next/cache";

import {
  getImportAdapter,
  buildImportPreview,
  splitFlatAndInstallmentRows,
  matchExistingGroup,
  normalizeDescription,
  type ImportSource,
  type ImportPreview,
  type NormalizedImportRow,
  type InferredInstallmentGroup,
} from "@family-finance/importers";
import { createTransactionDraft, createInstallmentPlan, brl } from "@family-finance/domain";
import {
  confirmImport as confirmImportBatch,
  transactionInsertFromDraft,
  findHouseholdIdForCurrentUser,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  listCreditCards,
  listInstallmentGroupsByHousehold,
  findCardChargesBetween,
  createInstallmentPurchase,
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

export type CreditCardOption = { id: string; name: string };
export type InferredGroupPreview = InferredInstallmentGroup & {
  status: "new" | "exists";
};
export type MpPreviewExtras = {
  referenceMonth: string;
  groups: InferredGroupPreview[];
  /** Row indices (into preview.rows) of parcela rows — NOT flat-importable. */
  installmentRowIndices: number[];
  /** Row indices already found in the DB (flag "já importada", default-skip). */
  dbDuplicateIndices: number[];
};

export type PreviewState = {
  ok: true;
  preview: ImportPreview;
  accounts: AccountOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  creditCards: CreditCardOption[];
  mp?: MpPreviewExtras;
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

    // PRIVACY: for the PDF fatura the bytes are extracted to text in-memory and
    // dropped immediately — same transient guarantee as the CSV path.
    let fileText: string;
    if (source === "mercado-pago") {
      const { extractText } = await import("unpdf");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extracted = await extractText(bytes, { mergePages: true });
      fileText = Array.isArray(extracted.text)
        ? extracted.text.join("\n")
        : extracted.text;
    } else {
      fileText = await file.text();
    }

    const adapter = getImportAdapter(source);
    if (adapter === undefined) {
      return { ok: false, message: "Fonte de importação não suportada." };
    }

    const parsed = await adapter.parse(fileText);
    const { rows, errors } = parsed;
    const preview = buildImportPreview({ source, rows, errors });

    // Load the household catalog so the UI can offer account + category mapping.
    const [accounts, categories, creditCards] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
      listCreditCards(client, householdId),
    ]);
    const subLists = await Promise.all(
      categories.map((c) =>
        findSubcategoriesByCategory(client, householdId, c.id),
      ),
    );
    const subcategories = subLists.flat();

    let mp: MpPreviewExtras | undefined;
    if (source === "mercado-pago") {
      const referenceMonth = parsed.statement?.referenceMonth;
      if (referenceMonth === undefined) {
        return {
          ok: false,
          message:
            "Não foi possível identificar o mês de emissão da fatura no PDF.",
        };
      }
      const { flatRowIndices, groups } = splitFlatAndInstallmentRows(
        rows,
        referenceMonth,
      );
      const installmentRowIndices = rows
        .map((_, i) => i)
        .filter((i) => !flatRowIndices.includes(i));

      // §4 dedupe — installment groups already in the DB.
      const existingGroups = await listInstallmentGroupsByHousehold(
        client,
        householdId,
      );
      const summaries = existingGroups.map((g) => ({
        description: g.description,
        installmentCount: g.installment_count,
        purchasedOn: g.purchased_on,
      }));
      const groupPreviews: InferredGroupPreview[] = groups.map((g) => ({
        ...g,
        status: matchExistingGroup(g, summaries) === null ? "new" : "exists",
      }));

      // §4 dedupe — flat charges already imported on a card in the period.
      const dates = rows
        .filter((_, i) => flatRowIndices.includes(i))
        .map((r) => r.occurredOn)
        .sort();
      let dbDuplicateIndices: number[] = [];
      const first = dates[0];
      const last = dates[dates.length - 1];
      if (first !== undefined && last !== undefined) {
        const charges = await findCardChargesBetween(
          client,
          householdId,
          first,
          last,
        );
        const seen = new Set(
          charges.map(
            (c) =>
              `${c.occurred_on}|${c.kind}|${Math.abs(c.amount_cents)}|` +
              normalizeDescription(c.description).toLowerCase(),
          ),
        );
        dbDuplicateIndices = flatRowIndices.filter((i) => {
          const r = rows[i] as NormalizedImportRow;
          const key =
            `${r.occurredOn}|${r.kind}|${r.amount.cents}|` +
            normalizeDescription(r.description).toLowerCase();
          return seen.has(key);
        });
      }

      mp = {
        referenceMonth,
        groups: groupPreviews,
        installmentRowIndices,
        dbDuplicateIndices,
      };
    }

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
      creditCards: creditCards.map((c) => ({ id: c.id, name: c.name })),
      mp,
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

export type ConfirmGroupInput = {
  description: string;
  totalAmountCents: number;
  installmentCount: number;
  purchasedOn: string; // ISO YYYY-MM-DD (user-edited)
  categoryId?: string;
  subcategoryId?: string;
};

export type ConfirmInput = {
  source: ImportSource;
  /** The normalized rows from the preview (the file is already discarded). */
  rows: NormalizedImportRow[];
  /** Target account every imported transaction is booked against (CSV sources). */
  accountId?: string;
  /** Target credit card for Mercado Pago fatura charges (required when source is "mercado-pago"). */
  creditCardId?: string;
  /** Kept inferred installment groups from the MP preview (source is "mercado-pago" only). */
  groups?: ConfirmGroupInput[];
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

    const isMp = input.source === "mercado-pago";
    if (isMp) {
      if (
        typeof input.creditCardId !== "string" ||
        input.creditCardId.length === 0
      ) {
        return {
          ok: false,
          message: "Escolha o cartão de destino antes de confirmar.",
        };
      }
    } else if (
      typeof input.accountId !== "string" ||
      input.accountId.length === 0
    ) {
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

      const payment =
        isMp && typeof input.creditCardId === "string"
          ? ({ type: "card", creditCardId: input.creditCardId } as const)
          : ({ type: "account", accountId: input.accountId as string } as const);

      const draftResult = createTransactionDraft({
        householdId,
        kind: row.kind,
        amount: row.amount,
        occurredOn: row.occurredOn,
        description: row.description,
        createdByUserId,
        payment,
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

    // §5 step 2: create the kept inferred installment groups, one RPC per
    // group. Not atomic with the batch above — acceptable per spec §5: a
    // re-import flags both already-imported charges and already-created
    // groups, so a partial failure is visible and recoverable, not duplicated.
    let groupsCreated = 0;
    const groupErrors: string[] = [];
    if (isMp && Array.isArray(input.groups)) {
      for (const g of input.groups) {
        const planResult = createInstallmentPlan({
          householdId,
          creditCardId: input.creditCardId as string,
          description: g.description,
          totalAmount: brl(g.totalAmountCents),
          installmentCount: g.installmentCount,
          purchasedOn: g.purchasedOn,
          createdByUserId,
          category:
            g.categoryId !== undefined
              ? { categoryId: g.categoryId, subcategoryId: g.subcategoryId }
              : undefined,
        });
        if (!planResult.ok) {
          groupErrors.push(
            `${g.description}: ${planResult.errors.map((e) => e.message).join("; ")}`,
          );
          continue;
        }
        try {
          await createInstallmentPurchase(client, planResult.value);
          groupsCreated += 1;
        } catch (error) {
          groupErrors.push(
            `${g.description}: ${error instanceof Error ? error.message : "falha ao gravar parcelamento"}`,
          );
        }
      }
    }

    revalidatePath("/imports");
    revalidatePath("/dashboard");

    const parts: string[] = [];
    parts.push(
      writeErrors.length === 0
        ? `Importação confirmada: ${imported} transações gravadas.`
        : `Importadas ${imported}; ${writeErrors.length} linha(s) com erro.`,
    );
    if (isMp) {
      parts.push(`${groupsCreated} parcelamento(s) criado(s).`);
      if (groupErrors.length > 0) {
        parts.push(`Falhas em parcelamentos: ${groupErrors.join(" | ")}`);
      }
    }
    parts.push("Arquivo original descartado.");

    return {
      ok: writeErrors.length === 0 && groupErrors.length === 0,
      message: parts.join(" "),
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
