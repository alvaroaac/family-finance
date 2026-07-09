import type { EvalPrediction } from "./types.js";

export type ModelTarget = {
  provider: "anthropic" | "openai";
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
      if (provider !== "anthropic" && provider !== "openai") {
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
): Promise<EvalPrediction> {
  if (target.provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
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
    };
    const text = body.content?.find((part) => part.type === "text")?.text;
    if (!text) {
      throw new Error("Anthropic response contained no text");
    }
    return extractJson(text);
  }

  // Intentionally use plain single-turn text on both providers. Provider-
  // specific structured-output features would make the comparison unfair.
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
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
  };
  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!text) {
    throw new Error("OpenAI response contained no output_text");
  }
  return extractJson(text);
}
