/**
 * Categorization memory: explainable, auditable patterns learned from user
 * corrections.
 *
 * A memory entry says "when the description contains PATTERN, categorize as
 * category/subcategory". Entries can be listed, disabled (`isActive: false`),
 * and explained in plain language so an advanced user can audit why a category
 * was suggested. Memory entries reference REAL category ids — they are created
 * from confirmed corrections, never from unapproved AI guesses.
 *
 * Pure module: it defines the store INTERFACE (wired by the app to the
 * `categorization_memory` table via packages/db) but contains no I/O itself and
 * no domain/db/web imports.
 */

import { scoreConfidence } from "./confidence.js";
import type { CategorizationContext } from "./context.js";
import { normalizeMerchantKey } from "./merchant.js";

export type CategorizationRowKind = "expense" | "income";
export type MemoryMatchKind =
  | "merchant_exact"
  | "merchant_prefix"
  | "description_contains"
  | "suppress";

/** One memory record. Mirrors the durable fields of `categorization_memory`. */
export type CategorizationMemoryEntry = {
  id: string;
  householdId: string;
  /** Case-insensitive substring tested against the description. */
  pattern: string;
  categoryId: string | null;
  subcategoryId: string | null;
  confidence: number;
  /** Stored human explanation, e.g. 'descrição contém "IFOOD" -> ...'. */
  explanation: string;
  isActive: boolean;
  /** Undefined preserves legacy description-contains matching. */
  matchKind?: MemoryMatchKind;
  /** Undefined legacy entries are expense-only. */
  rowKind?: CategorizationRowKind;
  /** Version provenance for merchant keys; old records may omit it. */
  normalizerVersion?: string;
};

/**
 * Read-only store interface the engine depends on. The web app/bot provide an
 * implementation backed by `packages/db` (the `categorization_memory` table,
 * RLS-scoped by household). Keeping this an interface preserves the package
 * boundary: categorization never imports a db client.
 */
export type CategorizationMemoryStore = {
  findActiveByHousehold(
    householdId: string,
  ): Promise<CategorizationMemoryEntry[]>;
};

/**
 * Find the first ACTIVE memory entry whose pattern is contained in the
 * description (case-insensitive). Disabled entries are never matched. Among
 * active matches, the longest pattern wins (most specific), and ties break on
 * higher confidence so a more trusted correction is preferred.
 */
export function matchMemory(
  context: CategorizationContext,
  entries: CategorizationMemoryEntry[],
): CategorizationMemoryEntry | null {
  const haystack = (context.description ?? "").toUpperCase();
  const merchantKey = context.merchantKey ?? normalizeMerchantKey(context.description);
  const rowKind = context.kind ?? "expense";
  let best: CategorizationMemoryEntry | null = null;
  for (const entry of entries) {
    if (
      !entry.isActive ||
      entry.householdId !== context.householdId ||
      (entry.rowKind ?? "expense") !== rowKind
    ) {
      continue;
    }
    const kind = entry.matchKind ?? "description_contains";
    const legacyNeedle = entry.pattern.trim().toUpperCase();
    const merchantNeedle = normalizeMerchantKey(entry.pattern);
    const matched =
      kind === "description_contains"
        ? legacyNeedle.length > 0 && haystack.includes(legacyNeedle)
        : kind === "merchant_prefix"
          ? merchantNeedle.length > 0 && merchantKey.startsWith(merchantNeedle)
          : merchantNeedle.length > 0 && merchantKey === merchantNeedle;
    if (!matched) {
      continue;
    }
    if (best === null) {
      best = entry;
      continue;
    }
    const bestRank = memorySpecificity(best);
    const entryRank = memorySpecificity(entry);
    const bestLen = best.pattern.trim().length;
    const entryLen = entry.pattern.trim().length;
    if (
      entryRank > bestRank ||
      (entryRank === bestRank && entryLen > bestLen) ||
      (entryRank === bestRank && entryLen === bestLen && entry.confidence > best.confidence)
    ) {
      best = entry;
    }
  }
  return best;
}

function memorySpecificity(entry: CategorizationMemoryEntry): number {
  switch (entry.matchKind ?? "description_contains") {
    case "suppress":
      return 4;
    case "merchant_exact":
      return 3;
    case "merchant_prefix":
      return 2;
    case "description_contains":
      return 1;
  }
}

/** Minimal catalog projection used to render names in explanations. */
export type ExplainCatalog = {
  categories: ReadonlyArray<{ id: string; name: string }>;
  subcategories: ReadonlyArray<{
    id: string;
    categoryId: string;
    name: string;
  }>;
};

/**
 * Render a stable, human-readable explanation for a memory entry against the
 * current catalog, e.g. `descrição contém "IFOOD" -> Alimentação > Delivery`.
 * Recomputed from live names so renamed categories stay accurate even if the
 * stored `explanation` text is stale.
 */
export function describeMemory(
  entry: CategorizationMemoryEntry,
  catalog: ExplainCatalog,
): string {
  const category =
    catalog.categories.find((c) => c.id === entry.categoryId)?.name ?? null;
  const subcategory =
    catalog.subcategories.find((s) => s.id === entry.subcategoryId)?.name ??
    null;

  const target = category
    ? subcategory
      ? `${category} > ${subcategory}`
      : category
    : "(sem categoria)";

  return `descrição contém "${entry.pattern.toUpperCase()}" -> ${target}`;
}

/**
 * Build the fields for a NEW memory entry from a confirmed correction. Pure:
 * the caller persists the returned shape via packages/db. The resulting entry
 * always references real ids the user approved, so corrections become
 * learning without ever auto-creating categories.
 */
export function memoryEntryFromCorrection(input: {
  householdId: string;
  pattern: string;
  categoryId: string | null;
  subcategoryId: string | null;
  confidence?: number;
  catalog: ExplainCatalog;
  matchKind?: MemoryMatchKind;
  rowKind?: CategorizationRowKind;
  normalizerVersion?: string;
}): Omit<CategorizationMemoryEntry, "id"> {
  const entry: CategorizationMemoryEntry = {
    id: "",
    householdId: input.householdId,
    pattern: input.pattern.trim(),
    categoryId: input.categoryId,
    subcategoryId: input.subcategoryId,
    confidence: scoreConfidence(input.confidence ?? 0.95),
    explanation: "",
    isActive: true,
    ...(input.matchKind === undefined ? {} : { matchKind: input.matchKind }),
    ...(input.rowKind === undefined ? {} : { rowKind: input.rowKind }),
    ...(input.normalizerVersion === undefined
      ? {}
      : { normalizerVersion: input.normalizerVersion }),
  };
  const { id: _omit, ...rest } = {
    ...entry,
    explanation: describeMemory(entry, input.catalog),
  };
  void _omit;
  return rest;
}
