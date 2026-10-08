import { describe, expect, it } from "vitest";

import {
  confirmationMessage,
  installmentConfirmationMessage,
  obligationConfirmationMessage,
} from "./replies.js";

const expense = {
  description: "Posto",
  amountCents: 15000,
  occurredOn: "2026-10-06",
  categoryLabel: "Transporte",
  paymentLabel: "Crédito Nubank",
  responsibleLabel: "Alvaro",
};

describe("confirmation summary placement", () => {
  it.each([
    [
      "expense",
      "Confirme o lançamento:",
      (explanation?: string) =>
        confirmationMessage({ ...expense, categoryExplanation: explanation }),
    ],
    [
      "installment",
      "Confirme a compra parcelada:",
      (explanation?: string) =>
        installmentConfirmationMessage({
          description: "Notebook",
          totalCents: 360000,
          installmentCount: 12,
          cardName: "Nubank",
          purchasedOn: "2026-10-06",
          firstDueMonth: "2026-11",
          categoryLabel: "Eletrônicos > Notebook",
          responsibleLabel: "Alvaro",
          categoryExplanation: explanation,
        }),
    ],
    [
      "obligation",
      "Confirme a obrigação:",
      (explanation?: string) =>
        obligationConfirmationMessage({
          description: "Internet",
          monthlyAmountCents: 12990,
          termMonths: null,
          startMonth: "2026-10",
          endMonth: null,
          dueDay: 5,
          accountLabel: "Conta Nubank",
          categoryLabel: "Moradia > Contas",
          categoryExplanation: explanation,
        }),
    ],
  ] as const)(
    "keeps %s decisions below all guidance, including long explanations",
    (_name, heading, render) => {
      for (const explanation of [
        undefined,
        "Explicação da classificação. ".repeat(30),
      ]) {
        const text = render(explanation);
        const summaryStart = text.indexOf(heading);
        expect(summaryStart).toBeGreaterThan(text.indexOf("Para corrigir"));
        expect(summaryStart).toBeGreaterThan(
          text.indexOf('responder "confirmar" ou "cancelar"'),
        );
        if (explanation)
          expect(summaryStart).toBeGreaterThan(
            text.indexOf(explanation) + explanation.length,
          );
        expect(text.split("\n").at(-1)).toMatch(/^• Categoria: /);
        expect(text.slice(summaryStart)).not.toMatch(
          /Para corrigir|Sugestão:|cancelar/,
        );
      }
    },
  );

  it("keeps every expense decision together in five detail lines", () => {
    expect(
      confirmationMessage(expense).split("Confirme o lançamento:\n")[1],
    ).toBe(
      [
        "• Descrição: Posto",
        "• Valor: R$ 150,00 · Data: 06/10/2026",
        "• Pagamento: Crédito Nubank",
        "• Responsável: Alvaro",
        "• Categoria: Transporte",
      ].join("\n"),
    );
  });

  it("keeps a pending new category visible at the bottom", () => {
    expect(
      confirmationMessage({ ...expense, proposedNewCategory: "Combustível" })
        .split("\n")
        .at(-1),
    ).toBe('• Categoria: "Combustível" (nova — sugerida)');
  });
});
