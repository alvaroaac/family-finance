import { z } from "zod";

import { tierOf, scoreConfidence, type ConfidenceTier } from "./confidence.js";
import type { CategorizationContext } from "./context.js";
import {
  matchMemory,
  describeMemory,
  type CategorizationMemoryEntry,
  type CategorizationRowKind,
} from "./memory.js";
import {
  MERCHANT_KEY_VERSION,
  normalizeMerchantKey,
  normalizeSourceCategoryLabel,
} from "./merchant.js";
import {
  defaultRuleSet,
  matchRules,
  type CategorizationRule,
} from "./rules.js";
import type { CategoryCatalog } from "./index.js";

export const MAX_SUGGESTION_CANDIDATES = 3;
export const MAX_AI_ITEMS_PER_PREVIEW = 50;
export const MAX_AI_ITEMS_PER_CHUNK = 25;
export const AI_BATCH_SCHEMA_VERSION = "category-batch-v1" as const;

export type CategorizationImportSource =
  | "minhas-financas"
  | "nubank"
  | "nubank-ofx"
  | "mercado-pago";

export type SourceCategoryMapping = {
  id: string;
  householdId: string;
  source: CategorizationImportSource;
  sourceLabel: string;
  normalizedSourceLabel?: string;
  rowKind: CategorizationRowKind;
  categoryId: string | null;
  subcategoryId?: string | null;
  suppress?: boolean;
  confidence?: number;
  explanation?: string;
  isActive: boolean;
};

export type SuggestionProvenance =
  | "memory"
  | "source_mapping"
  | "rule"
  | "codex"
  | "paid_fallback";

export type SuggestionCandidate = {
  categoryId: string;
  subcategoryId?: string;
  source: SuggestionProvenance;
  confidence: number;
  tier: ConfidenceTier;
  explanation: string;
  requiresReview: boolean;
  modelVersion?: string;
  promptVersion?: string;
  rulesVersion?: string;
  normalizerVersion?: string;
};

const boundedId = z.string().min(1).max(100);
const boundedExplanation = z.string().min(1).max(240);
export const suggestionCandidateSchema = z
  .object({
    categoryId: boundedId,
    subcategoryId: boundedId.optional(),
    source: z.enum([
      "memory",
      "source_mapping",
      "rule",
      "codex",
      "paid_fallback",
    ]),
    confidence: z.number().min(0).max(1),
    tier: z.enum(["high", "medium", "low"]),
    explanation: boundedExplanation,
    requiresReview: z.boolean(),
    modelVersion: z.string().min(1).max(80).optional(),
    promptVersion: z.string().min(1).max(80).optional(),
    rulesVersion: z.string().min(1).max(80).optional(),
    normalizerVersion: z.string().min(1).max(80).optional(),
  })
  .strict();

export const suggestionCandidatesSchema = z
  .array(suggestionCandidateSchema)
  .max(MAX_SUGGESTION_CANDIDATES);

export type ExplicitCategoryChoice = {
  categoryId: string;
  subcategoryId?: string;
};

export type BatchCategorizationRow = {
  rowKey: string;
  householdId: string;
  description: string;
  kind: CategorizationRowKind;
  amountCents?: number;
  occurredOn?: string;
  source?: CategorizationImportSource;
  sourceCategory?: string;
  included?: boolean;
  explicitChoice?: ExplicitCategoryChoice;
};

export type FinalCategorySelection = ExplicitCategoryChoice & {
  source: SuggestionProvenance | "user";
};

export type BatchCategorizationRowPlan = {
  rowKey: string;
  merchantKey: string;
  status: "selected" | "suppressed" | "unresolved";
  selection: FinalCategorySelection | null;
  candidates: SuggestionCandidate[];
  suppressionExplanation?: string;
  aiRequestKey?: string;
};

export type AiSuggestionRequestItem = {
  requestKey: string;
  merchantKey: string;
  description: string;
  amountCents?: number;
  occurredOn?: string;
  sourceCategory?: string;
};

export type BatchCategorizationPlan = {
  rows: BatchCategorizationRowPlan[];
  aiItems: AiSuggestionRequestItem[];
};

export type BatchCategorizationOptions = {
  catalog: CategoryCatalog;
  memoryEntries?: readonly CategorizationMemoryEntry[];
  sourceMappings?: readonly SourceCategoryMapping[];
  rules?: readonly CategorizationRule[];
  maxAiSignatures?: number;
  rulesVersion?: string;
};

function bounded(value: string, max: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, max);
}

function validChoice(
  catalog: CategoryCatalog,
  categoryId: string,
  subcategoryId?: string | null,
): ExplicitCategoryChoice | null {
  if (!catalog.categories.some((category) => category.id === categoryId)) {
    return null;
  }
  if (subcategoryId === undefined || subcategoryId === null) {
    return { categoryId };
  }
  const validSubcategory = catalog.subcategories.some(
    (subcategory) =>
      subcategory.id === subcategoryId && subcategory.categoryId === categoryId,
  );
  return validSubcategory ? { categoryId, subcategoryId } : null;
}

function candidate(input: {
  choice: ExplicitCategoryChoice;
  source: SuggestionProvenance;
  confidence: number;
  explanation: string;
  rulesVersion?: string;
  modelVersion?: string;
  promptVersion?: string;
}): SuggestionCandidate {
  const confidence = scoreConfidence(input.confidence);
  return {
    ...input.choice,
    source: input.source,
    confidence,
    tier: tierOf(confidence),
    explanation: bounded(input.explanation, 240) || "Sugestão de categoria.",
    // AI is review-required regardless of self-reported confidence.
    requiresReview:
      input.source === "codex" ||
      input.source === "paid_fallback" ||
      confidence < 0.85,
    normalizerVersion: MERCHANT_KEY_VERSION,
    ...(input.rulesVersion === undefined
      ? {}
      : { rulesVersion: input.rulesVersion }),
    ...(input.modelVersion === undefined
      ? {}
      : { modelVersion: input.modelVersion }),
    ...(input.promptVersion === undefined
      ? {}
      : { promptVersion: input.promptVersion }),
  };
}

function resolveRuleChoice(
  catalog: CategoryCatalog,
  categoryName: string,
  subcategoryName: string | null,
): ExplicitCategoryChoice | null {
  const normalize = (value: string) => normalizeSourceCategoryLabel(value);
  const category = catalog.categories.find(
    (item) => normalize(item.name) === normalize(categoryName),
  );
  if (category === undefined) {
    return null;
  }
  if (subcategoryName === null) {
    return { categoryId: category.id };
  }
  const subcategory = catalog.subcategories.find(
    (item) =>
      item.categoryId === category.id &&
      normalize(item.name) === normalize(subcategoryName),
  );
  return subcategory === undefined
    ? null
    : { categoryId: category.id, subcategoryId: subcategory.id };
}

function matchingSourceMapping(
  row: BatchCategorizationRow,
  mappings: readonly SourceCategoryMapping[],
): SourceCategoryMapping | null {
  if (row.source === undefined || row.sourceCategory === undefined) {
    return null;
  }
  const label = normalizeSourceCategoryLabel(row.sourceCategory);
  return (
    mappings.find(
      (mapping) =>
        mapping.isActive &&
        mapping.householdId === row.householdId &&
        mapping.source === row.source &&
        mapping.rowKind === row.kind &&
        (mapping.normalizedSourceLabel ??
          normalizeSourceCategoryLabel(mapping.sourceLabel)) === label,
    ) ?? null
  );
}

/**
 * Resolve deterministic precedence once for an entire preview and emit grouped
 * AI work only for unresolved included expense rows.
 */
export function planCategorizationBatch(
  inputRows: readonly BatchCategorizationRow[],
  options: BatchCategorizationOptions,
): BatchCategorizationPlan {
  const memoryEntries = options.memoryEntries ?? [];
  const sourceMappings = options.sourceMappings ?? [];
  const rules = options.rules ?? defaultRuleSet();
  const maxAi = Math.max(
    0,
    Math.min(
      options.maxAiSignatures ?? MAX_AI_ITEMS_PER_PREVIEW,
      MAX_AI_ITEMS_PER_PREVIEW,
    ),
  );
  const rows: BatchCategorizationRowPlan[] = [];
  const grouped = new Map<
    string,
    { requestKey: string; item: AiSuggestionRequestItem }
  >();

  for (const row of inputRows) {
    const merchantKey = normalizeMerchantKey(row.description);
    const context: CategorizationContext = {
      householdId: row.householdId,
      description: row.description,
      kind: row.kind,
      merchantKey,
      ...(row.amountCents === undefined
        ? {}
        : { amountCents: row.amountCents }),
      ...(row.occurredOn === undefined ? {} : { occurredOn: row.occurredOn }),
    };
    const base: BatchCategorizationRowPlan = {
      rowKey: row.rowKey,
      merchantKey,
      status: "unresolved",
      selection: null,
      candidates: [],
    };

    if (row.included === false) {
      rows.push(base);
      continue;
    }
    if (row.explicitChoice !== undefined) {
      const choice = validChoice(
        options.catalog,
        row.explicitChoice.categoryId,
        row.explicitChoice.subcategoryId,
      );
      rows.push(
        choice === null
          ? base
          : {
              ...base,
              status: "selected",
              selection: { ...choice, source: "user" },
            },
      );
      continue;
    }

    const memory = matchMemory(context, [...memoryEntries]);
    if (memory?.matchKind === "suppress") {
      rows.push({
        ...base,
        status: "suppressed",
        suppressionExplanation: bounded(memory.explanation, 240),
      });
      continue;
    }
    if (memory?.categoryId !== undefined && memory.categoryId !== null) {
      const choice = validChoice(
        options.catalog,
        memory.categoryId,
        memory.subcategoryId,
      );
      if (choice !== null) {
        const result = candidate({
          choice,
          source: "memory",
          confidence: Math.max(memory.confidence, 0.97),
          explanation: describeMemory(memory, options.catalog),
        });
        rows.push({
          ...base,
          status: "selected",
          selection: { ...choice, source: "memory" },
          candidates: [result],
        });
        continue;
      }
    }

    const mapping = matchingSourceMapping(row, sourceMappings);
    if (mapping !== null) {
      if (mapping.suppress || mapping.categoryId === null) {
        rows.push({
          ...base,
          status: "suppressed",
          suppressionExplanation:
            mapping.explanation ??
            `Categoria da origem "${mapping.sourceLabel}" suprimida pelo usuário.`,
        });
        continue;
      }
      const choice = validChoice(
        options.catalog,
        mapping.categoryId,
        mapping.subcategoryId,
      );
      if (choice !== null) {
        const result = candidate({
          choice,
          source: "source_mapping",
          confidence: mapping.confidence ?? 0.95,
          explanation:
            mapping.explanation ??
            `Categoria do arquivo "${mapping.sourceLabel}" mapeada pelo usuário.`,
        });
        rows.push({
          ...base,
          status: "selected",
          selection: { ...choice, source: "source_mapping" },
          candidates: [result],
        });
        continue;
      }
    }

    const rule = matchRules(context, [...rules]);
    if (rule !== null) {
      const choice = resolveRuleChoice(
        options.catalog,
        rule.categoryName,
        rule.subcategoryName,
      );
      if (choice !== null) {
        const result = candidate({
          choice,
          source: "rule",
          confidence: rule.confidence,
          explanation: rule.explanation,
          rulesVersion: options.rulesVersion,
        });
        rows.push({
          ...base,
          status: "selected",
          selection: { ...choice, source: "rule" },
          candidates: [result],
        });
        continue;
      }
    }

    if (row.kind !== "expense") {
      rows.push(base);
      continue;
    }
    const groupKey = [
      merchantKey,
      row.source ?? "",
      normalizeSourceCategoryLabel(row.sourceCategory ?? ""),
    ].join("\u0000");
    let group = grouped.get(groupKey);
    if (group === undefined && grouped.size < maxAi) {
      const requestKey = `category-signature-${String(grouped.size + 1).padStart(4, "0")}`;
      const item: AiSuggestionRequestItem = {
        requestKey,
        merchantKey: bounded(merchantKey, 120),
        description: bounded(row.description, 200),
        ...(row.amountCents === undefined
          ? {}
          : { amountCents: row.amountCents }),
        ...(row.occurredOn === undefined ? {} : { occurredOn: row.occurredOn }),
        ...(row.sourceCategory === undefined
          ? {}
          : { sourceCategory: bounded(row.sourceCategory, 100) }),
      };
      group = { requestKey, item };
      grouped.set(groupKey, group);
    }
    rows.push(
      group === undefined ? base : { ...base, aiRequestKey: group.requestKey },
    );
  }
  return { rows, aiItems: [...grouped.values()].map(({ item }) => item) };
}

export function chunkAiSuggestionItems(
  items: readonly AiSuggestionRequestItem[],
  chunkSize = MAX_AI_ITEMS_PER_CHUNK,
): AiSuggestionRequestItem[][] {
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_AI_ITEMS_PER_CHUNK
  ) {
    throw new Error(
      `chunkSize must be between 1 and ${MAX_AI_ITEMS_PER_CHUNK}`,
    );
  }
  const chunks: AiSuggestionRequestItem[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

const requestItemSchema = z
  .object({
    requestKey: z.string().min(1).max(64),
    merchantKey: z.string().max(120),
    description: z.string().min(1).max(200),
    amountCents: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    occurredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    sourceCategory: z.string().min(1).max(100).optional(),
  })
  .strict();

const catalogCategorySchema = z
  .object({ id: boundedId, name: z.string().min(1).max(80) })
  .strict();
const catalogSubcategorySchema = z
  .object({
    id: boundedId,
    categoryId: boundedId,
    name: z.string().min(1).max(80),
  })
  .strict();

export const aiBatchRequestSchema = z
  .object({
    schemaVersion: z.literal(AI_BATCH_SCHEMA_VERSION),
    items: z.array(requestItemSchema).min(1).max(MAX_AI_ITEMS_PER_CHUNK),
    catalog: z
      .object({
        categories: z.array(catalogCategorySchema).max(100),
        subcategories: z.array(catalogSubcategorySchema).max(500),
      })
      .strict(),
  })
  .strict();

const suggestionReplySchema = z
  .object({
    requestKey: z.string().min(1).max(64),
    status: z.literal("suggestion"),
    categoryId: boundedId,
    subcategoryId: boundedId.nullable().optional(),
    confidence: z.number().min(0).max(1),
    explanation: boundedExplanation,
  })
  .strict();
const abstainReplySchema = z
  .object({
    requestKey: z.string().min(1).max(64),
    status: z.literal("abstain"),
    explanation: z.string().max(240).optional(),
  })
  .strict();
const proposalReplySchema = z
  .object({
    requestKey: z.string().min(1).max(64),
    status: z.literal("proposal"),
    categoryName: z.string().min(1).max(80),
    subcategoryName: z.string().min(1).max(80).nullable().optional(),
    confidence: z.number().min(0).max(1),
    explanation: boundedExplanation,
  })
  .strict();

export const aiBatchReplyItemSchema = z.discriminatedUnion("status", [
  suggestionReplySchema,
  abstainReplySchema,
  proposalReplySchema,
]);
export type AiBatchReplyItem = z.infer<typeof aiBatchReplyItemSchema>;

export const aiBatchReplyEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(AI_BATCH_SCHEMA_VERSION),
    items: z.array(z.unknown()).max(MAX_AI_ITEMS_PER_CHUNK),
  })
  .strict();

export type ParsedAiBatchReply = {
  valid: AiBatchReplyItem[];
  invalidRequestKeys: string[];
  missingRequestKeys: string[];
};

/** Validate siblings independently so one malformed model item is isolated. */
export function parseAiBatchReply(
  value: unknown,
  expectedRequestKeys: readonly string[],
): ParsedAiBatchReply {
  const expected = new Set(expectedRequestKeys);
  const envelope = aiBatchReplyEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return {
      valid: [],
      invalidRequestKeys: [],
      missingRequestKeys: [...expected],
    };
  }
  const valid: AiBatchReplyItem[] = [];
  const invalid = new Set<string>();
  const seen = new Set<string>();
  for (const raw of envelope.data.items) {
    const parsed = aiBatchReplyItemSchema.safeParse(raw);
    const possibleKey =
      typeof raw === "object" && raw !== null && "requestKey" in raw
        ? (raw as { requestKey?: unknown }).requestKey
        : undefined;
    if (!parsed.success) {
      if (typeof possibleKey === "string" && expected.has(possibleKey)) {
        invalid.add(possibleKey);
      }
      continue;
    }
    if (!expected.has(parsed.data.requestKey)) {
      continue;
    }
    if (seen.has(parsed.data.requestKey)) {
      invalid.add(parsed.data.requestKey);
      const firstIndex = valid.findIndex(
        (item) => item.requestKey === parsed.data.requestKey,
      );
      if (firstIndex !== -1) {
        valid.splice(firstIndex, 1);
      }
      continue;
    }
    seen.add(parsed.data.requestKey);
    valid.push(parsed.data);
  }
  const missing = [...expected].filter(
    (key) => !seen.has(key) || invalid.has(key),
  );
  return {
    valid,
    invalidRequestKeys: [...invalid],
    missingRequestKeys: missing,
  };
}

export type TaxonomyProposal = {
  requestKey: string;
  provider: "codex" | "paid_fallback";
  categoryName: string;
  subcategoryName: string | null;
  confidence: number;
  explanation: string;
};

export type AppliedAiBatch = {
  plan: BatchCategorizationPlan;
  proposals: TaxonomyProposal[];
  rejectedRequestKeys: string[];
};

/** Fan a provider result back to grouped rows without overwriting selections. */
export function applyAiBatchReply(
  plan: BatchCategorizationPlan,
  parsed: ParsedAiBatchReply,
  provider: "codex" | "paid_fallback",
  catalog: CategoryCatalog,
  versions: { modelVersion: string; promptVersion: string },
): AppliedAiBatch {
  const byKey = new Map(parsed.valid.map((item) => [item.requestKey, item]));
  const proposals: TaxonomyProposal[] = [];
  const rejected = new Set([
    ...parsed.invalidRequestKeys,
    ...parsed.missingRequestKeys,
  ]);
  for (const item of parsed.valid) {
    if (item.status === "proposal") {
      proposals.push({
        requestKey: item.requestKey,
        provider,
        categoryName: item.categoryName,
        subcategoryName: item.subcategoryName ?? null,
        confidence: item.confidence,
        explanation: item.explanation,
      });
    }
  }
  const rows = plan.rows.map((row): BatchCategorizationRowPlan => {
    if (row.status !== "unresolved" || row.aiRequestKey === undefined) {
      return row;
    }
    const reply = byKey.get(row.aiRequestKey);
    if (reply?.status !== "suggestion") {
      return row;
    }
    const choice = validChoice(catalog, reply.categoryId, reply.subcategoryId);
    if (choice === null) {
      rejected.add(row.aiRequestKey);
      return row;
    }
    const result = candidate({
      choice,
      source: provider,
      confidence: reply.confidence,
      explanation: reply.explanation,
      modelVersion: versions.modelVersion,
      promptVersion: versions.promptVersion,
    });
    return {
      ...row,
      status: "selected",
      selection: { ...choice, source: provider },
      candidates: [...row.candidates, result].slice(
        0,
        MAX_SUGGESTION_CANDIDATES,
      ),
    };
  });
  return {
    plan: { ...plan, rows },
    proposals,
    rejectedRequestKeys: [...rejected],
  };
}
