/**
 * Conversation tests for the card-installment flow (PR-2 / Task 5):
 *
 *  - classify -> SUMMARY confirmation (card resolution: keyword match, auto
 *    single-card, ambiguous grid) -> confirmar persists via
 *    deps.createInstallmentPurchase (never before), with valor/parcelas/
 *    cartão/categoria/data corrections
 *  - no active card -> terminal refusal
 *  - cf callback parity with typed "confirmar"; cd:<uuid> sets the card;
 *    stale cd: on a saved state -> expired
 */

import { describe, it, expect, vi } from "vitest";

import type {
  CategoryCatalog,
  CategorizationResult,
} from "@family-finance/categorization";
import type { InstallmentPlan } from "@family-finance/domain";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";
import type {
  InterpretedCardPurchase,
  InterpretedIntent,
  MessageClassifier,
} from "./interpret.js";
import {
  CARD_TOKEN_PREFIX,
  CATEGORY_SUGGESTION_TOKEN_PREFIX,
  TOKENS,
} from "./keyboards.js";

const TODAY = "2026-07-06";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [
    { id: "cat-tech", name: "Eletrônicos" },
    { id: "cat-transporte", name: "Transporte" },
  ],
  subcategories: [],
};

function classifierReturning(
  result: InterpretedIntent | null,
): MessageClassifier {
  return async () => result;
}

function buildDeps(overrides: Partial<ConversationDeps> = {}): {
  deps: ConversationDeps;
  createInstallmentPurchase: ReturnType<typeof vi.fn>;
  logInteraction: ReturnType<typeof vi.fn>;
} {
  const createInstallmentPurchase = vi.fn(async () => ({ groupId: "group-1" }));
  const logInteraction = vi.fn(async () => undefined);

  const deps: ConversationDeps = {
    householdId: "house-1",
    catalog: CATALOG,
    defaultAccountId: "acct-1",
    resolveCardId: () => "card-1",
    resolveAccountId: () => "acct-1",
    resolveResponsibleUserId: () => undefined,
    suggestCategory: async () => ({
      status: "uncategorized" as const,
      suggestion: null,
      requiresConfirmation: false,
    }),
    createTransaction: vi.fn(async () => ({ id: "txn-1" })),
    logInteraction,
    listActiveCards: () => [{ id: "card-1", name: "Nubank" }],
    createInstallmentPurchase,
    ...overrides,
  };
  return { deps, createInstallmentPurchase, logInteraction };
}

function purchaseIntent(
  purchase: Partial<InterpretedCardPurchase> = {},
): InterpretedIntent {
  return {
    intent: "card_installment",
    purchase: {
      description: "Notebook",
      ...purchase,
    },
  };
}

describe("card installment start: card resolution", () => {
  it("keeps explicit card credit on the installment path", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const outcome = await startConversation(
      {
        text: "Notebook 3000 em 12x no crédito Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.obligationDraft).toBeUndefined();
    expect(outcome.state.installmentDraft).toMatchObject({
      description: "Notebook",
      totalCents: 300000,
      installmentCount: 12,
      cardId: "card-1",
    });
  });

  it.each([
    ["classifier unavailable", null],
    [
      "classifier incorrectly says plain",
      {
        intent: "plain" as const,
        expense: { description: "Notebook 12x", amountCents: 30000 },
      },
    ],
  ])(
    "routes the exact Notebook regression when %s",
    async (_label, classified) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: "Notebook em 12x de 300 no credito nubank",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_installment_confirmation");
      expect(outcome.state.installmentDraft).toMatchObject({
        description: "Notebook",
        totalCents: 360000,
        installmentCount: 12,
        cardId: "card-1",
      });
      expect(outcome.reply).toContain("Notebook");
      expect(outcome.reply).not.toMatch(
        /Notebook\s+(?:12x|cr[eé]dito|Nubank)/i,
      );
    },
  );

  it("keeps an explicit 1x credit purchase out of installment routing even when AI is wrong", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const outcome = await startConversation(
      { text: "Notebook 3600 em 1x no Nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.installmentDraft).toBeUndefined();
    expect(createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it.each([
    ["conflicting totals", "Notebook 3x de 50, total 200, no Nubank"],
    ["an invalid installment count", "Notebook 3600 em 0x no Nubank"],
  ])(
    "keeps %s terminal and write-free even when AI returns an installment",
    async (_label, text) => {
      const { deps, createInstallmentPurchase } = buildDeps({
        classifyMessage: classifierReturning(
          purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
        ),
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toMatch(/não consegui separar com segurança/i);
      expect(createInstallmentPurchase).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("carries an explicit parser date into a deterministic installment fallback", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-1", name: "Nubank", closingDay: 5 }],
    });
    const started = await startConversation(
      {
        text: "Notebook 3600 em 12x no Nubank dia 12/06",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.installmentDraft?.purchasedOn).toBe("2026-06-12");

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.purchasedOn).toBe("2026-06-12");
    expect(plan.installments[0]?.dueMonth).toBe("2026-07");
  });

  it.each([
    [
      "classifier result without a date",
      purchaseIntent({ totalCents: 120000, installmentCount: 12 }),
      "Comprei TV 1200 em 12x no Nubank dia 31/12",
      "2025-12-31",
    ],
    [
      "deterministic fallback",
      null,
      "Comprei TV 1200 em 12x no Nubank dia 31/12",
      "2025-12-31",
    ],
    [
      "deterministic fallback with an explicit year",
      null,
      "Comprei TV 1200 em 12x no Nubank dia 31/12/2024",
      "2024-12-31",
    ],
  ])(
    "persists purchase chronology for %s",
    async (_label, classified, text, expectedPurchasedOn) => {
      const { deps, createInstallmentPurchase } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: "2026-01-02" },
      );

      expect(started.state.installmentDraft?.purchasedOn).toBe(
        expectedPurchasedOn,
      );

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-01-02",
      });
      expect(createInstallmentPurchase).toHaveBeenCalledWith(
        expect.objectContaining({
          group: expect.objectContaining({ purchasedOn: expectedPurchasedOn }),
        }),
      );
    },
  );

  it("no active card -> terminal refusal", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      listActiveCards: () => [],
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state, reply } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(createInstallmentPurchase).not.toHaveBeenCalled();
    expect(reply).toBe(
      "Compra parcelada é no cartão — a casa ainda não tem cartão cadastrado. Cadastre um em Cartões no painel.",
    );
  });

  it("auto-picks the single active card when no keyword is given", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state, reply } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_installment_confirmation");
    expect(state.installmentDraft?.cardId).toBe("card-1");
    expect(reply).toContain("Nubank");
    expect(reply).toMatch(/1ª parcela jul\/2026/);
  });

  it("starts from total form: `Notebook 3600 em 12x no Nubank`", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        }),
      ),
    });

    const outcome = await startConversation(
      { text: "Notebook 3600 em 12x no Nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.draft.amountCents).toBeUndefined();
    expect(outcome.state.installmentDraft?.description).toBe("Notebook");
    expect(outcome.state.installmentDraft?.totalCents).toBe(360000);
    expect(outcome.state.installmentDraft?.installmentCount).toBe(12);
    expect(outcome.state.installmentDraft?.cardId).toBe("card-1");
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(deps.createInstallmentPurchase).not.toHaveBeenCalled();
    expect(outcome.reply).toContain("Confirme a compra parcelada:");
    expect(outcome.reply).not.toContain("Confirme o lançamento:");
  });

  it("starts from per-parcel form: `Notebook 12x de 300 no Nubank`", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({
          perInstallmentCents: 30000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        }),
      ),
    });

    const outcome = await startConversation(
      { text: "Notebook 12x de 300 no Nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.installmentDraft?.description).toBe("Notebook");
    expect(outcome.state.installmentDraft?.totalCents).toBe(360000);
    expect(outcome.state.installmentDraft?.installmentCount).toBe(12);
    expect(outcome.state.installmentDraft?.cardId).toBe("card-1");
    expect(outcome.reply).toContain("R$ 3.600,00 em 12× de R$ 300,00");
  });

  it("keyword match picks the right card among two", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "inter",
        }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x no inter", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_installment_confirmation");
    expect(state.installmentDraft?.cardId).toBe("card-2");
  });

  it('short card name "C6" resolves via keyword "c6" (whole-string fallback)', async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "C6" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "c6",
        }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x no c6", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_installment_confirmation");
    expect(state.installmentDraft?.cardId).toBe("card-2");
  });

  it("ambiguous (2+ cards, no keyword match) -> card grid, no cardId", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state, reply, keyboard } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_installment_confirmation");
    expect(state.installmentDraft?.cardId).toBeUndefined();
    expect(reply).toContain("Qual cartão?");
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: "Inter", callback_data: `${CARD_TOKEN_PREFIX}card-2` },
          { text: "Nubank", callback_data: `${CARD_TOKEN_PREFIX}card-1` },
        ],
      ],
    });
  });

  it("`Notebook 3600 parcelado` asks which card when multiple active cards exist", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });

    const { state, reply, keyboard } = await startConversation(
      { text: "Notebook 3600 parcelado", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("awaiting_installment_confirmation");
    expect(state.installmentDraft?.cardId).toBeUndefined();
    expect(reply).toContain("Qual cartão?");
    expect(
      keyboard?.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Inter", "Nubank"]);
  });

  it("parcelado only offers credit cards when Mercado Pago is both account and card", async () => {
    const { deps } = buildDeps({
      listActiveAccounts: () => [
        { id: "acct-mercado-pago", name: "Mercado Pago" },
      ],
      listActiveCards: () => [
        { id: "card-mercado-pago", name: "Mercado Pago" },
        { id: "card-itau", name: "Itaú" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "Mercado Pago",
        }),
      ),
    });

    const outcome = await startConversation(
      { text: "Notebook 3600 em 12x Mercado Pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.installmentDraft?.cardId).toBe("card-mercado-pago");
    expect(outcome.state.paymentCandidates).toBeUndefined();
    expect(
      outcome.keyboard?.inline_keyboard.flat().map((button) => button.text),
    ).not.toContain("Conta Mercado Pago");
  });

  it("multi-word Mercado Pago credit card is stripped from installment description", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-mercado-pago", name: "Mercado Pago" },
        { id: "card-itau", name: "Itaú" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          description: "Notebook Mercado Pago",
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "Mercado Pago",
        }),
      ),
    });

    const outcome = await startConversation(
      {
        text: "Notebook 3600 em 12x credito Mercado Pago",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.installmentDraft?.description).toBe("Notebook");
    expect(outcome.state.installmentDraft?.cardId).toBe("card-mercado-pago");
    expect(outcome.reply).toContain("no Mercado Pago");
  });
});

describe("card installment start: amount normalization + summary", () => {
  it("total form and per-parcel form normalize to the same total", async () => {
    const { deps: depsTotal } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 120000, installmentCount: 10 }),
      ),
    });
    const totalOutcome = await startConversation(
      { text: "sofa 1200 em 10x", fromUserId: "user-alvaro" },
      depsTotal,
      { today: TODAY },
    );

    const { deps: depsPer } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ perInstallmentCents: 12000, installmentCount: 10 }),
      ),
    });
    const perOutcome = await startConversation(
      { text: "sofa 10x de 120", fromUserId: "user-alvaro" },
      depsPer,
      { today: TODAY },
    );

    expect(totalOutcome.state.installmentDraft?.totalCents).toBe(120000);
    expect(perOutcome.state.installmentDraft?.totalCents).toBe(120000);
    expect(totalOutcome.reply).toContain("R$ 1.200,00");
    expect(perOutcome.reply).toContain("R$ 1.200,00");
  });

  it("shows per-parcel amount only when the total divides evenly", async () => {
    const { deps: divisible } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 120000, installmentCount: 10 }),
      ),
    });
    const { reply: replyDivisible } = await startConversation(
      { text: "sofa 1200 em 10x", fromUserId: "user-alvaro" },
      divisible,
      { today: TODAY },
    );
    expect(replyDivisible).toContain("de R$ 120,00");

    const { deps: indivisible } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 100000, installmentCount: 3 }),
      ),
    });
    const { reply: replyIndivisible } = await startConversation(
      { text: "sofa 1000 em 3x", fromUserId: "user-alvaro" },
      indivisible,
      { today: TODAY },
    );
    expect(replyIndivisible).not.toContain("de R$");
  });
});

describe("card installment start: missing installment count", () => {
  it("confirmar without count asks 'Em quantas parcelas?'", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "confirmar", deps, {
      today: TODAY,
    });
    expect(outcome.reply).toBe(
      'Em quantas parcelas? Responda com "parcelas 12".',
    );
    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
  });

  it('"parcelas 12" fills the count', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "parcelas 12", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.installmentCount).toBe(12);
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"parcelas 1" is rejected (needs at least 2)', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "parcelas 1", deps, {
      today: TODAY,
    });
    expect(outcome.reply).toBe(
      "O parcelamento precisa de pelo menos 2 parcelas.",
    );
    expect(outcome.state.installmentDraft?.installmentCount).toBeUndefined();
  });
});

describe("card installment corrections", () => {
  async function startDraft(
    deps: ConversationDeps,
  ): Promise<ConversationState> {
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    return state;
  }

  it('"valor 3.700" corrects the total', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "valor 3.700", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.totalCents).toBe(370000);
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"cartão inter" switches the card', async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "nubank",
        }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "cartão inter", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.cardId).toBe("card-2");
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"categoria Transporte" corrects the category', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "categoria Transporte", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.categoryId).toBe("cat-transporte");
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"data 12/06" corrects the purchase date', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "data 12/06", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.purchasedOn).toBe("2026-06-12");
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"dia 08/02" corrects the purchase date as DD/MM', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "dia 08/02", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.purchasedOn).toBe("2026-02-08");
    expect(outcome.reply).toContain("Atualizei a data");
    expect(outcome.reply).toContain("1ª parcela fev/2026");
  });

  it('"cartão c6" switches to a short-named card (whole-string fallback)', async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "C6" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          cardKeyword: "nubank",
        }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "cartão c6", deps, {
      today: TODAY,
    });
    expect(outcome.state.installmentDraft?.cardId).toBe("card-2");
    expect(outcome.reply).toContain("Atualizei");
  });

  it('unknown "cartão xyz" replies not-found', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "cartão xyz", deps, {
      today: TODAY,
    });
    expect(outcome.reply).toContain('Não encontrei o cartão "xyz"');
  });
});

describe("card installment confirm: persistence", () => {
  it("persists the canonical description on the group and every installment", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Notebook em 12x de 300 no credito nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    await applyMessage(started.state, "confirmar", deps, { today: TODAY });

    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.description).toBe("Notebook");
    expect(plan.installments).toHaveLength(12);
    expect(
      plan.installments.every((item) => item.description === "Notebook"),
    ).toBe(true);
  });

  it.each([
    [
      "classified installment",
      purchaseIntent({
        description: "Geladeira",
        totalCents: 300000,
        installmentCount: 10,
        cardKeyword: "Nubank",
      }),
    ],
    ["deterministic fallback", null],
  ])(
    "persists the canonical Geladeira description through %s",
    async (_label, classified) => {
      const { deps, createInstallmentPurchase } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Comprei no Nubank uma geladeira por 3000 em 10x",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.installmentDraft?.description).toBe("Geladeira");

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      const plan = createInstallmentPurchase.mock
        .calls[0]?.[0] as InstallmentPlan;
      expect(plan.group.description).toBe("Geladeira");
      expect(plan.installments).toHaveLength(10);
      expect(
        plan.installments.every((item) => item.description === "Geladeira"),
      ).toBe(true);
    },
  );

  it("persists an explicit reverse-order per-installment amount despite inconsistent AI total", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({
          description: "Notebook",
          totalCents: 30000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        }),
      ),
    });
    const started = await startConversation(
      {
        text: "Notebook R$ 300 12x no Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.installmentDraft).toMatchObject({
      description: "Notebook",
      totalCents: 360000,
      installmentCount: 12,
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.totalAmount.cents).toBe(360000);
    expect(plan.installments).toHaveLength(12);
    expect(plan.installments.every((item) => item.amount.cents === 30000)).toBe(
      true,
    );
  });

  it("persists `12 parcelas R$ 300` as twelve R$ 300 installments despite an inconsistent AI total", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({
          description: "Notebook",
          totalCents: 30000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        }),
      ),
    });
    const started = await startConversation(
      {
        text: "Notebook 12 parcelas R$ 300 no Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.installmentDraft).toMatchObject({
      description: "Notebook",
      totalCents: 360000,
      installmentCount: 12,
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.description).toBe("Notebook");
    expect(plan.group.totalAmount.cents).toBe(360000);
    expect(plan.installments).toHaveLength(12);
    expect(plan.installments.every((item) => item.amount.cents === 30000)).toBe(
      true,
    );
  });

  it("strips an explicit purchase date from the description while preserving it through persistence", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({
          description: "Notebook dia 10/08",
          totalCents: 360000,
          installmentCount: 12,
          purchasedOn: "2026-08-10",
          cardKeyword: "Nubank",
        }),
      ),
    });
    const started = await startConversation(
      {
        text: "Comprei notebook dia 10/08 por 3600 em 12x no Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.installmentDraft).toMatchObject({
      description: "Notebook",
      totalCents: 360000,
      installmentCount: 12,
      purchasedOn: "2026-08-10",
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.description).toBe("Notebook");
    expect(plan.group.purchasedOn).toBe("2026-08-10");
    expect(plan.installments).toHaveLength(12);
    expect(
      plan.installments.every((item) => item.description === "Notebook"),
    ).toBe(true);
    expect(plan.installments[0]?.dueMonth).toBe("2026-08");
  });

  it("confirm persists a plan matching the draft, with closingDay shift", async () => {
    const { deps, createInstallmentPurchase, logInteraction } = buildDeps({
      listActiveCards: () => [{ id: "card-1", name: "Nubank", closingDay: 5 }],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          purchasedOn: "2026-07-10",
        }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "confirmar", deps, {
      today: TODAY,
    });

    expect(outcome.state.status).toBe("saved");
    expect(createInstallmentPurchase).toHaveBeenCalledTimes(1);
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.group.totalAmount.cents).toBe(360000);
    expect(plan.group.installmentCount).toBe(12);
    expect(plan.group.creditCardId).toBe("card-1");
    expect(plan.installments).toHaveLength(12);
    // Purchase day (10) AFTER closingDay (5) -> first dueMonth is next month.
    expect(plan.installments[0]?.dueMonth).toBe("2026-08");
    expect(logInteraction).toHaveBeenCalledTimes(1);
    expect(outcome.reply).toContain("Compra parcelada salva!");
    expect(outcome.reply).toContain("1ª parcela ago/2026");
  });

  it("persist throws -> failure message, state cancelled, no interaction logged", async () => {
    const { deps, logInteraction } = buildDeps({
      createInstallmentPurchase: vi.fn(async () => {
        throw new Error("boom");
      }),
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "confirmar", deps, {
      today: TODAY,
    });

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toBe(
      'Não consegui salvar a compra parcelada "Notebook" — tenta de novo em instantes.',
    );
    expect(logInteraction).not.toHaveBeenCalled();
  });

  it("closingDay shift: purchase ON closing day stays in the current month", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      listActiveCards: () => [{ id: "card-1", name: "Nubank", closingDay: 5 }],
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          purchasedOn: "2026-07-05",
        }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyMessage(state, "confirmar", deps, { today: TODAY });
    const plan = createInstallmentPurchase.mock
      .calls[0]?.[0] as InstallmentPlan;
    expect(plan.installments[0]?.dueMonth).toBe("2026-07");
  });
});

describe("card installment confirmation keyboard has no responsável button", () => {
  function flatten(
    keyboard: { inline_keyboard: { callback_data: string }[][] } | undefined,
  ) {
    return (keyboard?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  }

  it("start outcome (complete draft, card already resolved) omits responsável", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { keyboard } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(flatten(keyboard)).not.toContain(TOKENS.responsible);
  });

  it("cd:<uuid> re-render omits responsável", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(
      state,
      `${CARD_TOKEN_PREFIX}card-2`,
      deps,
      {
        today: TODAY,
      },
    );
    expect(flatten(outcome.keyboard)).not.toContain(TOKENS.responsible);
  });

  it("ct:<uuid> category-pick re-render omits responsável", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(state, "ct:cat-transporte", deps, {
      today: TODAY,
    });
    expect(flatten(outcome.keyboard)).not.toContain(TOKENS.responsible);
  });

  it("tapping 📂 Categoria on a live installment draft shows a grid with no nova-categoria button", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(state, TOKENS.categories, deps, {
      today: TODAY,
    });
    expect(flatten(outcome.keyboard)).not.toContain(TOKENS.newCategory);
  });

  it("tapping resp (TOKENS.responsible) on a live installment session is stale (button no longer renders)", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(state, TOKENS.responsible, deps, {
      today: TODAY,
    });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toBe("Sessão expirada — envie o gasto novamente.");
  });
});

describe("card installment callback parity", () => {
  it("cf callback matches typed confirmar; second tap is a friendly no-op", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(outcome.state.status).toBe("saved");
    expect(createInstallmentPurchase).toHaveBeenCalledTimes(1);

    const second = await applyCallback(outcome.state, "cf", deps, {
      today: TODAY,
    });
    expect(second.silent).toBe(true);
    expect(second.toast).toBe("Já salvo ✅");
    expect(createInstallmentPurchase).toHaveBeenCalledTimes(1);
  });

  it("cd:<uuid> sets the card and re-shows the summary", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Inter" },
      ],
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.installmentDraft?.cardId).toBeUndefined();

    const outcome = await applyCallback(
      state,
      `${CARD_TOKEN_PREFIX}card-2`,
      deps,
      {
        today: TODAY,
      },
    );
    expect(outcome.state.installmentDraft?.cardId).toBe("card-2");
    expect(outcome.reply).toContain("Inter");
  });

  it("stale cd: on a saved state -> expired", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const { state } = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const confirmed = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(confirmed.state.status).toBe("saved");

    const stale = await applyCallback(
      confirmed.state,
      `${CARD_TOKEN_PREFIX}card-1`,
      deps,
      { today: TODAY },
    );
    expect(stale.silent).toBe(true);
    expect(stale.toast).toBe("Sessão expirada — envie o gasto novamente.");
  });
});

describe("card installment category suggestions", () => {
  it("prefills the top existing subcategory suggestion while keeping suggestion buttons", async () => {
    const { deps } = buildDeps({
      catalog: {
        ...CATALOG,
        subcategories: [
          { id: "sub-notebook", categoryId: "cat-tech", name: "Notebook" },
        ],
      },
      classifyMessage: classifierReturning(
        purchaseIntent({
          totalCents: 360000,
          installmentCount: 12,
          unifiedPrimary: true,
          categoryCandidates: [
            {
              categoryName: "Eletrônicos",
              subcategoryName: "Notebook",
              confidence: 0.94,
              explanation: "Notebook é eletrônico.",
            },
          ],
        }),
      ),
    });

    const outcome = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.installmentDraft?.categoryId).toBe("cat-tech");
    expect(outcome.state.installmentDraft?.subcategoryId).toBe("sub-notebook");
    expect(outcome.reply).toContain("Categoria: Eletrônicos > Notebook");
    expect(outcome.keyboard?.inline_keyboard.flat()).toContainEqual({
      text: "📂 Eletrônicos › Notebook",
      callback_data: `${CATEGORY_SUGGESTION_TOKEN_PREFIX}0`,
    });
  });

  it("accepts a proposed new subcategory into the installment draft without saving immediately", async () => {
    const pendingSubcategory: CategorizationResult = {
      status: "pending_new_subcategory",
      suggestion: {
        macroCategoryId: "cat-tech",
        confidence: 0.91,
        explanation: "Notebook gamer ainda não existe.",
        source: "ai",
      },
      pendingCategory: {
        categoryName: "Eletrônicos",
        subcategoryName: "Notebook gamer",
        confidence: 0.91,
        explanation: "Notebook gamer ainda não existe.",
      },
      requiresConfirmation: true,
    };
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
      suggestCategory: vi.fn(async () => pendingSubcategory),
      listAllSubcategories: vi.fn(async () => []),
      createSubcategory: vi.fn(async () => ({ id: "sub-gamer" })),
      restoreSubcategory: vi.fn(async () => undefined),
    });

    const start = await startConversation(
      { text: "notebook gamer 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(start.state.installmentDraft?.categoryId).toBe("cat-tech");
    expect(start.state.installmentDraft?.subcategoryId).toBeUndefined();
    expect(start.state.proposedSubcategory).toEqual({
      categoryId: "cat-tech",
      categoryName: "Eletrônicos",
      subcategoryName: "Notebook gamer",
      explanation: "Notebook gamer ainda não existe.",
    });
    expect(start.reply).toContain(
      'Categoria: "Eletrônicos > Notebook gamer" (nova — sugerida)',
    );

    const accepted = await applyCallback(
      start.state,
      TOKENS.acceptProposal,
      deps,
      { today: TODAY },
    );

    expect(deps.createSubcategory).toHaveBeenCalledWith(
      "cat-tech",
      "Notebook gamer",
    );
    expect(accepted.state.status).toBe("awaiting_installment_confirmation");
    expect(accepted.state.installmentDraft?.categoryId).toBe("cat-tech");
    expect(accepted.state.installmentDraft?.subcategoryId).toBe("sub-gamer");
    expect(accepted.state.proposedSubcategory).toBeUndefined();
    expect(deps.createInstallmentPurchase).not.toHaveBeenCalled();
  });
});

const PROPOSAL: CategorizationResult = {
  status: "pending_new_category",
  suggestion: {
    confidence: 0.9,
    explanation: "Petz é um pet shop.",
    source: "ai",
  },
  pendingCategory: {
    categoryName: "Pets",
    subcategoryName: null,
    confidence: 0.9,
    explanation: "Petz é um pet shop.",
  },
  requiresConfirmation: true,
};

function proposalDeps(
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  const { deps } = buildDeps({
    catalog: {
      ...CATALOG,
      categories: [...CATALOG.categories, { id: "cat-pets", name: "Pets" }],
    },
    classifyMessage: classifierReturning(
      purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
    ),
    suggestCategory: vi.fn(async () => PROPOSAL),
    listAllCategories: vi.fn(async () => [
      { id: "cat-transporte", name: "Transporte", isActive: true },
    ]),
    createCategory: vi.fn(async () => ({ id: "cat-pets" })),
    restoreCategory: vi.fn(async () => undefined),
    ...overrides,
  });
  return deps;
}

describe("card installment: AI new-category proposal sub-flow", () => {
  it("start surfaces the proposal in state, summary, and keyboard (no plain cf button)", async () => {
    const deps = proposalDeps();
    const outcome = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.state.proposedCategoryName).toBe("Pets");
    expect(outcome.reply).toContain('Categoria: "Pets" (nova — sugerida)');

    const flat = (outcome.keyboard?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain(TOKENS.acceptProposal);
    expect(flat).toContain(TOKENS.categories);
    expect(flat).toContain(TOKENS.dropProposal);
    expect(flat).toContain(TOKENS.cancel);
    expect(flat).not.toContain(TOKENS.confirm);
  });

  it("nca creates/reuses the category, updates the draft, and returns to the summary WITHOUT persisting", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(
      start.state,
      TOKENS.acceptProposal,
      deps,
      {
        today: TODAY,
      },
    );

    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(outcome.state.installmentDraft?.categoryId).toBe("cat-pets");
    expect(outcome.state.proposedCategoryName).toBeUndefined();
    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.reply).toContain("Pets");
    expect(outcome.reply).not.toContain("(nova — sugerida)");
    expect(deps.createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it("dedupe: an active case/accent-insensitive match is reused, not duplicated", async () => {
    const deps = proposalDeps({
      catalog: {
        ...CATALOG,
        categories: [...CATALOG.categories, { id: "cat-pets-x", name: "PÉTS" }],
      },
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-x", name: "PÉTS", isActive: true },
      ]),
    });
    const start = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(
      start.state,
      TOKENS.acceptProposal,
      deps,
      {
        today: TODAY,
      },
    );
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(outcome.state.installmentDraft?.categoryId).toBe("cat-pets-x");
  });

  it("nocat drops the proposal and returns to the normal keyboard", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(
      start.state,
      TOKENS.dropProposal,
      deps,
      {
        today: TODAY,
      },
    );
    expect(outcome.state.proposedCategoryName).toBeUndefined();
    expect(outcome.reply).not.toContain("(nova — sugerida)");
    const flat = (outcome.keyboard?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain(TOKENS.confirm);
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(deps.createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it("acceptProposal with deps.createCategory/listAllCategories undefined -> notUnderstood, draft intact", async () => {
    const deps = proposalDeps({
      createCategory: undefined,
      listAllCategories: undefined,
    });
    const start = await startConversation(
      { text: "notebook 3600 em 12x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(
      start.state,
      TOKENS.acceptProposal,
      deps,
      {
        today: TODAY,
      },
    );
    expect(outcome.state.proposedCategoryName).toBe("Pets");
    expect(outcome.state.installmentDraft?.categoryId).toBeUndefined();
    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(deps.createInstallmentPurchase).not.toHaveBeenCalled();
  });
});
