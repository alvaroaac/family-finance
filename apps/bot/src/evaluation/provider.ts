import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { z } from "zod";

import type { EvalPrediction, PredictionRecord } from "./types.js";
import { createNodeCodexRunner, type CodexProcessRunner } from "../codex.js";

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

const candidateSchema = z
  .object({
    purpose: z.string().nullable(),
    category: z.string().min(1),
    subcategory: z.string().nullable(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
const evalPredictionSchema = z
  .object({
    intent: z.string().min(1),
    fields: z
      .object({
        merchant: z.string().nullable(),
        item: z.string().nullable(),
        description: z.string().nullable(),
        amount_kind: z.string().nullable(),
        amount_cents: z.number().nullable(),
        monthly_amount_cents: z.number().nullable(),
        installment_count: z.number().nullable(),
        card: z.string().nullable(),
        occurred_on: z.string().nullable(),
        due_day: z.number().nullable(),
        term_months: z.number().nullable(),
      })
      .strict(),
    categorization: z
      .object({
        decision: z.enum(["single", "choose", "propose_new", "abstain"]),
        candidates: z.array(candidateSchema).max(3),
        proposal: z
          .object({
            kind: z.enum(["category", "subcategory"]),
            category: z.string().min(1),
            subcategory: z.string().nullable(),
            reason: z.string(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    accounting: z
      .object({
        cash_flow: z.enum(["outflow", "inflow", "neutral"]),
        available_balance: z.enum(["subtract", "add", "unchanged"]),
        accounting_expense: z.enum(["include", "exclude"]),
        consumption_spend: z.enum(["include", "exclude"]),
        destination: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const CODEX_EVAL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "fields", "categorization", "accounting"],
  properties: {
    intent: { type: "string" },
    fields: {
      type: "object",
      additionalProperties: false,
      required: [
        "merchant",
        "item",
        "description",
        "amount_kind",
        "amount_cents",
        "monthly_amount_cents",
        "installment_count",
        "card",
        "occurred_on",
        "due_day",
        "term_months",
      ],
      properties: {
        merchant: { type: ["string", "null"] },
        item: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        amount_kind: { type: ["string", "null"] },
        amount_cents: { type: ["number", "null"] },
        monthly_amount_cents: { type: ["number", "null"] },
        installment_count: { type: ["number", "null"] },
        card: { type: ["string", "null"] },
        occurred_on: { type: ["string", "null"] },
        due_day: { type: ["number", "null"] },
        term_months: { type: ["number", "null"] },
      },
    },
    categorization: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "candidates", "proposal"],
      properties: {
        decision: { enum: ["single", "choose", "propose_new", "abstain"] },
        candidates: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["purpose", "category", "subcategory", "confidence"],
            properties: {
              purpose: { type: ["string", "null"] },
              category: { type: "string" },
              subcategory: { type: ["string", "null"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
        proposal: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "category", "subcategory", "reason"],
              properties: {
                kind: { enum: ["category", "subcategory"] },
                category: { type: "string" },
                subcategory: { type: ["string", "null"] },
                reason: { type: "string" },
              },
            },
          ],
        },
      },
    },
    accounting: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "cash_flow",
            "available_balance",
            "accounting_expense",
            "consumption_spend",
            "destination",
          ],
          properties: {
            cash_flow: { enum: ["outflow", "inflow", "neutral"] },
            available_balance: { enum: ["subtract", "add", "unchanged"] },
            accounting_expense: { enum: ["include", "exclude"] },
            consumption_spend: { enum: ["include", "exclude"] },
            destination: { type: ["string", "null"] },
          },
        },
      ],
    },
  },
} as const;

export async function completeCodexEvaluation(args: {
  prompt: string;
  model: string;
  timeoutMs: number;
  codexHome?: string;
  runner?: CodexProcessRunner;
}): Promise<{ prediction: EvalPrediction; usage: null }> {
  const temp = await mkdtemp(join(tmpdir(), "family-finance-eval-codex-"));
  const cwd = join(temp, "empty");
  const schemaPath = join(temp, "schema.json");
  const outputPath = join(temp, "output.json");
  try {
    await Promise.all([
      mkdir(cwd),
      writeFile(schemaPath, JSON.stringify(CODEX_EVAL_OUTPUT_SCHEMA), "utf8"),
    ]);
    const result = await (args.runner ?? createNodeCodexRunner())({
      prompt: args.prompt,
      schemaPath,
      outputPath,
      cwd,
      codexHome:
        args.codexHome ??
        process.env.CODEX_HOME ??
        join(tmpdir(), "family-finance-eval-codex-home"),
      model: args.model,
      timeoutMs: args.timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0 || result.timedOut || result.errorCode) {
      throw new Error("Codex evaluation invocation failed");
    }
    const parsed = evalPredictionSchema.safeParse(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
    if (!parsed.success) throw new Error("Codex evaluation schema invalid");
    return { prediction: parsed.data, usage: null };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
