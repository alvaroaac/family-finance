/**
 * Core import contracts.
 *
 * Boundary: domain types, validation and file parsers only; never web/bot/db
 * clients. A source file is TRANSIENT input; adapters turn it
 * into normalized rows and never persist the original bytes. Category mapping
 * and persistence happen in the web action layer, not here.
 */

import type { MoneyAmount } from "@family-finance/domain";

/**
 * Logical import source. Kept independent of the database `import_source` enum
 * (`minhas_financas_csv` | `nubank_csv`); the web action maps between them so
 * this package stays free of any db coupling.
 */
export type ImportSource =
  | "minhas-financas"
  | "nubank"
  | "nubank-ofx"
  | "mercado-pago";

/** Expense vs income, derived from the source row's sign/type column. */
export type ImportRowKind = "expense" | "income";

/**
 * One successfully normalized row, ready to become a transaction draft.
 *
 * Money is a domain `MoneyAmount` (BRL integer cents); `amount.cents` is always
 * a positive magnitude — direction is carried by `kind`. The original raw cell
 * values are intentionally NOT retained.
 */
export type NormalizedImportRow = {
  /** 1-based line number in the source file (header is line 1). */
  sourceLine: number;
  /** ISO date (YYYY-MM-DD) the transaction occurred. */
  occurredOn: string;
  /** Merchant/description text, trimmed. */
  description: string;
  /** Positive magnitude in BRL cents; direction is in `kind`. */
  amount: MoneyAmount;
  kind: ImportRowKind;
  /**
   * Original source category name, when the source provides one. Used by the
   * web action layer to drive category mapping; it is never auto-applied here.
   */
  sourceCategory?: string;
  /**
   * Present when the source row is one parcel of an installment purchase
   * ("Parcela X de Y" on a fatura). Flat/à-vista rows omit it.
   */
  installment?: { number: number; count: number };
  /** Card last-4 of the fatura section this row came from, when known. */
  cardLast4?: string;
  /** Stable source-native transaction ID when an adapter can provide one. */
  providerTransactionId?: string;
};

/**
 * A row that could not be mapped. The whole import does NOT fail because of it;
 * the operator reviews these and re-imports a corrected file if needed. We keep
 * only the line number and a human-readable reason — never the raw cell bytes.
 */
export type ImportRowError = {
  sourceLine: number;
  message: string;
};

/** Statement-level metadata a fatura-style source can provide. */
export type StatementInfo = {
  /** YYYY-MM the statement was emitted in — anchors year inference. */
  referenceMonth: string;
};

/** The result of running a source adapter over a file's text. */
export type AdapterResult = {
  source: ImportSource;
  rows: NormalizedImportRow[];
  errors: ImportRowError[];
  statement?: StatementInfo;
  notices?: string[];
};

/**
 * A source adapter. `parse` accepts the file's decoded text (transient input)
 * and returns normalized rows plus reviewable errors. It must never throw for
 * row-level problems — those become `errors` entries.
 */
export type ImportAdapter = {
  source: ImportSource;
  parse(fileText: string): Promise<AdapterResult>;
};

/**
 * A probable duplicate detected within a single import batch. `rowIndex` is the
 * later occurrence; `duplicateOfIndex` is the earlier row it matches. Indices
 * are positions into `ImportPreview.rows`.
 */
export type DuplicateCandidate = {
  rowIndex: number;
  duplicateOfIndex: number;
  /** Human-readable, auditable reason (pt-BR) shown before any write. */
  reason: string;
};

/**
 * Everything the UI needs to let the user review an import BEFORE writing: the
 * normalized rows, the reviewable errors, the duplicate candidates, and summary
 * counts. The original file is not part of this model.
 */
export type ImportPreview = {
  source: ImportSource;
  rows: NormalizedImportRow[];
  errors: ImportRowError[];
  duplicates: DuplicateCandidate[];
  /** parsed rows + error rows (the full size of the source minus header). */
  totalRows: number;
  errorCount: number;
  duplicateCount: number;
  /** Rows that would be written if confirmed (parsed minus flagged dupes). */
  importableCount: number;
};
