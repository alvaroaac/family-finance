import type { BotEnv } from "@family-finance/config";
import {
  createAiCategorizer,
  type AiCategorizer,
} from "@family-finance/categorization";
import { createOpenAiCompletionClient } from "./providers.js";
import {
  createJevCategorizer,
  createJevClient,
  type JevClient,
} from "./jev.js";
import { DEFAULT_OPENAI_MODEL } from "@family-finance/config";

const CATEGORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categoryName", "subcategoryName", "confidence", "explanation"],
  properties: {
    categoryName: { type: "string" },
    subcategoryName: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string" },
  },
};
export function createCategoryRuntime(
  env: BotEnv,
  factories = { jev: createJevClient, openai: createOpenAiCompletionClient },
): { jev: JevClient | undefined; categorizer: AiCategorizer } {
  const jev = env.TYPESAFE_API_KEY
    ? factories.jev({
        apiKey: env.TYPESAFE_API_KEY,
        model: env.JEV_MODEL,
        timeoutMs: env.JEV_TIMEOUT_MS,
      })
    : undefined;
  const fallback = env.OPENAI_API_KEY
    ? createAiCategorizer(
        factories.openai({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
          outputSchema: CATEGORY_SCHEMA,
          reasoningEffort: "none",
          timeoutMs: 4000,
        }),
      )
    : undefined;
  return { jev, categorizer: createJevCategorizer(jev, fallback) };
}
