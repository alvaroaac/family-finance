/**
 * Parcela reconstruction: turn "Parcela X de Y" fatura rows into inferred,
 * user-editable installment-group previews, and split them away from the flat
 * (à-vista) rows that import as plain card transactions.
 *
 * Inference (spec §3): the fatura shows only THIS month's parcel, so
 *   count            = Y
 *   perInstallment   = the row amount
 *   estimatedTotal   = per × Y            (exact when parcels are equal)
 *   purchaseMonth    = referenceMonth − (X − 1), or the row's posting month
 *                      for OFX, whose closing month can be one month later
 *   purchasedOn      = purchaseMonth + the row's day-of-month (the parcela
 *                      row's DD/MM is the original purchase date), clamped to
 *                      the month length. Everything is editable downstream.
 *
 * Pure: no I/O, no db types — matching runs on plain summaries the caller maps
 * from its rows.
 */

import type { NormalizedImportRow } from "./types.js";
import { normalizeDescription } from "./normalize.js";

export type InferredInstallmentGroup = {
  rowIndex: number;
  sourceLine: number;
  description: string;
  cardLast4?: string;
  installmentNumber: number;
  installmentCount: number;
  perInstallmentCents: number;
  estimatedTotalCents: number;
  purchaseMonth: string;
  purchasedOn: string;
};

export type ExistingGroupSummary = {
  description: string;
  installmentCount: number;
  purchasedOn: string;
};

/** YYYY-MM minus `offset` whole months, stable across year boundaries. */
function subtractMonths(referenceMonth: string, offset: number): string {
  const [y, m] = referenceMonth.split("-").map((p) => Number.parseInt(p, 10));
  const zeroBased = (y as number) * 12 + ((m as number) - 1) - offset;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Last day of a YYYY-MM month. */
function lastDayOfMonth(month: string): number {
  const [y, m] = month.split("-").map((p) => Number.parseInt(p, 10));
  return new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
}

export function splitFlatAndInstallmentRows(
  rows: NormalizedImportRow[],
  referenceMonth: string,
  dateBasis: "statement" | "posted" = "statement",
): { flatRowIndices: number[]; groups: InferredInstallmentGroup[] } {
  const flatRowIndices: number[] = [];
  const groups: InferredInstallmentGroup[] = [];

  rows.forEach((row, rowIndex) => {
    if (row.installment === undefined) {
      flatRowIndices.push(rowIndex);
      return;
    }
    const { number, count } = row.installment;
    const rowDay = Number.parseInt(row.occurredOn.slice(8, 10), 10);
    // Nubank posts carried-over installments on day 1, not the purchase day.
    // Keep their statement-based estimate so the observed installment stays
    // in this invoice; only dated purchases use the OFX posting month.
    const isCarriedOverPlaceholder = number > 1 && rowDay === 1;
    const purchaseMonth = subtractMonths(
      dateBasis === "posted" && !isCarriedOverPlaceholder
        ? row.occurredOn.slice(0, 7)
        : referenceMonth,
      number - 1,
    );
    const day = Math.min(rowDay, lastDayOfMonth(purchaseMonth));
    groups.push({
      rowIndex,
      sourceLine: row.sourceLine,
      description: row.description,
      cardLast4: row.cardLast4,
      installmentNumber: number,
      installmentCount: count,
      perInstallmentCents: row.amount.cents,
      estimatedTotalCents: row.amount.cents * count,
      purchaseMonth,
      purchasedOn: `${purchaseMonth}-${String(day).padStart(2, "0")}`,
    });
  });

  return { flatRowIndices, groups };
}

/**
 * Loose dedupe match (spec §4): normalized description + installment count +
 * purchase MONTH (not day — the inferred day is an estimate). Returns the index
 * of the first matching existing group, or null.
 */
export function matchExistingGroup(
  inferred: InferredInstallmentGroup,
  existing: ExistingGroupSummary[],
): number | null {
  const wanted = normalizeDescription(inferred.description).toLowerCase();
  const index = existing.findIndex(
    (g) =>
      normalizeDescription(g.description).toLowerCase() === wanted &&
      g.installmentCount === inferred.installmentCount &&
      g.purchasedOn.slice(0, 7) === inferred.purchaseMonth,
  );
  return index === -1 ? null : index;
}
