/**
 * @family-finance/importers
 *
 * Source adapters that turn a TRANSIENT import file (CSV today; XLSX/Nubank-like
 * reports are future adapters behind the same contract) into normalized rows,
 * reviewable errors, and a preview model with probable-duplicate detection.
 *
 * Boundary: this package imports `@family-finance/domain` + `zod` only — never
 * web/bot/db clients. The original file is never persisted here; category
 * mapping and persistence are the web action layer's job.
 */

// Core contracts.
export type {
  ImportSource,
  ImportRowKind,
  NormalizedImportRow,
  ImportRowError,
  AdapterResult,
  ImportAdapter,
  DuplicateCandidate,
  ImportPreview,
  StatementInfo,
} from "./types.js";

// Pure normalization primitives (also exported for unit tests / reuse).
export {
  parseCsv,
  parseBrlToCents,
  normalizeDate,
  normalizeDescription,
  moneyFromSignedCents,
} from "./normalize.js";

// Duplicate detection + preview assembly.
export { findDuplicateCandidates, buildImportPreview } from "./dedupe.js";

// Versioned immutable source identity and target-scoped claim helpers.
export {
  IMPORT_IDENTITY_VERSION,
  normalizeIdentityDescription,
  canonicalJson,
  sha256Hex,
  rowIdentityCanonicalValue,
  rowBaseIdentityHash,
  assignRowIdentities,
  normalizedRowsFingerprint,
  claimIdentity,
} from "./identity.js";
export type {
  ImportIdentityVersion,
  SourceIdentityMetadata,
  RowIdentityInput,
  RowIdentity,
  ClaimTarget,
  ClaimIdentity,
} from "./identity.js";

// Parcela reconstruction: split flat rows from inferred installment groups.
export {
  splitFlatAndInstallmentRows,
  matchExistingGroup,
} from "./reconstruction.js";
export type {
  InferredInstallmentGroup,
  ExistingGroupSummary,
} from "./reconstruction.js";

// Source adapters.
export { minhasFinancasCsvAdapter } from "./minhas-financas-csv.js";
export { nubankCsvAdapter } from "./nubank-csv.js";
export { mercadoPagoPdfAdapter } from "./mercado-pago-pdf.js";

import type { ImportAdapter, ImportSource } from "./types.js";
import { minhasFinancasCsvAdapter } from "./minhas-financas-csv.js";
import { nubankCsvAdapter } from "./nubank-csv.js";
import { mercadoPagoPdfAdapter } from "./mercado-pago-pdf.js";

/** Registry of available adapters, keyed by logical source. */
export const importAdapters: Record<ImportSource, ImportAdapter> = {
  "minhas-financas": minhasFinancasCsvAdapter,
  nubank: nubankCsvAdapter,
  "mercado-pago": mercadoPagoPdfAdapter,
};

/** Resolve an adapter by source, or `undefined` when unknown. */
export function getImportAdapter(
  source: ImportSource,
): ImportAdapter | undefined {
  return importAdapters[source];
}
