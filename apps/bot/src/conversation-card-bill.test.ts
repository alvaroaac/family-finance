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
  it("no card at all -> terminal refusal", async () => {
    const { deps, getCardBillAmount } = buildDeps({
      listActiveCards: () => [],
      classifyMessage: classifierReturning(markPaidCardIntent()),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
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
      { text: "santander pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_card_bill_confirmation");
    expect(state.cardBillDraft?.cardId).toBeUndefined();
    expect(reply).toBe(
      'Não encontrei o cartão "santander". Cartões da casa: Itaú, Nubank — ou corrija o nome.',
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
      { text: "nubank pago", fromUserId: "user-alvaro" },
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
      'Fatura Nubank de jul/2026 — R$ 1.230,00. Pagar da conta Conta Corrente?\n\nResponda "confirmar", corrija com "valor 2.350" ou "conta X", ou "cancelar".',
    );
  });
});

describe("card-bill start: computed amount / override", () => {
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
      { text: "santander pago", fromUserId: "user-alvaro" },
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
