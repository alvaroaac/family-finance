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

import type { CategoryCatalog } from "@family-finance/categorization";
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
import { CARD_TOKEN_PREFIX, TOKENS } from "./keyboards.js";

const TODAY = "2026-07-06";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [
    { id: "cat-tech", name: "Eletrônicos" },
    { id: "cat-transporte", name: "Transporte" },
  ],
  subcategories: [],
};

function classifierReturning(result: InterpretedIntent | null): MessageClassifier {
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
      { text: "sofa 12000 em 10x", fromUserId: "user-alvaro" },
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
      classifyMessage: classifierReturning(purchaseIntent({ totalCents: 360000 })),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "confirmar", deps, { today: TODAY });
    expect(outcome.reply).toBe("Em quantas parcelas? Responda com \"parcelas 12\".");
    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
  });

  it('"parcelas 12" fills the count', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(purchaseIntent({ totalCents: 360000 })),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "parcelas 12", deps, { today: TODAY });
    expect(outcome.state.installmentDraft?.installmentCount).toBe(12);
    expect(outcome.reply).toContain("Atualizei");
  });

  it('"parcelas 1" is rejected (needs at least 2)', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(purchaseIntent({ totalCents: 360000 })),
    });
    const { state } = await startConversation(
      { text: "notebook 3600", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(state, "parcelas 1", deps, { today: TODAY });
    expect(outcome.reply).toBe(
      "O parcelamento precisa de pelo menos 2 parcelas.",
    );
    expect(outcome.state.installmentDraft?.installmentCount).toBeUndefined();
  });
});

describe("card installment corrections", () => {
  async function startDraft(deps: ConversationDeps): Promise<ConversationState> {
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
    const outcome = await applyMessage(state, "valor 3.700", deps, { today: TODAY });
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
    const outcome = await applyMessage(state, "cartão inter", deps, { today: TODAY });
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
    const outcome = await applyMessage(state, "data 12/06", deps, { today: TODAY });
    expect(outcome.state.installmentDraft?.purchasedOn).toBe("2026-06-12");
    expect(outcome.reply).toContain("Atualizei");
  });

  it('unknown "cartão xyz" replies not-found', async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(
        purchaseIntent({ totalCents: 360000, installmentCount: 12 }),
      ),
    });
    const state = await startDraft(deps);
    const outcome = await applyMessage(state, "cartão xyz", deps, { today: TODAY });
    expect(outcome.reply).toContain('Não encontrei o cartão "xyz"');
  });
});

describe("card installment confirm: persistence", () => {
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
    const outcome = await applyMessage(state, "confirmar", deps, { today: TODAY });

    expect(outcome.state.status).toBe("saved");
    expect(createInstallmentPurchase).toHaveBeenCalledTimes(1);
    const plan = createInstallmentPurchase.mock.calls[0]?.[0] as InstallmentPlan;
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
    const plan = createInstallmentPurchase.mock.calls[0]?.[0] as InstallmentPlan;
    expect(plan.installments[0]?.dueMonth).toBe("2026-07");
  });
});

describe("card installment confirmation keyboard has no responsável button", () => {
  function flatten(keyboard: { inline_keyboard: { callback_data: string }[][] } | undefined) {
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
    const outcome = await applyCallback(state, `${CARD_TOKEN_PREFIX}card-2`, deps, {
      today: TODAY,
    });
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

    const second = await applyCallback(outcome.state, "cf", deps, { today: TODAY });
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

    const outcome = await applyCallback(state, `${CARD_TOKEN_PREFIX}card-2`, deps, {
      today: TODAY,
    });
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
