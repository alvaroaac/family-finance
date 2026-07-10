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

export const importSuggestionRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    scopeKey: z.string().min(1).max(128),
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
    fallback: z
      .object({
        haiku: z.boolean(),
        maxPaidItems: z.number().int().min(0).max(25),
      })
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
  provider: "codex" | "haiku";
};
export type ImportSuggestionItem = {
  key: string;
  candidates: ImportSuggestionCandidate[];
  proposedTaxonomyChange:
    | (z.infer<typeof proposalSchema> & { provider: "codex" | "haiku" })
    | null;
};

export type ImportSuggestionResponse = {
  version: 1;
  requestId: string;
  outcome: "success" | "partial" | "unavailable";
  providerRuns: Array<{
    provider: "codex" | "haiku";
    outcome: StructuredCodexOutcome | "success" | "invalid_schema" | "error";
    itemCount: number;
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
  haikuClient?: AiCompletionClient;
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
        providerRuns.push({
          provider: "codex",
          outcome: codex.outcome,
          itemCount: request.items.length,
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
      }

      const unresolved = request.items.filter(
        (item) => !resolved.has(item.key),
      );
      const paidItems = unresolved.slice(0, request.fallback.maxPaidItems);
      if (
        request.fallback.haiku &&
        args.haikuClient !== undefined &&
        paidItems.length > 0
      ) {
        const started = Date.now();
        const paidRequest = { ...request, items: paidItems };
        const reply = await args.haikuClient
          .complete(buildPrompt(paidRequest), {
            label: "import_category_fallback",
          })
          .catch(() => null);
        const data =
          reply === null
            ? null
            : validatedModelResult(parseCompletionJson(reply), paidRequest);
        providerRuns.push({
          provider: "haiku",
          outcome:
            data === null
              ? reply === null
                ? "error"
                : "invalid_schema"
              : "success",
          itemCount: paidItems.length,
          latencyMs: Date.now() - started,
        });
        for (const item of data?.items ?? []) {
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
                      provider: "haiku" as const,
                    },
              candidates: item.candidates.map((candidate) => ({
                ...candidate,
                provider: "haiku" as const,
              })),
            });
          }
        }
      }

      const unresolvedKeys = request.items
        .map((item) => item.key)
        .filter((key) => !resolved.has(key));
      const response: ImportSuggestionResponse = {
        version: 1,
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
