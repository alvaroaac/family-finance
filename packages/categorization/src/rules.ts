/**
 * Deterministic categorization rules.
 *
 * A rule matches a transaction context by a case-insensitive substring on the
 * description (which carries the merchant/payee text from imports and the bot)
 * and proposes a macro category and optional subcategory *by name*. The engine
 * (`index.ts`) resolves those names against the household's real catalog, so
 * rules never invent ids and never auto-create categories.
 *
 * Pure module: no I/O, no domain/db/web imports.
 */

import { CONFIDENCE, scoreConfidence } from "./confidence.js";
import type { CategorizationContext } from "./context.js";
import type { CategorizationRowKind } from "./memory.js";

/** A single deterministic rule. */
export type CategorizationRule = {
  id: string;
  /** Which context field the rule reads. Only `description` for the MVP. */
  field: "description";
  /** Case-insensitive substring that must appear in the field. */
  contains: string;
  /** Target macro category, matched by name against the catalog. */
  categoryName: string;
  /** Optional target subcategory, matched by name under the macro category. */
  subcategoryName?: string;
  /** Confidence this rule asserts (clamped to [0,1]). Defaults to RULE. */
  confidence?: number;
  /** Undefined legacy rules are expense-only. */
  rowKind?: CategorizationRowKind;
};

/** Outcome of matching a context against rules — names, not ids. */
export type RuleMatch = {
  ruleId: string;
  categoryName: string;
  subcategoryName: string | null;
  confidence: number;
  explanation: string;
};

/**
 * The built-in starter rules. These are intentionally small and merchant-token
 * based; the real intelligence grows through {@link CategorizationMemoryEntry}
 * records created from user corrections, not by expanding this list. Category
 * names align with the seeded taxonomy (Alimentação, Transporte, ...).
 */
export function defaultRuleSet(): CategorizationRule[] {
  return [
    {
      id: "builtin-ifood",
      field: "description",
      contains: "IFOOD",
      categoryName: "Alimentação",
      subcategoryName: "Delivery",
      confidence: CONFIDENCE.RULE,
    },
    {
      id: "builtin-rappi",
      field: "description",
      contains: "RAPPI",
      categoryName: "Alimentação",
      subcategoryName: "Delivery",
      confidence: CONFIDENCE.RULE,
    },
    {
      id: "builtin-uber",
      field: "description",
      contains: "UBER",
      categoryName: "Transporte",
      confidence: CONFIDENCE.RULE,
    },
    {
      id: "builtin-99",
      field: "description",
      contains: "99APP",
      categoryName: "Transporte",
      confidence: CONFIDENCE.RULE,
    },
  ];
}

function fieldValue(
  context: CategorizationContext,
  field: CategorizationRule["field"],
): string {
  switch (field) {
    case "description":
      return context.description ?? "";
    default:
      return "";
  }
}

/** Build the canonical "descrição contém X -> Cat > Sub" explanation. */
export function ruleExplanation(
  token: string,
  categoryName: string,
  subcategoryName: string | null,
): string {
  const target = subcategoryName
    ? `${categoryName} > ${subcategoryName}`
    : categoryName;
  return `descrição contém "${token.toUpperCase()}" -> ${target}`;
}

/**
 * Return the first matching rule for a context, or null. Rules are evaluated in
 * order, so more specific rules should appear earlier in the list.
 */
export function matchRules(
  context: CategorizationContext,
  rules: CategorizationRule[],
): RuleMatch | null {
  for (const rule of rules) {
    if ((rule.rowKind ?? "expense") !== (context.kind ?? "expense")) {
      continue;
    }
    const haystack = fieldValue(context, rule.field).toUpperCase();
    const needle = rule.contains.trim().toUpperCase();
    if (needle.length === 0) {
      continue;
    }
    if (haystack.includes(needle)) {
      const subcategoryName = rule.subcategoryName ?? null;
      return {
        ruleId: rule.id,
        categoryName: rule.categoryName,
        subcategoryName,
        confidence: scoreConfidence(rule.confidence ?? CONFIDENCE.RULE),
        explanation: ruleExplanation(
          rule.contains,
          rule.categoryName,
          subcategoryName,
        ),
      };
    }
  }
  return null;
}
