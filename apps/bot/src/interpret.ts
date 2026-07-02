/**
 * LLM text interpretation fallback for the Telegram bot (spec §3.4).
 *
 * When the deterministic parser (`parseExpenseText`) cannot extract an amount
 * from a message, the conversation layer may pass the ORIGINAL text through
 * this interpreter: a single pt-BR prompt asks the model for a STRICT JSON
 * object with the expense fields, validated here with zod.
 *
 * Fallback, NOT replacement: the result feeds the exact same draft +
 * confirmation flow — the model never saves anything and the user always sees
 * the editable summary and must "confirmar". Any API/parse/validation failure
 * returns `null`, so callers keep today's "rephrase" behavior unchanged.
 *
 * Reuses the provider-agnostic `AiCompletionClient` interface the
 * categorization engine already injects (Anthropic in production), so the bot
 * has ONE completion client for both features.
 */

import { z } from "zod";

import type { AiCompletionClient } from "@family-finance/categorization";

/** What the model extracted from a free-text expense message. */
export type InterpretedExpense = {
  /** BRL integer cents, when the model could extract a value. */
  amountCents?: number;
  /** Short merchant/description text. */
  description: string;
  /** ISO date (YYYY-MM-DD) the expense occurred on, when mentioned. */
  occurredOn?: string;
  /** Free-text category suggestion — context for the engine, NEVER an id. */
  categoryHint?: string;
  /** Free-text responsible-person name — resolved by the conversation layer. */
  responsibleHint?: string;
};

export type TextInterpreter = (
  text: string,
  options: { today: string },
) => Promise<InterpretedExpense | null>;

/** Strict schema for the JSON object the prompt demands from the model. */
const interpretedReplySchema = z.object({
  amount_cents: z.number().int().positive().nullish(),
  description: z.string().min(1),
  occurred_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  category_hint: z.string().min(1).nullish(),
  responsible_hint: z.string().min(1).nullish(),
});

/**
 * Build the pt-BR extraction prompt. `today` lets the model resolve relative
 * dates ("ontem", "sábado passado") into ISO dates. The output contract is a
 * single strict JSON object (or the literal `null` when nothing is extractable).
 */
export function buildInterpretationPrompt(text: string, today: string): string {
  return [
    "Você ajuda uma família brasileira a registrar despesas a partir de mensagens informais de Telegram.",
    `Hoje é ${today}.`,
    "",
    "Extraia os campos da despesa descrita na mensagem abaixo.",
    `Mensagem: "${text}"`,
    "",
    "Responda APENAS com um objeto JSON, sem texto extra, no formato:",
    '{"amount_cents": number | null, "description": string, "occurred_on": "YYYY-MM-DD" | null, "category_hint": string | null, "responsible_hint": string | null}',
    "",
    "Regras:",
    "- amount_cents é o valor em CENTAVOS de real (R$ 32,50 -> 3250); null se a mensagem não indicar valor.",
    "- description é um resumo curto do que foi comprado/pago, em português.",
    '- occurred_on resolve datas relativas ("ontem", "sábado") usando a data de hoje; null se não houver data.',
    '- category_hint é uma sugestão livre de categoria (ex.: "Alimentação"); null se não estiver claro.',
    '- responsible_hint é o nome da pessoa responsável, SOMENTE se a mensagem citar uma (ex.: "foi a Karol quem pagou"); null caso contrário.',
    "- Se a mensagem não descrever uma despesa, responda exatamente: null",
  ].join("\n");
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
 * Create a {@link TextInterpreter} backed by an injected completion client.
 * Returns `null` on ANY failure (client abstains/throws, no JSON, malformed
 * JSON, schema mismatch) so the conversation keeps its deterministic behavior.
 */
export function createTextInterpreter(
  client: AiCompletionClient,
): TextInterpreter {
  return async (text, options) => {
    try {
      const reply = await client.complete(
        buildInterpretationPrompt(text, options.today),
      );
      if (reply === null) {
        return null;
      }
      const json = extractJsonObject(reply);
      if (json === null) {
        return null;
      }
      const parsed = interpretedReplySchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        return null;
      }
      const data = parsed.data;
      return {
        amountCents: data.amount_cents ?? undefined,
        description: data.description,
        occurredOn: data.occurred_on ?? undefined,
        categoryHint: data.category_hint ?? undefined,
        responsibleHint: data.responsible_hint ?? undefined,
      };
    } catch {
      // Includes JSON.parse errors and client/network failures.
      return null;
    }
  };
}
