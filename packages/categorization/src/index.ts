/**
 * @family-finance/categorization
 *
 * Explainable, hybrid category suggestion engine shared by the importer and the
 * Telegram bot. Strategy order: memory (confirmed corrections) -> deterministic
 * rules -> AI fallback. Every suggestion carries a confidence (0..1) and a
 * human explanation, and low-confidence results always request confirmation.
 *
 * Boundary: this package is PURE. It may import @family-finance/domain + zod,
 * but NOT web/bot/db clients or any AI implementation. The memory store and the
 * AI categorizer are INTERFACES wired by the app (db) and Task 8 (ai.ts).
 */

import { z } from "zod";

import {
  CONFIDENCE,
  scoreConfidence,
  needsConfirmation,
  tierOf,
} from "./confidence.js";
import { matchRules, defaultRuleSet, type CategorizationRule } from "./rules.js";
import {
  matchMemory,
  describeMemory,
  type CategorizationMemoryEntry,
  type CategorizationMemoryStore,
} from "./memory.js";
import type { CategorizationContext } from "./context.js";

// Re-export the building blocks so consumers import from one entry point.
export { CONFIDENCE, scoreConfidence, needsConfirmation, tierOf } from "./confidence.js";
export type { ConfidenceTier } from "./confidence.js";
export {
  matchRules,
  defaultRuleSet,
  ruleExplanation,
} from "./rules.js";
export type { CategorizationRule, RuleMatch } from "./rules.js";
export {
  matchMemory,
  describeMemory,
  memoryEntryFromCorrection,
} from "./memory.js";
export type {
  CategorizationMemoryEntry,
  CategorizationMemoryStore,
  ExplainCatalog,
} from "./memory.js";
export type { CategorizationContext } from "./context.js";

// ---------------------------------------------------------------------------
// Core suggestion contract.
// ---------------------------------------------------------------------------

/** Where a suggestion came from — drives explainability and trust. */
export type SuggestionSource = "memory" | "rule" | "ai";

/**
 * A category suggestion for a transaction. `macroCategoryId`/`subcategoryId`
 * reference REAL catalog ids (never invented). `confidence` is in [0,1] and
 * `explanation` is a human-readable reason an advanced user can audit.
 */
export type CategorySuggestion = {
  macroCategoryId?: string;
  subcategoryId?: string;
  confidence: number;
  explanation: string;
  source: SuggestionSource;
};

export const categorySuggestionSchema = z.object({
  macroCategoryId: z.string().min(1).optional(),
  subcategoryId: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  source: z.enum(["memory", "rule", "ai"]),
});

/**
 * Outcome of a categorization request.
 * - `matched`: a usable suggestion resolved to real catalog ids.
 * - `pending_new_category`: a confident proposal that does NOT exist in the
 *   catalog. It stays PENDING for human approval and is never auto-created.
 * - `uncategorized`: nothing matched; the user must categorize manually.
 *
 * `requiresConfirmation` is true whenever the result is below the high-
 * confidence bar or is a pending/uncategorized result.
 */
export type CategorizationStatus =
  | "matched"
  | "pending_new_category"
  | "uncategorized";

export type PendingCategoryProposal = {
  categoryName: string;
  subcategoryName: string | null;
  confidence: number;
  explanation: string;
};

export type CategorizationResult = {
  status: CategorizationStatus;
  suggestion: CategorySuggestion | null;
  /** Present only when status === "pending_new_category". */
  pendingCategory?: PendingCategoryProposal;
  requiresConfirmation: boolean;
};

// ---------------------------------------------------------------------------
// Catalog + AI fallback interface.
// ---------------------------------------------------------------------------

/** The household's current taxonomy. Suggestions resolve names against this. */
export type CategoryCatalog = {
  householdId: string;
  categories: ReadonlyArray<{ id: string; name: string }>;
  subcategories: ReadonlyArray<{
    id: string;
    categoryId: string;
    name: string;
  }>;
};

/** What an AI categorizer returns — names only; the engine resolves to ids. */
export type AiCategorySuggestion = {
  categoryName: string;
  subcategoryName: string | null;
  confidence: number;
  explanation: string;
};

/**
 * AI fallback INTERFACE only. No implementation lives in this package — Task 8
 * provides `ai.ts`. The engine uses it solely when deterministic strategies are
 * uncertain, and any AI output is still subject to confidence gating and the
 * "new categories stay pending" rule.
 */
export type AiCategorizer = {
  categorize(
    context: CategorizationContext,
    catalog: CategoryCatalog,
  ): Promise<AiCategorySuggestion | null>;
};

export type SuggestOptions = {
  catalog: CategoryCatalog;
  /** Optional override of the deterministic rule set. */
  rules?: CategorizationRule[];
  /** Optional memory store; when omitted, no memory lookup happens. */
  memoryStore?: CategorizationMemoryStore;
  /** Optional AI fallback; when omitted, no AI lookup happens. */
  ai?: AiCategorizer;
};

// ---------------------------------------------------------------------------
// Name resolution helpers (case-insensitive against the catalog).
// ---------------------------------------------------------------------------

function norm(value: string): string {
  return value.trim().toLowerCase();
}

type ResolvedCategory = {
  categoryId?: string;
  subcategoryId?: string;
  /** True when the proposed macro category name does not exist in the catalog. */
  isNewCategory: boolean;
};

function resolveNames(
  catalog: CategoryCatalog,
  categoryName: string,
  subcategoryName: string | null,
): ResolvedCategory {
  const category = catalog.categories.find(
    (c) => norm(c.name) === norm(categoryName),
  );
  if (category === undefined) {
    return { isNewCategory: true };
  }
  if (subcategoryName === null) {
    return { categoryId: category.id, isNewCategory: false };
  }
  const subcategory = catalog.subcategories.find(
    (s) =>
      s.categoryId === category.id && norm(s.name) === norm(subcategoryName),
  );
  return {
    categoryId: category.id,
    // An unknown subcategory under a known macro is simply dropped (the macro
    // still applies); it does not make the whole suggestion a new category.
    subcategoryId: subcategory?.id,
    isNewCategory: false,
  };
}

const UNCATEGORIZED: CategorizationResult = {
  status: "uncategorized",
  suggestion: null,
  requiresConfirmation: true,
};

function matchedResult(suggestion: CategorySuggestion): CategorizationResult {
  return {
    status: "matched",
    suggestion,
    requiresConfirmation: needsConfirmation(suggestion.confidence),
  };
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

/**
 * Suggest a category for a transaction context.
 *
 * Resolution order (highest trust first):
 *   1. Memory — a prior confirmed correction whose pattern matches.
 *   2. Rules — deterministic merchant/description rules.
 *   3. AI fallback — only if provided and the above did not match.
 *
 * Guarantees:
 *   - Suggestions resolve to REAL catalog ids; novel categories are returned as
 *     `pending_new_category` and are NEVER auto-created.
 *   - Low confidence (below {@link CONFIDENCE.HIGH}) sets `requiresConfirmation`.
 *   - Every returned suggestion has a confidence in [0,1] and an explanation.
 */
export async function suggestCategory(
  context: CategorizationContext,
  options: SuggestOptions,
): Promise<CategorizationResult> {
  const { catalog } = options;

  // 1. Memory — confirmed corrections win and boost confidence.
  if (options.memoryStore) {
    const entries = await options.memoryStore.findActiveByHousehold(
      context.householdId,
    );
    const hit = matchMemory(context, entries);
    if (hit !== null && hit.categoryId !== null) {
      const suggestion: CategorySuggestion = {
        macroCategoryId: hit.categoryId,
        subcategoryId: hit.subcategoryId ?? undefined,
        confidence: scoreConfidence(
          Math.max(hit.confidence, CONFIDENCE.MEMORY),
        ),
        explanation: describeMemory(hit, catalog),
        source: "memory",
      };
      return matchedResult(suggestion);
    }
  }

  // 2. Deterministic rules.
  const ruleMatch = matchRules(context, options.rules ?? defaultRuleSet());
  if (ruleMatch !== null) {
    const resolved = resolveNames(
      catalog,
      ruleMatch.categoryName,
      ruleMatch.subcategoryName,
    );
    if (!resolved.isNewCategory && resolved.categoryId !== undefined) {
      const suggestion: CategorySuggestion = {
        macroCategoryId: resolved.categoryId,
        subcategoryId: resolved.subcategoryId,
        confidence: ruleMatch.confidence,
        explanation: ruleMatch.explanation,
        source: "rule",
      };
      return matchedResult(suggestion);
    }
    // A rule targeting a category that no longer exists falls through.
  }

  // 3. AI fallback — only when configured.
  if (options.ai) {
    const ai = await options.ai.categorize(context, catalog);
    if (ai !== null) {
      const confidence = scoreConfidence(ai.confidence);
      const resolved = resolveNames(
        catalog,
        ai.categoryName,
        ai.subcategoryName,
      );
      if (resolved.isNewCategory) {
        // Never auto-create. Surface the proposal for explicit approval.
        return {
          status: "pending_new_category",
          suggestion: {
            confidence,
            explanation: ai.explanation,
            source: "ai",
          },
          pendingCategory: {
            categoryName: ai.categoryName,
            subcategoryName: ai.subcategoryName,
            confidence,
            explanation: ai.explanation,
          },
          requiresConfirmation: true,
        };
      }
      if (resolved.categoryId !== undefined) {
        const suggestion: CategorySuggestion = {
          macroCategoryId: resolved.categoryId,
          subcategoryId: resolved.subcategoryId,
          confidence,
          explanation: ai.explanation,
          source: "ai",
        };
        return matchedResult(suggestion);
      }
    }
  }

  // 4. Nothing matched.
  return UNCATEGORIZED;
}
