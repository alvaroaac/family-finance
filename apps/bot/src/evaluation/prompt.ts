import { createHash } from "node:crypto";

import type { EvalCase, Taxonomy } from "./types.js";

export const PROMPT_VERSION = "family-finance-eval-v1";

export function buildEvaluationPrompt(
  entry: EvalCase,
  taxonomy: Taxonomy,
): string {
  return [
    `Prompt version: ${PROMPT_VERSION}`,
    "Você interpreta mensagens financeiras informais de uma família brasileira.",
    "A resposta é apenas um objeto JSON. Não use markdown nem texto fora do JSON.",
    `Hoje é ${entry.input.today}.`,
    `Mensagem: ${JSON.stringify(entry.input.text)}`,
    `Contexto específico: ${JSON.stringify(entry.context ?? {})}`,
    `Taxonomia congelada: ${JSON.stringify(taxonomy)}`,
    "",
    "Separe merchant (estabelecimento/plataforma) de item (produto/serviço) quando ambos existirem.",
    "Valores monetários são centavos inteiros. amount_kind é total, per_installment, monthly ou null.",
    "Compra em cartão sem número de parcelas é plain_card_expense; só use card_installment quando houver parcelamento.",
    "Obrigações são contas/financiamentos recorrentes fora do cartão; 72x de 710,44 significa 71044 por mês.",
    "Escolha no máximo 3 categorias ranqueadas. Se faltar informação, decision=choose ou abstain; não invente certeza.",
    "Pode propor uma categoria OU subcategoria nova, mas nunca criar automaticamente e nunca duplicar sinônimos existentes.",
    "Purposes são uma dimensão separada das categorias.",
    "Aporte/investimento é transferência/outflow: reduz o Saldo disponível exibido, mas NÃO entra como despesa contábil nem em consumo.",
    "",
    "Formato exato:",
    JSON.stringify({
      intent:
        "plain_expense | plain_card_expense | card_installment | obligation | mark_paid | investment_transfer | transfer | non_financial",
      fields: {
        merchant: "string|null",
        item: "string|null",
        description: "string|null",
        amount_kind: "total|per_installment|monthly|null",
        amount_cents: "number|null",
        monthly_amount_cents: "number|null",
        installment_count: "number|null",
        card: "string|null",
        occurred_on: "YYYY-MM-DD|null",
        due_day: "number|null",
        term_months: "number|null",
      },
      categorization: {
        decision: "single|choose|propose_new|abstain",
        candidates: [
          {
            purpose: "string|null",
            category: "string",
            subcategory: "string|null",
            confidence: "number 0..1",
          },
        ],
        proposal: {
          kind: "category|subcategory",
          category: "string",
          subcategory: "string|null",
          reason: "string",
        },
      },
      accounting: {
        cash_flow: "outflow|inflow|neutral",
        available_balance: "subtract|add|unchanged",
        accounting_expense: "include|exclude",
        consumption_spend: "include|exclude",
        destination: "string|null",
      },
    }),
    "Use null para proposal/accounting quando não se aplicarem. Inclua todas as chaves de fields.",
  ].join("\n");
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}
