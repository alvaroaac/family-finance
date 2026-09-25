import { describe, expect, it } from "vitest";

import { recentExpensesMessage } from "./replies.js";

describe("recentExpensesMessage", () => {
  it("formats a two-line numbered list", () => {
    expect(
      recentExpensesMessage([
        {
          amountCents: 4590,
          occurredOn: "2026-09-02",
          description: "Farmácia",
          categoryLabel: "Saúde › Remédios",
          paymentLabel: "Nubank",
          responsibleLabel: "Karol",
        },
        {
          amountCents: 23000,
          occurredOn: "2026-09-01",
          description: "Mercado",
          categoryLabel: "Alimentação",
          paymentLabel: "Conta da casa",
          responsibleLabel: "Casa",
        },
      ]),
    ).toBe(
      [
        "Últimos 2 lançamentos:",
        "",
        "1. 02/09 · R$ 45,90 · Farmácia",
        "   Saúde › Remédios · Nubank · Karol",
        "2. 01/09 · R$ 230,00 · Mercado",
        "   Alimentação · Conta da casa · Casa",
      ].join("\n"),
    );
  });

  it("uses the singular header for one item", () => {
    const message = recentExpensesMessage([
      {
        amountCents: 100,
        occurredOn: "2026-09-03",
        description: "Café",
        categoryLabel: "Alimentação",
        paymentLabel: "Conta",
        responsibleLabel: "Casa",
      },
    ]);
    expect(message).toBe(
      "Último lançamento:\n\n1. 03/09 · R$ 1,00 · Café\n   Alimentação · Conta · Casa",
    );
  });

  it("formats an empty list", () => {
    expect(recentExpensesMessage([])).toBe(
      "Nenhum lançamento registrado ainda.",
    );
  });
});
