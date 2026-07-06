import { describe, it, expect } from "vitest";

import {
  confirmationMessage,
  askCategoryNameMessage,
  categoryCreatedMessage,
  categoryReusedMessage,
  chooseCategoryMessage,
  chooseResponsibleMessage,
  invalidCategoryNameMessage,
  SESSION_EXPIRED_TOAST,
  ALREADY_SAVED_TOAST,
} from "./replies.js";

const BASE_VIEW = {
  amountCents: 3250,
  description: "Petz",
  occurredOn: "2026-07-04",
  categoryLabel: "Sem categoria (a definir)",
  paymentLabel: "Conta",
  responsibleLabel: "Alvaro",
};

describe("confirmationMessage with an AI category proposal", () => {
  it("shows the proposed name marked as nova — sugerida", () => {
    const text = confirmationMessage({
      ...BASE_VIEW,
      proposedNewCategory: "Pets",
      categoryExplanation: "Petz é um pet shop.",
    });
    expect(text).toContain('Categoria: "Pets" (nova — sugerida)');
    expect(text).toContain("Sugestão: Petz é um pet shop.");
    // Typed-command hints stay: buttons are progressive enhancement.
    expect(text).toContain("confirmar");
    expect(text).toContain("cancelar");
  });

  it("keeps today's plain category label when there is no proposal", () => {
    const text = confirmationMessage(BASE_VIEW);
    expect(text).toContain("Categoria: Sem categoria (a definir)");
  });
});

describe("category-creation copy", () => {
  it("asks for a name with a cancel hint", () => {
    expect(askCategoryNameMessage()).toContain("nome da nova categoria");
    expect(askCategoryNameMessage()).toContain("cancelar");
  });

  it("confirms creation and reuse", () => {
    expect(categoryCreatedMessage("Pets")).toBe('Categoria "Pets" criada ✅');
    expect(categoryReusedMessage("Pets")).toContain('"Pets" já existia');
  });

  it("grid prompts", () => {
    expect(chooseCategoryMessage()).toBe("Escolha a categoria:");
    expect(chooseResponsibleMessage()).toBe("Quem é o responsável?");
  });

  it("validation errors in pt-BR", () => {
    expect(invalidCategoryNameMessage("empty")).toContain("vazio");
    expect(invalidCategoryNameMessage("too_long")).toContain("40");
  });

  it("toast constants", () => {
    expect(SESSION_EXPIRED_TOAST).toBe(
      "Sessão expirada — envie o gasto novamente.",
    );
    expect(ALREADY_SAVED_TOAST).toBe("Já salvo ✅");
  });
});
