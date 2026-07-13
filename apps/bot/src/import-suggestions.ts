import { z } from "zod";

import type { AiCompletionClient } from "@family-finance/categorization";

import {
  runCodexStructured,
  type CodexProcessRunner,
  type StructuredCodexOutcome,
} from "./codex.js";

const categorySchema = z
  .object({ id: z.string().min(1).max(128), name: z.string().min(1).max(120) })
  .strict();
const subcategorySchema = z
  .object({
    id: z.string().min(1).max(128),
    categoryId: z.string().min(1).max(128),
    name: z.string().min(1).max(120),
  })
  .strict();

const requestCatalogAndItemsSchema = {
  catalog: z
    .object({
      categories: z.array(categorySchema).max(100),
      subcategories: z.array(subcategorySchema).max(500),
    })
    .strict(),
  items: z
    .array(
      z
        .object({
          key: z.string().min(1).max(128),
          description: z.string().min(1).max(200),
          amountCents: z.number().int().positive(),
          occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          merchantKey: z.string().min(1).max(160).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(25),
};

const legacyImportSuggestionRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    scopeKey: z.string().min(1).max(128),
    ...requestCatalogAndItemsSchema,
    fallback: z
      .object({ haiku: z.boolean(), maxPaidItems: z.number().int().min(0).max(25) })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.items.map((item) => item.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate item key",
      });
    }
    const categoryIds = new Set(
      value.catalog.categories.map((item) => item.id),
    );
    for (const subcategory of value.catalog.subcategories) {
      if (!categoryIds.has(subcategory.categoryId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subcategory has unknown parent",
        });
      }
    }
  });

const currentImportSuggestionRequestSchema = z
  .object({
    version: z.literal(2),
    requestId: z.string().uuid(),
    scopeKey: z.string().uuid(),
    budgetKey: z.string().uuid(),
    actorUserId: z.string().uuid(),
    ...requestCatalogAndItemsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.items.map((item) => item.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate item key",
      });
    }
    const categoryIds = new Set(
      value.catalog.categories.map((item) => item.id),
    );
    for (const subcategory of value.catalog.subcategories) {
      if (!categoryIds.has(subcategory.categoryId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subcategory has unknown parent",
        });
      }
    }
  });

export const importSuggestionRequestSchema = z.union([
  legacyImportSuggestionRequestSchema,
  currentImportSuggestionRequestSchema,
]);

export type ImportSuggestionRequest = z.infer<
  typeof importSuggestionRequestSchema
>;

const candidateSchema = z
  .object({
    categoryId: z.string().min(1).max(128),
    subcategoryId: z.string().min(1).max(128).nullable(),
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1).max(240),
  })
  .strict();
const proposalSchema = z
  .object({
    kind: z.enum(["category", "subcategory"]),
    categoryName: z.string().min(1).max(120),
    subcategoryName: z.string().min(1).max(120).nullable(),
    explanation: z.string().min(1).max(240),
  })
  .strict();
const modelItemSchema = z
  .object({
    key: z.string().min(1).max(128),
    candidates: z.array(candidateSchema).max(3),
    proposedTaxonomyChange: proposalSchema.nullable(),
  })
  .strict();
const modelResultSchema = z
  .object({ items: z.array(modelItemSchema).max(25) })
  .strict();

export type ImportSuggestionCandidate = z.infer<typeof candidateSchema> & {
  provider: "codex" | "paid_fallback";
};
export type ImportSuggestionItem = {
  key: string;
  candidates: ImportSuggestionCandidate[];
  proposedTaxonomyChange:
    | (z.infer<typeof proposalSchema> & {
        provider: "codex" | "paid_fallback";
      })
    | null;
};

export type ImportSuggestionResponse = {
  version: 1 | 2;
  requestId: string;
  outcome: "success" | "partial" | "unavailable";
  providerRuns: Array<{
    provider: "codex" | "paid_fallback";
    model: string;
    outcome:
      | StructuredCodexOutcome
      | "disabled"
      | "success"
      | "invalid_schema"
      | "error";
    attemptedItems: number;
    resolvedItems: number;
    latencyMs: number;
  }>;
  items: ImportSuggestionItem[];
  unresolvedKeys: string[];
};

export const IMPORT_SUGGESTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "candidates", "proposedTaxonomyChange"],
        properties: {
          key: { type: "string" },
          candidates: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "categoryId",
                "subcategoryId",
                "confidence",
                "explanation",
              ],
              properties: {
                categoryId: { type: "string" },
                subcategoryId: { type: ["string", "null"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                explanation: { type: "string" },
              },
            },
          },
          proposedTaxonomyChange: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "kind",
                  "categoryName",
                  "subcategoryName",
                  "explanation",
                ],
                properties: {
                  kind: { enum: ["category", "subcategory"] },
                  categoryName: { type: "string" },
                  subcategoryName: { type: ["string", "null"] },
                  explanation: { type: "string" },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;

function buildPrompt(request: ImportSuggestionRequest): string {
  return [
    "Você categoriza lançamentos financeiros brasileiros em lote.",
    "Ação obrigatória: sugerir somente; nunca crie, edite ou persista dados.",
    "Use somente categoryId/subcategoryId do catálogo e preserve cada key.",
    "Retorne até 3 candidatos ranqueados. Se não houver boa opção, candidates deve ser vazio.",
    "Uma categoria nova pode aparecer apenas em proposedTaxonomyChange para revisão humana; nunca em candidates.",
    "Não confunda o propósito de planejamento com o que foi comprado.",
    `Catálogo: ${JSON.stringify(request.catalog)}`,
    `Itens: ${JSON.stringify(request.items)}`,
  ].join("\n");
}

function validatedModelResult(
  value: unknown,
  request: ImportSuggestionRequest,
): z.infer<typeof modelResultSchema> | null {
  const envelope = z
    .object({ items: z.array(z.unknown()).max(25) })
    .strict()
    .safeParse(value);
  if (!envelope.success) return null;
  const requestedKeys = new Set(request.items.map((item) => item.key));
  const categoryIds = new Set(
    request.catalog.categories.map((item) => item.id),
  );
  const subcategories = new Map(
    request.catalog.subcategories.map((item) => [item.id, item]),
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const valid: z.infer<typeof modelItemSchema>[] = [];
  for (const raw of envelope.data.items) {
    const parsedItem = modelItemSchema.safeParse(raw);
    if (!parsedItem.success) continue;
    const item = parsedItem.data;
    if (!requestedKeys.has(item.key)) continue;
    if (seen.has(item.key)) {
      duplicates.add(item.key);
      continue;
    }
    seen.add(item.key);
    let itemValid = true;
    for (const candidate of item.candidates) {
      if (!categoryIds.has(candidate.categoryId)) itemValid = false;
      if (candidate.subcategoryId !== null) {
        const subcategory = subcategories.get(candidate.subcategoryId);
        if (subcategory?.categoryId !== candidate.categoryId) itemValid = false;
      }
    }
    if (itemValid) valid.push(item);
  }
  return { items: valid.filter((item) => !duplicates.has(item.key)) };
}

function parseCompletionJson(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createImportSuggestionHandler(args: {
  codexEnabled: boolean;
  codexModel: string;
  codexTimeoutMs: number;
  codexHome: string;
  codexRunner?: CodexProcessRunner;
  paidFallbackEnabled: boolean;
  paidFallbackMaxItems: number;
  paidFallbackProvider: string;
  paidFallbackModel: string;
  paidFallbackClient?: AiCompletionClient;
  reservePaidItems: (input: {
    householdId: string;
    budgetKey: string;
    attemptKey: string;
    requestedItems: number;
    previewMaxItems: number;
    createdByUserId: string;
  }) => Promise<number>;
  recordPaidResult: (input: {
    householdId: string;
    attemptKey: string;
    provider: string;
    model: string;
    outcome: "success" | "invalid_schema" | "error";
    resolvedItems: number;
    latencyMs: number;
  }) => Promise<void>;
}): (body: unknown) => Promise<{ status: number; body: unknown }> {
  let active = 0;
  return async (body) => {
    const parsed = importSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: "invalid request" } };
    }
    if (active >= 2) {
      return { status: 503, body: { ok: false, error: "service saturated" } };
    }
    active += 1;
    try {
      const request = parsed.data;
      const providerRuns: ImportSuggestionResponse["providerRuns"] = [];
      const resolved = new Map<string, ImportSuggestionItem>();
      const codexReturnedKeys = new Set<string>();
      let codexOutcome: StructuredCodexOutcome | "disabled" = "disabled";

      if (args.codexEnabled) {
        const codex = await runCodexStructured({
          prompt: buildPrompt(request),
          outputSchema: IMPORT_SUGGESTION_OUTPUT_SCHEMA,
          validate: (value) => validatedModelResult(value, request),
          model: args.codexModel,
          timeoutMs: args.codexTimeoutMs,
          codexHome: args.codexHome,
          runner: args.codexRunner,
        });
        codexOutcome = codex.outcome;
        for (const item of codex.data?.items ?? []) {
          codexReturnedKeys.add(item.key);
        }
        providerRuns.push({
          provider: "codex",
          model: args.codexModel,
          outcome: codex.outcome,
          attemptedItems: request.items.length,
          resolvedItems: (codex.data?.items ?? []).filter(
            (item) =>
              item.candidates.length > 0 ||
              item.proposedTaxonomyChange !== null,
          ).length,
          latencyMs: codex.latencyMs,
        });
        for (const item of codex.data?.items ?? []) {
          if (
            item.candidates.length > 0 ||
            item.proposedTaxonomyChange !== null
          ) {
            resolved.set(item.key, {
              key: item.key,
              proposedTaxonomyChange:
                item.proposedTaxonomyChange === null
                  ? null
                  : {
                      ...item.proposedTaxonomyChange,
                      provider: "codex" as const,
                    },
              candidates: item.candidates.map((candidate) => ({
                ...candidate,
                provider: "codex" as const,
              })),
            });
          }
        }
      } else {
        providerRuns.push({
          provider: "codex",
          model: args.codexModel,
          outcome: "disabled",
          attemptedItems: 0,
          resolvedItems: 0,
          latencyMs: 0,
        });
      }

      // A successful Codex item with an empty result is an intentional
      // abstention and stays manual. Paid fallback is reserved only for an
      // operational failure or a key missing from otherwise-valid output.
      const operationallyMissing =
        codexOutcome === "success"
          ? request.items.filter((item) => !codexReturnedKeys.has(item.key))
          : request.items;
      if (
        request.version === 2 &&
        args.paidFallbackEnabled &&
        args.paidFallbackClient !== undefined &&
        operationallyMissing.length > 0 &&
        args.paidFallbackMaxItems > 0
      ) {
        const requestedItems = Math.min(
          operationallyMissing.length,
          args.paidFallbackMaxItems,
        );
        let allowedItems = 0;
        try {
          allowedItems = await args.reservePaidItems({
            householdId: request.scopeKey,
            budgetKey: request.budgetKey,
            attemptKey: request.requestId,
            requestedItems,
            previewMaxItems: args.paidFallbackMaxItems,
            createdByUserId: request.actorUserId,
          });
        } catch {
          allowedItems = 0;
        }
        const paidItems = operationallyMissing.slice(0, allowedItems);
        if (paidItems.length > 0) {
          const started = Date.now();
          const paidRequest = { ...request, items: paidItems };
          const reply = await args.paidFallbackClient
            .complete(buildPrompt(paidRequest), {
              label: "import_category_paid_fallback",
            })
            .catch(() => null);
          const data =
            reply === null
              ? null
              : validatedModelResult(parseCompletionJson(reply), paidRequest);
          const outcome =
            data === null
              ? reply === null
                ? ("error" as const)
                : ("invalid_schema" as const)
              : ("success" as const);
          let resolvedItems = 0;
          for (const item of data?.items ?? []) {
            if (
              item.candidates.length > 0 ||
              item.proposedTaxonomyChange !== null
            ) {
              resolvedItems += 1;
              resolved.set(item.key, {
                key: item.key,
                proposedTaxonomyChange:
                  item.proposedTaxonomyChange === null
                    ? null
                    : {
                        ...item.proposedTaxonomyChange,
                        provider: "paid_fallback" as const,
                      },
                candidates: item.candidates.map((candidate) => ({
                  ...candidate,
                  provider: "paid_fallback" as const,
                })),
              });
            }
          }
          const latencyMs = Date.now() - started;
          providerRuns.push({
            provider: "paid_fallback",
            model: args.paidFallbackModel,
            outcome,
            attemptedItems: paidItems.length,
            resolvedItems,
            latencyMs,
          });
          await args
            .recordPaidResult({
              householdId: request.scopeKey,
              attemptKey: request.requestId,
              provider: args.paidFallbackProvider,
              model: args.paidFallbackModel,
              outcome,
              resolvedItems,
              latencyMs,
            })
            .catch(() => undefined);
        }
      }

      const unresolvedKeys = request.items
        .map((item) => item.key)
        .filter((key) => !resolved.has(key));
      const response: ImportSuggestionResponse = {
        version: request.version,
        requestId: request.requestId,
        outcome:
          resolved.size === 0
            ? "unavailable"
            : unresolvedKeys.length === 0
              ? "success"
              : "partial",
        providerRuns,
        items: request.items.flatMap((item) => {
          const result = resolved.get(item.key);
          return result === undefined ? [] : [result];
        }),
        unresolvedKeys,
      };
      return { status: 200, body: response };
    } finally {
      active -= 1;
    }
  };
}
