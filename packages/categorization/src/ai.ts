/**
 * Concrete {@link AiCategorizer} for the hybrid suggestion engine.
 *
 * Boundary: this module keeps `@family-finance/categorization` PURE. It imports
 * ONLY `zod` + sibling modules — NEVER an AI SDK. The actual provider lives
 * behind an injected {@link AiCompletionClient} interface, so the package never
 * pulls a network/SDK dependency into its build and tests mock the client with
 * no network.
 *
 * The categorizer is used by the engine ONLY as a last resort (after memory and
 * deterministic rules are uncertain — see `suggestCategory`). It builds a
 * catalog-aware prompt from the household's REAL category names, asks the client
 * for a single JSON object, and validates it. Every returned suggestion carries
 * a `confidence` (0..1) and a human `explanation`. The engine still applies the
 * "novel categories stay PENDING / never auto-created" rule, so an AI proposal
 * for a category that is not in the catalog never becomes a real category here.
 *
 * Any failure (client error, empty/non-JSON reply, missing/invalid fields)
 * degrades to `null` — the safe fallback — so AI never breaks the flow.
 */

import { z } from "zod";

import { scoreConfidence } from "./confidence.js";
import type {
  AiCategorizer,
  AiCategorySuggestion,
  CategoryCatalog,
} from "./index.js";
import type { CategorizationContext } from "./context.js";

/**
 * Provider-agnostic completion client INTERFACE. An adapter (e.g. an Anthropic
 * Claude client) implements `complete` to turn a prompt into a text reply, or
 * `null` when it cannot/should not answer. No SDK type leaks into this package.
 */
export type AiCompletionClient = {
  /** Return the model's text reply for a prompt, or null to abstain. */
  complete(prompt: string): Promise<string | null>;
};

/** Zod schema for the JSON object we expect back from the model. */
const aiReplySchema = z.object({
  categoryName: z.string().min(1),
  subcategoryName: z.string().min(1).nullable().optional(),
  confidence: z.number(),
  explanation: z.string().min(1),
});

/**
 * Build the instruction prompt. It lists the household's REAL macro categories
 * and subcategories so the model picks from what exists; novel proposals are
 * allowed but the engine keeps them pending. Output must be a single JSON object.
 */
export function buildCategorizationPrompt(
  context: CategorizationContext,
  catalog: CategoryCatalog,
): string {
  const subsByCategory = new Map<string, string[]>();
  for (const sub of catalog.subcategories) {
    const list = subsByCategory.get(sub.categoryId) ?? [];
    list.push(sub.name);
    subsByCategory.set(sub.categoryId, list);
  }
  const catalogLines = catalog.categories.map((c) => {
    const subs = subsByCategory.get(c.id) ?? [];
    return subs.length > 0
      ? `- ${c.name} (subcategorias: ${subs.join(", ")})`
      : `- ${c.name}`;
  });

  return [
    "Você é um classificador de despesas de uma família brasileira.",
    "Classifique a transação abaixo em UMA das categorias existentes quando possível.",
    "",
    "Categorias existentes:",
    ...catalogLines,
    "",
    `Descrição da transação: "${context.description}"`,
    context.amountCents !== undefined
      ? `Valor (centavos): ${context.amountCents}`
      : "",
    "",
    "Responda APENAS com um objeto JSON, sem texto extra, no formato:",
    '{"categoryName": string, "subcategoryName": string | null, "confidence": number (0 a 1), "explanation": string em português}',
    "Se não conseguir classificar com alguma segurança, responda exatamente: null",
  ]
    .filter((line) => line.length > 0 || line === "")
    .join("\n");
}

/** Pull the first balanced JSON object out of a model reply, if any. */
function extractJsonObject(reply: string): string | null {
  const start = reply.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < reply.length; i += 1) {
    const ch = reply[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return reply.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Create a concrete {@link AiCategorizer} backed by an injected completion
 * client. Returns `null` on any uncertainty/error so callers fall back safely.
 */
export function createAiCategorizer(
  client: AiCompletionClient,
): AiCategorizer {
  return {
    async categorize(
      context: CategorizationContext,
      catalog: CategoryCatalog,
    ): Promise<AiCategorySuggestion | null> {
      let reply: string | null;
      try {
        reply = await client.complete(
          buildCategorizationPrompt(context, catalog),
        );
      } catch {
        // Provider failure is never fatal: degrade to deterministic fallback.
        return null;
      }
      if (reply === null) {
        return null;
      }

      const json = extractJsonObject(reply);
      if (json === null) {
        return null;
      }

      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(json);
      } catch {
        return null;
      }

      const parsed = aiReplySchema.safeParse(parsedUnknown);
      if (!parsed.success) {
        return null;
      }

      return {
        categoryName: parsed.data.categoryName,
        subcategoryName: parsed.data.subcategoryName ?? null,
        // Clamp to [0,1]; the engine re-clamps and gates on confidence too.
        confidence: scoreConfidence(parsed.data.confidence),
        explanation: parsed.data.explanation,
      };
    },
  };
}
