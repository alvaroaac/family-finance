/**
 * Conversation tests for the card-bill payment flow ("nubank pago", PR-2 /
 * Task 6):
 *
 *  - classify mark_paid{card} -> resolve the card (keyword match/auto-single/
 *    ambiguous grid) -> compute the bill amount -> SUMMARY confirmation
 *    (override amount wins over computed) -> confirmar settles via
 *    deps.settleCardBill (never before), with valor/conta corrections
 *  - a computed-zero bill with no override is a terminal no-write no-op
 *  - cf/cx callback parity with typed confirmar/cancelar; cd:<uuid> resolves
 *    the picked card; a typed card name while the picker is open also resolves
 *  - alreadyPaid is a friendly no-op; a settle failure cancels with an
 *    apology and never claims success
 */

import { describe, it, expect, vi } from "vitest";

import type { CategoryCatalog } from "@family-finance/categorization";
import type { CardBillSettlementDraft } from "@family-finance/domain";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
} from "./conversation.js";
import type { InterpretedIntent, MessageClassifier } from "./interpret.js";
import { CARD_TOKEN_PREFIX, TOKENS } from "./keyboards.js";

const TODAY = "2026-07-06";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [],
  subcategories: [],
};

function classifierReturning(
  result: InterpretedIntent | null,
): MessageClassifier {
  return async () => result;
}

function buildDeps(overrides: Partial<ConversationDeps> = {}): {
  deps: ConversationDeps;
  getCardBillAmount: ReturnType<typeof vi.fn>;
  settleCardBill: ReturnType<typeof vi.fn>;
  logInteraction: ReturnType<typeof vi.fn>;
} {
  const getCardBillAmount = vi.fn(async () => 123000);
  const settleCardBill = vi.fn(async () => ({ alreadyPaid: false }));
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
    resolveAccountIdByName: (name: string) => {
      const normalized = name.toLowerCase();
      if (normalized === "itau" || normalized === "itaú") return "acct-2";
      if (normalized === "pix") return "acct-1";
      return undefined;
    },
    accountNameById: (accountId: string) =>
      accountId === "acct-1"
        ? "Conta Corrente"
        : accountId === "acct-2"
          ? "Itaú"
          : undefined,
    getCardBillAmount,
    settleCardBill,
    ...overrides,
  };
  return {
    deps,
    getCardBillAmount: (deps.getCardBillAmount ??
      getCardBillAmount) as ReturnType<typeof vi.fn>,
    settleCardBill: (deps.settleCardBill ?? settleCardBill) as ReturnType<
      typeof vi.fn
    >,
    logInteraction,
  };
}

function markPaidCardIntent(
  overrides: { keyword?: string; amountCents?: number } = {},
): InterpretedIntent {
  return {
    intent: "mark_paid",
    target: "card",
    keyword: overrides.keyword ?? "nubank",
    amountCents: overrides.amountCents,
  };
}

describe("card-bill start: card resolution", () => {
  it("routes a generic paid fatura occurrence date to the sole card", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: { description: "Fatura errada", monthlyAmountCents: 1 },
      }),
    });

    const started = await startConversation(
      {
        text: "fatura paga dia 05/07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      month: "2026-07",
      paidOn: "2026-07-05",
      amountCents: 123_000,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it("uses a generic paid fatura month as bill month, not an obligation", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: { description: "Fatura errada", monthlyAmountCents: 1 },
      }),
    });

    const started = await startConversation(
      { text: "fatura 07/2026 paga", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 123_000,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it.each([
    ["Paguei o cartão 1000", 100000],
    ["Cartão pago", 123000],
    ["Fatura paga", 123000],
  ])(
    "routes the generic settlement `%s` to the sole card bill without creating an expense",
    async (text, expectedAmountCents) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(null),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-1",
        amountCents: expectedAmountCents,
      });
      expect(started.state.installmentDraft).toBeUndefined();
      expect(started.state.obligationDraft).toBeUndefined();
      expect(deps.createTransaction).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    },
  );

  it.each(["Paguei o cartão 1000", "Cartão pago", "Fatura paga"])(
    "asks which card for the generic settlement `%s` when multiple cards exist",
    async (text) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        listActiveCards: () => [
          { id: "card-1", name: "Nubank" },
          { id: "card-2", name: "Itaú" },
        ],
        classifyMessage: classifierReturning(null),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft?.cardId).toBeUndefined();
      expect(started.reply).toBe("Qual cartão é a fatura?");
      expect(started.state.installmentDraft).toBeUndefined();
      expect(started.state.obligationDraft).toBeUndefined();
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("no card at all -> terminal refusal", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "paguei a fatura nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(getCardBillAmount).not.toHaveBeenCalled();
    expect(reply).toBe("A casa ainda não tem cartão cadastrado.");
  });

  it("keyword matches no card -> opens the picker grid (not terminal)", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Itaú" },
      ],
      classifyMessage: classifierReturning(
        markPaidCardIntent({ keyword: "santander" }),
      ),
    });
    const { state, reply, keyboard } = await startConversation(
      { text: "paguei a fatura santander", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_card_bill_confirmation");
    expect(state.cardBillDraft?.cardId).toBeUndefined();
    expect(reply).toBe(
      'Não encontrei o cartão "Fatura santander". Cartões da casa: Itaú, Nubank — ou corrija o nome.',
    );
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: "Itaú", callback_data: `${CARD_TOKEN_PREFIX}card-2` },
          { text: "Nubank", callback_data: `${CARD_TOKEN_PREFIX}card-1` },
        ],
      ],
    });
  });

  it('short card name "C6" resolves via keyword "c6" (whole-string fallback)', async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "C6" },
      ],
      classifyMessage: classifierReturning(
        markPaidCardIntent({ keyword: "c6" }),
      ),
    });
    const { state, reply } = await startConversation(
      { text: "c6 pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(getCardBillAmount).toHaveBeenCalledWith("card-2", "2026-07");
    expect(state.status).toBe("awaiting_card_bill_confirmation");
    expect(state.cardBillDraft?.cardId).toBe("card-2");
    expect(reply).toContain("C6");
  });

  it("no default account -> terminal refusal", async () => {
    const { deps } = buildDeps({
      defaultAccountId: undefined,
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(reply).toBe(
      "A casa ainda não tem uma conta cadastrada — crie uma em Contas no painel antes de pagar faturas.",
    );
  });

  it("ambiguous keyword (2+ matches) -> grid, no amount computed yet", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank Roxo" },
        { id: "card-2", name: "Nubank Ultravioleta" },
      ],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply, keyboard } = await startConversation(
      { text: "paguei a fatura nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_card_bill_confirmation");
    expect(state.cardBillDraft?.cardId).toBeUndefined();
    expect(getCardBillAmount).not.toHaveBeenCalled();
    expect(reply).toBe("Qual cartão é a fatura?");
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: "Nubank Roxo", callback_data: `${CARD_TOKEN_PREFIX}card-1` },
          {
            text: "Nubank Ultravioleta",
            callback_data: `${CARD_TOKEN_PREFIX}card-2`,
          },
        ],
      ],
    });
  });

  it("exactly one card match -> resolves and computes the amount", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(state.status).toBe("awaiting_card_bill_confirmation");
    expect(state.cardBillDraft?.cardId).toBe("card-1");
    expect(state.cardBillDraft?.amountCents).toBe(123000);
    expect(reply).toBe(
      'Fatura Nubank de jul/2026 — R$ 1.230,00. Pagar da conta Conta Corrente?\nData do pagamento: 06/07/2026.\n\nResponda "confirmar", corrija com "valor 2.350", "conta X" ou "data 05/07/2026", ou "cancelar".',
    );
  });
});

describe("card-bill start: computed amount / override", () => {
  it.each(
    ["Paguei a fatura Nubank dia 5", "Paguei a fatura Nubank dia5"].flatMap(
      (text) => [
        [text, "no AI result", null] as const,
        [
          text,
          "a wrong AI amount",
          markPaidCardIntent({ keyword: "errado", amountCents: 5 }),
        ] as const,
      ],
    ),
  )(
    "uses the computed bill and today's payment date for `%s` with %s",
    async (text, _classificationLabel, classified) => {
      const { deps, getCardBillAmount } = buildDeps({
        classifyMessage: classifierReturning(classified),
        getCardBillAmount: vi.fn(async () => 123000),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-1",
        amountCents: 123000,
        paidOn: TODAY,
      });
      expect(started.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
    },
  );

  it("keeps a bare bill day out of the amount through card selection", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Itaú" },
      ],
      getCardBillAmount: vi.fn(async () => 123000),
    });

    const started = await startConversation(
      { text: "Paguei a fatura dia5", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.state.cardBillDraft).toMatchObject({ paidOn: TODAY });
    expect(started.state.cardBillDraft?.cardId).toBeUndefined();
    expect(started.state.cardBillDraft?.overrideAmountCents).toBeUndefined();

    const picked = await applyCallback(
      started.state,
      `${CARD_TOKEN_PREFIX}card-1`,
      deps,
      { today: TODAY },
    );
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(picked.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      amountCents: 123000,
      paidOn: TODAY,
    });
    expect(picked.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it.each(
    [
      "Paguei o cartão Aurea+ 2",
      "Cartão Aurea+ 2 pago",
      "Fatura Aurea+ 2 paga",
      "Paguei a fatura do cartão Aurea+ 2",
      "Paguei a fatura cartão Aurea+ 2",
      "Fatura do cartão Aurea+ 2 paga",
      "Quitei a fatura do cartão Aurea+ 2",
      "Paguei o cartão chamado Aurea+ 2 pago",
      "Paguei o cartão chamado Aurea+ 2 em 07/2026",
      "Paguei o cartão chamado Aurea+ 2 via Pix",
    ].flatMap((text) => [
      [text, "no AI result", null] as const,
      [
        text,
        "a wrong AI amount",
        markPaidCardIntent({ keyword: "errado", amountCents: 2 }),
      ] as const,
    ]),
  )(
    "uses the computed bill for `%s` with %s",
    async (text, _classificationLabel, classified) => {
      const { deps, getCardBillAmount } = buildDeps({
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+ 2" }],
        classifyMessage: classifierReturning(classified),
        getCardBillAmount: vi.fn(async () => 45000),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(getCardBillAmount).toHaveBeenCalledWith("card-aurea", "2026-07");
      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        amountCents: 45000,
      });
      expect(started.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
    },
  );

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong AI amount",
      markPaidCardIntent({ keyword: "errado", amountCents: 2 }),
    ] as const,
  ])(
    "confirms `Paguei a fatura do cartão Aurea+2` with %s",
    async (_classificationLabel, classified) => {
      const { deps, getCardBillAmount } = buildDeps({
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+2" }],
        classifyMessage: classifierReturning(classified),
        getCardBillAmount: vi.fn(async () => 45000),
      });

      const started = await startConversation(
        {
          text: "Paguei a fatura do cartão Aurea+2",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(getCardBillAmount).toHaveBeenCalledWith("card-aurea", "2026-07");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        amountCents: 45000,
      });
      expect(started.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
    },
  );

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong AI result",
      markPaidCardIntent({ keyword: "Áurea", amountCents: 2 }),
    ] as const,
  ])(
    "keeps an account tail outside the exact card name with %s",
    async (_classificationLabel, classified) => {
      const { deps, getCardBillAmount } = buildDeps({
        listActiveCards: () => [
          { id: "card-aurea-short", name: "Áurea" },
          { id: "card-aurea", name: "Áurea+ 2" },
        ],
        resolveAccountIdByName: (name) =>
          name.toLowerCase() === "inter" ? "acct-inter" : undefined,
        accountNameById: (id) => (id === "acct-inter" ? "Inter" : undefined),
        classifyMessage: classifierReturning(classified),
        getCardBillAmount: vi.fn(async () => 45000),
      });

      const started = await startConversation(
        {
          text: "Paguei o cartão chamado Aurea+ 2 com conta Inter",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(getCardBillAmount).toHaveBeenCalledWith("card-aurea", "2026-07");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        accountId: "acct-inter",
        amountCents: 45000,
      });
    },
  );

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong purchase AI result",
      {
        intent: "plain" as const,
        expense: {
          description: "Compra errada",
          amountCents: 1,
          cardKeyword: "Nubank",
        },
      },
    ] as const,
    [
      "a wrong settlement AI result",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Errado",
        amountCents: 1,
        settlementAccountKeyword: "Nubank PJ",
      },
    ] as const,
  ])(
    "keeps an overlapping source-account span out of longest-card resolution with %s",
    async (_classificationLabel, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        listActiveCards: () => [
          { id: "card-nubank", name: "Nubank" },
          { id: "card-nubank-pj", name: "Nubank PJ" },
        ],
        listActiveAccounts: () => [
          { id: "account-nubank", name: "Nubank" },
        ],
        resolveAccountIdByName: (name) =>
          name.toLowerCase() === "nubank" ? "account-nubank" : undefined,
        accountNameById: (id) =>
          id === "account-nubank" ? "Nubank" : undefined,
        classifyMessage: classifierReturning(classified),
        getCardBillAmount: vi.fn(async () => 99_900),
      });

      const started = await startConversation(
        {
          text: "Paguei Nubank PJ pela conta Nubank 2350",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-nubank-pj",
        accountId: "account-nubank",
        amountCents: 235_000,
        overrideAmountCents: 235_000,
      });
      expect(started.reply).toContain("Fatura Nubank PJ");
      expect(started.reply).toContain("conta Nubank");
      expect(getCardBillAmount).toHaveBeenCalledWith(
        "card-nubank-pj",
        "2026-07",
      );
      expect(deps.createTransaction).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-nubank-pj",
          accountId: "account-nubank",
          amountCents: 235_000,
        }),
      );
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("does not silently resolve an unknown authoritative name to a registered prefix", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [{ id: "card-aurea", name: "Áurea" }],
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: "Paguei o cartão chamado Aurea+ 2 pago",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(getCardBillAmount).not.toHaveBeenCalled();
    expect(started.state.cardBillDraft?.cardId).toBeUndefined();
    expect(started.reply).toContain("Aurea+ 2");
  });

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong AI prefix",
      markPaidCardIntent({ keyword: "Áurea+2", amountCents: 2 }),
    ] as const,
  ])(
    "does not settle a normal fatura whose full target only starts with a registered card with %s",
    async (_classificationLabel, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+2" }],
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        {
          text: "Fatura Aurea+2 Black paga",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft?.cardId).toBeUndefined();
      expect(started.reply).toContain("Aurea+2 Black");
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      "Fatura Card05/08 dia06/08 Black",
      "Fatura Card05/08 paga Black",
      "Fatura Card05/08 R$450 Black",
    ].flatMap((text) => [
      [text, "no AI result", null] as const,
      [
        text,
        "a wrong AI prefix",
        markPaidCardIntent({ keyword: "Card05/08", amountCents: 45_000 }),
      ] as const,
    ]),
  )(
    "does not settle an invalid normal fatura tail for `%s` with %s",
    async (text, _classificationLabel, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        listActiveCards: () => [{ id: "card-date", name: "Card05/08" }],
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft?.cardId).toBeUndefined();
      expect(started.reply).toContain(text.slice("Fatura ".length));
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      "Compra mercado paga na fatura Nubank R$50",
      "Pedido pago na fatura Nubank R$50",
      "Entrada paga na fatura Nubank R$50",
      "Compra da fatura Nubank paga",
      "Pedido da fatura Nubank pago",
      "Entrada da fatura Nubank paga",
      "Fatura Nubank paga, compra do mercado",
      "Compras na fatura Nubank paga",
      "Fatura Nubank paga, pedidos do mercado",
      "Entradas da fatura Nubank paga",
    ].flatMap((text) => [
      [text, "no AI result", null] as const,
      [
        text,
        "a wrong card-settlement AI result",
        markPaidCardIntent({ keyword: "Nubank", amountCents: 5_000 }),
      ] as const,
      [
        text,
        "the correct purchase AI result",
        {
          intent: "plain" as const,
          expense: {
            description: "Mercado",
            amountCents: 5_000,
            cardKeyword: "Nubank",
          },
        },
      ] as const,
    ]),
  )(
    "never starts a card settlement for purchase residue in `%s` with %s",
    async (text, _classificationLabel, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.cardBillDraft).toBeUndefined();
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong purchase AI result",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Compra errada",
          totalCents: 1,
          installmentCount: 12,
          cardKeyword: "Nubank",
        },
      },
    ] as const,
  ])(
    "confirms and persists a card-first qualified amount with reordered source/date tails with %s",
    async (_classificationLabel, classified) => {
      const { deps, settleCardBill } = buildDeps({
        listActiveAccounts: () => [{ id: "acct-2", name: "Inter" }],
        resolveAccountIdByName: (name) =>
          name.toLowerCase() === "inter" ? "acct-2" : undefined,
        accountNameById: (id) => (id === "acct-2" ? "Inter" : undefined),
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        {
          text: "Cartão Nubank pela conta Inter data 05/07/2026 pago por R$ 450",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-1",
        accountId: "acct-2",
        amountCents: 45_000,
        overrideAmountCents: 45_000,
        paidOn: "2026-07-05",
      });
      expect(deps.createTransaction).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-1",
          accountId: "acct-2",
          amountCents: 45_000,
          paidOn: "2026-07-05",
        }),
      );
    },
  );

  it.each([
    ["no AI result", null] as const,
    [
      "a wrong AI result",
      markPaidCardIntent({ keyword: "errado", amountCents: 2 }),
    ] as const,
  ])(
    "masks an authoritative numeric card name before amount parsing and persists its date with %s",
    async (_classificationLabel, classified) => {
      const { deps, settleCardBill } = buildDeps({
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+ 2" }],
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        {
          text: "Paguei o cartão chamado Aurea+ 2 no dia 05/07/2026 por R$ 450",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        amountCents: 45_000,
        overrideAmountCents: 45_000,
        paidOn: "2026-07-05",
      });
      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-aurea",
          amountCents: 45_000,
          paidOn: "2026-07-05",
        }),
      );
    },
  );

  it("keeps an explicit amount outside a numeric known-card name", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [{ id: "card-aurea", name: "Áurea+ 2" }],
      classifyMessage: classifierReturning(
        markPaidCardIntent({ keyword: "errado", amountCents: 2 }),
      ),
      getCardBillAmount: vi.fn(async () => 45000),
    });

    const started = await startConversation(
      {
        text: "Paguei o cartão Aurea+ 2 por R$ 450",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(getCardBillAmount).toHaveBeenCalledWith("card-aurea", "2026-07");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-aurea",
      overrideAmountCents: 45000,
      amountCents: 45000,
    });
  });

  it("routes `Cartão Nubank pago` to computed bill settlement despite wrong plain AI", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning({
        intent: "plain",
        expense: { description: "Cartão Nubank", amountCents: 99900 },
      }),
    });

    const started = await startConversation(
      { text: "Cartão Nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      month: "2026-07",
      amountCents: 45000,
    });
    expect(deps.createTransaction).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        creditCardId: "card-1",
        billMonth: "2026-07",
        amountCents: 45000,
      }),
    );
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it("keeps an explicit R$ 500 override for `Cartão Nubank pago`", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning({
        intent: "plain",
        expense: { description: "Cartão Nubank", amountCents: 99900 },
      }),
    });

    const started = await startConversation(
      { text: "Cartão Nubank pago R$ 500", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      overrideAmountCents: 50000,
      amountCents: 50000,
    });
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["Paguei o Nubank", undefined, 45000],
    ["Nubank pago ontem", undefined, 45000],
    ["Paguei o cartão Nubank via Pix 2000", 200000, 200000],
  ])(
    "keeps `%s` on the Nubank bill path despite a wrong plain classification",
    async (text, expectedOverride, expectedAmount) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        getCardBillAmount: vi.fn(async () => 45000),
        classifyMessage: classifierReturning({
          intent: "plain",
          expense: { description: "Despesa comum", amountCents: 99900 },
        }),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft?.cardId).toBe("card-1");
      expect(started.state.cardBillDraft?.overrideAmountCents).toBe(
        expectedOverride,
      );
      expect(started.state.cardBillDraft?.amountCents).toBe(expectedAmount);
      expect(started.reply).toContain("Fatura Nubank");

      if (expectedOverride !== undefined) {
        await applyMessage(started.state, "confirmar", deps, { today: TODAY });
        expect(settleCardBill).toHaveBeenCalledWith(
          expect.objectContaining({
            creditCardId: "card-1",
            amountCents: 200000,
          }),
        );
      }
    },
  );

  it("shows the computed amount when no trailing amount is given", async () => {
    const { deps } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.cardBillDraft?.amountCents).toBe(450 * 100);
    expect(reply).toContain("R$ 450,00");
  });

  it("a trailing amount (override) wins over the computed amount", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning(
        markPaidCardIntent({ amountCents: 235000 }),
      ),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago 2350", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(getCardBillAmount).toHaveBeenCalled();
    expect(state.cardBillDraft?.overrideAmountCents).toBe(235000);
    expect(state.cardBillDraft?.amountCents).toBe(235000);
    expect(reply).toContain("R$ 2.350,00");
  });

  it("extracts a leading actual payment amount without AI and persists the override", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 123000),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei 1500 da fatura Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.overrideAmountCents).toBe(150000);
    expect(started.state.cardBillDraft?.amountCents).toBe(150000);
    expect(started.reply).toContain("R$ 1.500,00");

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 150000 }),
    );
  });

  it("preserves a card payment amount placed after its named source", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-2", name: "Itaú" }],
    });
    const started = await startConversation(
      {
        text: "Paguei Nubank pela conta Itaú 2350",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      overrideAmountCents: 235000,
      amountCents: 235000,
      accountId: "acct-2",
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 235000, accountId: "acct-2" }),
    );
  });

  it("preserves a card payment amount and source expressed with pelo Pix", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-1", name: "Pix" }],
    });
    const started = await startConversation(
      {
        text: "Paguei Nubank pelo Pix 2350",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      overrideAmountCents: 235000,
      amountCents: 235000,
      accountId: "acct-1",
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 235000, accountId: "acct-1" }),
    );
  });

  it("uses a registered Pix account when the card payment explicitly says conta Pix", async () => {
    const { deps, settleCardBill } = buildDeps({
      defaultAccountId: "acct-itau",
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [
        { id: "acct-itau", name: "Itaú" },
        { id: "acct-pix", name: "Pix" },
      ],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "pix" ? "acct-pix" : undefined,
      accountNameById: (id: string) =>
        id === "acct-itau" ? "Itaú" : id === "acct-pix" ? "Pix" : undefined,
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank pela conta Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      amountCents: 123000,
      accountId: "acct-pix",
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 123000, accountId: "acct-pix" }),
    );
  });

  it("prefers a full Conta-prefixed source over Pix and the default", async () => {
    const { deps, settleCardBill } = buildDeps({
      defaultAccountId: "acct-default",
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [
        { id: "acct-checking", name: "Conta corrente" },
        { id: "acct-pix", name: "Pix" },
      ],
      resolveAccountIdByName: (name: string) => {
        const normalized = name.trim().toLowerCase();
        return normalized === "conta corrente"
          ? "acct-checking"
          : normalized === "pix"
            ? "acct-pix"
            : undefined;
      },
    });
    const started = await startConversation(
      {
        text: "Paguei Nubank pela conta Conta corrente 2350 via Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      overrideAmountCents: 235000,
      amountCents: 235000,
      accountId: "acct-checking",
    });

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 235000,
        accountId: "acct-checking",
      }),
    );
  });

  it("extracts a card payment amount after the card name without AI", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 123000),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei o cartão Nubank 2350",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.overrideAmountCents).toBe(235000);
    expect(started.state.cardBillDraft?.amountCents).toBe(235000);

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 235000 }),
    );
  });

  it("does not treat a bill reference month as the payment amount", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning(
        markPaidCardIntent({ amountCents: 202600 }),
      ),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 08/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
    expect(started.state.cardBillDraft?.amountCents).toBe(45000);
    expect(started.reply).toContain("R$ 450,00");
    expect(started.reply).not.toContain("R$ 2.026,00");
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it("keeps an explicit amount alongside a bill reference month", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning(
        markPaidCardIntent({ amountCents: 202600 }),
      ),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 08/2026 por 2350",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.overrideAmountCents).toBe(235000);
    expect(started.state.cardBillDraft?.amountCents).toBe(235000);

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 235000 }),
    );
  });

  it("uses an explicit prior bill month through confirmation and settlement", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 45000),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(started.state.cardBillDraft?.month).toBe("2026-07");

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-22",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ billMonth: "2026-07" }),
    );
  });

  it("recognizes `em MM/AAAA` as an explicit prior bill month", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      getCardBillAmount: vi.fn(async () => 71000),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank em 07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(started.state.cardBillDraft?.month).toBe("2026-07");
  });

  it("uses an explicit Itaú settlement source through confirmation", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 200000),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank pela conta Itaú R$ 2000",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.accountId).toBe("acct-2");
    expect(started.reply).toContain("Itaú");

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-2", amountCents: 200000 }),
    );
  });

  it.each([
    [
      "wrong AI settlement account",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Nubank",
        settlementAccountKeyword: "Inter",
      } as InterpretedIntent,
    ],
    ["no AI result", null],
  ])(
    "uses the default account for a card settlement with no named source despite %s",
    async (_label, classified) => {
      const { deps, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [{ id: "acct-inter", name: "Inter" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
      });

      const started = await startConversation(
        { text: "Fatura Nubank paga", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft?.accountId).toBe("acct-1");
      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acct-1" }),
      );
    },
  );

  it.each([
    [
      "wrong AI",
      "Paguei a fatura Nubank com conta Inter",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Inter",
        amountCents: 1,
        settlementAccountKeyword: "Nubank",
      } as InterpretedIntent,
      235000,
    ],
    ["no AI result", "Paguei a fatura Nubank com conta Inter", null, 235000],
    [
      "an explicit user amount and wrong AI",
      "Paguei a fatura Nubank R$ 2000 com conta Inter",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Inter",
        amountCents: 1,
        settlementAccountKeyword: "Nubank",
      } as InterpretedIntent,
      200000,
    ],
    [
      "a bare user amount and wrong AI",
      "Paguei a fatura Nubank 2000 com conta Inter",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Inter",
        amountCents: 1,
        settlementAccountKeyword: "Nubank",
      } as InterpretedIntent,
      200000,
    ],
    [
      "a bare user amount and no AI result",
      "Paguei a fatura Nubank 2000 com conta Inter",
      null,
      200000,
    ],
  ])(
    "pays the Nubank bill from the Inter account despite %s",
    async (_label, text, classified, expectedAmount) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [
          { id: "card-nubank", name: "Nubank" },
          { id: "card-inter", name: "Inter" },
        ],
        listActiveAccounts: () => [{ id: "acct-inter", name: "Inter" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
        accountNameById: (id: string) =>
          id === "acct-inter" ? "Inter" : undefined,
        getCardBillAmount: vi.fn(async () => 235000),
      });

      const started = await startConversation(
        {
          text,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-nubank",
        accountId: "acct-inter",
        amountCents: expectedAmount,
      });
      expect(started.state.cardBillDraft?.overrideAmountCents).toBe(
        expectedAmount === 235000 ? undefined : expectedAmount,
      );
      expect(getCardBillAmount).toHaveBeenCalledWith("card-nubank", "2026-07");
      expect(settleCardBill).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-nubank",
          accountId: "acct-inter",
          amountCents: expectedAmount,
        }),
      );
    },
  );

  it("uses the longest full source-account name before a trailing status word", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [
        { id: "acct-mercado", name: "Mercado" },
        { id: "acct-mercado-pago", name: "Mercado Pago" },
      ],
      resolveAccountIdByName: (name: string) =>
        name === "Mercado Pago"
          ? "acct-mercado-pago"
          : name === "Mercado"
            ? "acct-mercado"
            : undefined,
      accountNameById: (id: string) =>
        id === "acct-mercado-pago"
          ? "Mercado Pago"
          : id === "acct-mercado"
            ? "Mercado"
            : undefined,
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank com a conta Mercado Pago hoje",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.accountId).toBe("acct-mercado-pago");
    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-mercado-pago" }),
    );
  });

  it("rejects an unknown explicit settlement source before bill calculation", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank pela conta Inter R$ 2000",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("cancelled");
    expect(started.reply).toContain("Inter");
    expect(started.reply).toMatch(/não encontrei a conta/i);
    expect(getCardBillAmount).not.toHaveBeenCalled();
    expect(settleCardBill).not.toHaveBeenCalled();
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it("expands a standalone short-year bill month through computation and settlement", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async (_cardId, month) =>
        month === "2026-07" ? 71000 : 82000,
      ),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 07/26",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.month).toBe("2026-07");
    expect(started.state.cardBillDraft?.amountCents).toBe(71000);

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-22",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ billMonth: "2026-07", amountCents: 71000 }),
    );
  });

  it.each(["13/2026", "00/26"])(
    "rejects invalid bill month %s before computing or settling despite AI output",
    async (invalidBillMonth) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(
          markPaidCardIntent({ amountCents: 235000 }),
        ),
      });

      const started = await startConversation(
        {
          text: `Paguei a fatura Nubank de ${invalidBillMonth}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("cancelled");
      expect(started.reply).toBe(
        `O mês da fatura “${invalidBillMonth}” é inválido. Envie no formato MM/AAAA, com mês entre 01 e 12.`,
      );
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("treats a full calendar date as occurrence context, not a prior bill month", async () => {
    const getCardBillAmount = vi.fn(async (_cardId: string, month: string) =>
      month === "2026-07" ? 71000 : 82000,
    );
    const { deps } = buildDeps({
      getCardBillAmount,
      classifyMessage: classifierReturning(null),
    });

    const fullDate = await startConversation(
      {
        text: "Paguei a fatura Nubank dia 15/07/26",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );
    expect(fullDate.state.cardBillDraft?.month).toBe("2026-08");
    expect(fullDate.state.cardBillDraft?.amountCents).toBe(82000);

    const standaloneMonth = await startConversation(
      {
        text: "Paguei a fatura Nubank de 07/26",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );
    expect(standaloneMonth.state.cardBillDraft?.month).toBe("2026-07");
    expect(standaloneMonth.state.cardBillDraft?.amountCents).toBe(71000);
  });

  it.each(["Nubank pago dia 10/08", "Paguei a fatura Nubank em 15/07"])(
    "keeps the current bill month when `%s` contains only an occurrence date",
    async (text) => {
      const { deps, getCardBillAmount } = buildDeps({
        getCardBillAmount: vi.fn(async () => 82000),
        classifyMessage: classifierReturning(null),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-08");
      expect(getCardBillAmount).not.toHaveBeenCalledWith("card-1", "2008-10");
      expect(started.state.cardBillDraft?.month).toBe("2026-08");
      expect(started.state.cardBillDraft?.amountCents).toBe(82000);
    },
  );

  it.each([
    ["Paguei a fatura Nubank 13/08", "2026-08-13"],
    ["Paguei a fatura Nubank 10/08", "2026-08-10"],
  ])(
    "treats the bare DD/MM in `%s` as the payment date for the current bill",
    async (text, expectedPaidOn) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        getCardBillAmount: vi.fn(async () => 82000),
        classifyMessage: classifierReturning(null),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        month: "2026-08",
        paidOn: expectedPaidOn,
        amountCents: 82000,
      });
      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-08");
      expect(getCardBillAmount).not.toHaveBeenCalledWith("card-1", "2008-10");
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("does not turn a card bill installment position into paidOn", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank, parcela 10/12",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.paidOn).toBe("2026-08-22");
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it("keeps an installment position out of paidOn through card selection", async () => {
    const { deps, settleCardBill } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "Itaú" },
      ],
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura, parcela 10/12",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft?.cardId).toBeUndefined();
    expect(started.state.cardBillDraft?.paidOn).toBe("2026-08-22");
    expect(settleCardBill).not.toHaveBeenCalled();

    const picked = await applyCallback(
      started.state,
      `${CARD_TOKEN_PREFIX}card-2`,
      deps,
      { today: "2026-08-22" },
    );
    expect(picked.state.cardBillDraft).toMatchObject({
      cardId: "card-2",
      paidOn: "2026-08-22",
    });
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it("carries yesterday across a month boundary through card confirmation", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank ontem",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-01" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-08",
      paidOn: "2026-07-31",
    });

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-01",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        billMonth: "2026-08",
        paidOn: "2026-07-31",
      }),
    );
  });

  it("does not read an authoritative relative-date card name as paidOn", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-yesterday", name: "Ontem" }],
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura do cartão chamado Ontem",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-yesterday",
      month: "2026-08",
      paidOn: "2026-08-23",
    });
  });

  it.each([
    ["no AI result", null],
    ["wrong AI card", markPaidCardIntent({ keyword: "Nubank" })],
  ])(
    "resolves a normal fatura named Ontem without treating its name as paidOn with %s",
    async (_label, classified) => {
      const { deps, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-yesterday", name: "Ontem" }],
      });

      const started = await startConversation(
        {
          text: "Paguei a fatura Ontem",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-yesterday",
        paidOn: "2026-08-23",
      });

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-23",
      });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-yesterday",
          paidOn: "2026-08-23",
        }),
      );
    },
  );

  it.each([
    ["no AI result", null],
    ["wrong AI card", markPaidCardIntent({ keyword: "Nubank" })],
  ])(
    "masks only the normal fatura name Ontem so a later hoje remains the payment date with %s",
    async (_label, classified) => {
      const { deps, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-yesterday", name: "Ontem" }],
      });

      const started = await startConversation(
        {
          text: "Paguei a fatura Ontem hoje",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-yesterday",
        paidOn: "2026-08-23",
      });

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-23",
      });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-yesterday",
          paidOn: "2026-08-23",
        }),
      );
    },
  );

  it.each([
    ["no AI result", null],
    ["wrong AI card", markPaidCardIntent({ keyword: "Nubank" })],
  ])(
    "resolves a normal fatura named Hoje and preserves a later explicit date with %s",
    async (_label, classified) => {
      const { deps, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-today", name: "Hoje" }],
      });

      const started = await startConversation(
        {
          text: "Paguei a fatura Hoje na data 05/07/2026",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        cardId: "card-today",
        paidOn: "2026-07-05",
      });

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-23",
      });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          creditCardId: "card-today",
          paidOn: "2026-07-05",
        }),
      );
    },
  );

  it("does not read an authoritative numeric-date card name as paidOn", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-date", name: "05/08" }],
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura do cartão chamado 05/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-date",
      month: "2026-08",
      paidOn: "2026-08-23",
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-date", "2026-08");
  });

  it("masks only a date-shaped authoritative card name before parsing a later payment date", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-date", name: "05/08" }],
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura do cartão chamado 05/08 dia 06/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-date",
      month: "2026-08",
      paidOn: "2026-08-06",
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-date", "2026-08");
  });

  it("does not shorten an unknown longer date-shaped authoritative card name", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-date", name: "05/08" }],
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura do cartão chamado 05/08 Black dia 06/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft?.cardId).toBeUndefined();
    expect(started.reply).toContain("05/08 Black");
    expect(getCardBillAmount).not.toHaveBeenCalled();
  });

  it("does not read an authoritative numeric-date source name as paidOn", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
      listActiveAccounts: () => [{ id: "acct-date", name: "05/08" }],
      resolveAccountIdByName: (name: string) =>
        name.trim() === "05/08" ? "acct-date" : undefined,
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank pela conta chamada 05/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      cardId: "card-1",
      accountId: "acct-date",
      month: "2026-08",
      paidOn: "2026-08-23",
    });
  });

  it("keeps an explicit `de MM/AA` selector as the bill month, not paidOn", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      getCardBillAmount: vi.fn(async () => 71000),
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 07/26",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-07",
      paidOn: "2026-08-22",
      amountCents: 71000,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
  });

  it.each([
    ["Paguei a fatura Nubank em 07/26", "2026-07", 71000],
    ["Paguei a fatura Nubank em 15/07", "2026-08", 82000],
  ])(
    "hands `%s` through as the intended bill month",
    async (text, expectedMonth, expectedAmount) => {
      const { deps, getCardBillAmount } = buildDeps({
        classifyMessage: classifierReturning(
          markPaidCardIntent({ keyword: "Inter", amountCents: 1507 }),
        ),
        getCardBillAmount: vi.fn(async (_cardId, month) =>
          month === "2026-07" ? 71000 : 82000,
        ),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        month: expectedMonth,
        amountCents: expectedAmount,
      });
      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", expectedMonth);
    },
  );

  it("uses an explicit short-year bill month alongside a separate occurrence date", async () => {
    const { deps, getCardBillAmount, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async (_cardId, month) =>
        month === "2026-06" ? 61000 : 82000,
      ),
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank dia 15/07 de 06/26",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-06");
    expect(started.state.cardBillDraft?.month).toBe("2026-06");
    expect(started.state.cardBillDraft?.amountCents).toBe(61000);

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-22",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ billMonth: "2026-06", amountCents: 61000 }),
    );
  });

  it("computed zero with no override -> terminal zero message, nothing written", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: vi.fn(async () => 0),
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(settleCardBill).not.toHaveBeenCalled();
    expect(reply).toBe(
      "Fatura do Nubank está zerada este mês — nada pra pagar. 👍",
    );
  });

  it("deps.getCardBillAmount undefined -> unavailable terminal", async () => {
    const { deps, settleCardBill } = buildDeps({
      getCardBillAmount: undefined,
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(settleCardBill).not.toHaveBeenCalled();
    expect(reply).toMatch(/não está disponível/i);
  });
});

describe("card-bill picker: cd: tap and typed card name", () => {
  async function openPicker(deps: ConversationDeps) {
    return startConversation(
      { text: "paguei a fatura santander", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
  }

  it("cd:<uuid> resolves the card and computes the amount", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank Roxo" },
        { id: "card-2", name: "Nubank Ultravioleta" },
      ],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await openPicker(deps);
    const outcome = await applyCallback(
      started.state,
      `${CARD_TOKEN_PREFIX}card-2`,
      deps,
      { today: TODAY },
    );
    expect(getCardBillAmount).toHaveBeenCalledWith("card-2", "2026-07");
    expect(outcome.state.cardBillDraft?.cardId).toBe("card-2");
    expect(outcome.reply).toContain("Nubank Ultravioleta");
  });

  it("typing a card name while the picker is open resolves it too", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank Roxo" },
        { id: "card-2", name: "Nubank Ultravioleta" },
      ],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await openPicker(deps);
    const outcome = await applyMessage(started.state, "Roxo", deps, {
      today: TODAY,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-07");
    expect(outcome.state.cardBillDraft?.cardId).toBe("card-1");
    expect(outcome.reply).toContain("Nubank Roxo");
  });

  it('typing "c6" while the picker is open resolves via whole-string fallback', async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank" },
        { id: "card-2", name: "C6" },
      ],
      classifyMessage: classifierReturning(
        markPaidCardIntent({ keyword: "santander" }),
      ),
    });
    const started = await openPicker(deps);
    const outcome = await applyMessage(started.state, "c6", deps, {
      today: TODAY,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-2", "2026-07");
    expect(outcome.state.cardBillDraft?.cardId).toBe("card-2");
    expect(outcome.reply).toContain("C6");
  });

  it("typing a message matching 0 or 2+ cards re-asks with the grid", async () => {
    const { deps } = buildDeps({
      listActiveCards: () => [
        { id: "card-1", name: "Nubank Roxo" },
        { id: "card-2", name: "Nubank Ultravioleta" },
      ],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await openPicker(deps);
    const outcome = await applyMessage(started.state, "Nubank", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("awaiting_card_bill_confirmation");
    expect(outcome.state.cardBillDraft?.cardId).toBeUndefined();
    expect(outcome.reply).toBe("Qual cartão é a fatura?");
  });
});

describe("card-bill confirmation: corrections", () => {
  it("'valor X' overrides the computed amount and re-shows confirmation", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "valor 999,90", deps, {
      today: TODAY,
    });
    expect(outcome.state.cardBillDraft?.overrideAmountCents).toBe(99990);
    expect(outcome.state.cardBillDraft?.amountCents).toBe(99990);
    expect(outcome.reply).toContain("R$ 999,90");
  });

  it("'conta X' found -> re-shows confirmation with the new account", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "conta Itau", deps, {
      today: TODAY,
    });
    expect(outcome.state.cardBillDraft?.accountId).toBe("acct-2");
    expect(outcome.reply).toContain("Itaú");
  });

  it("'conta X' not found -> keeps the draft, replies account-not-found", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(
      started.state,
      "conta Inexistente",
      deps,
      {
        today: TODAY,
      },
    );
    expect(outcome.state.cardBillDraft?.accountId).toBe("acct-1");
    expect(outcome.reply).toBe('Não encontrei a conta "Inexistente".');
  });

  it("cancelar discards the draft", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "cancelar", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("cancelled");
    expect(settleCardBill).not.toHaveBeenCalled();
  });
});

describe("card-bill confirm: persists via settleCardBill", () => {
  it("keeps an explicitly introduced full payment date above a later relative word", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank na data10/12/2025 hoje",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      paidOn: "2025-12-10",
    });

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-23",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ paidOn: "2025-12-10" }),
    );
  });

  it("prefers a relative payment date over a weak structural installment date", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank por R$ 450 hoje, em 10/12/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      paidOn: "2026-08-23",
      amountCents: 45_000,
    });
    expect(started.state.status).toBe("awaiting_card_bill_confirmation");

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-23",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ paidOn: "2026-08-23" }),
    );
  });

  it("treats a bare two-part date as paidOn rather than a historical bill selector", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank 08/12",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-08",
      paidOn: "2025-12-08",
    });
    expect(started.reply).toContain("Data do pagamento: 08/12/2025");

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-23",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        billMonth: "2026-08",
        paidOn: "2025-12-08",
      }),
    );
  });

  it("keeps a contextual DD/MM as paidOn instead of the bill month", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank em 05/09",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-08",
      paidOn: "2025-09-05",
    });
    expect(started.reply).toContain("Data do pagamento: 05/09/2025");

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-23",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        billMonth: "2026-08",
        paidOn: "2025-09-05",
      }),
    );
  });

  it("accepts a focused payment-date correction before confirmation", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "Nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: "2026-08-23" },
    );

    const invalid = await applyMessage(started.state, "data 31/02/2026", deps, {
      today: "2026-08-23",
    });
    expect(invalid.state.status).toBe("awaiting_card_bill_confirmation");
    expect(invalid.reply).toContain("data de pagamento");
    expect(settleCardBill).not.toHaveBeenCalled();

    const corrected = await applyMessage(
      invalid.state,
      "data 05/09/2025",
      deps,
      {
        today: "2026-08-23",
      },
    );
    expect(corrected.state.cardBillDraft).toMatchObject({
      paidOn: "2025-09-05",
    });
    expect(corrected.reply).toContain("Data do pagamento: 05/09/2025");
    expect(settleCardBill).not.toHaveBeenCalled();

    await applyMessage(corrected.state, "confirmar", deps, {
      today: "2026-08-23",
    });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({ paidOn: "2025-09-05" }),
    );
  });

  it("persists an explicit occurrence date while keeping the selected bill month", async () => {
    const { deps, settleCardBill, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 06/2026 em 05/07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_card_bill_confirmation");
    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-06",
      paidOn: "2026-07-05",
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-06");

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        billMonth: "2026-06",
        paidOn: "2026-07-05",
      }),
    );
  });

  it.each([
    ["no AI result", null],
    [
      "a wrong AI result",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Fatura errada",
          monthlyAmountCents: 202_500,
        },
      },
    ],
  ])(
    "uses a compact spoken full card-payment date with %s without turning its year into money",
    async (_label, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Paguei a fatura Nubank em15/08 de2025",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(started.state.status).toBe("awaiting_card_bill_confirmation");
      expect(started.state.cardBillDraft).toMatchObject({
        month: "2026-08",
        paidOn: "2025-08-15",
        amountCents: 123_000,
      });
      expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-08");

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-23",
      });
      expect(settleCardBill).toHaveBeenCalledWith(
        expect.objectContaining({
          billMonth: "2026-08",
          paidOn: "2025-08-15",
          amountCents: 123_000,
        }),
      );
    },
  );

  it("keeps a card bill selector, spoken full occurrence date, and explicit amount separate", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank de 06/2026 por R$ 450 em15/08 de2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.cardBillDraft).toMatchObject({
      month: "2026-06",
      paidOn: "2025-08-15",
      amountCents: 45_000,
    });
    expect(getCardBillAmount).toHaveBeenCalledWith("card-1", "2026-06");
  });

  it.each([
    ["no AI result", null],
    [
      "a wrong AI result",
      {
        intent: "plain" as const,
        expense: { description: "Errado", amountCents: 202_500 },
      },
    ],
  ])(
    "rejects an impossible spoken full card-payment date with %s",
    async (_label, classified) => {
      const { deps, settleCardBill, getCardBillAmount } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: "Paguei a fatura Nubank em31/02 de2025",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("data de pagamento");
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("carries the explicit occurrence date through a card picker", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
      listActiveCards: () => [
        { id: "card-1", name: "Nubank PF" },
        { id: "card-2", name: "Nubank PJ" },
      ],
    });
    const started = await startConversation(
      {
        text: "Paguei a fatura Nubank em 05/07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    expect(started.state.cardBillDraft).toMatchObject({
      paidOn: "2026-07-05",
    });

    const picked = await applyCallback(
      started.state,
      `${CARD_TOKEN_PREFIX}card-2`,
      deps,
      { today: TODAY },
    );
    expect(picked.state.cardBillDraft).toMatchObject({
      cardId: "card-2",
      paidOn: "2026-07-05",
    });

    await applyCallback(picked.state, TOKENS.confirm, deps, { today: TODAY });
    expect(settleCardBill).toHaveBeenCalledWith(
      expect.objectContaining({
        creditCardId: "card-2",
        paidOn: "2026-07-05",
      }),
    );
  });

  it("clarifies an invalid explicit payment date without settling", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const outcome = await startConversation(
      {
        text: "Paguei a fatura Nubank em 31/02/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("data de pagamento");
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it.each(
    ["dia 0", "dia0", "dia 32", "dia100"].flatMap((day) => [
      [day, "no AI result", null] as const,
      [
        day,
        "a wrong AI result",
        {
          intent: "obligation" as const,
          obligation: {
            description: "Fatura errada",
            monthlyAmountCents: 1,
          },
        },
      ] as const,
    ]),
  )(
    "clarifies invalid bare card-payment metadata `%s` with %s",
    async (day, _classificationLabel, classified) => {
      const { deps, getCardBillAmount, settleCardBill } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: `Paguei a fatura Nubank ${day}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("data de pagamento");
      expect(outcome.reply.replace(/\s/g, "")).toContain(
        day.replace(/\s/g, ""),
      );
      expect(getCardBillAmount).not.toHaveBeenCalled();
      expect(settleCardBill).not.toHaveBeenCalled();
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("confirmar calls deps.settleCardBill with the exact draft", async () => {
    const { deps, settleCardBill, logInteraction } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(settleCardBill).toHaveBeenCalledWith({
      householdId: "house-1",
      creditCardId: "card-1",
      accountId: "acct-1",
      billMonth: "2026-07",
      amountCents: 123000,
      paidOn: TODAY,
      createdByUserId: "user-alvaro",
    } satisfies CardBillSettlementDraft);
    expect(outcome.state.status).toBe("saved");
    expect(logInteraction).toHaveBeenCalled();
    expect(outcome.reply).toBe(
      "Fatura paga! ✅ Nubank — R$ 1.230,00 (jul/2026)",
    );
  });

  it("alreadyPaid: true -> friendly no-op, does not log a new interaction", async () => {
    const { deps, logInteraction } = buildDeps({
      settleCardBill: vi.fn(async () => ({ alreadyPaid: true })),
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("saved");
    expect(logInteraction).not.toHaveBeenCalled();
    expect(outcome.reply).toBe(
      "A fatura do Nubank de jul/2026 já estava paga — nada mudou. 👍",
    );
  });

  it("settle throws -> failure message, state cancelled", async () => {
    const { deps } = buildDeps({
      settleCardBill: vi.fn(async () => {
        throw new Error("boom");
      }),
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toBe(
      "Não consegui registrar o pagamento da fatura do Nubank — tenta de novo em instantes.",
    );
  });

  it("deps.settleCardBill undefined -> unavailable terminal", async () => {
    const { deps } = buildDeps({
      settleCardBill: undefined,
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toMatch(/não está disponível/i);
  });
});

describe("card-bill callback parity: cf/cx", () => {
  it("cf callback confirms exactly like typed confirmar", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(started.state, TOKENS.confirm, deps, {
      today: TODAY,
    });
    expect(settleCardBill).toHaveBeenCalledTimes(1);
    expect(outcome.state.status).toBe("saved");
  });

  it("cx callback cancels exactly like typed cancelar", async () => {
    const { deps, settleCardBill } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(started.state, TOKENS.cancel, deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("cancelled");
    expect(settleCardBill).not.toHaveBeenCalled();
  });

  it("an unknown token on a saved state answers expired", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const started = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const confirmed = await applyCallback(started.state, TOKENS.confirm, deps, {
      today: TODAY,
    });
    const outcome = await applyCallback(confirmed.state, TOKENS.cancel, deps, {
      today: TODAY,
    });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toBeDefined();
  });
});
