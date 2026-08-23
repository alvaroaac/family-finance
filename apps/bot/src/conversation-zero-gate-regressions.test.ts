import { describe, expect, it, vi } from "vitest";

import type { CategoryCatalog } from "@family-finance/categorization";
import type { InstallmentPlan } from "@family-finance/domain";

import {
  applyMessage,
  startConversation,
  type ConversationDeps,
} from "./conversation.js";
import type { InterpretedIntent, MessageClassifier } from "./interpret.js";

const TODAY = "2026-08-23";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [{ id: "cat-default", name: "Outros" }],
  subcategories: [],
};

function classifierReturning(
  result: InterpretedIntent | null,
): MessageClassifier {
  return async () => result;
}

function buildDeps(overrides: Partial<ConversationDeps> = {}) {
  const createTransaction = vi.fn(async () => ({ id: "txn-1" }));
  const createInstallmentPurchase = vi.fn(async (plan: InstallmentPlan) => ({
    groupId: "group-1",
    creditCardId: plan.group.creditCardId,
    description: plan.group.description,
    totalCents: plan.group.totalAmount.cents,
    installmentCount: plan.group.installmentCount,
    firstDueMonth:
      plan.installments[0]?.dueMonth ?? plan.group.purchasedOn.slice(0, 7),
  }));
  const createObligation = vi.fn(async () => ({ id: "ob-new" }));
  const materializeObligationPayment = vi.fn(async () => ({
    alreadyPaid: false,
  }));

  const deps: ConversationDeps = {
    householdId: "house-1",
    catalog: CATALOG,
    defaultAccountId: "acct-default",
    resolveCardId: () => undefined,
    resolveAccountId: () => "acct-default",
    resolveResponsibleUserId: () => undefined,
    suggestCategory: async () => ({
      status: "uncategorized" as const,
      suggestion: null,
      requiresConfirmation: false,
    }),
    createTransaction,
    createInstallmentPurchase,
    createObligation,
    materializeObligationPayment,
    logInteraction: vi.fn(async () => undefined),
    listActiveAccounts: () => [
      { id: "acct-default", name: "Conta corrente" },
      { id: "acct-itau", name: "Itaú" },
    ],
    resolveAccountIdByName: (name: string) =>
      name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
    accountNameById: (id: string) =>
      id === "acct-default"
        ? "Conta corrente"
        : id === "acct-itau"
          ? "Itaú"
          : undefined,
    listActiveCards: () => [
      { id: "card-nubank", name: "Nubank" },
      { id: "card-inter", name: "Inter" },
    ],
    cardNameById: (id: string) =>
      id === "card-nubank"
        ? "Nubank"
        : id === "card-inter"
          ? "Inter"
          : undefined,
    listActiveObligations: async () => [
      { id: "ob-rent", description: "Aluguel", amountCents: 120_000 },
      { id: "ob-ipva", description: "IPVA 2026", amountCents: 202_600 },
    ],
    ...overrides,
  };

  return {
    deps,
    createTransaction,
    createInstallmentPurchase,
    createObligation,
    materializeObligationPayment,
  };
}

const WRONG_PLAIN_INTENT: InterpretedIntent = {
  intent: "plain",
  expense: {
    description: "Mercado inventado",
    amountCents: 1,
    accountKeyword: "Itaú",
    cardKeyword: "Inter",
  },
};

const WRONG_CARD_PAYMENT_INTENT: InterpretedIntent = {
  intent: "mark_paid",
  target: "card",
  keyword: "Nubank",
  amountCents: 2,
};

describe("zero-gate conversation regressions", () => {
  it.each([
    [
      "hoje after a generic card",
      "Mercado 100 no cartão hoje",
      "2026-08-23",
      "Hoje",
    ],
    [
      "dia before an occurrence date",
      "Mercado 100 no cartão dia 05/08",
      "2026-08-05",
      "Dia",
    ],
    [
      "hoje before a generic card",
      "Mercado 100 hoje no crédito",
      "2026-08-23",
      "Hoje",
    ],
  ])(
    "does not treat %s as a card name with null or wrong AI",
    async (_label, text, expectedDate, temporalCardName) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps, createTransaction } = buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveCards: () => [
            { id: "card-temporal", name: temporalCardName },
            { id: "card-nubank", name: "Nubank" },
          ],
        });

        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("awaiting_payment_choice");
        expect(outcome.state.draft).toMatchObject({
          description: "Mercado",
          amountCents: 10_000,
          occurredOn: expectedDate,
        });
        expect(outcome.state.draft.cardId).toBeUndefined();
        expect(outcome.state.paymentCandidates?.map(({ id }) => id)).toEqual(
          expect.arrayContaining(["card-temporal", "card-nubank"]),
        );
        expect(createTransaction).not.toHaveBeenCalled();
      }
    },
  );

  it("does not treat ontem as an account name with null or wrong AI", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-ontem", name: "Ontem" },
        ],
      });

      const outcome = await startConversation(
        {
          text: "Mercado 100 na conta ontem",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        occurredOn: "2026-08-22",
        accountId: "acct-default",
      });
      expect(outcome.state.draft.accountId).not.toBe("acct-ontem");
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it("does not treat Hoje as an account name after generic boleto", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-hoje", name: "Hoje" },
        ],
      });

      const outcome = await startConversation(
        { text: "Mercado 100 no boleto hoje", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        occurredOn: TODAY,
        accountId: "acct-default",
      });
      expect(outcome.state.draft.accountId).not.toBe("acct-hoje");
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["Mercado 100 no crédito hoje", "card"],
    ["Mercado 100 no débito hoje", "account"],
  ] as const)(
    "keeps temporal names from hijacking the generic %s instrument alias",
    async (text, instrument) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
        listActiveCards: () => [
          { id: "card-today", name: "Hoje" },
          { id: "card-nubank", name: "Nubank" },
        ],
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-today", name: "Hoje" },
        ],
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        occurredOn: TODAY,
      });
      if (instrument === "card") {
        expect(outcome.state.status).toBe("awaiting_payment_choice");
        expect(outcome.state.draft.cardId).toBeUndefined();
      } else {
        expect(outcome.state.status).toBe("awaiting_confirmation");
        expect(outcome.state.draft.accountId).toBe("acct-default");
      }
      expect(outcome.state.draft.cardId).not.toBe("card-today");
      expect(outcome.state.draft.accountId).not.toBe("acct-today");
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(["Mercado 100 no débito", "Mercado 100 na conta"])(
    "ignores an AI-invented Itaú source for generic account language: %s",
    async (text) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        accountId: "acct-default",
      });
      expect(outcome.state.draft.accountId).not.toBe("acct-itau");
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicitly named account while rejecting invented sources", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
    });

    const outcome = await startConversation(
      {
        text: "Mercado 100 na conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft).toMatchObject({
      description: "Mercado",
      amountCents: 10_000,
      accountId: "acct-itau",
    });
  });

  it("ignores an AI-invented Inter for a generic installment card and asks safely", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "card_installment",
        purchase: {
          description: "Notebook inventado",
          totalCents: 1,
          installmentCount: 2,
          cardKeyword: "Inter",
        },
      }),
    });

    const outcome = await startConversation(
      {
        text: "Notebook 1200 em 12x no cartão",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_installment_confirmation");
    expect(outcome.state.installmentDraft).toMatchObject({
      description: "Notebook",
      totalCents: 120_000,
      installmentCount: 12,
    });
    expect(outcome.state.installmentDraft?.cardId).toBeUndefined();
    expect(outcome.reply).toContain("Qual cartão?");
    expect(
      outcome.keyboard?.inline_keyboard.flat().map(({ text }) => text),
    ).toEqual(["Inter", "Nubank"]);
    expect(createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it("keeps a structural amount clause after generic cartão in the card picker flow", async () => {
    const { deps, createTransaction } = buildDeps({
      classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
      listActiveCards: () => [
        { id: "card-por", name: "Por" },
        { id: "card-nubank", name: "Nubank" },
      ],
    });

    const outcome = await startConversation(
      { text: "Notebook no cartão por 1200", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_payment_choice");
    expect(outcome.state.draft).toMatchObject({
      description: "Notebook",
      amountCents: 120_000,
    });
    expect(outcome.state.draft.cardId).toBeUndefined();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["null AI", null],
    ["wrong AI", WRONG_PLAIN_INTENT],
  ])(
    "does not resolve a spoken structural count as the card named Três with %s",
    async (_label, classified) => {
      const { deps, createInstallmentPurchase } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [
          { id: "card-three", name: "Três" },
          { id: "card-nubank", name: "Nubank" },
        ],
      });

      const outcome = await startConversation(
        {
          text: "Notebook no cartão três vezes de 100",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_installment_confirmation");
      expect(outcome.state.installmentDraft).toMatchObject({
        description: "Notebook",
        installmentCount: 3,
        totalCents: 30_000,
      });
      expect(outcome.state.installmentDraft?.cardId).toBeUndefined();
      expect(outcome.reply).toContain("Qual cartão?");
      expect(createInstallmentPurchase).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["null AI", null],
    ["wrong AI", WRONG_PLAIN_INTENT],
  ])(
    "resolves the explicitly named card Três with %s",
    async (_label, classified) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-three", name: "Três" }],
      });

      const outcome = await startConversation(
        {
          text: "Notebook 300 no cartão chamado Três",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Notebook",
        amountCents: 30_000,
        cardId: "card-three",
      });
    },
  );

  it.each([
    ["Notebook 300 no cartão", "Cartão"],
    ["Notebook 300 no crédito", "Crédito"],
  ] as const)(
    "leaves the generic card picker open instead of selecting a card named %s",
    async (text, genericName) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
        listActiveCards: () => [
          { id: "card-generic", name: genericName },
          { id: "card-nubank", name: "Nubank" },
        ],
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_payment_choice");
      expect(outcome.state.draft).toMatchObject({
        description: "Notebook",
        amountCents: 30_000,
      });
      expect(outcome.state.draft.cardId).toBeUndefined();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Seguro 245 por mês todo dia 14",
      null,
      { description: "Seguro", monthlyAmountCents: 24_500, dueDay: 14 },
    ],
    [
      "Seguro 245 por mês todo dia 14",
      WRONG_PLAIN_INTENT,
      { description: "Seguro", monthlyAmountCents: 24_500, dueDay: 14 },
    ],
    [
      "Financiamento 1800 durante 240 meses",
      null,
      {
        description: "Financiamento",
        monthlyAmountCents: 180_000,
        termMonths: 240,
      },
    ],
    [
      "Financiamento 1800 durante 240 meses",
      WRONG_PLAIN_INTENT,
      {
        description: "Financiamento",
        monthlyAmountCents: 180_000,
        termMonths: 240,
      },
    ],
    [
      "Aluguel 1500 ao mês",
      WRONG_PLAIN_INTENT,
      { description: "Aluguel", monthlyAmountCents: 150_000 },
    ],
    [
      "Academia 99 mensalmente",
      null,
      { description: "Academia", monthlyAmountCents: 9_900 },
    ],
    [
      "Academia 99 mensais durante 12 meses",
      WRONG_PLAIN_INTENT,
      {
        description: "Academia",
        monthlyAmountCents: 9_900,
        termMonths: 12,
      },
    ],
    [
      "Aluguel 1500 todos os meses",
      WRONG_PLAIN_INTENT,
      { description: "Aluguel", monthlyAmountCents: 150_000 },
    ],
    [
      "Academia 99 cada mês",
      null,
      { description: "Academia", monthlyAmountCents: 9_900 },
    ],
    [
      "Seguro recorrente 245",
      WRONG_PLAIN_INTENT,
      { description: "Seguro", monthlyAmountCents: 24_500 },
    ],
    [
      "Academia 99 todos meses",
      WRONG_PLAIN_INTENT,
      { description: "Academia", monthlyAmountCents: 9_900 },
    ],
    [
      "Internet R$ 120/mês",
      null,
      { description: "Internet", monthlyAmountCents: 12_000 },
    ],
    [
      "Internet 120 todo dia 10",
      WRONG_PLAIN_INTENT,
      { description: "Internet", monthlyAmountCents: 12_000, dueDay: 10 },
    ],
    [
      "Mensalidade da academia R$ 99",
      null,
      { description: "Academia", monthlyAmountCents: 9_900 },
    ],
    [
      "Aluguel 1500 todo o mês",
      null,
      { description: "Aluguel", monthlyAmountCents: 150_000 },
    ],
    [
      "Aluguel 1500 todo o mês",
      WRONG_PLAIN_INTENT,
      { description: "Aluguel", monthlyAmountCents: 150_000 },
    ],
  ])(
    "creates a clean recurring obligation draft for %s",
    async (text, classified, expectedDraft) => {
      const expected = expectedDraft as {
        description: string;
        monthlyAmountCents: number;
        termMonths?: number;
        dueDay?: number;
      };
      const { deps, createObligation, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject(expected);
      expect(createObligation).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expected.description,
          amountCents: expected.monthlyAmountCents,
          ...(expected.termMonths === undefined
            ? {}
            : { termMonths: expected.termMonths }),
          ...(expected.dueDay === undefined ? {} : { dueDay: expected.dueDay }),
        }),
      );
    },
  );

  it.each([
    ["classifier unavailable", null],
    [
      "classifier wrongly marks it paid",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "aluguel",
      },
    ],
  ])(
    "does not immediately write the habitual phrase `Eu pago o aluguel` when %s",
    async (_label, classified) => {
      const {
        deps,
        createTransaction,
        createObligation,
        materializeObligationPayment,
      } = buildDeps({ classifyMessage: classifierReturning(classified) });

      const outcome = await startConversation(
        { text: "Eu pago o aluguel", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).not.toBe("saved");
      expect(createTransaction).not.toHaveBeenCalled();
      expect(createObligation).not.toHaveBeenCalled();
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it("does not persist IPVA's year as an AI-invented payment amount", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPVA 2026",
        amountCents: 202_600,
      }),
    });

    const outcome = await startConversation(
      { text: "Paguei IPVA 2026 via Pix", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-ipva",
      month: "2026-08",
      paidOn: TODAY,
    });
  });

  it.each([
    "Paguei IPVA de 2026 via Pix",
    "Paguei IPVA referente a 2026 via Pix",
  ])(
    "does not persist a tax metadata variant as an AI-invented amount: %s",
    async (text) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "IPVA 2026",
          amountCents: 202_600,
        }),
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-ipva",
        month: "2026-08",
        paidOn: TODAY,
      });
    },
  );

  it.each([
    "Notebook não parcelado 300 no crédito Nubank",
    "Notebook sem parcelas 300 no crédito Nubank",
    "Notebook pagamento único 300 no crédito Nubank",
    "sem parcelar: Notebook 300 no crédito Nubank",
    "cobrado de uma vez: Notebook 300 no crédito Nubank",
    "Notebook 300 parcela única no crédito Nubank",
    "Notebook 300 prestação única no crédito Nubank",
    "Notebook 300 em parcela única no crédito Nubank",
    "Notebook 300 uma só parcela no crédito Nubank",
    "Notebook 300 uma só prestação no crédito Nubank",
    "Notebook 300 em uma única vez no crédito Nubank",
    "Notebook em uma só vez por 300 no crédito Nubank",
  ])(
    "keeps single-charge markers out of the purchase draft: %s",
    async (text) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
        listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Notebook",
        amountCents: 30_000,
        cardId: "card-nubank",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    "IPTU 2026",
    "IPVA de2026",
    "Seguro referência2026",
    "IPTU ano fiscal 2026",
    "IPTU ano-calendário 2026",
    "IPTU ano calendário 2026",
    "IPTU exercício fiscal 2026",
    "IPTU exercício financeiro 2026",
    "IPTU exercício financeiro de 2026",
  ])(
    "does not turn standalone metadata into an AI-invented expense amount: %s",
    async (text) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "plain",
          expense: { description: "Taxa", amountCents: 202_600 },
        }),
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).not.toBe("saved");
      expect(outcome.state.draft?.amountCents).toBeUndefined();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit currency amount even when it resembles a year", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPVA",
        amountCents: 1,
      }),
    });

    const outcome = await startConversation(
      { text: "Paguei IPVA R$ 2026 via Pix", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-ipva",
      month: "2026-08",
      paidOn: TODAY,
      amountCents: 202_600,
    });
  });

  it.each(["Hoje", "Ontem", "Anteontem"])(
    "does not let a leading %s occurrence select a same-named instrument",
    async (temporalName) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(WRONG_PLAIN_INTENT),
        listActiveCards: () => [
          { id: "card-temporal", name: temporalName },
          { id: "card-nubank", name: "Nubank" },
        ],
        listActiveAccounts: () => [
          { id: "acct-temporal", name: temporalName },
          { id: "acct-default", name: "Conta corrente" },
        ],
      });

      const outcome = await startConversation(
        {
          text: `${temporalName} mercado 100 no crédito`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_payment_choice");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
      });
      expect(outcome.state.draft.cardId).toBeUndefined();
      expect(outcome.state.draft.accountId).toBeUndefined();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("resolves a temporal card only when the user explicitly names it", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-today", name: "Hoje" }],
      });

      const outcome = await startConversation(
        {
          text: "Mercado 100 no cartão chamado Hoje",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        cardId: "card-today",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it("does not let metadata vocabulary implicitly resolve a same-named instrument", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-reference", name: "Referência" }],
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-reference", name: "Referência" },
        ],
      });

      const outcome = await startConversation(
        { text: "Seguro referência 2026", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).not.toBe("saved");
      expect(outcome.state.draft?.cardId).toBeUndefined();
      expect(outcome.state.draft?.accountId).not.toBe("acct-reference");
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it("preserves an explicitly named cadence account with null or wrong AI", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-monthly", name: "Mensal" },
        ],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "mensal" ? "acct-monthly" : undefined,
        accountNameById: (id: string) =>
          id === "acct-monthly" ? "Mensal" : "Conta corrente",
      });

      const outcome = await startConversation(
        {
          text: "Mercado 100 pela conta de nome Mensal",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        accountId: "acct-monthly",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it("clarifies an unescaped reserved account name instead of silently using the default", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [
          { id: "acct-default", name: "Conta corrente" },
          { id: "acct-today", name: "Hoje" },
        ],
      });

      const outcome = await startConversation(
        { text: "Mercado 100 pela conta Hoje", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("Não consegui");
      expect(outcome.state.draft?.accountId).toBeUndefined();
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it.each(["Hoje", "Parcelado", "Mensal"])(
    "resolves an explicitly escaped reserved card named %s with null or wrong AI",
    async (name) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps, createTransaction } = buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveCards: () => [{ id: "card-reserved", name }],
        });

        const outcome = await startConversation(
          {
            text: `Mercado 100 no cartão de nome ${name}`,
            fromUserId: "user-alvaro",
          },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("awaiting_confirmation");
        expect(outcome.state.draft).toMatchObject({
          description: "Mercado",
          amountCents: 10_000,
          cardId: "card-reserved",
        });
        expect(createTransaction).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps an escaped card named Parcelado 10x as a one-off purchase with null or wrong AI", async () => {
    for (const classified of [null, WRONG_PLAIN_INTENT]) {
      const { deps, createInstallmentPurchase, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [
          { id: "card-short", name: "Parcelado" },
          { id: "card-full", name: "Parcelado 10x" },
        ],
        cardNameById: (id: string) =>
          id === "card-full" ? "Parcelado 10x" : "Parcelado",
      });

      const outcome = await startConversation(
        {
          text: "Mercado 100 no cartão de nome Parcelado 10x",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
        cardId: "card-full",
      });
      expect(outcome.state.installmentDraft).toBeUndefined();
      expect(createInstallmentPurchase).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it.each(["Parcelado", "Mensal 2026", "Conta123", "Hoje2", "Minha.Conta"])(
    "keeps an escaped account named %s as a one-off purchase with null or wrong AI",
    async (name) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const shortName = name
          .replace(/[ .]?\d+$/u, "")
          .split(".")[0] as string;
        const { deps, createObligation, createTransaction } = buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () =>
            shortName === name
              ? [{ id: "acct-full", name }]
              : [
                  { id: "acct-short", name: shortName },
                  { id: "acct-full", name },
                ],
          resolveAccountIdByName: (keyword: string) =>
            keyword === name ? "acct-full" : undefined,
          accountNameById: (id: string) =>
            id === "acct-full" ? name : undefined,
        });

        const outcome = await startConversation(
          {
            text: `Mercado 100 pela conta de nome ${name}`,
            fromUserId: "user-alvaro",
          },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("awaiting_confirmation");
        expect(outcome.state.draft).toMatchObject({
          description: "Mercado",
          amountCents: 10_000,
          accountId: "acct-full",
        });
        expect(outcome.state.obligationDraft).toBeUndefined();
        expect(createObligation).not.toHaveBeenCalled();
        expect(createTransaction).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["IPTU referente a 2026 todo mês", "IPTU de 2026 todo mês"])(
    "strips the complete tax metadata year in %s with null or wrong AI",
    async (text) => {
      for (const classified of [
        null,
        {
          intent: "obligation" as const,
          obligation: {
            description: "IPTU 2026",
            monthlyAmountCents: 202_600,
          },
        },
      ]) {
        const { deps, createObligation, createTransaction } = buildDeps({
          classifyMessage: classifierReturning(classified),
        });

        const outcome = await startConversation(
          {
            text,
            fromUserId: "user-alvaro",
          },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).not.toBe("saved");
        expect(outcome.state.obligationDraft?.description).toBe("IPTU");
        expect(
          outcome.state.obligationDraft?.monthlyAmountCents,
        ).toBeUndefined();
        expect(createObligation).not.toHaveBeenCalled();
        expect(createTransaction).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves the established direct `Paguei aluguel` settlement", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
    });

    const outcome = await startConversation(
      { text: "Paguei aluguel", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-08",
      paidOn: TODAY,
    });
  });

  it.each([
    [
      "card",
      "Notebook 300 no cartão chamado Nubank Ultravioleta",
      "Nubank Ultravioleta",
    ],
    ["account", "Mercado 100 pela conta de nome Conta+", "Conta+"],
  ])(
    "rejects an unknown complete authoritative %s name instead of using its registered prefix",
    async (_kind, text, unknownName) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps, createTransaction, createInstallmentPurchase } =
          buildDeps({
            classifyMessage: classifierReturning(classified),
            listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
            listActiveAccounts: () => [{ id: "acct-conta", name: "Conta" }],
            resolveAccountIdByName: () => "acct-conta",
          });

        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("cancelled");
        expect(outcome.reply).toContain(unknownName);
        expect(createTransaction).not.toHaveBeenCalled();
        expect(createInstallmentPurchase).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [
      "Notebook 300 no cartão chamado Aurea+ 2",
      "Áurea+ 2",
      "card-exact",
      undefined,
    ],
    [
      "Mercado 100 pela conta de nome Conta.2026+",
      "Conta.2026+",
      undefined,
      "acct-exact",
    ],
  ])(
    "accepts a complete authoritative punctuation/numeric name: %s",
    async (text, registeredName, expectedCardId, expectedAccountId) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveCards: () => [{ id: "card-exact", name: registeredName }],
        listActiveAccounts: () => [{ id: "acct-exact", name: registeredName }],
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft.cardId).toBe(expectedCardId);
      expect(outcome.state.draft.accountId).toBe(expectedAccountId);
    },
  );

  it.each([
    [
      "installment",
      "Notebook em 12x de 300 no cartão chamado Nubank Ultravioleta",
      "Nubank Ultravioleta",
      "Nubank",
    ],
    [
      "card bill",
      "Paguei o cartão chamado Nubank Ultravioleta",
      "Nubank Ultravioleta",
      "Nubank",
    ],
    [
      "installment",
      "Notebook em 12x de 300 no cartão chamado Aurea+ 2",
      "Aurea+ 2",
      "Áurea",
    ],
    ["card bill", "Paguei o cartão de nome Aurea+ 2", "Aurea+ 2", "Áurea"],
  ])(
    "never resolves an authoritative %s name through its registered prefix",
    async (_flow, text, authoritativeName, registeredPrefix) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const settleCardBill = vi.fn(async () => ({ alreadyPaid: false }));
        const { deps, createTransaction, createInstallmentPurchase } =
          buildDeps({
            classifyMessage: classifierReturning(classified),
            listActiveCards: () => [
              { id: "card-prefix", name: registeredPrefix },
            ],
            getCardBillAmount: vi.fn(async () => 100_000),
            settleCardBill,
          });

        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).not.toBe("saved");
        expect(outcome.reply).toContain(authoritativeName);
        expect(outcome.state.installmentDraft?.cardId).toBeUndefined();
        expect(outcome.state.cardBillDraft?.cardId).toBeUndefined();
        expect(createTransaction).not.toHaveBeenCalled();
        expect(createInstallmentPurchase).not.toHaveBeenCalled();
        expect(settleCardBill).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["installment", "Notebook em 12x de 300 no cartão chamado Aurea+ 2"],
    ["card bill", "Paguei o cartão de nome Aurea+ 2"],
  ])(
    "resolves an exact authoritative %s name with accents, punctuation, and numbers",
    async (flow, text) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps } = buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveCards: () => [{ id: "card-exact", name: "Áurea+ 2" }],
          getCardBillAmount: vi.fn(async () => 100_000),
          settleCardBill: vi.fn(async () => ({ alreadyPaid: false })),
        });

        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        if (flow === "installment") {
          expect(outcome.state.status).toBe(
            "awaiting_installment_confirmation",
          );
          expect(outcome.state.installmentDraft?.cardId).toBe("card-exact");
        } else {
          expect(outcome.state.status).toBe("awaiting_card_bill_confirmation");
          expect(outcome.state.cardBillDraft?.cardId).toBe("card-exact");
        }
      }
    },
  );

  it("keeps authoritative card corrections exact in installment and bill pickers", async () => {
    const { deps, createInstallmentPurchase } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 12,
          perInstallmentCents: 30_000,
        },
      }),
      listActiveCards: () => [
        { id: "card-nubank", name: "Nubank" },
        { id: "card-inter", name: "Inter" },
      ],
    });
    const installment = await startConversation(
      { text: "Notebook em 12x de 300", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(installment.state.status).toBe("awaiting_installment_confirmation");
    const correctedInstallment = await applyMessage(
      installment.state,
      "cartão chamado Nubank Ultravioleta",
      deps,
      { today: TODAY },
    );
    expect(correctedInstallment.state.installmentDraft?.cardId).toBeUndefined();
    expect(correctedInstallment.reply).toContain("Nubank Ultravioleta");
    expect(createInstallmentPurchase).not.toHaveBeenCalled();

    const billDeps = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
      getCardBillAmount: vi.fn(async () => 100_000),
      settleCardBill: vi.fn(async () => ({ alreadyPaid: false })),
    }).deps;
    const bill = await startConversation(
      {
        text: "Paguei o cartão chamado Nubank Ultravioleta",
        fromUserId: "user-alvaro",
      },
      billDeps,
      { today: TODAY },
    );
    expect(bill.state.cardBillDraft?.cardId).toBeUndefined();
    const correctedBill = await applyMessage(
      bill.state,
      "cartão chamado Nubank Ultravioleta",
      billDeps,
      { today: TODAY },
    );
    expect(correctedBill.state.cardBillDraft?.cardId).toBeUndefined();
    expect(correctedBill.reply).toContain("Nubank Ultravioleta");
  });

  it.each([null, WRONG_PLAIN_INTENT, WRONG_CARD_PAYMENT_INTENT])(
    "uses the computed bill instead of a digit inside an authoritative card name with %s AI",
    async (classified) => {
      const getCardBillAmount = vi.fn(async () => 123_400);
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+ 2" }],
        getCardBillAmount,
      });

      const outcome = await startConversation(
        {
          text: "Paguei o cartão chamado Aurea+ 2",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_card_bill_confirmation");
      expect(outcome.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        amountCents: 123_400,
      });
      expect(outcome.state.cardBillDraft?.overrideAmountCents).toBeUndefined();
      expect(getCardBillAmount).toHaveBeenCalledWith("card-aurea", "2026-08");
    },
  );

  it.each([null, WRONG_PLAIN_INTENT])(
    "keeps an explicit amount outside an authoritative numeric card name with %s AI",
    async (classified) => {
      const getCardBillAmount = vi.fn(async () => 123_400);
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-aurea", name: "Áurea+ 2" }],
        getCardBillAmount,
      });

      const outcome = await startConversation(
        {
          text: "Paguei o cartão chamado Aurea+ 2 por R$ 450",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.cardBillDraft).toMatchObject({
        cardId: "card-aurea",
        overrideAmountCents: 45_000,
        amountCents: 45_000,
      });
    },
  );

  it.each([null, WRONG_PLAIN_INTENT])(
    "strips a terminal sentence delimiter from an authoritative card name with %s AI",
    async (classified) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
        getCardBillAmount: vi.fn(async () => 100_000),
      });

      const outcome = await startConversation(
        {
          text: "Paguei o cartão chamado Nubank.",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.cardBillDraft?.cardId).toBe("card-nubank");
    },
  );

  it("prefers an exact punctuation-ending registered card name", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [
        { id: "card-plain", name: "Minha.Conta" },
        { id: "card-punctuated", name: "Minha.Conta." },
      ],
      getCardBillAmount: vi.fn(async () => 100_000),
    });

    const outcome = await startConversation(
      {
        text: "Paguei o cartão chamado Minha.Conta.",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.cardBillDraft?.cardId).toBe("card-punctuated");
  });

  it("keeps a date-shaped authoritative account separate from a plain expense date", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-date", name: "05/08" }],
      resolveAccountIdByName: (name: string) =>
        name.trim() === "05/08" ? "acct-date" : undefined,
      accountNameById: (id: string) =>
        id === "acct-date" ? "05/08" : undefined,
    });

    const outcome = await startConversation(
      {
        text: "Mercado 100 pela conta chamada 05/08 dia 06/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft).toMatchObject({
      accountId: "acct-date",
      occurredOn: "2026-08-06",
    });
  });

  it("rejects one-character partial replies but accepts exact short card names", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [
        { id: "card-xp", name: "XP" },
        { id: "card-c6", name: "C6" },
      ],
      getCardBillAmount: vi.fn(async () => 100_000),
    });

    const billPicker = await startConversation(
      { text: "Fatura paga", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const partialBill = await applyMessage(billPicker.state, "x", deps, {
      today: TODAY,
    });
    expect(partialBill.state.cardBillDraft?.cardId).toBeUndefined();
    const exactBill = await applyMessage(partialBill.state, "xp", deps, {
      today: TODAY,
    });
    expect(exactBill.state.cardBillDraft?.cardId).toBe("card-xp");

    const installment = await startConversation(
      {
        text: "Notebook em 12x de 300",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    expect(installment.state.installmentDraft?.cardId).toBeUndefined();
    const partialInstallment = await applyMessage(
      installment.state,
      "cartão x",
      deps,
      { today: TODAY },
    );
    expect(partialInstallment.state.installmentDraft?.cardId).toBeUndefined();
    const exactInstallment = await applyMessage(
      partialInstallment.state,
      "cartão xp",
      deps,
      { today: TODAY },
    );
    expect(exactInstallment.state.installmentDraft?.cardId).toBe("card-xp");

    const initialDeps = buildDeps({
      classifyMessage: classifierReturning({
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 12,
          perInstallmentCents: 30_000,
          cardKeyword: "x",
        },
      }),
      listActiveCards: () => [
        { id: "card-xp", name: "XP" },
        { id: "card-c6", name: "C6" },
      ],
    }).deps;
    const initialPartial = await startConversation(
      {
        text: "Notebook em 12x de 300",
        fromUserId: "user-alvaro",
      },
      initialDeps,
      { today: TODAY },
    );
    expect(initialPartial.state.installmentDraft?.cardId).toBeUndefined();
  });
});

describe("complete authoritative metadata tails", () => {
  const temporalInstrumentOverrides: Partial<ConversationDeps> = {
    listActiveCards: () => [{ id: "card-today", name: "Hoje" }],
    listActiveAccounts: () => [{ id: "acct-today", name: "Hoje" }],
    resolveAccountIdByName: (name) =>
      name.trim().toLowerCase() === "hoje" ? "acct-today" : undefined,
    accountNameById: (id) => (id === "acct-today" ? "Hoje" : undefined),
    cardNameById: (id) => (id === "card-today" ? "Hoje" : undefined),
    getCardBillAmount: vi.fn(async () => 45_000),
    settleCardBill: vi.fn(async () => ({ alreadyPaid: false })),
  };

  it.each([null, WRONG_PLAIN_INTENT])(
    "masks the exact temporal card name and parses a later date with %# AI",
    async (classified) => {
      const { deps } = buildDeps({
        ...temporalInstrumentOverrides,
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: "Paguei o cartão chamado Hoje na data 05/07/2026 por R$ 450",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_card_bill_confirmation");
      expect(outcome.state.cardBillDraft).toMatchObject({
        cardId: "card-today",
        amountCents: 45_000,
        paidOn: "2026-07-05",
      });
    },
  );

  it.each([null, WRONG_PLAIN_INTENT])(
    "keeps a later date outside an exact temporal account name with %# AI",
    async (classified) => {
      const { deps } = buildDeps({
        ...temporalInstrumentOverrides,
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: "Mercado 100 pela conta chamada Hoje no dia 05/07/2026",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft).toMatchObject({
        description: "Mercado",
        accountId: "acct-today",
        occurredOn: "2026-07-05",
      });
    },
  );

  it.each([null, WRONG_PLAIN_INTENT])(
    "carries an exact temporal source and later bare date into obligation settlement with %# AI",
    async (classified) => {
      const { deps, materializeObligationPayment } = buildDeps({
        ...temporalInstrumentOverrides,
        classifyMessage: classifierReturning(classified),
      });
      const outcome = await startConversation(
        {
          text: "Paguei aluguel pela conta chamada Hoje 05/07/2026",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: "2026-07-05",
        accountId: "acct-today",
      });
    },
  );

  it.each([
    ["single credit", "Notebook 300 no cartão chamado Hoje data 05/07/2026"],
    [
      "installment",
      "Notebook em 12x de 300 no cartão chamado Hoje data 05/07/2026",
    ],
  ])(
    "resolves an exact temporal card and later date for a %s purchase with null and wrong AI",
    async (_flow, text) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps } = buildDeps({
          ...temporalInstrumentOverrides,
          classifyMessage: classifierReturning(classified),
        });
        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        const draft = outcome.state.installmentDraft ?? outcome.state.draft;
        expect(draft).toMatchObject({
          cardId: "card-today",
        });
        expect(
          "purchasedOn" in draft ? draft.purchasedOn : draft.occurredOn,
        ).toBe("2026-07-05");
      }
    },
  );

  it.each([
    ["card bill", "Paguei o cartão chamado Hoje hoje Black"],
    ["plain account", "Mercado 100 pela conta chamada Hoje hoje Black"],
    ["single credit", "Notebook 300 no cartão chamado Hoje hoje Black"],
    ["installment", "Notebook em 12x de 300 no cartão chamado Hoje hoje Black"],
    ["obligation", "Paguei aluguel pela conta chamada Hoje hoje Black"],
  ])(
    "preserves unknown residue and performs no write in the %s flow",
    async (_flow, text) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const settleCardBill = vi.fn(async () => ({ alreadyPaid: false }));
        const {
          deps,
          createTransaction,
          createInstallmentPurchase,
          materializeObligationPayment,
        } = buildDeps({
          ...temporalInstrumentOverrides,
          settleCardBill,
          classifyMessage: classifierReturning(classified),
        });
        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).not.toBe("saved");
        expect(outcome.reply).toContain("Hoje hoje Black");
        expect(createTransaction).not.toHaveBeenCalled();
        expect(createInstallmentPurchase).not.toHaveBeenCalled();
        expect(materializeObligationPayment).not.toHaveBeenCalled();
        expect(settleCardBill).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["direct obligation", "paguei academia R$ 0 ontem pela conta Inter"],
    ["obligation picker", "paguei mensalidade R$ 0 ontem pela conta Inter"],
    ["card-bill picker", "paguei a fatura R$ 0 ontem pela conta Inter"],
    [
      "signed card-bill amount beside parcela",
      "Paguei a fatura do Nubank parcela -10 reais pela conta Inter",
    ],
    [
      "zero obligation amount beside parcela",
      "Paguei parcela 0 reais do financiamento",
    ],
  ])(
    "rejects an explicit non-positive amount before the %s can use a scheduled/computed amount",
    async (_flow, text) => {
      for (const classified of [
        null,
        WRONG_PLAIN_INTENT,
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "Academia",
          amountCents: 10_000,
        },
      ]) {
        const getCardBillAmount = vi.fn(async () => 50_000);
        const settleCardBill = vi.fn(async () => ({ alreadyPaid: false }));
        const { deps, createTransaction, materializeObligationPayment } =
          buildDeps({
            classifyMessage: classifierReturning(classified),
            listActiveAccounts: () => [
              { id: "acct-default", name: "Conta corrente" },
              { id: "acct-inter", name: "Inter" },
            ],
            resolveAccountIdByName: (name) =>
              name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
            listActiveObligations: async () => [
              {
                id: "ob-academia-1",
                description: "Academia",
                amountCents: 10_000,
              },
              {
                id: "ob-academia-2",
                description: "Academia Karol",
                amountCents: 12_000,
              },
              {
                id: "ob-escola",
                description: "Mensalidade escola",
                amountCents: 80_000,
              },
            ],
            getCardBillAmount,
            settleCardBill,
          });
        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("cancelled");
        expect(outcome.reply).toContain("maior que R$ 0");
        expect(createTransaction).not.toHaveBeenCalled();
        expect(materializeObligationPayment).not.toHaveBeenCalled();
        expect(getCardBillAmount).not.toHaveBeenCalled();
        expect(settleCardBill).not.toHaveBeenCalled();

        const afterConfirm = await applyMessage(
          outcome.state,
          "confirmar",
          deps,
          { today: TODAY },
        );
        expect(afterConfirm.state.status).toBe("cancelled");
        expect(createTransaction).not.toHaveBeenCalled();
        expect(materializeObligationPayment).not.toHaveBeenCalled();
        expect(settleCardBill).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["bare zero", "Paguei parcela 0 do financiamento do carro"],
    ["slash zero", "Paguei parcela 0/12 do financiamento do carro"],
    ["spoken zero", "Paguei parcela zero do financiamento do carro"],
    ["explicit zero", "Paguei a parcela número 0 do financiamento do carro"],
  ])(
    "terminally rejects the %s installment ordinal with null, wrong, and correct AI",
    async (_label, text) => {
      for (const classified of [
        null,
        WRONG_PLAIN_INTENT,
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "Financiamento do carro",
          amountCents: 10_000,
        },
      ]) {
        const { deps, createTransaction, materializeObligationPayment } =
          buildDeps({
            classifyMessage: classifierReturning(classified),
            listActiveObligations: async () => [
              {
                id: "ob-car",
                description: "Financiamento do carro",
                amountCents: 50_000,
              },
            ],
          });
        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("cancelled");
        expect(outcome.reply).toContain("maior ou igual a 1");
        expect(createTransaction).not.toHaveBeenCalled();
        expect(materializeObligationPayment).not.toHaveBeenCalled();

        await applyMessage(outcome.state, "confirmar", deps, { today: TODAY });
        expect(createTransaction).not.toHaveBeenCalled();
        expect(materializeObligationPayment).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["null AI", null],
    ["wrong AI", WRONG_PLAIN_INTENT],
    [
      "correct AI",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Financiamento do carro",
        amountCents: 1_000,
      },
    ],
  ])(
    "settles a positive signed explicit amount with %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveObligations: async () => [
            {
              id: "ob-car",
              description: "Financiamento do carro",
              amountCents: 50_000,
            },
          ],
        });
      const outcome = await startConversation(
        {
          text: "Paguei +10 reais do financiamento do carro",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          obligationId: "ob-car",
          amountCents: 1_000,
        }),
      );
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("keeps a signed positive merchant payment on the ordinary expense path", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(WRONG_CARD_PAYMENT_INTENT),
      },
    );
    const started = await startConversation(
      {
        text: "Paguei +10 reais no mercado",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_confirmation");
    expect(started.state.draft).toMatchObject({
      description: "Mercado",
      amountCents: 1_000,
    });
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each([
    "Paguei academia +10 reais ontem pela conta Inter",
    "Paguei academia por R$ +10",
  ])(
    "settles a clean positive signed Academia payment with null and wrong AI: %s",
    async (text) => {
      for (const classified of [null, WRONG_PLAIN_INTENT]) {
        const { deps, createTransaction, materializeObligationPayment } =
          buildDeps({
            classifyMessage: classifierReturning(classified),
            listActiveAccounts: () => [
              { id: "acct-default", name: "Conta corrente" },
              { id: "acct-inter", name: "Inter" },
            ],
            resolveAccountIdByName: (name) =>
              name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
            listActiveObligations: async () => [
              {
                id: "ob-academia",
                description: "Academia",
                amountCents: 10_000,
              },
            ],
          });

        const outcome = await startConversation(
          { text, fromUserId: "user-alvaro" },
          deps,
          { today: TODAY },
        );

        expect(outcome.state.status).toBe("saved");
        expect(materializeObligationPayment).toHaveBeenCalledWith(
          expect.objectContaining({
            obligationId: "ob-academia",
            amountCents: 1_000,
          }),
        );
        expect(createTransaction).not.toHaveBeenCalled();
      }
    },
  );
});
