/**
 * LLM text interpretation for the Telegram bot (spec §3.4).
 *
 * The conversation layer passes EVERY new entry's ORIGINAL text through this
 * interpreter (when configured) for a clean merchant description + category
 * hint: a single pt-BR prompt asks the model for a STRICT JSON object with
 * the expense fields, validated here with zod. The deterministic parser
 * remains the source of truth for amount/date — the LLM only fills what the
 * parser missed.
 *
 * Assistant, NOT decision-maker: the result feeds the exact same draft +
 * confirmation flow — the model never saves anything and the user always sees
 * the editable summary and must "confirmar". Any API/parse/validation failure
 * returns `null`, so callers keep the parser-only behavior unchanged.
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
    '- description é APENAS o nome do estabelecimento ou serviço (ex.: "OpenAI", "Uber", "Padaria"), sem palavras como "gasto", "compra" ou "valor".',
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

// ---------------------------------------------------------------------------
// Unified intent classifier (recurring-obligations design).
//
// ONE shared classifier decides what a new message is — it cannot detect
// obligations reliably without also recognizing card parcelas (to avoid
// mis-filing them). PR-1 wires plain, obligation (create) and
// mark_paid{obligation}; card_installment and mark_paid{card} are recognized
// but answered with "em breve" until PR-2.
// ---------------------------------------------------------------------------

/** What the model extracted for an `obligation` intent. */
export type InterpretedObligation = {
  description: string;
  /** PER-MONTH amount in BRL cents (the prompt owns total→per-month division). */
  monthlyAmountCents?: number;
  /** Fixed term in months; undefined = indefinite. */
  termMonths?: number;
  /** `YYYY-MM`; undefined = the caller defaults to the current month. */
  startMonth?: string;
  /** 1–28; undefined = caller default. */
  dueDay?: number;
  categoryHint?: string;
  responsibleHint?: string;
};

export type InterpretedIntent =
  | { intent: "plain"; expense: InterpretedExpense }
  | { intent: "obligation"; obligation: InterpretedObligation }
  | { intent: "card_installment" }
  | { intent: "mark_paid"; target: "obligation" | "card"; keyword: string };

export type MessageClassifier = (
  text: string,
  options: { today: string },
) => Promise<InterpretedIntent | null>;

const expensePayloadSchema = z.object({
  amount_cents: z.number().int().positive().nullish(),
  description: z.string().min(1),
  occurred_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  category_hint: z.string().min(1).nullish(),
  responsible_hint: z.string().min(1).nullish(),
});

const obligationPayloadSchema = z.object({
  description: z.string().min(1),
  monthly_amount_cents: z.number().int().positive().nullish(),
  term_months: z.number().int().positive().nullish(),
  start_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .nullish(),
  due_day: z.number().int().min(1).max(28).nullish(),
  category_hint: z.string().min(1).nullish(),
  responsible_hint: z.string().min(1).nullish(),
});

/** Strict schema for the classifier's JSON reply, discriminated on intent. */
const classifiedReplySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("plain"), expense: expensePayloadSchema }),
  z.object({
    intent: z.literal("obligation"),
    obligation: obligationPayloadSchema,
  }),
  z.object({ intent: z.literal("card_installment") }),
  z.object({
    intent: z.literal("mark_paid"),
    target: z.enum(["obligation", "card"]),
    keyword: z.string().min(1),
  }),
]);

/**
 * Build the pt-BR classification prompt. One strict JSON object out; `today`
 * resolves relative dates and "a partir de 05/10"-style start months.
 */
export function buildClassifierPrompt(text: string, today: string): string {
  return [
    "Você ajuda uma família brasileira a registrar finanças a partir de mensagens informais de Telegram.",
    `Hoje é ${today}.`,
    "",
    "Classifique a mensagem abaixo em UMA intenção e extraia os campos.",
    `Mensagem: "${text}"`,
    "",
    "Intenções possíveis:",
    '- "plain": uma despesa avulsa (ex.: "mercado 230", "farmácia 45 ontem").',
    '- "obligation": uma obrigação fixa mensal — financiamento, boleto, conta recorrente (ex.: "Parcela solar 710,44 72x a partir de 05/10", "aluguel 1200 todo mês dia 10"). NÃO é no cartão de crédito.',
    '- "card_installment": compra parcelada NO CARTÃO de crédito (ex.: "notebook 3600 em 12x no nubank"). Menções a cartão indicam esta intenção.',
    '- "mark_paid": dar baixa em algo já registrado (ex.: "placa solar pago", "nubank pago").',
    "",
    "Responda APENAS com um objeto JSON, sem texto extra, em UM dos formatos:",
    '{"intent": "plain", "expense": {"amount_cents": number | null, "description": string, "occurred_on": "YYYY-MM-DD" | null, "category_hint": string | null, "responsible_hint": string | null}}',
    '{"intent": "obligation", "obligation": {"description": string, "monthly_amount_cents": number | null, "term_months": number | null, "start_month": "YYYY-MM" | null, "due_day": number | null, "category_hint": string | null, "responsible_hint": string | null}}',
    '{"intent": "card_installment"}',
    '{"intent": "mark_paid", "target": "obligation" | "card", "keyword": string}',
    "",
    "Regras:",
    "- Valores sempre em CENTAVOS de real (R$ 710,44 -> 71044).",
    '- monthly_amount_cents é o valor POR MÊS. "72x de 710,44" e "710,44 72x" já são por mês; "51.000 em 72x" é o TOTAL — divida pelo número de parcelas (parte inteira em centavos).',
    "- term_months é o número de meses (72x -> 72); null quando for recorrente sem prazo (aluguel, luz).",
    '- start_month resolve "a partir de 05/10" usando a data de hoje para inferir o ano (dia 05, mês 10 -> due_day 5 e start_month do próximo 10 do calendário); null se não houver início explícito.',
    "- due_day entre 1 e 28; se a mensagem indicar dia 29, 30 ou 31, use 28. null se não houver dia.",
    '- Em mark_paid, keyword é O QUE foi pago, sem a palavra "pago" (ex.: "placa solar pago" -> "placa solar"; "nubank pago" -> "nubank"). target é "card" quando a keyword é um cartão de crédito; senão "obligation".',
    "- category_hint/responsible_hint são texto livre; null quando não estiver claro.",
    "- Se a mensagem não for nada disso, responda exatamente: null",
  ].join("\n");
}

/**
 * Create a {@link MessageClassifier} backed by an injected completion client.
 * Returns `null` on ANY failure (abstention, junk, schema mismatch, throw) so
 * the conversation falls back to today's deterministic parser path.
 */
export function createMessageClassifier(
  client: AiCompletionClient,
): MessageClassifier {
  return async (text, options) => {
    try {
      const reply = await client.complete(
        buildClassifierPrompt(text, options.today),
        { label: "classifier" },
      );
      if (reply === null) {
        return null;
      }
      const json = extractJsonObject(reply);
      if (json === null) {
        return null;
      }
      const parsed = classifiedReplySchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        return null;
      }
      const data = parsed.data;
      switch (data.intent) {
        case "plain":
          return {
            intent: "plain",
            expense: {
              amountCents: data.expense.amount_cents ?? undefined,
              description: data.expense.description,
              occurredOn: data.expense.occurred_on ?? undefined,
              categoryHint: data.expense.category_hint ?? undefined,
              responsibleHint: data.expense.responsible_hint ?? undefined,
            },
          };
        case "obligation":
          return {
            intent: "obligation",
            obligation: {
              description: data.obligation.description,
              monthlyAmountCents:
                data.obligation.monthly_amount_cents ?? undefined,
              termMonths: data.obligation.term_months ?? undefined,
              startMonth: data.obligation.start_month ?? undefined,
              dueDay: data.obligation.due_day ?? undefined,
              categoryHint: data.obligation.category_hint ?? undefined,
              responsibleHint: data.obligation.responsible_hint ?? undefined,
            },
          };
        case "card_installment":
          return { intent: "card_installment" };
        case "mark_paid":
          return {
            intent: "mark_paid",
            target: data.target,
            keyword: data.keyword,
          };
      }
    } catch {
      // Includes JSON.parse errors and client/network failures.
      return null;
    }
  };
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
        { label: "interpreter" },
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
