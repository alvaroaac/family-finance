/**
 * Probable-duplicate detection within a single import batch.
 *
 * We never auto-discard. We FLAG likely duplicates so the user can see them
 * before any write (the spec's "detecção de duplicatas prováveis" + "ver o que
 * será importado antes de gravar"). The signal is intentionally conservative:
 * same date, same amount magnitude+direction, and same normalized description.
 *
 * Pure: no I/O. Operates on already-normalized rows.
 */

import type {
  NormalizedImportRow,
  DuplicateCandidate,
  ImportPreview,
  ImportSource,
  ImportRowError,
} from "./types.js";
import { normalizeDescription } from "./normalize.js";

/** Build the equality key used to detect probable duplicates. */
function duplicateKey(row: NormalizedImportRow): string {
  if (row.providerTransactionId) return `provider:${row.providerTransactionId}`;
  const desc = normalizeDescription(row.description).toLowerCase();
  return `${row.occurredOn}|${row.kind}|${row.amount.cents}|${desc}`;
}

/**
 * Return one {@link DuplicateCandidate} for each row that matches an earlier row
 * on date + direction + amount + normalized description. The first occurrence of
 * a key is never flagged; only subsequent ones are.
 */
export function findDuplicateCandidates(
  rows: NormalizedImportRow[],
): DuplicateCandidate[] {
  const firstSeen = new Map<string, number>();
  const candidates: DuplicateCandidate[] = [];

  rows.forEach((row, index) => {
    const key = duplicateKey(row);
    const seenAt = firstSeen.get(key);
    if (seenAt === undefined) {
      firstSeen.set(key, index);
      return;
    }
    candidates.push({
      rowIndex: index,
      duplicateOfIndex: seenAt,
      reason: row.providerTransactionId
        ? "mesmo identificador da instituição de outra linha do arquivo"
        : "mesma data, valor e descrição de outra linha do arquivo",
    });
  });

  return candidates;
}

/**
 * Assemble a complete {@link ImportPreview} from an adapter's output. Computes
 * duplicate candidates and the summary counts the UI shows before confirming.
 * `importableCount` excludes rows flagged as duplicates by default.
 */
export function buildImportPreview(input: {
  source: ImportSource;
  rows: NormalizedImportRow[];
  errors: ImportRowError[];
}): ImportPreview {
  const { source, rows, errors } = input;
  const duplicates = findDuplicateCandidates(rows);
  const duplicateRowIndices = new Set(duplicates.map((d) => d.rowIndex));

  return {
    source,
    rows,
    errors,
    duplicates,
    totalRows: rows.length + errors.length,
    errorCount: errors.length,
    duplicateCount: duplicates.length,
    importableCount: rows.length - duplicateRowIndices.size,
  };
}
