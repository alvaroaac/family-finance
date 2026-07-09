import { join } from "node:path";
import { tmpdir } from "node:os";

import type { EvalPrediction, PredictionRecord } from "./types.js";
import type { EvalCase, Taxonomy } from "./types.js";
import { createCodexMessageClassifier } from "../codex.js";

export type ModelTarget = {
  provider: "anthropic" | "openai" | "codex";
  model: string;
};

export function parseModelTargets(value: string): ModelTarget[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator < 1 || separator === part.length - 1) {
        throw new Error(
          `Invalid model target "${part}"; use provider:model (for example anthropic:claude-haiku-4-5)`,
        );
      }
      const provider = part.slice(0, separator);
      if (
        provider !== "anthropic" &&
        provider !== "openai" &&
        provider !== "codex"
      ) {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      return { provider, model: part.slice(separator + 1) };
    });
}

function extractJson(text: string): EvalPrediction {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("model response did not contain a JSON object");
  }
  return JSON.parse(text.slice(start, end + 1)) as EvalPrediction;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for this provider`);
  }
  return value;
}

export async function completeEvaluation(
  target: ModelTarget,
  prompt: string,
  timeoutMs: number,
): Promise<{
  prediction: EvalPrediction;
  usage: NonNullable<PredictionRecord["usage"]>;
}> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (target.provider === "codex") {
    throw new Error("Codex evaluation uses completeCodexRuntimeEvaluation");
  }
  if (target.provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": requiredEnv("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: 1600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Anthropic HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.find((part) => part.type === "text")?.text;
    if (!text) {
      throw new Error("Anthropic response contained no text");
    }
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    return {
      prediction: extractJson(text),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  // Intentionally use plain single-turn text on both providers. Provider-
  // specific structured-output features would make the comparison unfair.
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: target.model,
      input: prompt,
      max_output_tokens: 1600,
      store: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!text) {
    throw new Error("OpenAI response contained no output_text");
  }
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  return {
    prediction: extractJson(text),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
    },
  };
}

export async function completeCodexRuntimeEvaluation(args: {
  entry: EvalCase;
  taxonomy: Taxonomy;
  model: string;
  timeoutMs: number;
}): Promise<{ prediction: EvalPrediction; usage: null }> {
  const categories = args.taxonomy.categories.map((category, index) => ({
    id: `category-${index}`,
    name: category.name,
  }));
  const subcategories = args.taxonomy.categories.flatMap(
    (category, categoryIndex) =>
      category.subcategories.map((name, subIndex) => ({
        id: `subcategory-${categoryIndex}-${subIndex}`,
        categoryId: `category-${categoryIndex}`,
        name,
      })),
  );
  const knownCards = (args.entry.context?.cards ?? []).map((name, index) => ({
    id: `card-${index}`,
    name,
  }));
  const classify = createCodexMessageClassifier({
    enabled: true,
    model: args.model,
    timeoutMs: args.timeoutMs,
    codexHome:
      process.env.CODEX_HOME ??
      join(tmpdir(), "family-finance-eval-codex-home"),
  });
  const result = await classify(args.entry.input.text, {
    today: args.entry.input.today,
    parserHints: {},
    knownCards,
    catalog: { categories, subcategories },
  });
  if (result === null)
    throw new Error("Codex runtime path abstained or failed");
  const fields: EvalPrediction["fields"] = {
    merchant: null,
    item: null,
    description: null,
    amount_kind: null,
    amount_cents: null,
    monthly_amount_cents: null,
    installment_count: null,
    card: null,
    occurred_on: null,
    due_day: null,
    term_months: null,
  };
  let candidates: EvalPrediction["categorization"]["candidates"] = [];
  if (result.intent === "plain") {
    fields.description = result.expense.description;
    fields.amount_cents = result.expense.amountCents ?? null;
    fields.card = result.expense.cardKeyword ?? null;
    fields.occurred_on = result.expense.occurredOn ?? null;
    candidates = (result.expense.categoryCandidates ?? []).map((candidate) => ({
      purpose: null,
      category: candidate.categoryName,
      subcategory: candidate.subcategoryName ?? null,
      confidence: candidate.confidence,
    }));
  }
  return {
    prediction: {
      intent:
        result.intent === "plain" && fields.card
          ? "plain_card_expense"
          : result.intent,
      fields,
      categorization: {
        decision:
          candidates.length > 1
            ? "choose"
            : candidates.length === 1
              ? "single"
              : "abstain",
        candidates,
        proposal: null,
      },
      accounting: null,
    },
    usage: null,
  };
}
