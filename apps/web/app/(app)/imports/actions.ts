"use server";

import {
  findFlatInstallmentMatches,
  type FlatInstallmentMatch,
} from "./flat-installment-matches";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  getImportAdapter,
  decodeOfx,
  buildImportPreview,
  splitFlatAndInstallmentRows,
  normalizeDescription,
  assignRowIdentities,
  normalizedRowsFingerprint,
  sha256Hex,
  canonicalJson,
  claimIdentity,
  assignInstallmentGroupIdentities,
  IMPORT_IDENTITY_VERSION,
  type ImportSource,
  type ImportPreview,
  type NormalizedImportRow,
  type ImportRowError,
  type InferredInstallmentGroup,
  type RowIdentity,
} from "@family-finance/importers";
import {
  planCategorizationBatch,
  type BatchCategorizationPlan,
  type CategoryCatalog,
  type CategorizationMemoryEntry,
  type SourceCategoryMapping,
  normalizeMerchantKey,
  normalizeSourceCategoryLabel,
  MERCHANT_KEY_VERSION,
  chunkAiSuggestionItems,
} from "@family-finance/categorization";
import { getServerEnv } from "@family-finance/config";
import {
  createTransactionDraft,
  createInstallmentPlan,
  brl,
  currentHouseholdDate,
} from "@family-finance/domain";
import {
  confirmImportV2 as confirmImportBatchV2,
  transactionInsertFromDraft,
  installmentGroupInsertFromPlan,
  installmentInsertPayloadsFromPlan,
  findHouseholdIdForCurrentUser,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  listCreditCards,
  listInstallmentGroupsByHousehold,
  listInstallmentsByDueMonth,
  findCardChargesBetween,
  listActiveCategorizationMemory,
  listSourceCategoryMappings,
  findImportItemClaims,
  findImportRowsByFileFingerprint,
  findTransactionsForInstrumentBetween,
  findManualExpensesBetween,
  type ImportSource as DbImportSource,
  type ConfirmImportV2Item,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  IMPORT_PREVIEW_TTL_MS,
  IMPORT_PREVIEW_VERSION,
  importPreviewSnapshotHash,
  signImportPreviewToken,
  verifyImportPreviewToken,
} from "./preview-token";
import { purchaseDescription } from "./purchase-description";
import { requestImportSuggestions } from "./suggestion-client";
import {
  findInstallmentCandidateMatches,
  hasLegacyInstallmentGroupOnCard,
  resolveInstallmentCandidatePages,
  type ExistingInstallmentCandidate,
  type InstallmentCandidateMatch,
} from "./group-duplicates";

export type { InstallmentCandidateMatch } from "./group-duplicates";

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
  "nubank-ofx": "nubank_ofx",
  "mercado-pago": "mercado_pago_pdf",
};

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 50;
const MAX_IMPORT_ROWS = 10_000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_INSTALLMENTS = 120;
const PARSER_VERSION: Record<ImportSource, string> = {
  "minhas-financas": "minhas-financas-v1",
  nubank: "nubank-v1",
  "nubank-ofx": "nubank-ofx-v1",
  "mercado-pago": "mercado-pago-v1",
};

function parseSource(value: FormDataEntryValue | null): ImportSource {
  if (
    value === "minhas-financas" ||
    value === "nubank" ||
    value === "nubank-ofx" ||
    value === "mercado-pago"
  ) {
    return value;
  }
  throw new Error("Fonte de importação inválida.");
}

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

async function authed(): Promise<{
  householdId: string;
  userId: string;
  client: ServerSupabaseClient;
}> {
  await requireAuthorizedUser();
  const { createServerSupabaseClient } = await import("../../../lib/supabase");
  const client = await createServerSupabaseClient();
  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) {
    throw new Error("Nenhuma casa ativa para o usuário atual.");
  }
  const {
    data: { user },
  } = await client.auth.getUser();
  if (user === null) throw new Error("Sessão inválida. Faça login novamente.");
  return { householdId, userId: user.id, client };
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

export type ImportPreviewSnapshot = {
  source: ImportSource;
  rows: NormalizedImportRow[];
  errors: ImportRowError[];
  identities: RowIdentity[];
  referenceMonth?: string;
  groupIdentities?: RowIdentity[];
  groupSourceRowIndices?: number[];
  installmentGroups?: InferredInstallmentGroup[];
};

export type PreviewState = {
  ok: true;
  version: typeof IMPORT_PREVIEW_VERSION;
  requestKey: string;
  previewToken: string;
  fileFingerprint: string;
  normalizedFingerprint: string;
  parserVersion: string;
  snapshot: ImportPreviewSnapshot;
  preview: ImportPreview;
  categorizationPlan: BatchCategorizationPlan;
  priorDispositions: Record<
    number,
    | "imported"
    | "duplicate_existing"
    | "duplicate_in_file"
    | "parser_error"
    | "validation_error"
    | "excluded"
  >;
  accounts: AccountOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  creditCards: CreditCardOption[];
  mp?: MpPreviewExtras;
  notices?: string[];
};

export type PreviewError = { ok: false; message: string };

const suggestionResponseSchema = z
  .object({
    version: z.literal(2),
    requestId: z.string().uuid(),
    outcome: z.enum(["success", "partial", "unavailable"]),
    providerRuns: z.array(z.unknown()).max(2),
    items: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            candidates: z
              .array(
                z
                  .object({
                    categoryId: z.string(),
                    subcategoryId: z.string().nullable(),
                    confidence: z.number().min(0).max(1),
                    explanation: z.string().max(500),
                    provider: z.enum(["codex", "paid_fallback"]),
                  })
                  .strict(),
              )
              .max(3),
            proposedTaxonomyChange: z
              .object({
                kind: z.enum(["category", "subcategory"]),
                categoryName: z.string().min(1).max(100),
                subcategoryName: z.string().max(100).nullable(),
                explanation: z.string().max(500),
                provider: z.enum(["codex", "paid_fallback"]),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(50),
    unresolvedKeys: z.array(z.string().min(1).max(200)).max(50),
  })
  .strict();

export type ImportAiSuggestion = {
  rowKey: string;
  categoryId: string;
  subcategoryId?: string;
  confidence: number;
  explanation: string;
  provider: "codex" | "paid_fallback";
};

export type SuggestImportResult =
  | {
      ok: true;
      suggestions: ImportAiSuggestion[];
      proposals: Array<{
        rowKey: string;
        categoryName: string;
        subcategoryName: string | null;
        explanation: string;
        provider: "codex" | "paid_fallback";
      }>;
      unresolvedCount: number;
      providerRuns: unknown[];
    }
  | { ok: false; message: string };

export type ResolveImportTargetsResult =
  | {
      ok: true;
      duplicateIndices: number[];
      claimIdsByIndex: Record<number, string>;
      groupDuplicateIndices: number[];
      groupClaimIdsByIndex: Record<number, string>;
      groupMatchesByIndex: Record<number, InstallmentCandidateMatch[]>;
      groupMatchCountsByIndex: Record<number, number>;
      groupReviewRequiredIndices: number[];
      flatMatchesByIndex: Record<number, FlatInstallmentMatch[]>;
    }
  | { ok: false; message: string };

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
    const { client, householdId, userId } = await authed();
    const source = parseSource(formData.get("source"));

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: "Selecione um arquivo para importar." };
    }

    const maxBytes = source === "mercado-pago" ? MAX_PDF_BYTES : MAX_CSV_BYTES;
    if (file.size > maxBytes) {
      return {
        ok: false,
        message: `Arquivo maior que ${maxBytes / 1024 / 1024} MiB. Divida-o antes de importar.`,
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileFingerprint = sha256Hex(bytes);
    const lowerName = file.name.toLowerCase();
    if (source === "mercado-pago") {
      const pdfMagic = new TextDecoder("ascii").decode(bytes.slice(0, 5));
      if (
        !lowerName.endsWith(".pdf") ||
        !["", "application/pdf"].includes(file.type) ||
        pdfMagic !== "%PDF-"
      ) {
        return { ok: false, message: "O arquivo precisa ser um PDF válido." };
      }
    } else if (source === "nubank-ofx") {
      if (
        !lowerName.endsWith(".ofx") ||
        bytes.includes(0) ||
        ![
          "",
          "application/x-ofx",
          "application/ofx",
          "application/vnd.intu.qfx",
          "application/octet-stream",
          "text/plain",
          "text/ofx",
          "application/xml",
          "text/xml",
        ].includes(file.type)
      ) {
        return {
          ok: false,
          message: "O arquivo precisa ser um OFX de texto valido.",
        };
      }
    } else if (
      !lowerName.endsWith(".csv") ||
      ![
        "",
        "text/csv",
        "text/plain",
        "application/csv",
        "application/vnd.ms-excel",
      ].includes(file.type) ||
      new TextDecoder("ascii").decode(bytes.slice(0, 5)) === "%PDF-" ||
      bytes.includes(0)
    ) {
      return {
        ok: false,
        message: "O arquivo precisa ser um CSV de texto válido.",
      };
    }

    // PRIVACY: for the PDF fatura the bytes are extracted to text in-memory and
    // dropped immediately — same transient guarantee as the CSV path.
    let fileText: string;
    if (source === "mercado-pago") {
      const { extractText } = await import("unpdf");
      const extracted = await extractText(bytes, { mergePages: true });
      if (
        typeof extracted.totalPages === "number" &&
        extracted.totalPages > MAX_PDF_PAGES
      ) {
        return {
          ok: false,
          message: `PDF com mais de ${MAX_PDF_PAGES} páginas. Divida a fatura antes de importar.`,
        };
      }
      fileText = Array.isArray(extracted.text)
        ? extracted.text.join("\n")
        : extracted.text;
    } else if (source === "nubank-ofx") {
      fileText = decodeOfx(bytes);
    } else {
      fileText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    const adapter = getImportAdapter(source);
    if (adapter === undefined) {
      return { ok: false, message: "Fonte de importação não suportada." };
    }

    const parsed = await adapter.parse(fileText);
    const { rows, errors } = parsed;
    if (rows.length + errors.length > MAX_IMPORT_ROWS) {
      return {
        ok: false,
        message: `O arquivo excede o limite de ${MAX_IMPORT_ROWS} linhas. Divida-o antes de importar.`,
      };
    }
    if (rows.some((row) => row.description.length > MAX_DESCRIPTION_LENGTH)) {
      return {
        ok: false,
        message: `Há descrições maiores que ${MAX_DESCRIPTION_LENGTH} caracteres.`,
      };
    }
    const preview = buildImportPreview({ source, rows, errors });

    // Load the household catalog so the UI can offer account + category mapping.
    const [
      accounts,
      categories,
      creditCards,
      memoryRows,
      sourceMappingRows,
      priorRows,
    ] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
      listCreditCards(client, householdId),
      listActiveCategorizationMemory(client, householdId),
      listSourceCategoryMappings(client, householdId, SOURCE_TO_DB[source]),
      findImportRowsByFileFingerprint(
        client,
        householdId,
        SOURCE_TO_DB[source],
        fileFingerprint,
      ),
    ]);
    const subLists = await Promise.all(
      categories.map((c) =>
        findSubcategoriesByCategory(client, householdId, c.id),
      ),
    );
    const subcategories = subLists.flat();

    const catalog: CategoryCatalog = {
      householdId,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
      })),
      subcategories: subcategories.map((subcategory) => ({
        id: subcategory.id,
        categoryId: subcategory.category_id,
        name: subcategory.name,
      })),
    };
    const memoryEntries: CategorizationMemoryEntry[] = memoryRows.map(
      (row) => ({
        id: row.id,
        householdId: row.household_id,
        pattern: row.pattern,
        categoryId: row.category_id,
        subcategoryId: row.subcategory_id,
        confidence: row.confidence ?? 0.95,
        explanation: row.explanation ?? "Correção confirmada anteriormente.",
        isActive: row.is_active,
        ...(row.row_kind === undefined || row.row_kind === null
          ? {}
          : { rowKind: row.row_kind }),
        ...(row.match_kind === undefined || row.match_kind === null
          ? {}
          : { matchKind: row.match_kind }),
        ...(row.normalizer_version === undefined ||
        row.normalizer_version === null
          ? {}
          : { normalizerVersion: row.normalizer_version }),
      }),
    );
    const identities = assignRowIdentities(
      rows.map((row) => ({
        source,
        row,
        providerTransactionId: row.providerTransactionId,
        sourceMetadata:
          source === "mercado-pago"
            ? { statementReferenceMonth: parsed.statement?.referenceMonth }
            : undefined,
      })),
    );
    const normalizedFingerprint = normalizedRowsFingerprint(identities);
    const sourceMappings: SourceCategoryMapping[] = sourceMappingRows.map(
      (row) => ({
        id: row.id,
        householdId: row.household_id,
        source,
        sourceLabel: row.normalized_label,
        normalizedSourceLabel: row.normalized_label,
        rowKind: row.row_kind,
        categoryId: row.category_id,
        subcategoryId: row.subcategory_id,
        suppress: row.suppress,
        isActive: row.is_active,
      }),
    );
    const categorizationPlan = planCategorizationBatch(
      rows.map((row, index) => ({
        rowKey: `${identities[index]?.baseIdentityHash}:${identities[index]?.occurrenceNo}`,
        householdId,
        description: row.description,
        kind: row.kind,
        amountCents: row.amount.cents,
        occurredOn: row.occurredOn,
        source,
        sourceCategory: row.sourceCategory,
      })),
      { catalog, memoryEntries, sourceMappings, rulesVersion: "default-v1" },
    );

    let mp: MpPreviewExtras | undefined;
    let groupIdentities: RowIdentity[] | undefined;
    let groupSourceRowIndices: number[] | undefined;
    let installmentGroups: InferredInstallmentGroup[] | undefined;
    if (source === "mercado-pago" || source === "nubank-ofx") {
      const referenceMonth = parsed.statement?.referenceMonth;
      if (referenceMonth === undefined) {
        return {
          ok: false,
          message:
            "Não foi possível identificar o mês de referência da fatura.",
        };
      }
      const { flatRowIndices, groups } = splitFlatAndInstallmentRows(
        rows,
        referenceMonth,
      );
      installmentGroups = groups;
      const installmentRowIndices = rows
        .map((_, i) => i)
        .filter((i) => !flatRowIndices.includes(i));

      const groupPreviews: InferredGroupPreview[] = groups.map((g) => ({
        ...g,
        // Exact group dedupe depends on the selected target card and is resolved
        // by resolveImportTargets after destination mapping.
        status: "new",
      }));
      groupIdentities = assignInstallmentGroupIdentities(
        groups.map((group) => ({
          source,
          description: group.description,
          installmentCount: group.installmentCount,
          purchasedOn: group.purchasedOn,
          cardLast4: group.cardLast4,
        })),
      );
      const usedGroupRows = new Set<number>();
      groupSourceRowIndices = groups.map((group) => {
        const index = rows.findIndex(
          (row, rowIndex) =>
            !usedGroupRows.has(rowIndex) &&
            row.installment?.count === group.installmentCount &&
            normalizeDescription(row.description).toLowerCase() ===
              normalizeDescription(group.description).toLowerCase() &&
            (group.cardLast4 === undefined ||
              row.cardLast4 === group.cardLast4),
        );
        if (index >= 0) usedGroupRows.add(index);
        return index;
      });

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
        // amount_cents is stored as a positive magnitude (CHECK > 0), so abs()
        // here is defensive — both sides of this key are positive magnitudes.
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

    const snapshot: ImportPreviewSnapshot = {
      source,
      rows,
      errors,
      identities,
      ...(groupIdentities === undefined ? {} : { groupIdentities }),
      ...(groupSourceRowIndices === undefined ? {} : { groupSourceRowIndices }),
      ...(installmentGroups === undefined ? {} : { installmentGroups }),
      ...(parsed.statement?.referenceMonth === undefined
        ? {}
        : { referenceMonth: parsed.statement.referenceMonth }),
    };
    const requestKey = crypto.randomUUID();
    const parserVersion = PARSER_VERSION[source];
    const now = Date.now();
    const previewToken = signImportPreviewToken(
      {
        version: IMPORT_PREVIEW_VERSION,
        requestKey,
        householdId,
        userId,
        issuedAt: now,
        expiresAt: now + IMPORT_PREVIEW_TTL_MS,
        source,
        fileFingerprint,
        normalizedFingerprint,
        parserVersion,
        snapshotHash: importPreviewSnapshotHash(snapshot),
      },
      getServerEnv().IMPORT_PREVIEW_SIGNING_SECRET ?? "",
    );
    const priorDispositions: PreviewState["priorDispositions"] = {};
    for (const row of priorRows) {
      if (
        row.source_line !== null &&
        row.disposition !== null &&
        priorDispositions[row.source_line] === undefined
      ) {
        priorDispositions[row.source_line] = row.disposition;
      }
    }

    return {
      ok: true,
      version: IMPORT_PREVIEW_VERSION,
      requestKey,
      previewToken,
      fileFingerprint,
      normalizedFingerprint,
      parserVersion,
      snapshot,
      preview,
      categorizationPlan,
      priorDispositions,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      subcategories: subcategories.map((s) => ({
        id: s.id,
        categoryId: s.category_id,
        name: s.name,
      })),
      creditCards: creditCards.map((c) => ({ id: c.id, name: c.name })),
      mp,
      notices: parsed.notices,
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

/** Refresh exact persisted duplicates whenever a destination mapping changes. */
export async function resolveImportTargets(input: {
  previewToken: string;
  snapshot: ImportPreviewSnapshot;
  accountId?: string;
  creditCardId?: string;
  creditCardByLast4?: Record<string, string>;
  matchPage?: { groupIndex: number; offset: number };
}): Promise<ResolveImportTargetsResult> {
  try {
    if (
      input.matchPage !== undefined &&
      (!Number.isInteger(input.matchPage.groupIndex) ||
        input.matchPage.groupIndex < 0 ||
        input.matchPage.groupIndex >=
          (input.snapshot.installmentGroups?.length ?? 0) ||
        !Number.isInteger(input.matchPage.offset) ||
        input.matchPage.offset < 0)
    )
      return { ok: false, message: "Página de correspondências inválida." };
    const { client, householdId, userId } = await authed();
    const previewClaims = verifyImportPreviewToken({
      token: input.previewToken,
      secret: getServerEnv().IMPORT_PREVIEW_SIGNING_SECRET ?? "",
      snapshot: input.snapshot,
    });
    if (
      previewClaims.householdId !== householdId ||
      previewClaims.userId !== userId
    ) {
      return {
        ok: false,
        message: "Este preview pertence a outra sessão ou casa.",
      };
    }
    const [accounts, cards] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      listCreditCards(client, householdId),
    ]);
    const accountIds = new Set(accounts.map((account) => account.id));
    const cardIds = new Set(cards.map((card) => card.id));
    const claims = input.snapshot.identities.map((identity, index) => {
      const row = input.snapshot.rows[index];
      const cardId =
        row?.cardLast4 === undefined
          ? input.creditCardId
          : input.creditCardByLast4?.[row.cardLast4];
      if (
        input.snapshot.source === "mercado-pago" ||
        input.snapshot.source === "nubank-ofx"
      ) {
        return cardId !== undefined && cardIds.has(cardId)
          ? claimIdentity(identity, { type: "credit_card", id: cardId })
          : null;
      }
      return input.accountId !== undefined && accountIds.has(input.accountId)
        ? claimIdentity(identity, { type: "account", id: input.accountId })
        : null;
    });
    const groupClaims = (input.snapshot.groupIdentities ?? []).map(
      (identity, groupIndex) => {
        const rowIndex = input.snapshot.groupSourceRowIndices?.[groupIndex];
        const row =
          rowIndex === undefined ? undefined : input.snapshot.rows[rowIndex];
        const cardId =
          row?.cardLast4 === undefined
            ? input.creditCardId
            : input.creditCardByLast4?.[row.cardLast4];
        return cardId !== undefined && cardIds.has(cardId)
          ? claimIdentity(identity, { type: "credit_card", id: cardId })
          : null;
      },
    );
    const persisted = await findImportItemClaims(
      client,
      householdId,
      SOURCE_TO_DB[input.snapshot.source],
      1,
      [...claims, ...groupClaims].flatMap((claim) =>
        claim === null ? [] : [claim.claimFingerprint],
      ),
    );
    const exact = new Set(
      persisted.map(
        (claim) => `${claim.base_fingerprint}:${claim.occurrence_no}`,
      ),
    );
    const claimIdByIdentity = new Map(
      persisted.map((claim) => [
        `${claim.base_fingerprint}:${claim.occurrence_no}`,
        claim.id,
      ]),
    );
    const dates = input.snapshot.rows.map((row) => row.occurredOn).sort();
    const firstDate = dates[0];
    const lastDate = dates.at(-1);
    const legacyKeys = new Set<string>();
    if (firstDate !== undefined && lastDate !== undefined) {
      const instruments = new Map<
        string,
        { type: "account" | "credit_card"; id: string }
      >();
      claims.forEach((claim) => {
        if (claim !== null)
          instruments.set(
            `${claim.target.type}:${claim.target.id}`,
            claim.target,
          );
      });
      const legacyRows = (
        await Promise.all(
          [...instruments.values()].map((instrument) =>
            findTransactionsForInstrumentBetween(
              client,
              householdId,
              instrument,
              firstDate,
              lastDate,
            ),
          ),
        )
      ).flat();
      for (const row of legacyRows) {
        legacyKeys.add(
          `${row.occurred_on}|${row.kind}|${Math.abs(row.amount_cents)}|${normalizeDescription(row.description).toLowerCase()}|${row.account_id ?? row.credit_card_id ?? ""}`,
        );
      }
    }
    const duplicateIndices: number[] = [];
    const claimIdsByIndex: Record<number, string> = {};
    claims.forEach((claim, index) => {
      if (claim === null) return;
      const row = input.snapshot.rows[index];
      const identityKey = `${claim.claimFingerprint}:${claim.occurrenceNo}`;
      const claimId = claimIdByIdentity.get(identityKey);
      const legacyKey =
        row === undefined
          ? ""
          : `${row.occurredOn}|${row.kind}|${row.amount.cents}|${normalizeDescription(row.description).toLowerCase()}|${claim.target.id}`;
      if (exact.has(identityKey) || legacyKeys.has(legacyKey))
        duplicateIndices.push(index);
      if (claimId !== undefined) claimIdsByIndex[index] = claimId;
    });
    const groupDuplicateIndices: number[] = [];
    const groupClaimIdsByIndex: Record<number, string> = {};
    let groupMatchesByIndex: Record<number, InstallmentCandidateMatch[]> = {};
    let groupMatchCountsByIndex: Record<number, number> = {};
    const groupReviewRequiredIndices: number[] = [];
    const flatMatchesByIndex: Record<number, FlatInstallmentMatch[]> = {};
    groupClaims.forEach((claim, index) => {
      if (claim === null) return;
      const identityKey = `${claim.claimFingerprint}:${claim.occurrenceNo}`;
      const claimId = claimIdByIdentity.get(identityKey);
      if (exact.has(identityKey)) groupDuplicateIndices.push(index);
      if (claimId !== undefined) groupClaimIdsByIndex[index] = claimId;
    });
    if ((input.snapshot.installmentGroups?.length ?? 0) > 0) {
      const purchaseDates = input.snapshot
        .installmentGroups!.map((g) => g.purchasedOn)
        .sort();
      const lastMonth = purchaseDates.at(-1)!.slice(0, 7);
      const lastDay = new Date(
        Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0),
      )
        .toISOString()
        .slice(0, 10);
      const manualExpenses = await findManualExpensesBetween(
        client,
        householdId,
        `${purchaseDates[0]!.slice(0, 7)}-01`,
        lastDay,
      );
      const instrumentNames = new Map(
        [...cards, ...accounts].map((instrument) => [
          instrument.id,
          instrument.name,
        ]),
      );
      const [legacyGroups, existingInstallments] = await Promise.all([
        listInstallmentGroupsByHousehold(client, householdId),
        listInstallmentsByDueMonth(
          client,
          householdId,
          input.snapshot.referenceMonth as string,
        ),
      ]);
      const legacySummaries = legacyGroups.map((candidate) => ({
        creditCardId: candidate.credit_card_id,
        description: candidate.description,
        installmentCount: candidate.installment_count,
        purchasedOn: candidate.purchased_on,
      }));
      const groupById = new Map(
        legacyGroups.map((candidate) => [candidate.id, candidate]),
      );
      const cardNameById = new Map(cards.map((card) => [card.id, card.name]));
      const matchCandidates = existingInstallments.flatMap(
        (installment): ExistingInstallmentCandidate[] => {
          const existingGroup = groupById.get(installment.installment_group_id);
          if (existingGroup === undefined) return [];
          return [
            {
              installmentGroupId: existingGroup.id,
              creditCardId: installment.credit_card_id,
              cardName:
                cardNameById.get(installment.credit_card_id) ?? "Cartão",
              description: existingGroup.description,
              purchaseDescription: existingGroup.purchase_description ?? null,
              categoryId: existingGroup.category_id,
              subcategoryId: existingGroup.subcategory_id,
              totalAmountCents: existingGroup.total_amount_cents,
              purchasedOn: existingGroup.purchased_on,
              installmentNumber: installment.number,
              installmentCount: installment.installment_count,
              amountCents: installment.amount_cents,
            },
          ];
        },
      );
      const resolved = resolveInstallmentCandidatePages(
        (input.snapshot.installmentGroups ?? []).map((group, index) => {
          const rowIndex = input.snapshot.groupSourceRowIndices?.[index];
          const row =
            rowIndex === undefined ? undefined : input.snapshot.rows[rowIndex];
          const cardId =
            row?.cardLast4 === undefined
              ? input.creditCardId
              : input.creditCardByLast4?.[row.cardLast4];
          if (cardId !== undefined && cardIds.has(cardId)) {
            const matches = findFlatInstallmentMatches(
              { ...group, totalAmountCents: group.estimatedTotalCents },
              cardId,
              manualExpenses,
              instrumentNames,
            );
            if (matches.length > 0) {
              flatMatchesByIndex[index] = matches;
              groupReviewRequiredIndices.push(index);
            }
          }
          if (
            cardId !== undefined &&
            cardIds.has(cardId) &&
            hasLegacyInstallmentGroupOnCard(group, cardId, legacySummaries)
          ) {
            groupReviewRequiredIndices.push(index);
          }
          return {
            group,
            cardId:
              cardId !== undefined && cardIds.has(cardId) ? cardId : undefined,
          };
        }),
        matchCandidates,
        input.matchPage,
      );
      groupMatchesByIndex = resolved.matchesByIndex;
      groupMatchCountsByIndex = resolved.matchCountsByIndex;
      for (const index of Object.keys(groupMatchCountsByIndex).map(Number)) {
        if (!groupReviewRequiredIndices.includes(index))
          groupReviewRequiredIndices.push(index);
      }
      for (const index of resolved.duplicateIndices) {
        if (!groupDuplicateIndices.includes(index))
          groupDuplicateIndices.push(index);
      }
    }
    return {
      ok: true,
      duplicateIndices,
      claimIdsByIndex,
      groupDuplicateIndices,
      groupClaimIdsByIndex,
      groupMatchesByIndex,
      groupMatchCountsByIndex,
      groupReviewRequiredIndices,
      flatMatchesByIndex,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível atualizar duplicatas.",
    };
  }
}

/** Best-effort AI enrichment. A failure never invalidates or blocks the preview. */
export async function suggestImportCategories(input: {
  previewToken: string;
  snapshot: ImportPreviewSnapshot;
}): Promise<SuggestImportResult> {
  try {
    const { client, householdId, userId } = await authed();
    const env = getServerEnv();
    const secret = env.IMPORT_PREVIEW_SIGNING_SECRET ?? "";
    const previewClaims = verifyImportPreviewToken({
      token: input.previewToken,
      secret,
      snapshot: input.snapshot,
    });
    if (
      previewClaims.householdId !== householdId ||
      previewClaims.userId !== userId
    ) {
      return {
        ok: false,
        message: "Este preview pertence a outra sessão ou casa.",
      };
    }
    if (
      env.IMPORT_SUGGESTION_URL === undefined ||
      env.IMPORT_SUGGESTION_SHARED_SECRET === undefined
    ) {
      return {
        ok: false,
        message: "Sugestões por Codex não estão configuradas.",
      };
    }
    const [categories, memoryRows, sourceMappingRows] = await Promise.all([
      findCategoriesByHousehold(client, householdId),
      listActiveCategorizationMemory(client, householdId),
      listSourceCategoryMappings(
        client,
        householdId,
        SOURCE_TO_DB[input.snapshot.source],
      ),
    ]);
    const subcategories = (
      await Promise.all(
        categories.map((category) =>
          findSubcategoriesByCategory(client, householdId, category.id),
        ),
      )
    ).flat();
    const catalog: CategoryCatalog = {
      householdId,
      categories: categories.map(({ id, name }) => ({ id, name })),
      subcategories: subcategories.map((item) => ({
        id: item.id,
        categoryId: item.category_id,
        name: item.name,
      })),
    };
    const memoryEntries: CategorizationMemoryEntry[] = memoryRows.map(
      (row) => ({
        id: row.id,
        householdId: row.household_id,
        pattern: row.pattern,
        categoryId: row.category_id,
        subcategoryId: row.subcategory_id,
        confidence: row.confidence ?? 0.95,
        explanation: row.explanation ?? "Correção confirmada anteriormente.",
        isActive: row.is_active,
        ...(row.row_kind == null ? {} : { rowKind: row.row_kind }),
        ...(row.match_kind == null ? {} : { matchKind: row.match_kind }),
        ...(row.normalizer_version == null
          ? {}
          : { normalizerVersion: row.normalizer_version }),
      }),
    );
    const plan = planCategorizationBatch(
      input.snapshot.rows.map((row, index) => ({
        rowKey: `${input.snapshot.identities[index]?.baseIdentityHash}:${input.snapshot.identities[index]?.occurrenceNo}`,
        householdId,
        description: row.description,
        kind: row.kind,
        amountCents: row.amount.cents,
        occurredOn: row.occurredOn,
        source: input.snapshot.source,
        sourceCategory: row.sourceCategory,
      })),
      {
        catalog,
        memoryEntries,
        sourceMappings: sourceMappingRows.map((row) => ({
          id: row.id,
          householdId: row.household_id,
          source: input.snapshot.source,
          sourceLabel: row.normalized_label,
          normalizedSourceLabel: row.normalized_label,
          rowKind: row.row_kind,
          categoryId: row.category_id,
          subcategoryId: row.subcategory_id,
          suppress: row.suppress,
          isActive: row.is_active,
        })),
        rulesVersion: "default-v1",
      },
    );
    if (plan.aiItems.length === 0) {
      return {
        ok: true,
        suggestions: [],
        proposals: [],
        unresolvedCount: 0,
        providerRuns: [],
      };
    }
    const responses: z.infer<typeof suggestionResponseSchema>[] = [];
    let failedUnresolvedCount = 0;
    for (const chunk of chunkAiSuggestionItems(plan.aiItems)) {
      try {
        const raw = await requestImportSuggestions({
          baseUrl: env.IMPORT_SUGGESTION_URL as string,
          secret: env.IMPORT_SUGGESTION_SHARED_SECRET as string,
          body: {
            version: 2,
            requestId: crypto.randomUUID(),
            scopeKey: householdId,
            budgetKey: previewClaims.requestKey,
            actorUserId: userId,
            catalog: {
              categories: catalog.categories,
              subcategories: catalog.subcategories,
            },
            items: chunk.map((item) => ({
              key: item.requestKey,
              description: item.description,
              amountCents: item.amountCents ?? 1,
              occurredOn: item.occurredOn ?? currentHouseholdDate(),
              merchantKey: item.merchantKey || undefined,
            })),
          },
        });
        responses.push(suggestionResponseSchema.parse(raw));
      } catch {
        // Preserve successful chunks. Suggestions are best-effort and must not
        // turn saturation or one malformed response into an all-or-nothing UI.
        failedUnresolvedCount += chunk.length;
      }
    }
    const rowsByRequest = new Map<string, string[]>();
    for (const row of plan.rows) {
      if (row.aiRequestKey === undefined) continue;
      const list = rowsByRequest.get(row.aiRequestKey) ?? [];
      list.push(row.rowKey);
      rowsByRequest.set(row.aiRequestKey, list);
    }
    const suggestions: ImportAiSuggestion[] = [];
    const proposals: Extract<SuggestImportResult, { ok: true }>["proposals"] =
      [];
    for (const item of responses.flatMap((response) => response.items)) {
      for (const rowKey of rowsByRequest.get(item.key) ?? []) {
        const best = item.candidates[0];
        if (best !== undefined) {
          suggestions.push({
            rowKey,
            categoryId: best.categoryId,
            ...(best.subcategoryId === null
              ? {}
              : { subcategoryId: best.subcategoryId }),
            confidence: best.confidence,
            explanation: best.explanation,
            provider: best.provider,
          });
        }
        if (item.proposedTaxonomyChange !== null) {
          proposals.push({
            rowKey,
            categoryName: item.proposedTaxonomyChange.categoryName,
            subcategoryName: item.proposedTaxonomyChange.subcategoryName,
            explanation: item.proposedTaxonomyChange.explanation,
            provider: item.proposedTaxonomyChange.provider,
          });
        }
      }
    }
    return {
      ok: true,
      suggestions,
      proposals,
      unresolvedCount: responses.reduce(
        (total, response) => total + response.unresolvedKeys.length,
        failedUnresolvedCount,
      ),
      providerRuns: responses.flatMap((response) => response.providerRuns),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Sugestões indisponíveis. A importação manual continua funcionando.",
    };
  }
}

export type ConfirmGroupInput = {
  purchaseDescription?: string;
  existingGroupId?: string;
  replaceTransaction?: { id: string; updatedAt: string };
  sourceGroupIndex: number;
  description: string;
  totalAmountCents: number;
  installmentCount: number;
  purchasedOn: string; // ISO YYYY-MM-DD (user-edited)
  categoryId?: string;
  subcategoryId?: string;
  creditCardId: string;
  cardLast4?: string;
  override?: { token?: string; claimId?: string; reason: string };
};

export type ConfirmInput = {
  previewToken: string;
  snapshot: ImportPreviewSnapshot;
  requestKey: string;
  fileFingerprint: string;
  normalizedFingerprint: string;
  parserVersion: string;
  source: ImportSource;
  /** Target account every imported transaction is booked against (CSV sources). */
  accountId?: string;
  /** Target credit card for Mercado Pago fatura charges (required when source is "mercado-pago"). */
  creditCardId?: string;
  creditCardByLast4?: Record<string, string>;
  /** Kept inferred installment groups from the MP preview (source is "mercado-pago" only). */
  groups?: ConfirmGroupInput[];
  /** rowIndex -> chosen category/subcategory (optional; may be uncategorized). */
  mapping: Record<number, { categoryId?: string; subcategoryId?: string }>;
  /** Indices (into rows) the user chose to import (duplicates excluded by UI). */
  selectedIndices: number[];
  /** Optional minimal note (e.g. original filename) — never the file bytes. */
  notes?: string;
  /** Explicit teaching choices; off by default in the UI. */
  learning?: Record<
    number,
    { sourceCategory?: boolean; merchant?: boolean; suppress?: boolean }
  >;
  edits?: Record<
    number,
    {
      occurredOn?: string;
      description?: string;
      amountCents?: number;
      kind?: "expense" | "income";
    }
  >;
  overrides?: Record<
    number,
    { token?: string; claimId?: string; reason: string }
  >;
  provenance?: Record<
    number,
    {
      source:
        | "memory"
        | "source_mapping"
        | "rule"
        | "codex"
        | "paid_fallback"
        | "user";
      confidence?: number;
      accepted: boolean;
      changed: boolean;
    }
  >;
};

export type ConfirmResult = {
  ok: boolean;
  message: string;
  importedRows?: number;
  duplicateRows?: number;
  errorRows?: number;
  excludedRows?: number;
  batchId?: string;
  replayed?: boolean;
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
export async function confirmImport(
  input: ConfirmInput,
): Promise<ConfirmResult> {
  try {
    const { client, householdId, userId } = await authed();
    const env = getServerEnv();
    const claims = verifyImportPreviewToken({
      token: input.previewToken,
      secret: env.IMPORT_PREVIEW_SIGNING_SECRET ?? "",
      snapshot: input.snapshot,
    });
    if (
      claims.requestKey !== input.requestKey ||
      claims.source !== input.source ||
      claims.fileFingerprint !== input.fileFingerprint ||
      claims.normalizedFingerprint !== input.normalizedFingerprint ||
      claims.parserVersion !== input.parserVersion ||
      input.snapshot.source !== input.source ||
      claims.householdId !== householdId ||
      claims.userId !== userId ||
      normalizedRowsFingerprint(input.snapshot.identities) !==
        input.normalizedFingerprint
    ) {
      return {
        ok: false,
        message: "O preview mudou. Envie o arquivo novamente.",
      };
    }
    const isMp =
      input.source === "mercado-pago" || input.source === "nubank-ofx";
    const createdByUserId = userId;
    const [accounts, cards, categories] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      listCreditCards(client, householdId),
      findCategoriesByHousehold(client, householdId),
    ]);
    const accountIds = new Set(accounts.map((account) => account.id));
    const cardById = new Map(cards.map((card) => [card.id, card]));
    if (
      !isMp &&
      (input.accountId === undefined || !accountIds.has(input.accountId))
    ) {
      return { ok: false, message: "Escolha uma conta de destino ativa." };
    }
    const targetCardFor = (last4?: string): string | undefined =>
      (last4 === undefined ? undefined : input.creditCardByLast4?.[last4]) ??
      input.creditCardId;
    if (
      isMp &&
      input.snapshot.rows.some((row) => {
        const target = targetCardFor(row.cardLast4);
        return target === undefined || !cardById.has(target);
      })
    ) {
      return {
        ok: false,
        message: "Mapeie cada final de cartão para um cartão ativo.",
      };
    }
    const subcategories = (
      await Promise.all(
        categories.map((category) =>
          findSubcategoriesByCategory(client, householdId, category.id),
        ),
      )
    ).flat();
    const categoryIds = new Set(categories.map((category) => category.id));
    const subcategoryParent = new Map(
      subcategories.map((subcategory) => [
        subcategory.id,
        subcategory.category_id,
      ]),
    );
    const validCategory = (
      categoryId?: string,
      subcategoryId?: string,
    ): boolean =>
      (categoryId === undefined && subcategoryId === undefined) ||
      (categoryId !== undefined &&
        categoryIds.has(categoryId) &&
        (subcategoryId === undefined ||
          subcategoryParent.get(subcategoryId) === categoryId));

    const selected = new Set(
      input.selectedIndices.filter(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < input.snapshot.rows.length,
      ),
    );
    if (selected.size !== new Set(input.selectedIndices).size) {
      return { ok: false, message: "Seleção de linhas inválida." };
    }
    const editedRow = (
      row: NormalizedImportRow,
      index: number,
    ): NormalizedImportRow => {
      const edit = input.edits?.[index];
      if (edit === undefined) return row;
      const description = edit.description?.trim() ?? row.description;
      const occurredOn = edit.occurredOn ?? row.occurredOn;
      const amountCents = edit.amountCents ?? row.amount.cents;
      const kind = edit.kind ?? row.kind;
      if (
        description.length < 1 ||
        description.length > MAX_DESCRIPTION_LENGTH ||
        !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) ||
        !Number.isSafeInteger(amountCents) ||
        amountCents <= 0
      ) {
        throw new Error(`Edição inválida na linha ${row.sourceLine}.`);
      }
      return {
        ...row,
        description,
        occurredOn,
        amount: brl(amountCents),
        kind,
      };
    };
    const duplicateIndices = new Set(
      buildImportPreview({
        source: input.source,
        rows: input.snapshot.rows,
        errors: input.snapshot.errors,
      }).duplicates.map((duplicate) => duplicate.rowIndex),
    );
    const legacyDuplicateIndices = new Set<number>();
    const confirmationDates = input.snapshot.rows
      .map((row) => row.occurredOn)
      .sort();
    const confirmationFirst = confirmationDates[0];
    const confirmationLast = confirmationDates.at(-1);
    if (confirmationFirst !== undefined && confirmationLast !== undefined) {
      const instruments = new Map<
        string,
        { type: "account" | "credit_card"; id: string }
      >();
      input.snapshot.rows.forEach((row) => {
        const instrument = isMp
          ? ({
              type: "credit_card",
              id: targetCardFor(row.cardLast4) as string,
            } as const)
          : ({ type: "account", id: input.accountId as string } as const);
        instruments.set(`${instrument.type}:${instrument.id}`, instrument);
      });
      const existing = (
        await Promise.all(
          [...instruments.values()].map((instrument) =>
            findTransactionsForInstrumentBetween(
              client,
              householdId,
              instrument,
              confirmationFirst,
              confirmationLast,
            ),
          ),
        )
      ).flat();
      const existingKeys = new Set(
        existing.map(
          (row) =>
            `${row.occurred_on}|${row.kind}|${Math.abs(row.amount_cents)}|${normalizeDescription(row.description).toLowerCase()}|${row.account_id ?? row.credit_card_id ?? ""}`,
        ),
      );
      input.snapshot.rows.forEach((row, index) => {
        const targetId = isMp ? targetCardFor(row.cardLast4) : input.accountId;
        const key = `${row.occurredOn}|${row.kind}|${row.amount.cents}|${normalizeDescription(row.description).toLowerCase()}|${targetId ?? ""}`;
        if (existingKeys.has(key)) legacyDuplicateIndices.add(index);
      });
    }
    const groupRowIndices = new Set<number>();
    const items: ConfirmImportV2Item[] = [];
    const errors: string[] = [];
    const [legacyGroupRows, existingInstallments] = isMp
      ? await Promise.all([
          listInstallmentGroupsByHousehold(client, householdId),
          listInstallmentsByDueMonth(
            client,
            householdId,
            input.snapshot.referenceMonth as string,
          ),
        ])
      : [[], []];
    const legacyInstallmentGroups = legacyGroupRows.map((candidate) => ({
      creditCardId: candidate.credit_card_id,
      description: candidate.description,
      installmentCount: candidate.installment_count,
      purchasedOn: candidate.purchased_on,
    }));
    const legacyGroupById = new Map(
      legacyGroupRows.map((candidate) => [candidate.id, candidate]),
    );
    const existingMatchCandidates = existingInstallments.flatMap(
      (installment): ExistingInstallmentCandidate[] => {
        const existingGroup = legacyGroupById.get(
          installment.installment_group_id,
        );
        if (existingGroup === undefined) return [];
        return [
          {
            installmentGroupId: existingGroup.id,
            creditCardId: installment.credit_card_id,
            cardName:
              cardById.get(installment.credit_card_id)?.name ?? "Cartão",
            description: existingGroup.description,
            purchaseDescription: existingGroup.purchase_description ?? null,
            categoryId: existingGroup.category_id,
            subcategoryId: existingGroup.subcategory_id,
            totalAmountCents: existingGroup.total_amount_cents,
            purchasedOn: existingGroup.purchased_on,
            installmentNumber: installment.number,
            installmentCount: installment.installment_count,
            amountCents: installment.amount_cents,
          },
        ];
      },
    );

    const confirmationGroups = input.groups ?? [];
    const flatDates = confirmationGroups
      .map((group) => group.purchasedOn)
      .sort();
    const finalMonth = flatDates.at(-1)?.slice(0, 7);
    const flatExpenses =
      finalMonth === undefined
        ? []
        : await findManualExpensesBetween(
            client,
            householdId,
            `${flatDates[0]!.slice(0, 7)}-01`,
            new Date(
              Date.UTC(
                Number(finalMonth.slice(0, 4)),
                Number(finalMonth.slice(5)),
                0,
              ),
            )
              .toISOString()
              .slice(0, 10),
          );
    const linkedGroupIds = new Set<string>();
    const replacementIds = new Set<string>();
    for (const group of confirmationGroups) {
      const flatMatches = findFlatInstallmentMatches(
        group,
        group.creditCardId,
        flatExpenses,
      );
      if (group.replaceTransaction !== undefined) {
        if (replacementIds.has(group.replaceTransaction.id)) {
          return {
            ok: false,
            message:
              "Um lançamento não pode substituir duas compras. Revise as correspondências.",
          };
        }
        replacementIds.add(group.replaceTransaction.id);
        // The RPC rechecks the locked original and handles an already-completed retry.
        if (
          flatExpenses.some((tx) => tx.id === group.replaceTransaction!.id) &&
          !flatMatches.some(
            (match) =>
              match.transactionId === group.replaceTransaction!.id &&
              match.updatedAt === group.replaceTransaction!.updatedAt,
          )
        ) {
          return {
            ok: false,
            message:
              "O lançamento ou o parcelamento mudou. Atualize as comparações antes de substituir.",
          };
        }
      } else if (
        group.existingGroupId === undefined &&
        flatMatches.length > 0 &&
        (group.override?.reason.trim().length ?? 0) < 5
      ) {
        return {
          ok: false,
          message:
            "Existe uma despesa única correspondente. Escolha manter, substituir ou justifique importar novamente.",
        };
      }
      if (
        !Number.isInteger(group.installmentCount) ||
        group.installmentCount < 1 ||
        group.installmentCount > MAX_INSTALLMENTS
      ) {
        return {
          ok: false,
          message: `Parcelamentos devem ter entre 1 e ${MAX_INSTALLMENTS} parcelas.`,
        };
      }
      if (!isMp || !cardById.has(group.creditCardId)) {
        return {
          ok: false,
          message: "Parcelamento com cartão de destino inválido.",
        };
      }
      if (!validCategory(group.categoryId, group.subcategoryId)) {
        return { ok: false, message: "Categoria inválida em um parcelamento." };
      }
      const rowIndex =
        input.snapshot.groupSourceRowIndices?.[group.sourceGroupIndex] ?? -1;
      const identity = input.snapshot.identities[rowIndex];
      const sourceRow = input.snapshot.rows[rowIndex];
      const inferredGroup =
        input.snapshot.installmentGroups?.[group.sourceGroupIndex];
      if (
        rowIndex < 0 ||
        groupRowIndices.has(rowIndex) ||
        identity === undefined ||
        sourceRow === undefined
      ) {
        return {
          ok: false,
          message: `Não foi possível vincular ${group.description} à fatura.`,
        };
      }
      if (
        inferredGroup === undefined ||
        group.description !== inferredGroup.description
      ) {
        return {
          ok: false,
          message: "O nome original do banco não pode ser alterado.",
        };
      }
      if (
        group.purchaseDescription !== undefined &&
        (typeof group.purchaseDescription !== "string" ||
          group.purchaseDescription.trim().length > MAX_DESCRIPTION_LENGTH)
      ) {
        return {
          ok: false,
          message: "A descrição da compra deve ter até 200 caracteres.",
        };
      }
      const existingGroup =
        group.existingGroupId === undefined
          ? undefined
          : legacyGroupById.get(group.existingGroupId);
      if (group.existingGroupId !== undefined) {
        const match = findInstallmentCandidateMatches(
          inferredGroup,
          group.creditCardId,
          existingMatchCandidates,
        ).find(
          (candidate) => candidate.installmentGroupId === group.existingGroupId,
        );
        if (
          !existingGroup ||
          !match ||
          linkedGroupIds.has(existingGroup.id) ||
          group.override !== undefined ||
          group.replaceTransaction !== undefined ||
          existingGroup.credit_card_id !== group.creditCardId ||
          existingGroup.installment_count !== inferredGroup.installmentCount
        ) {
          return {
            ok: false,
            message:
              "A correspondência mudou ou não pertence a este cartão. Revise o parcelamento.",
          };
        }
        linkedGroupIds.add(existingGroup.id);
      }
      const label = purchaseDescription(
        inferredGroup.description,
        group.purchaseDescription ??
          existingGroup?.purchase_description ??
          flatExpenses.find(
            (transaction) => transaction.id === group.replaceTransaction?.id,
          )?.description ??
          existingGroup?.description,
      );
      if (
        existingGroup === undefined &&
        inferredGroup !== undefined &&
        (hasLegacyInstallmentGroupOnCard(
          inferredGroup,
          group.creditCardId,
          legacyInstallmentGroups,
        ) ||
          findInstallmentCandidateMatches(
            inferredGroup,
            group.creditCardId,
            existingMatchCandidates,
          ).length > 0) &&
        group.replaceTransaction === undefined &&
        (group.override?.reason.trim().length ?? 0) < 5
      ) {
        return {
          ok: false,
          message:
            "Encontramos um parcelamento correspondente. Compare os dados e informe o motivo para importar novamente.",
        };
      }
      groupRowIndices.add(rowIndex);
      const card = cardById.get(group.creditCardId);
      const closingDay =
        card?.closing_day != null && card.closing_day <= 28
          ? card.closing_day
          : undefined;
      const plan = createInstallmentPlan({
        householdId,
        creditCardId: group.creditCardId,
        description: group.description,
        totalAmount: brl(group.totalAmountCents),
        installmentCount: group.installmentCount,
        purchasedOn: group.purchasedOn,
        createdByUserId,
        closingDay,
        category:
          group.categoryId === undefined
            ? undefined
            : {
                categoryId: group.categoryId,
                subcategoryId: group.subcategoryId,
              },
      });
      if (!plan.ok) {
        if (group.replaceTransaction !== undefined) {
          return {
            ok: false,
            message: `Substituição cancelada: ${plan.errors.map((error) => error.message).join("; ")}`,
          };
        }
        errors.push(
          `${group.description}: ${plan.errors.map((error) => error.message).join("; ")}`,
        );
        items.push({
          household_id: householdId,
          disposition: "validation_error",
          source_line: sourceRow.sourceLine,
          error_message: plan.errors.map((error) => error.message).join("; "),
          description: sourceRow.description,
          occurred_on: sourceRow.occurredOn,
          amount_cents: -sourceRow.amount.cents,
          observed_installment_number: sourceRow.installment?.number,
          observed_installment_count: sourceRow.installment?.count,
          card_last4: sourceRow.cardLast4,
        });
        continue;
      }
      const groupIdentity =
        input.snapshot.groupIdentities?.[group.sourceGroupIndex];
      if (groupIdentity === undefined) {
        return { ok: false, message: "Identidade de parcelamento inválida." };
      }
      const claim = claimIdentity(groupIdentity, {
        type: "credit_card",
        id: group.creditCardId,
      });
      items.push({
        household_id: householdId,
        disposition: "imported",
        source_line: sourceRow.sourceLine,
        occurred_on: sourceRow.occurredOn,
        amount_cents: -sourceRow.amount.cents,
        description: sourceRow.description,
        fingerprint_version: 1,
        base_fingerprint: claim.claimFingerprint,
        occurrence_no: groupIdentity.occurrenceNo,
        observed_installment_number: sourceRow.installment?.number,
        observed_installment_count: sourceRow.installment?.count,
        card_last4: sourceRow.cardLast4,
        installment_group: {
          ...installmentGroupInsertFromPlan(plan.value),
          purchase_description: label,
        },
        ...(existingGroup === undefined
          ? {}
          : {
              existing_installment_group_id: existingGroup.id,
              expected_group_updated_at: existingGroup.updated_at,
              observed_due_month: input.snapshot.referenceMonth,
            }),
        installments: installmentInsertPayloadsFromPlan(plan.value),
        ...(group.replaceTransaction === undefined
          ? {}
          : {
              replace_transaction: {
                id: group.replaceTransaction.id,
                updated_at: group.replaceTransaction.updatedAt,
              },
            }),
        ...(group.override === undefined
          ? {}
          : {
              override_reason: group.override.reason,
              ...(group.override.token === undefined
                ? {}
                : { override_token: group.override.token }),
              ...(group.override.claimId === undefined
                ? {}
                : { override_of_claim_id: group.override.claimId }),
            }),
      });
    }

    for (let index = 0; index < input.snapshot.rows.length; index += 1) {
      if (groupRowIndices.has(index)) continue;
      const sourceRow = input.snapshot.rows[index];
      const identity = input.snapshot.identities[index];
      if (sourceRow === undefined || identity === undefined) continue;
      const row = editedRow(sourceRow, index);
      if (
        !selected.has(index) ||
        (isMp && sourceRow.installment !== undefined)
      ) {
        items.push({
          household_id: householdId,
          disposition: duplicateIndices.has(index)
            ? "duplicate_in_file"
            : "excluded",
          source_line: sourceRow.sourceLine,
          occurred_on: sourceRow.occurredOn,
          amount_cents:
            sourceRow.kind === "expense"
              ? -sourceRow.amount.cents
              : sourceRow.amount.cents,
          description: sourceRow.description,
          fingerprint_version: 1,
          base_fingerprint: identity.baseIdentityHash,
          occurrence_no: identity.occurrenceNo,
          observed_installment_number: sourceRow.installment?.number,
          observed_installment_count: sourceRow.installment?.count,
          card_last4: sourceRow.cardLast4,
        });
        continue;
      }
      const mapping = input.mapping[index] ?? {};
      if (
        (duplicateIndices.has(index) || legacyDuplicateIndices.has(index)) &&
        input.overrides?.[index] === undefined
      ) {
        return {
          ok: false,
          message: `A linha ${row.sourceLine} precisa de justificativa para importar a duplicata.`,
        };
      }
      if (!validCategory(mapping.categoryId, mapping.subcategoryId)) {
        return {
          ok: false,
          message: `Categoria inválida na linha ${row.sourceLine}.`,
        };
      }
      const targetCardId = isMp
        ? targetCardFor(sourceRow.cardLast4)
        : undefined;
      const payment = isMp
        ? ({ type: "card", creditCardId: targetCardId as string } as const)
        : ({ type: "account", accountId: input.accountId as string } as const);
      const draftResult = createTransactionDraft({
        householdId,
        kind: row.kind,
        amount: row.amount,
        occurredOn: row.occurredOn,
        description: row.description,
        createdByUserId,
        payment,
        category: mapping,
      });
      if (!draftResult.ok) {
        const message = draftResult.errors.map((e) => e.message).join("; ");
        errors.push(`Linha ${row.sourceLine}: ${message}`);
        items.push({
          household_id: householdId,
          disposition: "validation_error",
          source_line: row.sourceLine,
          occurred_on: row.occurredOn,
          amount_cents:
            row.kind === "expense" ? -row.amount.cents : row.amount.cents,
          description: row.description,
          error_message: message,
        });
        continue;
      }
      const target = isMp
        ? ({ type: "credit_card", id: targetCardId as string } as const)
        : ({ type: "account", id: input.accountId as string } as const);
      const claim = claimIdentity(identity, target);
      const { import_batch_id: _drop, ...transaction } =
        transactionInsertFromDraft(draftResult.value);
      const teaching = input.learning?.[index];
      const override = input.overrides?.[index];
      if (
        override !== undefined &&
        (override.reason.trim().length < 5 ||
          (override.token === undefined) !== (override.claimId === undefined) ||
          (override.token !== undefined &&
            !/^[0-9a-f-]{36}$/i.test(override.token)) ||
          (override.claimId !== undefined &&
            !/^[0-9a-f-]{36}$/i.test(override.claimId)))
      ) {
        return {
          ok: false,
          message: `Justificativa de duplicata inválida na linha ${row.sourceLine}.`,
        };
      }
      const suppress = teaching?.suppress === true;
      const learning =
        teaching === undefined ||
        (!teaching.sourceCategory && !teaching.merchant)
          ? undefined
          : {
              ...(teaching.sourceCategory && row.sourceCategory
                ? {
                    source_category: {
                      normalized_label: normalizeSourceCategoryLabel(
                        row.sourceCategory,
                      ),
                      row_kind: row.kind,
                      category_id: suppress
                        ? null
                        : (mapping.categoryId ?? null),
                      subcategory_id: suppress
                        ? null
                        : (mapping.subcategoryId ?? null),
                      suppress,
                    },
                  }
                : {}),
              ...(teaching.merchant
                ? {
                    merchant_memory: {
                      pattern: normalizeMerchantKey(row.description),
                      row_kind: row.kind,
                      category_id: suppress
                        ? null
                        : (mapping.categoryId ?? null),
                      subcategory_id: suppress
                        ? null
                        : (mapping.subcategoryId ?? null),
                      suppress,
                      confidence: 0.99,
                      explanation: "Escolha confirmada durante importação.",
                      match_kind: "merchant_exact" as const,
                      normalizer_version: MERCHANT_KEY_VERSION,
                    },
                  }
                : {}),
            };
      items.push({
        household_id: householdId,
        disposition: "imported",
        source_line: sourceRow.sourceLine,
        occurred_on: sourceRow.occurredOn,
        amount_cents:
          sourceRow.kind === "expense"
            ? -sourceRow.amount.cents
            : sourceRow.amount.cents,
        description: sourceRow.description,
        fingerprint_version: 1,
        base_fingerprint: claim.claimFingerprint,
        occurrence_no: identity.occurrenceNo,
        override_token: override?.token,
        override_of_claim_id: override?.claimId,
        override_reason: override?.reason.trim().slice(0, 200),
        category_source: input.provenance?.[index]?.source,
        category_confidence: input.provenance?.[index]?.confidence,
        category_accepted: input.provenance?.[index]?.accepted,
        category_changed: input.provenance?.[index]?.changed,
        card_last4: sourceRow.cardLast4,
        learning,
        transaction,
      });
    }

    for (const parseError of input.snapshot.errors) {
      items.push({
        household_id: householdId,
        disposition: "parser_error",
        source_line: parseError.sourceLine,
        error_message: parseError.message,
      });
    }
    if (!items.some((item) => item.disposition === "imported")) {
      return {
        ok: false,
        message: "Selecione ao menos um lançamento ou parcelamento válido.",
      };
    }
    const confirmationPayload = {
      source: input.source,
      requestKey: input.requestKey,
      selectedIndices: [...selected].sort((a, b) => a - b),
      accountId: input.accountId,
      creditCardId: input.creditCardId,
      creditCardByLast4: input.creditCardByLast4,
      mapping: input.mapping,
      groups: input.groups,
      learning: input.learning,
      edits: input.edits,
      overrides: input.overrides,
      provenance: input.provenance,
      normalizedFingerprint: input.normalizedFingerprint,
    };
    const result = await confirmImportBatchV2(
      client,
      {
        household_id: householdId,
        source: SOURCE_TO_DB[input.source],
        request_key: input.requestKey,
        payload_fingerprint: sha256Hex(canonicalJson(confirmationPayload)),
        file_fingerprint: input.fileFingerprint,
        parser_version: `${input.parserVersion};identity=${IMPORT_IDENTITY_VERSION}`,
        normalized_fingerprint: input.normalizedFingerprint,
        notes:
          typeof input.notes === "string" && input.notes.trim().length > 0
            ? input.notes.trim().slice(0, 200)
            : null,
        created_by_user_id: createdByUserId,
      },
      items,
    );

    revalidatePath("/imports");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/cards");
    return {
      ok: true,
      message: `${result.replayed ? "Importação já confirmada" : "Importação confirmada"}: ${result.transactions_created} transação(ões), ${result.installment_groups_created} parcelamento(s), ${result.duplicate_rows} duplicata(s), ${result.error_rows} erro(s). Arquivo original descartado.`,
      importedRows: result.imported_rows,
      duplicateRows: result.duplicate_rows,
      errorRows: result.error_rows,
      excludedRows: result.excluded_rows,
      batchId: result.batch.id,
      replayed: result.replayed,
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
