/**
 * Conversation tests for the recurring-obligations flows (PR-1):
 *
 *  - obligation create: classify -> SUMMARY confirmation -> confirmar persists
 *    via deps.createObligation (never before), with valor/dia/conta corrections
 *  - mark_paid{obligation}: keyword match (single/ambiguous/none), send-date
 *    paidOn, idempotent repeat
 *  - a null classifier result falls back to the legacy plain-expense path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { CategoryCatalog } from "@family-finance/categorization";
import type { InstallmentPlan } from "@family-finance/domain";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
} from "./conversation.js";
import { TOKENS } from "./keyboards.js";
import type { InterpretedIntent, MessageClassifier } from "./interpret.js";

const TODAY = "2026-07-03";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [{ id: "cat-moradia", name: "Moradia" }],
  subcategories: [],
};

async function unexpectedInstallmentResult(plan: InstallmentPlan) {
  return {
    groupId: "group-unexpected",
    creditCardId: plan.group.creditCardId,
    description: plan.group.description,
    totalCents: plan.group.totalAmount.cents,
    installmentCount: plan.group.installmentCount,
    firstDueMonth:
      plan.installments[0]?.dueMonth ?? plan.group.purchasedOn.slice(0, 7),
  };
}

function classifierReturning(
  result: InterpretedIntent | null,
): MessageClassifier {
  return async () => result;
}

function buildDeps(overrides: Partial<ConversationDeps> = {}): {
  deps: ConversationDeps;
  createTransaction: ReturnType<typeof vi.fn>;
  createObligation: ReturnType<typeof vi.fn>;
  materializeObligationPayment: ReturnType<typeof vi.fn>;
  logInteraction: ReturnType<typeof vi.fn>;
} {
  const createTransaction = vi.fn(async () => ({ id: "txn-1" }));
  const createObligation = vi.fn(async () => ({ id: "ob-new" }));
  const materializeObligationPayment = vi.fn(async () => ({
    alreadyPaid: false,
  }));
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
    createTransaction,
    logInteraction,
    listActiveObligations: async () => [
      { id: "ob-solar", description: "Parcela solar", amountCents: 71044 },
      {
        id: "ob-carro",
        description: "Financiamento carro",
        amountCents: 90000,
      },
      { id: "ob-rent", description: "Aluguel", amountCents: 120000 },
    ],
    createObligation,
    materializeObligationPayment,
    resolveAccountIdByName: (name: string) => {
      const normalized = name.trim().toLowerCase();
      return normalized === "nubank"
        ? "acct-nubank"
        : normalized === "pix"
          ? "acct-pix"
          : undefined;
    },
    accountNameById: (id: string) =>
      id === "acct-1"
        ? "Conta corrente"
        : id === "acct-nubank"
          ? "Nubank"
          : id === "acct-pix"
            ? "Pix"
            : undefined,
    ...overrides,
  };
  return {
    deps,
    createTransaction,
    createObligation,
    materializeObligationPayment,
    logInteraction,
  };
}

const SOLAR_INTENT: InterpretedIntent = {
  intent: "obligation",
  obligation: {
    description: "Solar",
    monthlyAmountCents: 71044,
    termMonths: 72,
    startMonth: "2026-10",
    dueDay: 5,
  },
};

describe("obligation create flow", () => {
  it.each([
    [
      "an incorrect classified obligation",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Empréstimo incorreto",
          monthlyAmountCents: 99900,
          termMonths: 3,
        },
      },
    ],
    ["deterministic fallback", null],
  ])(
    "keeps crédito consignado on the canonical obligation path with %s",
    async (_label, classified) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Crédito consignado 24 parcelas de 500",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.installmentDraft).toBeUndefined();
      expect(started.state.obligationDraft).toMatchObject({
        description: "Crédito consignado",
        monthlyAmountCents: 50000,
        termMonths: 24,
      });
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Crédito consignado",
          amountCents: 50000,
          termMonths: 24,
        }),
      );
    },
  );

  it.each([
    ["without AI", null],
    [
      "with conflicting installment AI",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Notebook",
          totalCents: 30000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        },
      },
    ],
  ])(
    "keeps a bare count-first loan amount on the obligation path %s",
    async (_label, classified) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Empréstimo 12 parcelas 300",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.installmentDraft).toBeUndefined();
      expect(started.state.obligationDraft).toMatchObject({
        description: "Empréstimo",
        monthlyAmountCents: 30000,
        termMonths: 12,
      });
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Empréstimo",
          amountCents: 30000,
          termMonths: 12,
        }),
      );
    },
  );

  it.each([
    [
      "a conflicting expense",
      {
        intent: "plain" as const,
        expense: { description: "Empréstimo errado", amountCents: 1 },
      },
    ],
    [
      "an already correct obligation",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Empréstimo",
          monthlyAmountCents: 50_000,
          termMonths: 12,
        },
      },
    ],
    ["no classifier result", null],
  ])(
    "persists R$ 500 per month for 12 spoken `vezes de` with %s",
    async (_label, classified) => {
      const { deps, createObligation, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Empréstimo em doze vezes de 500",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject({
        description: "Empréstimo",
        monthlyAmountCents: 50_000,
        termMonths: 12,
      });
      expect(createObligation).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });

      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Empréstimo",
          amountCents: 50_000,
          termMonths: 12,
        }),
      );
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("keeps a lunch with the same named account on the plain-expense path", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "plain",
          expense: {
            description: "Almoço",
            amountCents: 7500,
          },
        }),
        listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
      },
    );

    const outcome = await startConversation(
      { text: "Almoço 75 pela conta Itaú", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.state.draft).toMatchObject({
      description: "Almoço",
      amountCents: 7500,
      accountId: "acct-itau",
    });
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown named account", "Almoço 75 pela conta Fantasma", null],
    [
      "an unknown named card despite a wrong plain classification",
      "Almoço 75 no cartão Fantasma",
      {
        intent: "plain" as const,
        expense: { description: "Almoço", amountCents: 7500 },
      },
    ],
  ])(
    "clarifies %s instead of using the household default",
    async (_label, text, classified) => {
      const { deps, createTransaction } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
        listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("Fantasma");
      expect(outcome.reply).toMatch(/não encontrei (a conta|o cartão)/i);
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("replies with a SUMMARY confirmation (never 72 lines) and does not persist", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const { state, reply } = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("awaiting_obligation_confirmation");
    expect(createObligation).not.toHaveBeenCalled();
    expect(reply).toContain("Parcela solar");
    expect(reply).toContain("R$ 710,44/mês × 72");
    expect(reply).toContain("out/2026 → set/2032");
    expect(reply).toContain("Vence dia 5");
    expect(reply).toContain("Conta corrente");
    expect(reply).toMatch(/confirmar/i);
    // Summary, not a parcel list.
    expect(reply.split("\n").length).toBeLessThan(15);
  });

  it.each([
    ["710,44 parcela solar 72x a partir de 05/10", "Parcela solar"],
    ["R$710,44 parcela solar em 72x", "Parcela solar"],
    ["710,44 empréstimo 72x", "Empréstimo"],
    ["710,44 consórcio 72x", "Consórcio"],
    [
      "R$710,44 financiamento solar em 72x a partir de 05/10",
      "Financiamento solar",
    ],
  ])(
    "uses the amount-first fixed-obligation value as monthly: %s",
    async (text, description) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "obligation",
          obligation: {
            description: "Obrigação errada",
            monthlyAmountCents: 5_100_000,
            termMonths: 72,
          },
        }),
      });

      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject({
        description,
        monthlyAmountCents: 71_044,
        termMonths: 72,
      });
      expect(started.reply).toContain("R$ 710,44/mês × 72");
      expect(createObligation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Parcela solar 710,44 72x", "acct-1"],
    ["Parcela solar 710,44 72x pela conta Solar", "acct-solar"],
  ])(
    "uses the registered Solar account only with explicit payment-source syntax: %s",
    async (text, expectedAccountId) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "obligation",
          obligation: {
            description: "Parcela solar",
            monthlyAmountCents: 71_044,
            termMonths: 72,
          },
        }),
        listActiveAccounts: () => [
          { id: "acct-1", name: "Conta corrente" },
          { id: "acct-solar", name: "Solar" },
        ],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "solar" ? "acct-solar" : undefined,
        accountNameById: (id: string) =>
          id === "acct-solar" ? "Solar" : "Conta corrente",
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_obligation_confirmation");
      expect(outcome.state.obligationDraft?.accountId).toBe(expectedAccountId);
    },
  );

  it.each([
    ["Parcela solar 710,44 72x todo dia 29", 28],
    ["Parcela solar 710,44 72x todo dia 30", 28],
    ["Parcela solar 710,44 72x todo dia 31", 28],
  ] as const)(
    "clamps an explicit late-month due day through confirmation and persistence: %s",
    async (text, dueDay) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(null),
      });
      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject({
        description: "Parcela solar",
        monthlyAmountCents: 71_044,
        termMonths: 72,
        dueDay,
      });
      expect(started.reply).toContain("Vence dia 28");
      expect(started.reply).toContain(
        `Ajustei o vencimento solicitado (dia ${text.match(/dia (\d+)/)?.[1]}) para o dia 28`,
      );

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({ dueDay }),
      );
    },
  );

  it.each([
    classifierReturning(null),
    classifierReturning({
      intent: "obligation",
      obligation: {
        description: "Parcela solar",
        monthlyAmountCents: 71_044,
        termMonths: 72,
        dueDay: 1,
      },
    }),
  ])(
    "does not draft or persist an explicit zero due day despite classifier %#",
    async (classifyMessage) => {
      const { deps, createObligation } = buildDeps({ classifyMessage });
      const started = await startConversation(
        {
          text: "Parcela solar 710,44 72x todo dia 0",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).not.toBe("awaiting_obligation_confirmation");
      expect(createObligation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["R$710,44 parcela solar em 72x", "Parcela solar"],
    ["710,44 empréstimo 72x", "Empréstimo"],
    ["710,44 consórcio 72x", "Consórcio"],
  ])(
    "persists an amount-first finite obligation instead of creating a card purchase: %s",
    async (text, description) => {
      const createInstallmentPurchase = vi.fn(unexpectedInstallmentResult);
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "card_installment",
          purchase: {
            description: "Compra errada",
            totalCents: 71_044,
            installmentCount: 72,
            cardKeyword: "Nubank",
          },
        }),
        createInstallmentPurchase,
      });
      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.installmentDraft).toBeUndefined();
      expect(started.state.obligationDraft).toMatchObject({
        description,
        monthlyAmountCents: 71_044,
        termMonths: 72,
      });

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description,
          amountCents: 71_044,
          termMonths: 72,
        }),
      );
      expect(createInstallmentPurchase).not.toHaveBeenCalled();
    },
  );

  it("does not write mixed finite-obligation and explicit-card evidence", async () => {
    const createInstallmentPurchase = vi.fn(unexpectedInstallmentResult);
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "card_installment",
        purchase: {
          description: "Parcela solar",
          totalCents: 71_044,
          installmentCount: 72,
          cardKeyword: "Nubank",
        },
      }),
      createInstallmentPurchase,
    });

    const outcome = await startConversation(
      {
        text: "R$710,44 parcela solar em 72x no cartão Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(createObligation).not.toHaveBeenCalled();
    expect(createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it("persists via createObligation only after confirmar, with the right domain draft", async () => {
    const { deps, createObligation, logInteraction } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    const confirmed = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });

    expect(confirmed.state.status).toBe("saved");
    expect(createObligation).toHaveBeenCalledTimes(1);
    const draft = createObligation.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(draft).toMatchObject({
      householdId: "house-1",
      description: "Parcela solar",
      amountCents: 71044,
      startMonth: "2026-10",
      termMonths: 72,
      dueDay: 5,
      accountId: "acct-1",
      createdByUserId: "user-alvaro",
    });
    expect(logInteraction).toHaveBeenCalledTimes(1);
    expect(confirmed.reply).toMatch(/salv/i);
  });

  it("carries an explicit start date into deterministic obligation fallback", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_obligation_confirmation");
    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2026-10",
      dueDay: 5,
    });
    expect(started.reply).toContain("out/2026");
    expect(started.reply).toContain("Vence dia 5");
    expect(createObligation).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ startMonth: "2026-10", dueDay: 5 }),
    );
  });

  it.each([
    ["deterministic fallback", null],
    [
      "a misleading AI due day",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Aluguel errado",
          monthlyAmountCents: 1,
          dueDay: 5,
        },
      },
    ],
  ])(
    "preserves an independent due day and clean description with %s",
    async (_label, classified) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "aluguel1200 todo mês dia10 a partir de05/09",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject({
        description: "Aluguel",
        monthlyAmountCents: 120_000,
        startMonth: "2026-09",
        dueDay: 10,
      });
      expect(started.reply).toContain("Vence dia 10");
      expect(started.reply).not.toContain("Ajustei o vencimento solicitado");
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Aluguel",
          amountCents: 120_000,
          startMonth: "2026-09",
          dueDay: 10,
        }),
      );
    },
  );

  it.each([29, 31])(
    "clamps, discloses, and persists explicit due day %i independently of the start date",
    async (requestedDueDay) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(null),
      });
      const started = await startConversation(
        {
          text: `Aluguel 1200 todo mês dia ${requestedDueDay} a partir de 05/09`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.obligationDraft).toMatchObject({
        description: "Aluguel",
        startMonth: "2026-09",
        dueDay: 28,
      });
      expect(started.reply).toContain(
        `Ajustei o vencimento solicitado (dia ${requestedDueDay}) para o dia 28`,
      );

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({ startMonth: "2026-09", dueDay: 28 }),
      );
    },
  );

  it.each([
    ["deterministic fallback", null],
    [
      "a misleading AI due day",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71044,
          termMonths: 72,
          startMonth: "2027-03",
          dueDay: 1,
        },
      },
    ],
  ])(
    "discloses and persists a late due day from an explicit start date with %s",
    async (_label, classified) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(classified),
      });
      const started = await startConversation(
        {
          text: "Parcela solar 710,44 72x a partir de 31/10/2026",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft).toMatchObject({
        startMonth: "2026-10",
        dueDay: 28,
      });
      expect(started.reply).toContain(
        "Ajustei o vencimento solicitado (dia 31) para o dia 28",
      );
      expect(started.reply).toContain("Vence dia 28");
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({ startMonth: "2026-10", dueDay: 28 }),
      );
    },
  );

  it("does not show an adjustment warning for a valid explicit start due day", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 28/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2026-10",
      dueDay: 28,
    });
    expect(started.reply).not.toContain("Ajustei o vencimento solicitado");
  });

  it("preserves a valid classified future start month", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71044,
          termMonths: 72,
          startMonth: "2027-10",
          dueDay: 5,
        },
      }),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-11-03" },
    );

    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2027-10",
      dueDay: 5,
    });

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-11-03",
    });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ startMonth: "2027-10", dueDay: 5 }),
    );
  });

  it("rolls a past yearless start date to its next calendar occurrence", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-11-03" },
    );

    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2027-10",
      dueDay: 5,
    });
    expect(createObligation).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-11-03",
    });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ startMonth: "2027-10", dueDay: 5 }),
    );
  });

  it.each([
    ["the current month", "05/08", "2026-08"],
    ["an earlier month", "05/07", "2027-07"],
  ])(
    "resolves a yearless start in %s using obligation month chronology",
    async (_label, rawDate, expectedStartMonth) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(null),
      });
      const started = await startConversation(
        {
          text: `Parcela solar 710,44 72x a partir de ${rawDate}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.obligationDraft).toMatchObject({
        startMonth: expectedStartMonth,
        dueDay: 5,
      });
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-22",
      });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          startMonth: expectedStartMonth,
          dueDay: 5,
        }),
      );
    },
  );

  it("uses an explicit start year over a conflicting valid AI month", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71044,
          termMonths: 72,
          startMonth: "2027-10",
          dueDay: 5,
        },
      }),
    });
    const started = await startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2025-10",
      dueDay: 5,
    });
    expect(createObligation).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, {
      today: "2026-08-22",
    });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ startMonth: "2025-10", dueDay: 5 }),
    );
  });

  it.each([
    ["classifier fallback", null],
    [
      "a misleading AI date",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71044,
          termMonths: 72,
          startMonth: "2027-03",
          dueDay: 1,
        },
      },
    ],
  ])(
    "rejects an impossible explicit obligation start date before %s can create a draft",
    async (_label, classified) => {
      const classifyMessage = vi.fn(async () => classified);
      const { deps, createObligation } = buildDeps({ classifyMessage });

      const started = await startConversation(
        {
          text: "Parcela solar 710,44 72x a partir de 31/02",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("cancelled");
      expect(started.state.obligationDraft).toBeUndefined();
      expect(started.reply).toContain("data de início");
      expect(started.reply).toContain("31/02");
      expect(classifyMessage).not.toHaveBeenCalled();
      expect(createObligation).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, {
        today: "2026-08-22",
      });
      expect(createObligation).not.toHaveBeenCalled();
    },
  );

  it.each(["31/04", "29/02/2026", "10/13/2026"])(
    "rejects the impossible calendar start date %s",
    async (rawDate) => {
      const { deps, createObligation } = buildDeps({
        classifyMessage: classifierReturning(null),
      });

      const started = await startConversation(
        {
          text: `Parcela solar 710,44 72x a partir de ${rawDate}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-22" },
      );

      expect(started.state.status).toBe("cancelled");
      expect(started.reply).toContain(rawDate);
      expect(createObligation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["explicit leap year", "29/02/2028"],
    ["yearless next leap occurrence", "29/02"],
  ])("accepts a valid %s start date", async (_label, rawDate) => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(null),
    });

    const started = await startConversation(
      {
        text: `Parcela solar 710,44 72x a partir de ${rawDate}`,
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-22" },
    );

    expect(started.state.status, started.reply).toBe(
      "awaiting_obligation_confirmation",
    );
    expect(started.state.obligationDraft).toMatchObject({
      startMonth: "2028-02",
    });
    expect(createObligation).not.toHaveBeenCalled();
  });

  it("defaults startMonth to the current month and dueDay to 1 when unstated", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: { description: "Aluguel", monthlyAmountCents: 120000 },
      }),
    });
    const started = await startConversation(
      { text: "aluguel 1200 todo mês", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    const draft = createObligation.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(draft).toMatchObject({
      startMonth: "2026-07",
      dueDay: 1,
      termMonths: null,
      accountId: "acct-1",
    });
  });

  it.each([
    [
      "an incorrect AI Pix account",
      {
        intent: "obligation",
        obligation: {
          description: "Aluguel",
          monthlyAmountCents: 150000,
          accountKeyword: "Pix",
        },
      } as unknown as InterpretedIntent,
    ],
    ["classifier fallback", null],
  ])(
    "creates an Itaú obligation from explicit text despite %s and no default account",
    async (_label, classified) => {
      const { deps, createObligation } = buildDeps({
        defaultAccountId: undefined,
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [
          { id: "acct-itau", name: "Itaú" },
          { id: "acct-pix", name: "Pix" },
        ],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú"
            ? "acct-itau"
            : name.trim().toLowerCase() === "pix"
              ? "acct-pix"
              : undefined,
      });
      const started = await startConversation(
        {
          text: "Aluguel 1500 todo mês pela conta Itaú",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_obligation_confirmation");
      expect(started.state.obligationDraft?.accountId).toBe("acct-itau");
      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Aluguel",
          amountCents: 150000,
          accountId: "acct-itau",
        }),
      );
    },
  );

  it("keeps the default account when Pix only names the payment method", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const started = await startConversation(
      {
        text: "Aluguel 1500 todo mês no Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.obligationDraft?.accountId).toBe("acct-1");
    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1" }),
    );
  });

  it("creates an obligation on a registered Pix account when text explicitly says conta Pix", async () => {
    const { deps, createObligation } = buildDeps({
      defaultAccountId: "acct-itau",
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [
        { id: "acct-itau", name: "Itaú" },
        { id: "acct-pix", name: "Pix" },
      ],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "pix" ? "acct-pix" : undefined,
    });
    const started = await startConversation(
      {
        text: "Aluguel 1500 todo mês pela conta Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_obligation_confirmation");
    expect(started.state.obligationDraft?.accountId).toBe("acct-pix");
    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(createObligation).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-pix" }),
    );
  });

  it("clarifies an unknown explicit obligation account without creating", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: {
          description: "Aluguel",
          monthlyAmountCents: 150000,
          accountKeyword: "Fantasma",
        },
      } as unknown as InterpretedIntent),
    });
    const { state, reply } = await startConversation(
      {
        text: "Aluguel 1500 todo mês pela conta Fantasma",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toContain("Fantasma");
    expect(createObligation).not.toHaveBeenCalled();
  });

  it("asks for the amount when missing, and 'valor X' fills it", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: { description: "Aluguel" },
      }),
    });
    const started = await startConversation(
      { text: "aluguel todo mês", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("awaiting_obligation_confirmation");
    expect(started.reply).toMatch(/valor/i);

    const corrected = await applyMessage(
      started.state,
      "valor 1.200,00",
      deps,
      {
        today: TODAY,
      },
    );
    expect(corrected.reply).toContain("R$ 1.200,00/mês");

    const confirmed = await applyMessage(corrected.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(confirmed.state.status).toBe("saved");
    expect(createObligation.mock.calls[0]?.[0]).toMatchObject({
      amountCents: 120000,
    });
  });

  it("refuses to confirm without an amount", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: { description: "Aluguel" },
      }),
    });
    const started = await startConversation(
      { text: "aluguel todo mês", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const attempt = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(attempt.state.status).toBe("awaiting_obligation_confirmation");
    expect(createObligation).not.toHaveBeenCalled();
    expect(attempt.reply).toMatch(/valor/i);
  });

  it("applies dia and conta corrections", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startConversation(
      { text: "Parcela solar 710,44 72x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const withDay = await applyMessage(started.state, "dia 7", deps, {
      today: TODAY,
    });
    expect(withDay.reply).toContain("Vence dia 7");
    const withAccount = await applyMessage(
      withDay.state,
      "conta Nubank",
      deps,
      {
        today: TODAY,
      },
    );
    expect(withAccount.reply).toContain("Nubank");

    await applyMessage(withAccount.state, "confirmar", deps, { today: TODAY });
    expect(createObligation.mock.calls[0]?.[0]).toMatchObject({
      dueDay: 7,
      accountId: "acct-nubank",
    });
  });

  it("creates a fixed-term monthly recurrence and preserves the account before its start date", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: {
          description: "Academia errada",
          monthlyAmountCents: 1,
          termMonths: 2,
        },
      }),
      listActiveAccounts: () => [{ id: "acct-inter", name: "Inter" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
    });

    const started = await startConversation(
      {
        text: "Academia R$99 por mês durante 12 meses na conta Inter a partir de 15/09",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_obligation_confirmation");
    expect(started.state.obligationDraft).toMatchObject({
      description: "Academia",
      monthlyAmountCents: 9_900,
      termMonths: 12,
      startMonth: "2026-09",
      dueDay: 15,
      accountId: "acct-inter",
    });
    expect(createObligation).not.toHaveBeenCalled();
  });

  it("cancelar discards the obligation draft", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startConversation(
      { text: "Parcela solar 710,44 72x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const cancelled = await applyMessage(started.state, "cancelar", deps, {
      today: TODAY,
    });
    expect(cancelled.state.status).toBe("cancelled");
    expect(createObligation).not.toHaveBeenCalled();
  });
});

const ARBITRARY_MARK_PAID_CHOICE_WORDS = [
  "Carro",
  "Escola",
  "show",
  "tá",
  "tudo",
  "feito",
  "tranquilo",
  "normal",
  "processada",
  "concluída",
  "entretanto",
  "assim",
] as const;

describe("mark_paid{obligation} flow", () => {
  it.each([
    ["classifier unavailable", null],
    [
      "classifier points at the source provider",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Empréstimo Nubank",
        amountCents: 1,
      },
    ],
    [
      "classifier agrees with the target",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 1,
      },
    ],
  ])(
    "settles Escola through the source account when account and card are both Nubank and %s",
    async (_label, classified) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
        listActiveAccounts: () => [{ id: "acct-nubank", name: "Nubank" }],
        listActiveObligations: async () => [
          { id: "ob-school", description: "Escola", amountCents: 50_000 },
          {
            id: "ob-nubank-loan",
            description: "Empréstimo Nubank",
            amountCents: 50_000,
          },
        ],
      });

      const outcome = await startConversation(
        {
          text: "Paguei escola 500 pela conta Nubank",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-school",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 50_000,
        accountId: "acct-nubank",
      });
    },
  );

  it("does not auto-settle when the preserved target matches multiple obligations", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
      listActiveAccounts: () => [{ id: "acct-nubank", name: "Nubank" }],
      listActiveObligations: async () => [
        { id: "ob-school-a", description: "Escola Alice", amountCents: 50_000 },
        { id: "ob-school-b", description: "Escola Bruno", amountCents: 50_000 },
        {
          id: "ob-nubank-loan",
          description: "Empréstimo Nubank",
          amountCents: 50_000,
        },
      ],
    });

    const outcome = await startConversation(
      {
        text: "Paguei escola 500 pela conta Nubank",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_mark_paid_choice");
    expect(outcome.reply).toContain("Escola Alice");
    expect(outcome.reply).toContain("Escola Bruno");
    expect(outcome.reply).not.toContain("Empréstimo Nubank");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each(["Paguei aluguel ontem ou anteontem", "Paguei aluguel hoje ontem"])(
    "rejects conflicting relative payment dates before a direct settlement: %s",
    async (text) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel",
        }),
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("data de pagamento");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it("allows duplicate relative references that resolve to the same date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
      }),
    });

    const outcome = await startConversation(
      {
        text: "Paguei aluguel ontem ontem",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: "2026-07-02",
    });
  });

  it("rejects conflicting relative dates before opening an obligation picker", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
      }),
      listActiveObligations: async () => [
        { id: "ob-school-a", description: "Escola Alice", amountCents: 50_000 },
        { id: "ob-school-b", description: "Escola Bruno", amountCents: 50_000 },
      ],
    });

    const outcome = await startConversation(
      {
        text: "Paguei escola 500 via Pix ontem ou anteontem",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "card settlement",
      "Paguei a fatura Nubank hoje ontem",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Nubank",
      },
    ],
    [
      "installment purchase",
      "Notebook em 12x de 300 no crédito Nubank hoje ontem",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Notebook",
          totalAmountCents: 360_000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        },
      },
    ],
  ])(
    "rejects conflicting relative dates before a %s can write",
    async (_label, text, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveCards: () => [{ id: "card-nubank", name: "Nubank" }],
        });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(createTransaction).not.toHaveBeenCalled();
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["classifier unavailable", null],
    [
      "classifier points at a different obligation",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
      },
    ],
  ])(
    "does not settle Conta de luz from an account-shaped Escola target when %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () => [{ id: "acct-school", name: "Escola" }],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "escola" ? "acct-school" : undefined,
          listActiveObligations: async () => [
            { id: "ob-light", description: "Conta de luz", amountCents: 18000 },
          ],
        });

      const outcome = await startConversation(
        {
          text: "Paguei a conta da escola pela conta Escola",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("settles the exact account-shaped obligation through its same-named source account", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
      }),
      listActiveAccounts: () => [{ id: "acct-school", name: "Escola" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "escola" ? "acct-school" : undefined,
      listActiveObligations: async () => [
        {
          id: "ob-school-bill",
          description: "Conta da escola",
          amountCents: 95000,
        },
        { id: "ob-light", description: "Conta de luz", amountCents: 18000 },
      ],
    });

    const outcome = await startConversation(
      {
        text: "Paguei a conta da escola pela conta Escola",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-school-bill",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-school",
    });
  });

  it("requires a choice when the complete account-shaped target matches multiple obligations", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Conta da escola Alice",
      }),
      listActiveAccounts: () => [{ id: "acct-school", name: "Escola" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "escola" ? "acct-school" : undefined,
      listActiveObligations: async () => [
        {
          id: "ob-school-alice",
          description: "Conta da escola Alice",
          amountCents: 95000,
        },
        {
          id: "ob-school-bruno",
          description: "Conta da escola Bruno",
          amountCents: 95000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Paguei a conta da escola pela conta Escola",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const selected = await applyMessage(
      started.state,
      "Conta da escola Alice",
      deps,
      { today: TODAY },
    );
    expect(selected.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-school-alice",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-school",
    });
  });

  it.each([
    [
      "a missing classifier",
      "Paguei a conta de internet R$119,90 pela conta Inter",
      null,
    ],
    [
      "a wrong plain classifier",
      "QuiteI a conta de internet R$119,90 pela conta Inter",
      {
        intent: "plain" as const,
        expense: { description: "Internet", amountCents: 1 },
      },
    ],
  ])(
    "settles an explicit account target with %s instead of creating an expense",
    async (_label, text, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () => [{ id: "acct-inter", name: "Inter" }],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
          listActiveObligations: async () => [
            {
              id: "ob-internet",
              description: "Conta de internet",
              amountCents: 11990,
            },
          ],
        });

      const outcome = await startConversation(
        {
          text,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-internet",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 11_990,
        accountId: "acct-inter",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Paguei o aluguel pela conta Inter3", null, undefined],
    [
      "Paguei o aluguel R$ 1500 pela conta Inter3",
      {
        intent: "plain" as const,
        expense: { description: "errado", amountCents: 3 },
      },
      150_000,
    ],
    [
      "Paguei o aluguel pela conta Inter3 R$ 1500",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "errado",
        amountCents: 3,
        settlementAccountKeyword: "errado",
      },
      150_000,
    ],
  ])(
    "persists a resolved numeric settlement account without leaking its digit into the obligation amount: %s",
    async (text, classified, amountCents) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [{ id: "acct-inter3", name: "Inter3" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "inter3" ? "acct-inter3" : undefined,
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
        accountId: "acct-inter3",
        ...(amountCents === undefined ? {} : { amountCents }),
      });
    },
  );

  it("settles an obligation from a registered Pix account when text explicitly says conta Pix", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      defaultAccountId: "acct-itau",
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
      listActiveAccounts: () => [
        { id: "acct-itau", name: "Itaú" },
        { id: "acct-pix", name: "Pix" },
      ],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "pix" ? "acct-pix" : undefined,
    });

    const { state } = await startConversation(
      {
        text: "Paguei aluguel pela conta Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-pix",
    });
  });

  it.each([
    ["Paguei a conta de luz pela conta Itaú", "ob-luz", "Conta de luz"],
    ["Paguei IPTU pela conta Itaú", "ob-iptu", "IPTU"],
    ["Paguei Internet pela conta Itaú", "ob-internet", "Internet"],
    ["Paguei Academia pela conta Itaú", "ob-academia", "Academia"],
  ])(
    "hands %s from deterministic routing to obligation settlement with the named account",
    async (text, obligationId, keyword) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning({
            intent: "mark_paid",
            target: "obligation",
            keyword,
          }),
          listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
          listActiveObligations: async () => [
            { id: "ob-luz", description: "Conta de luz", amountCents: 18000 },
            { id: "ob-iptu", description: "IPTU", amountCents: 25000 },
            {
              id: "ob-internet",
              description: "Internet",
              amountCents: 12000,
            },
            {
              id: "ob-academia",
              description: "Academia",
              amountCents: 9900,
            },
          ],
        });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId,
        month: "2026-07",
        paidOn: TODAY,
        accountId: "acct-itau",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("uses an explicit payment date for both paidOn and the obligation month", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    await startConversation(
      {
        text: "Paguei aluguel em 05/09/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2025-09",
      paidOn: "2025-09-05",
    });
  });

  it("prefers a relative payment date over a weak structural installment date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    const outcome = await startConversation(
      {
        text: "Paguei aluguel hoje, parcela em 10/12/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );
    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-08",
      paidOn: "2026-08-23",
    });
  });

  it.each([
    ["no AI result", null],
    [
      "a wrong AI result",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Aluguel errado",
          installmentCount: 12,
          totalCents: 202_500,
        },
      },
    ],
  ])(
    "uses a compact spoken full payment date with %s without turning its year into money",
    async (_label, classified) => {
      const { deps, materializeObligationPayment, createTransaction } =
        buildDeps({ classifyMessage: classifierReturning(classified) });

      const outcome = await startConversation(
        {
          text: "Paguei aluguel em15/08 de2025",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2025-08",
        paidOn: "2025-08-15",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("preserves a separate explicit amount beside a spoken full obligation payment date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
    });

    await startConversation(
      {
        text: "Paguei aluguel por R$ 1.100 em15/08 de2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2025-08",
      paidOn: "2025-08-15",
      amountCents: 110_000,
    });
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
    "rejects an impossible spoken full obligation payment date with %s",
    async (_label, classified) => {
      const { deps, materializeObligationPayment, createTransaction } =
        buildDeps({ classifyMessage: classifierReturning(classified) });
      const outcome = await startConversation(
        {
          text: "Paguei aluguel em31/02 de2025",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-23" },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain("data de pagamento");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Paguei aluguel pela conta chamada Ontem", "2026-08-23"],
    ["Paguei aluguel pela conta chamada Ontem ontem", "2026-08-22"],
    ["Paguei aluguel pela conta chamada Ontem dia 05/08", "2026-08-05"],
  ])(
    "keeps an authoritative temporal account name out of paidOn in `%s`",
    async (text, expectedPaidOn) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "aluguel",
        }),
        listActiveAccounts: () => [{ id: "acct-yesterday", name: "Ontem" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "ontem" ? "acct-yesterday" : undefined,
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: "2026-08-23" },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: expectedPaidOn.slice(0, 7),
        paidOn: expectedPaidOn,
        accountId: "acct-yesterday",
      });
    },
  );

  it("carries an authoritative temporal account through an ambiguous obligation picker", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
      }),
      listActiveAccounts: () => [{ id: "acct-yesterday", name: "Ontem" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "ontem" ? "acct-yesterday" : undefined,
      listActiveObligations: async () => [
        {
          id: "ob-car-sp",
          description: "Financiamento carro SP",
          amountCents: 90000,
        },
        {
          id: "ob-car-rj",
          description: "Financiamento carro RJ",
          amountCents: 95000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Paguei financiamento do carro pela conta chamada Ontem",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state).toMatchObject({
      status: "awaiting_mark_paid_choice",
      markPaidAccountId: "acct-yesterday",
    });
    expect(started.state.markPaidPaidOn).toBeUndefined();

    await applyMessage(started.state, "SP", deps, { today: "2026-08-23" });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-sp",
      month: "2026-08",
      paidOn: "2026-08-23",
      accountId: "acct-yesterday",
    });
  });

  it("keeps a date-shaped authoritative account separate from a later payment date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
      listActiveAccounts: () => [{ id: "acct-date", name: "05/08" }],
      resolveAccountIdByName: (name: string) =>
        name.trim() === "05/08" ? "acct-date" : undefined,
    });

    const outcome = await startConversation(
      {
        text: "Paguei aluguel pela conta chamada 05/08 dia 06/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-08",
      paidOn: "2026-08-06",
      accountId: "acct-date",
    });
  });

  it("carries a date-shaped authoritative account and later date through the obligation picker", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
      }),
      listActiveAccounts: () => [{ id: "acct-date", name: "05/08" }],
      resolveAccountIdByName: (name: string) =>
        name.trim() === "05/08" ? "acct-date" : undefined,
      listActiveObligations: async () => [
        {
          id: "ob-car-sp",
          description: "Financiamento carro SP",
          amountCents: 90000,
        },
        {
          id: "ob-car-rj",
          description: "Financiamento carro RJ",
          amountCents: 95000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Paguei financiamento do carro pela conta de nome 05/08 dia 06/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state).toMatchObject({
      status: "awaiting_mark_paid_choice",
      markPaidAccountId: "acct-date",
      markPaidPaidOn: "2026-08-06",
    });

    await applyMessage(started.state, "SP", deps, { today: "2026-08-23" });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-sp",
      month: "2026-08",
      paidOn: "2026-08-06",
      accountId: "acct-date",
    });
  });

  it("settles an obligation when a structural installment fraction identifies its position", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "notebook",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-notebook",
          description: "Notebook",
          amountCents: 30000,
        },
      ],
    });

    const outcome = await startConversation(
      {
        text: "Parcela 10/12 do notebook paga",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-notebook",
      month: "2026-07",
      paidOn: TODAY,
    });
  });

  it.each([
    [
      "Paguei financiamento do carro 10/12",
      "carro",
      "ob-carro",
      "Financiamento carro",
    ],
    [
      "Paguei empréstimo pessoal 10/12",
      "empréstimo",
      "ob-loan",
      "Empréstimo pessoal",
    ],
    [
      "Paguei consórcio da moto 10/12",
      "consórcio",
      "ob-consortium",
      "Consórcio moto",
    ],
  ])(
    "treats the bare financing fraction in `%s` as an installment position",
    async (text, keyword, obligationId, description) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword,
        }),
        listActiveObligations: async () => [
          { id: obligationId, description, amountCents: 90000 },
        ],
      });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId,
        month: "2026-07",
        paidOn: TODAY,
      });
    },
  );

  it("skips a financing position and uses the later explicit payment date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "carro",
      }),
    });

    await startConversation(
      {
        text: "Paguei financiamento do carro 10/12 em 05/08",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-08",
      paidOn: "2026-08-05",
    });
  });

  it("treats an impossible financing position as the payment date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "carro",
      }),
    });

    const outcome = await startConversation(
      {
        text: "Financiamento do carro pago 31/07",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: "2026-07-31",
    });
  });

  it("keeps a financing position out of paidOn through obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-car-sp",
          description: "Financiamento carro SP",
          amountCents: 90000,
        },
        {
          id: "ob-car-rj",
          description: "Financiamento carro RJ",
          amountCents: 95000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Paguei financiamento do carro 10/12",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidPaidOn).toBeUndefined();

    const chosen = await applyMessage(started.state, "SP", deps, {
      today: TODAY,
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-sp",
      month: "2026-07",
      paidOn: TODAY,
    });
  });

  it("preserves an impossible financing position as paidOn through obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-car-sp",
          description: "Financiamento carro SP",
          amountCents: 90000,
        },
        {
          id: "ob-car-rj",
          description: "Financiamento carro RJ",
          amountCents: 95000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Financiamento do carro pago 31/07",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidPaidOn).toBe("2026-07-31");

    const chosen = await applyMessage(started.state, "SP", deps, {
      today: "2026-08-23",
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-sp",
      month: "2026-07",
      paidOn: "2026-07-31",
    });
  });

  it("uses a structural installment fraction without treating it as a date during obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPTU",
      }),
      listActiveObligations: async () => [
        { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
        { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
      ],
    });

    const started = await startConversation(
      {
        text: "Parcela 10/12 do IPTU paga",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidPaidOn).toBeUndefined();
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const chosen = await applyMessage(started.state, "SP", deps, {
      today: TODAY,
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-iptu-sp",
      month: "2026-07",
      paidOn: TODAY,
    });
  });

  it("does not interpret a descriptive availability fraction as paidOn", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "suporte",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-support",
          description: "Suporte",
          amountCents: 10000,
        },
      ],
    });

    const outcome = await startConversation(
      { text: "Suporte 24/7 pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("accepts the same compact token when temporal context establishes a date", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "suporte",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-support",
          description: "Suporte",
          amountCents: 10000,
        },
      ],
    });

    await startConversation(
      { text: "Suporte pago em 24/7", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-support",
      month: "2025-07",
      paidOn: "2025-07-24",
    });
  });

  it.each([
    ["hoje", "2026-08", "2026-08-01"],
    ["ontem", "2026-07", "2026-07-31"],
    ["anteontem", "2026-07", "2026-07-30"],
  ])(
    "resolves `%s` for a direct obligation payment across a month boundary",
    async (relativeDate, expectedMonth, expectedPaidOn) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "aluguel",
        }),
      });

      const outcome = await startConversation(
        {
          text: `Paguei aluguel ${relativeDate}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: "2026-08-01" },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: expectedMonth,
        paidOn: expectedPaidOn,
      });
    },
  );

  it("resolves a future-looking yearless past payment to its most recent occurrence", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    await startConversation(
      {
        text: "Paguei aluguel em 05/09",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2025-09",
      paidOn: "2025-09-05",
    });
  });

  it("persists an explicit payment occurrence date instead of confirmation today", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    const outcome = await startConversation(
      {
        text: "Paguei aluguel em 02/07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: "2026-07-02",
    });
  });

  it("carries an explicit payment date through the obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPTU",
      }),
      listActiveObligations: async () => [
        { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
        { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
      ],
    });

    const started = await startConversation(
      {
        text: "IPTU pago em 02/07/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidPaidOn).toBe("2026-07-02");

    const chosen = await applyMessage(started.state, "SP", deps, {
      today: TODAY,
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-iptu-sp",
      month: "2026-07",
      paidOn: "2026-07-02",
    });
  });

  it("carries a relative payment date over a structural installment date through the obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPTU",
      }),
      listActiveObligations: async () => [
        { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
        { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
      ],
    });

    const started = await startConversation(
      {
        text: "IPTU pago hoje, parcela em 10/12/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );
    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidPaidOn).toBe("2026-08-23");

    await applyMessage(started.state, "SP", deps, { today: "2026-08-23" });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-iptu-sp",
      month: "2026-08",
      paidOn: "2026-08-23",
    });
  });

  it("clarifies conflicting strongly introduced payment dates without writing", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    const outcome = await startConversation(
      {
        text: "Paguei aluguel no dia 05/08/2026, na data 06/08/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("data de pagamento");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("uses the chosen payment date month after an obligation choice", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPTU",
      }),
      listActiveObligations: async () => [
        { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
        { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
      ],
    });

    const started = await startConversation(
      {
        text: "IPTU pago em 05/09/2025",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: "2026-08-23" },
    );
    await applyMessage(started.state, "SP", deps, { today: "2026-08-23" });

    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-iptu-sp",
      month: "2025-09",
      paidOn: "2025-09-05",
    });
  });

  it("clarifies an invalid explicit payment date without writing", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "aluguel",
        }),
      },
    );

    const outcome = await startConversation(
      {
        text: "Paguei aluguel em 31/02/2026",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("data de pagamento");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each(
    ["dia 0", "dia0", "dia 32", "dia100"].flatMap((day) => [
      [day, "no AI result", null] as const,
      [
        day,
        "a wrong AI result",
        {
          intent: "card_installment" as const,
          purchase: {
            description: "Aluguel errado",
            installmentCount: 12,
            totalCents: 1,
          },
        },
      ] as const,
    ]),
  )(
    "clarifies invalid bare obligation-payment metadata `%s` with %s",
    async (day, _classificationLabel, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({ classifyMessage: classifierReturning(classified) });
      const outcome = await startConversation(
        {
          text: `Paguei aluguel ${day}`,
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
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(["dia 1", "dia1", "dia 31", "dia31"])(
    "keeps valid bare obligation-payment metadata `%s` on today's payment",
    async (day) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
      });
      const outcome = await startConversation(
        {
          text: `Paguei aluguel ${day}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
      });
    },
  );

  const MARK_SOLAR: InterpretedIntent = {
    intent: "mark_paid",
    target: "obligation",
    keyword: "solar",
  };

  it("single keyword match materializes the current month with the send date", async () => {
    const { deps, materializeObligationPayment, logInteraction } = buildDeps({
      classifyMessage: classifierReturning(MARK_SOLAR),
    });
    const { state, reply } = await startConversation(
      { text: "placa solar pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-solar",
      month: "2026-07",
      paidOn: TODAY,
    });
    expect(reply).toContain("Parcela solar");
    expect(reply).toContain("710,44");
    expect(logInteraction).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "wrong AI settlement account",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "aluguel",
        settlementAccountKeyword: "Inter",
      },
    ],
    ["no AI result", null],
  ])(
    "uses the obligation's normal account when the user names no payment source despite %s",
    async (_label, classified) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(classified),
        listActiveAccounts: () => [{ id: "acct-inter", name: "Inter" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "inter" ? "acct-inter" : undefined,
      });

      const outcome = await startConversation(
        { text: "Paguei o aluguel", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
      });
    },
  );

  it.each([
    [
      "escola",
      "wrong AI source without deterministic payment language",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        settlementAccountKeyword: "Itaú",
      },
    ],
    [
      "Paguei escola",
      "wrong AI source",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        settlementAccountKeyword: "Itaú",
      },
    ],
    [
      "Paguei escola",
      "no AI source",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
      },
    ],
    [
      "Paguei escola pela conta",
      "wrong AI source",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        settlementAccountKeyword: "Itaú",
      },
    ],
    [
      "Paguei escola pela conta",
      "no AI source",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
      },
    ],
  ])(
    "does not auto-settle the generic target %s with %s",
    async (text, _label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () => [
            { id: "acct-default", name: "Conta principal" },
            { id: "acct-itau", name: "Itaú" },
          ],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
          listActiveObligations: async () => [
            { id: "ob-school", description: "Escola", amountCents: 95000 },
          ],
        });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("needs_amount");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("does not let a named source turn a generic noun into an automatic settlement", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
      }),
      listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
      listActiveObligations: async () => [
        { id: "ob-school", description: "Escola", amountCents: 95000 },
      ],
    });

    const outcome = await startConversation(
      {
        text: "Paguei escola pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("needs_amount");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["classifier unavailable", "Paguei escola no Pix 950", null, undefined],
    [
      "classifier unavailable with the amount before Pix",
      "Paguei escola 950 no Pix",
      null,
      undefined,
    ],
    [
      "AI correctly identifies the amount-before-Pix payment",
      "Paguei escola 950 no Pix",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 95_000,
      },
      undefined,
    ],
    [
      "AI incorrectly calls the amount-before-Pix payment an expense",
      "Paguei escola 950 no Pix",
      {
        intent: "plain" as const,
        expense: {
          description: "Compra errada",
          amountCents: 1,
          accountKeyword: "Pix",
        },
      },
      undefined,
    ],
    [
      "AI invents a source for a generic account payment",
      "Paguei escola pela conta 950",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 1,
        settlementAccountKeyword: "Itaú",
      },
      undefined,
    ],
    [
      "AI correctly identifies a named-source payment",
      "Paguei escola pela conta Itaú 950",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 1,
      },
      "acct-itau",
    ],
    [
      "classifier is unavailable with the amount before its named source",
      "Paguei escola 950 pela conta Itaú",
      null,
      "acct-itau",
    ],
    [
      "AI correctly identifies the payment with the amount before its named source",
      "Paguei escola 950 pela conta Itaú",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 95_000,
        settlementAccountKeyword: "Itaú",
      },
      "acct-itau",
    ],
    [
      "AI supplies wrong payment fields with the amount before its named source",
      "Paguei escola 950 pela conta Itaú",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 1,
        settlementAccountKeyword: "Inter",
      },
      "acct-itau",
    ],
    [
      "AI incorrectly calls the amount-before-source payment an expense",
      "Paguei escola 950 pela conta Itaú",
      {
        intent: "plain" as const,
        expense: {
          description: "Compra errada",
          amountCents: 1,
          accountKeyword: "Inter",
        },
      },
      "acct-itau",
    ],
  ])(
    "persists a source-qualified obligation amount when %s",
    async (_label, text, classified, expectedAccountId) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () => [
            { id: "acct-default", name: "Conta principal" },
            { id: "acct-itau", name: "Itaú" },
          ],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
          listActiveObligations: async () => [
            { id: "ob-school", description: "Escola", amountCents: 95_000 },
          ],
        });

      const outcome = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-school",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 95_000,
        ...(expectedAccountId === undefined
          ? {}
          : { accountId: expectedAccountId }),
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("offers matching obligations instead of writing when an amount-before-target payment is ambiguous", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(null),
        listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
        listActiveObligations: async () => [
          {
            id: "ob-school-one",
            description: "Escola Alice",
            amountCents: 95_000,
          },
          {
            id: "ob-school-two",
            description: "Escola Bruno",
            amountCents: 95_000,
          },
        ],
      },
    );

    const outcome = await startConversation(
      {
        text: "Paguei R$950 da escola pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_mark_paid_choice");
    expect(outcome.state.markPaidCandidates).toHaveLength(2);
    expect(outcome.state.markPaidAmountCents).toBe(95_000);
    expect(outcome.state.markPaidAccountId).toBe("acct-itau");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("clarifies an unmatched amount-before-target payment without creating an expense", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          { id: "ob-rent", description: "Aluguel", amountCents: 150_000 },
        ],
      },
    );

    const outcome = await startConversation(
      { text: "Paguei R$950 da escola no Pix", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toMatch(/não encontrei|nao encontrei/i);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("keeps a merchant-shaped verb-first lunch on the ordinary expense path", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "plain",
          expense: { description: "Almoço", amountCents: 5_000 },
        }),
      },
    );

    const started = await startConversation(
      { text: "Paguei almoço 50", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_confirmation");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();

    await applyMessage(started.state, "confirmar", deps, { today: TODAY });
    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("uses a supplied actual amount without changing the obligation forecast", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "solar",
        amountCents: 82437,
      }),
    });
    const { state, reply } = await startConversation(
      { text: "placa solar paga 824,37", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-solar",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 82437,
    });
    expect(reply).toContain("824,37");
    expect(reply).not.toContain("710,44");
  });

  it("treats 10/12 as an installment position when settling the solar obligation", async () => {
    const createInstallmentPurchase = vi.fn(unexpectedInstallmentResult);
    const {
      deps,
      createTransaction,
      createObligation,
      materializeObligationPayment,
    } = buildDeps({
      classifyMessage: classifierReturning(null),
      createInstallmentPurchase,
    });

    const outcome = await startConversation(
      {
        text: "Paguei parcela 10/12 da placa solar R$710",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-solar",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 71_000,
    });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(createObligation).not.toHaveBeenCalled();
    expect(createInstallmentPurchase).not.toHaveBeenCalled();
  });

  it("treats Pix as a payment method without overriding the obligation account", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
        amountCents: 150000,
      }),
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "pix" ? "acct-pix" : undefined,
    });

    const { state } = await startConversation(
      { text: "Aluguel pago no Pix 1500", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
    });
  });

  it("resolves another named account for an obligation payment", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "solar",
      }),
      listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
    });

    const { state } = await startConversation(
      {
        text: "Paguei a parcela solar pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-solar",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-itau",
    });
  });

  it.each([
    ["a missing classifier", null],
    [
      "a wrong payment classifier",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Parcela solar",
      },
    ],
    [
      "a wrong expense classifier",
      {
        intent: "plain" as const,
        expense: { description: "Parcela solar", amountCents: 1 },
      },
    ],
  ])(
    "does not pay or create anything when only a source named like an obligation is present with %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveAccounts: () => [
            { id: "acct-solar", name: "Parcela Solar" },
          ],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "parcela solar"
              ? "acct-solar"
              : undefined,
        });

      const outcome = await startConversation(
        {
          text: "Paguei pela conta Parcela Solar",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("keeps the target when an obligation and its source account have the same name", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-solar", name: "Parcela Solar" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "parcela solar"
          ? "acct-solar"
          : undefined,
    });

    const outcome = await startConversation(
      {
        text: "Paguei a parcela solar pela conta Parcela Solar",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-solar",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-solar",
    });
  });

  it("settles rent with a clean target, explicit amount, and named account", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
      listActiveObligations: async () => [
        { id: "ob-rent", description: "Aluguel", amountCents: 120000 },
      ],
    });

    const { state } = await startConversation(
      {
        text: "Paguei aluguel R$ 1500 pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
      accountId: "acct-itau",
    });
  });

  it("prefers the named Itaú account over a later generic Pix mention", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(null),
        listActiveAccounts: () => [
          { id: "acct-itau", name: "Itaú" },
          { id: "acct-pix", name: "Pix" },
        ],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú"
            ? "acct-itau"
            : name.trim().toLowerCase() === "pix"
              ? "acct-pix"
              : undefined,
        listActiveObligations: async () => [
          { id: "ob-rent", description: "Aluguel", amountCents: 120000 },
        ],
      },
    );

    const { state } = await startConversation(
      {
        text: "Paguei aluguel pela conta Itaú via Pix R$1500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
      accountId: "acct-itau",
    });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("preserves a rent amount placed after its named payment source", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
      resolveAccountIdByName: (name: string) =>
        name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
    });

    const { state } = await startConversation(
      {
        text: "Paguei aluguel pela conta Itaú 1500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
      accountId: "acct-itau",
    });
  });

  it.each(["Paguei aluguel pelo Pix 1500", "Paguei aluguel pela Pix R$ 1500"])(
    "preserves a rent amount while treating Pix as a payment method in `%s`",
    async (text) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveAccounts: () => [{ id: "acct-pix", name: "Pix" }],
      });

      const { state } = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 150000,
      });
    },
  );

  it("prefers the full Conta-prefixed account name over Pix and the default", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
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

    const { state } = await startConversation(
      {
        text: "Paguei aluguel pela conta Conta corrente 1500 pelo Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
      accountId: "acct-checking",
    });
  });

  it("clarifies an unknown explicit payment account without writing", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "aluguel",
      }),
    });

    const { state, reply } = await startConversation(
      {
        text: "Aluguel pago pela Conta inexistente",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toContain("Inexistente");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("does not treat an installment sequence number as the actual payment amount", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "televisão",
        amountCents: 300,
      }),
      listActiveObligations: async () => [
        {
          id: "ob-televisao",
          description: "Televisão",
          amountCents: 120000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei a parcela da televisão número 3",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-televisao",
      month: "2026-07",
      paidOn: TODAY,
    });
    expect(reply).toContain("1.200,00");
    expect(reply).not.toContain("3,00");
  });

  it.each([
    ["Paguei a parcela da internet 13", 13],
    ["Paguei a prestação da internet 24", 24],
    ["Paguei a parcela da internet 50", 50],
    ["Paguei a prestação da internet 1500", 1500],
    ["Paguei 1500 da parcela da internet", 1500],
  ])(
    "keeps a bare parcela/prestação number ambiguous despite an AI amount: %s",
    async (text, ambiguousNumber) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning({
            intent: "mark_paid",
            target: "obligation",
            keyword: "internet",
            amountCents: ambiguousNumber * 100,
          }),
          listActiveObligations: async () => [
            {
              id: "ob-internet",
              description: "Internet",
              amountCents: 11990,
            },
          ],
        });

      const { state, reply } = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("cancelled");
      expect(reply).toContain(
        `Não ficou claro se ${ambiguousNumber} é o valor pago ou o número da parcela.`,
      );
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("keeps a bare installment number ambiguous despite an incorrect AI amount and Pix source", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Casa",
          amountCents: 1000,
        }),
        listActiveObligations: async () => [
          { id: "ob-casa", description: "Casa", amountCents: 180000 },
        ],
      },
    );

    const { state, reply } = await startConversation(
      {
        text: "Paguei a parcela da casa 10 via Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toBe(
      "Não ficou claro se 10 é o valor pago ou o número da parcela. Envie “R$ 10” para informar o valor ou “parcela número 10” para informar a posição.",
    );
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each(["R$ 10", "por 10"])(
    "materializes an explicit Casa payment expressed as %s through Pix",
    async (amountText) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(null),
          listActiveObligations: async () => [
            { id: "ob-casa", description: "Casa", amountCents: 180000 },
          ],
        });

      const { state } = await startConversation(
        {
          text: `Paguei a parcela da casa ${amountText} via Pix`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-casa",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 1000,
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["R$ 50", 5000, "50,00"],
    ["número 50", undefined, "119,90"],
    ["R$ 1500", 150000, "1.500,00"],
    ["número 1500", undefined, "119,90"],
  ])(
    "settles an explicitly disambiguated Internet payment using %s",
    async (paymentDetail, expectedAmountCents, expectedReplyAmount) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          {
            id: "ob-internet",
            description: "Internet",
            amountCents: 11990,
          },
        ],
      });

      const { state, reply } = await startConversation(
        {
          text: `Paguei a parcela da internet ${paymentDetail}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-internet",
        month: "2026-07",
        paidOn: TODAY,
        ...(expectedAmountCents === undefined
          ? {}
          : { amountCents: expectedAmountCents }),
      });
      expect(reply).toContain(expectedReplyAmount);
    },
  );

  it("extracts an actual payment amount before the obligation target without AI", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-casa",
          description: "Casa",
          amountCents: 180000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei R$ 1500 da parcela da casa",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-casa",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
    });
    expect(reply).toContain("1.500,00");
    expect(reply).not.toContain("1.800,00");
  });

  it("lets AI rank an unresolved payment but waits for explicit selection", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
        amountCents: 90000,
      }),
    });

    const started = await startConversation(
      {
        text: "Paguei a parcela do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidCandidates).toEqual([
      expect.objectContaining({ id: "ob-carro" }),
    ]);
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const chosen = await applyMessage(
      started.state,
      "Financiamento carro",
      deps,
      { today: TODAY },
    );

    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 90000,
    });
  });

  it("carries the explicit account through an ordinal car choice without using the AI amount", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Financiamento do carro",
          amountCents: 900,
        }),
        listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
        listActiveObligations: async () => [
          {
            id: "ob-car-financing",
            description: "Financiamento do carro",
            amountCents: 90000,
          },
          {
            id: "ob-car-insurance",
            description: "Seguro do carro",
            amountCents: 50000,
          },
        ],
      },
    );

    const started = await startConversation(
      {
        text: "Paguei a parcela do carro número 9 pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidAmountCents).toBeUndefined();
    expect(started.state.markPaidAccountId).toBe("acct-itau");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();

    const chosen = await applyMessage(
      started.state,
      "Financiamento do carro",
      deps,
      { today: TODAY },
    );

    expect(chosen.state.status).toBe("saved");
    expect(chosen.reply).toContain("900,00");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-financing",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-itau",
    });
  });

  it("does not auto-write an ordinal car payment when the classifier is unavailable", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(null),
        listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
        resolveAccountIdByName: (name: string) =>
          name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
      },
    );

    const outcome = await startConversation(
      {
        text: "Paguei a parcela do carro número 9 pela conta Itaú",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).not.toBe("saved");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["the classifier is unavailable", null],
    [
      "AI incorrectly classifies it as plain",
      {
        intent: "plain" as const,
        expense: { description: "Parcela do carro", amountCents: 90000 },
      },
    ],
  ])(
    "keeps unresolved deterministic payment ambiguity terminal and write-free when %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
        });

      const { state, reply } = await startConversation(
        {
          text: "Paguei a parcela do carro 900",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("cancelled");
      expect(reply).toContain(
        "Não ficou claro se 900 é o valor pago ou o número da parcela.",
      );
      expect(reply).toContain("R$ 900");
      expect(reply).toContain("parcela número 900");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("an already-paid month replies as a friendly no-op", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(MARK_SOLAR),
      materializeObligationPayment: vi.fn(async () => ({ alreadyPaid: true })),
    });
    const { state, reply } = await startConversation(
      { text: "placa solar pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("saved");
    expect(reply).toMatch(/já estava|ja estava/i);
  });

  it("ambiguous keyword asks which obligation, then the answer settles it", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-solar",
          description: "Financiamento solar",
          amountCents: 71044,
        },
        {
          id: "ob-carro",
          description: "Financiamento do carro",
          amountCents: 90000,
        },
      ],
    });
    const asked = await startConversation(
      { text: "financiamento pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(asked.state.status).toBe("awaiting_mark_paid_choice");
    expect(asked.reply).toContain("Financiamento solar");
    expect(asked.reply).toContain("Financiamento do carro");
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const chosen = await applyMessage(
      asked.state,
      "Financiamento do carro",
      deps,
      { today: TODAY },
    );
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
    });
  });

  it.each([
    ["SP", "ob-iptu-sp"],
    ["RJ", "ob-iptu-rj"],
  ])(
    "accepts the short choice %s only after presenting ambiguous obligations",
    async (choice, obligationId) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "IPTU",
        }),
        listActiveObligations: async () => [
          { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
          { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
        ],
      });
      const asked = await startConversation(
        { text: "IPTU pago", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(asked.state.status).toBe("awaiting_mark_paid_choice");
      expect(materializeObligationPayment).not.toHaveBeenCalled();

      const chosen = await applyMessage(asked.state, choice, deps, {
        today: TODAY,
      });
      expect(chosen.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId,
        month: "2026-07",
        paidOn: TODAY,
      });
    },
  );

  it.each(["IPTU", "quero SP", "XX", "a"])(
    "keeps the obligation picker open for ambiguous or non-exact choice %s",
    async (choice) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "IPTU",
        }),
        listActiveObligations: async () => [
          { id: "ob-iptu-sp", description: "IPTU SP", amountCents: 10000 },
          { id: "ob-iptu-rj", description: "IPTU RJ", amountCents: 20000 },
        ],
      });
      const asked = await startConversation(
        { text: "IPTU pago", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      const retry = await applyMessage(asked.state, choice, deps, {
        today: TODAY,
      });
      expect(retry.state.status).toBe("awaiting_mark_paid_choice");
      expect(retry.reply).toContain("IPTU SP");
      expect(retry.reply).toContain("IPTU RJ");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it.each(["da", "do", "de", "em"])(
    "does not let the generic picker token %s settle an obligation",
    async (choice) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "casa",
        }),
        listActiveObligations: async () => [
          {
            id: "ob-iptu-house",
            description: "IPTU da casa",
            amountCents: 10000,
          },
          {
            id: "ob-insurance-house",
            description: "Seguro da casa",
            amountCents: 20000,
          },
        ],
      });
      const started = await startConversation(
        {
          text: "Paguei a parcela da casa por R$100",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );
      expect(started.state.status).toBe("awaiting_mark_paid_choice");

      const retry = await applyMessage(started.state, choice, deps, {
        today: TODAY,
      });
      expect(retry.state.status).toBe("awaiting_mark_paid_choice");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it.each(ARBITRARY_MARK_PAID_CHOICE_WORDS)(
    "keeps the picker open for arbitrary partial word %s",
    async (choice) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Escola",
        }),
        listActiveObligations: async () => [
          {
            id: "ob-school-generic",
            description: `${choice} Escola`,
            amountCents: 100_000,
          },
          {
            id: "ob-school-tuition",
            description: "ZX Escola",
            amountCents: 100_000,
          },
        ],
      });
      const asked = await startConversation(
        { text: "Paguei R$1.000 da escola", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );
      expect(asked.state.status).toBe("awaiting_mark_paid_choice");

      const retry = await applyMessage(asked.state, choice, deps, {
        today: TODAY,
      });
      expect(retry.state.status).toBe("awaiting_mark_paid_choice");
      expect(retry.reply).toContain(`${choice} Escola`);
      expect(retry.reply).toContain("ZX Escola");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it("accepts an exact one-word displayed description", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
      }),
      listActiveObligations: async () => [
        { id: "ob-school", description: "Escola", amountCents: 100_000 },
        {
          id: "ob-school-bruno",
          description: "Escola Bruno",
          amountCents: 90_000,
        },
      ],
    });
    const asked = await startConversation(
      { text: "Paguei R$1.000 da escola", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(asked.state.status).toBe("awaiting_mark_paid_choice");
    const chosen = await applyMessage(asked.state, "Escola", deps, {
      today: TODAY,
    });

    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-school",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 100_000,
    });
  });

  it.each([
    "Sim Escola",
    "Não Escola",
    "Ok Escola",
    "Certo Escola",
    "Depois Escola",
    "Então Escola",
    "Talvez Escola",
  ])(
    "accepts the complete displayed description `%s` even when it contains response vocabulary",
    async (description) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Escola",
        }),
        listActiveObligations: async () => [
          { id: "ob-selected", description, amountCents: 100_000 },
          {
            id: "ob-school-other",
            description: "ZX Escola",
            amountCents: 90_000,
          },
        ],
      });
      const asked = await startConversation(
        { text: "Paguei R$1.000 da escola", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );
      expect(asked.state.status).toBe("awaiting_mark_paid_choice");

      const chosen = await applyMessage(asked.state, description, deps, {
        today: TODAY,
      });

      expect(chosen.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-selected",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 100_000,
      });
    },
  );

  it("keeps a shared meaningful picker token ambiguous but accepts an exact displayed description", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-school-account",
          description: "Conta da Escola",
          amountCents: 100_000,
        },
        {
          id: "ob-school-tuition",
          description: "Mensalidade Escola",
          amountCents: 100_000,
        },
      ],
    });
    const asked = await startConversation(
      { text: "Paguei R$1.000 da escola", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const ambiguous = await applyMessage(asked.state, "Escola", deps, {
      today: TODAY,
    });
    expect(ambiguous.state.status).toBe("awaiting_mark_paid_choice");
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const selected = await applyMessage(
      ambiguous.state,
      "Conta da Escola",
      deps,
      { today: TODAY },
    );
    expect(selected.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-school-account",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 100_000,
    });
  });

  it("preserves the actual amount while resolving an ambiguous obligation", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento",
        amountCents: 95500,
      }),
      listActiveObligations: async () => [
        {
          id: "ob-solar",
          description: "Financiamento solar",
          amountCents: 71044,
        },
        {
          id: "ob-carro",
          description: "Financiamento carro",
          amountCents: 90000,
        },
      ],
    });
    const asked = await startConversation(
      { text: "financiamento pago 955", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(asked.state.markPaidAmountCents).toBe(95500);

    await applyMessage(asked.state, "Financiamento carro", deps, {
      today: TODAY,
    });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 95500,
    });
  });

  it("does not turn Pix into an account override while resolving an ambiguous obligation", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-rent-home",
          description: "Aluguel casa",
          amountCents: 120000,
        },
        {
          id: "ob-rent-office",
          description: "Aluguel sala",
          amountCents: 80000,
        },
      ],
    });
    const asked = await startConversation(
      {
        text: "Aluguel pago no Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
    expect(asked.state.markPaidAccountId).toBeUndefined();

    await applyMessage(asked.state, "Aluguel sala", deps, { today: TODAY });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent-office",
      month: "2026-07",
      paidOn: TODAY,
    });
  });

  it("no keyword match replies not-found and stays terminal", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "internet",
      }),
    });
    const { state, reply } = await startConversation(
      { text: "internet paga", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(reply).toMatch(/não encontrei|nao encontrei/i);
  });

  it.each([
    ["null AI", null],
    [
      "wrong AI",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Mercado Pago",
        amountCents: 1,
      },
    ],
    [
      "correct AI",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Mercado",
        amountCents: 10_000,
      },
    ],
  ])(
    "keeps a generic amount-first merchant payment behind a choice with %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveObligations: async () => [
            {
              id: "ob-market-pay",
              description: "Mercado Pago",
              amountCents: 10_000,
            },
            {
              id: "ob-market-city",
              description: "Mercado Municipal",
              amountCents: 12_000,
            },
          ],
        });

      const asked = await startConversation(
        { text: "Paguei R$100 do mercado", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(asked.state.status).toBe("awaiting_mark_paid_choice");
      expect(asked.state.markPaidAmountCents).toBe(10_000);
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Paguei pela conta Itaú R$950 da escola", "acct-itau", undefined],
    ["Paguei via Pix R$950 da escola", undefined, undefined],
    ["Paguei ontem via Pix R$950 da escola", undefined, "2026-07-02"],
    ["Paguei via Pix R$950 da escola ontem", undefined, "2026-07-02"],
    ["Paguei dia 02/07 via Pix R$950 da escola", undefined, "2026-07-02"],
    [
      "Paguei dia 05/08/2026 pela conta Itaú R$950 da escola",
      "acct-itau",
      "2026-08-05",
    ],
    ["Paguei ontem pela conta Itaú R$950 da escola", "acct-itau", "2026-07-02"],
    [
      "Paguei pela conta Itaú R$950 da escola em 05/08/2026",
      "acct-itau",
      "2026-08-05",
    ],
  ])(
    "preserves source, amount, and occurrence date in a source-first existing-payment choice: %s",
    async (text, expectedAccountId, expectedPaidOn) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(null),
          listActiveAccounts: () => [{ id: "acct-itau", name: "Itaú" }],
          resolveAccountIdByName: (name: string) =>
            name.trim().toLowerCase() === "itaú" ? "acct-itau" : undefined,
          listActiveObligations: async () => [
            {
              id: "ob-school-alice",
              description: "Escola Alice",
              amountCents: 95_000,
            },
            {
              id: "ob-school-bruno",
              description: "Escola Bruno",
              amountCents: 90_000,
            },
          ],
        });

      const asked = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );
      expect(asked.state.status).toBe("awaiting_mark_paid_choice");
      expect(asked.state.markPaidAmountCents).toBe(95_000);
      expect(asked.state.markPaidAccountId).toBe(expectedAccountId);
      expect(asked.state.markPaidPaidOn).toBe(expectedPaidOn);
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();

      await applyMessage(asked.state, "Escola Alice", deps, { today: TODAY });
      const persistedPaidOn = expectedPaidOn ?? TODAY;
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-school-alice",
        month: persistedPaidOn.slice(0, 7),
        paidOn: persistedPaidOn,
        amountCents: 95_000,
        ...(expectedAccountId === undefined
          ? {}
          : { accountId: expectedAccountId }),
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(["pago", "paga", "paguei", "quitado", "quitada", "quitei"])(
    "keeps the picker open for generic payment vocabulary `%s`",
    async (choice) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          {
            id: "ob-market-pay",
            description: "Mercado Pago",
            amountCents: 10_000,
          },
          {
            id: "ob-market-city",
            description: "Mercado Municipal",
            amountCents: 12_000,
          },
        ],
      });
      const asked = await startConversation(
        { text: "Paguei R$100 do mercado", fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      const retry = await applyMessage(asked.state, choice, deps, {
        today: TODAY,
      });
      expect(retry.state.status).toBe("awaiting_mark_paid_choice");
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );

  it("accepts the full Mercado Pago description from the picker", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-market-pay",
          description: "Mercado Pago",
          amountCents: 10000,
        },
        {
          id: "ob-market-city",
          description: "Mercado Municipal",
          amountCents: 12000,
        },
      ],
    });
    const asked = await startConversation(
      { text: "Paguei R$100 do mercado", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const chosen = await applyMessage(asked.state, "Mercado Pago", deps, {
      today: TODAY,
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-market-pay",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 10_000,
    });
  });

  it.each(["Paguei mercado 100", "Paguei mercado 100 via Pix"])(
    "keeps an ordinary merchant payment out of a wrong AI settlement: %s",
    async (text) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning({
            intent: "mark_paid",
            target: "obligation",
            keyword: "Mercado",
            amountCents: 1,
          }),
        });
      const started = await startConversation(
        { text, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(started.state.status).toBe("awaiting_confirmation");
      expect(started.state.draft).toMatchObject({
        description: "Mercado",
        amountCents: 10_000,
      });
      expect(materializeObligationPayment).not.toHaveBeenCalled();

      await applyMessage(started.state, "confirmar", deps, { today: TODAY });
      expect(createTransaction).toHaveBeenCalledTimes(1);
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );
});

describe("classifier fallback", () => {
  it("a null classification falls back to the legacy plain-expense path", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(null),
    });
    const { state, reply } = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("awaiting_confirmation");
    expect(reply).toContain("32,00");
  });

  it("a plain classification feeds the normal confirmation flow", async () => {
    const { deps, createTransaction } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "plain",
        expense: { amountCents: 4500, description: "Farmácia" },
      }),
    });
    const started = await startConversation(
      // No amount the deterministic parser can find.
      { text: "gastei um dinheirinho na farmácia", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("awaiting_confirmation");
    expect(started.reply).toContain("45,00");

    const confirmed = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(confirmed.state.status).toBe("saved");
    expect(createTransaction).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit choice before a generic paid adjective can settle a matching obligation", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Almoço",
        amountCents: 5_000,
      }),
      listActiveAccounts: () => [{ id: "acct-pix", name: "Pix" }],
      listActiveObligations: async () => [
        { id: "ob-lunch", description: "Almoço", amountCents: 5_000 },
      ],
    });

    const outcome = await startConversation(
      { text: "Almoço pago no Pix R$ 50", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_mark_paid_choice");
    expect(outcome.reply).toContain("Almoço");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each(["com Pix", "usando Pix", "por Pix", "via o Pix", "via a Pix"])(
    "keeps %s on default-account semantics in the full flow",
    async (method) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "plain",
          expense: {
            description: "Almoço",
            amountCents: 7_500,
            accountKeyword: "Pix",
          },
        }),
        listActiveAccounts: () => [
          { id: "acct-1", name: "Conta corrente" },
          { id: "acct-pix", name: "Pix" },
        ],
      });

      const outcome = await startConversation(
        { text: `Almoço R$ 75 ${method}`, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("awaiting_confirmation");
      expect(outcome.state.draft.accountId).toBe("acct-1");
    },
  );

  it.each(["Nubank PJ", "Itaú conjunta"])(
    "clarifies the full unknown source %s instead of resolving its registered prefix",
    async (spokenAccount) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel",
          amountCents: 150_000,
        }),
        listActiveAccounts: () => [
          { id: "acct-nubank", name: "Nubank" },
          { id: "acct-itau", name: "Itaú" },
        ],
        resolveAccountIdByName: (name) =>
          name === "Nubank"
            ? "acct-nubank"
            : name === "Itaú"
              ? "acct-itau"
              : undefined,
      });

      const outcome = await startConversation(
        {
          text: `Paguei aluguel pela conta ${spokenAccount} R$ 1500`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("cancelled");
      expect(outcome.reply).toContain(spokenAccount);
      expect(materializeObligationPayment).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Review fixes (PR #3): failure paths, matching robustness, error surfaces.
// ---------------------------------------------------------------------------

describe("mark_paid keyword matching robustness", () => {
  it.each([
    ["classifier unavailable", null],
    [
      "classifier agrees",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Aluguel",
        amountCents: 120_000,
      },
    ],
    [
      "classifier points to the wrong target and amount",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Nubank",
        amountCents: 1,
      },
    ],
  ])(
    "settles spoken R$ 1.200 against Aluguel without a duplicate expense when %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveObligations: async () => [
            {
              id: "ob-rent",
              description: "Aluguel",
              amountCents: 120_000,
            },
          ],
        });

      const outcome = await startConversation(
        {
          text: "Paguei aluguel mil e duzentos",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(outcome.state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledTimes(1);
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 120_000,
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a truncated AI keyword",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Luguel",
        amountCents: 100,
      },
    ],
    ["no classifier result", null],
  ])(
    "settles the existing Aluguel template with the deterministic amount when there is %s",
    async (_label, classified) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning(classified),
          listActiveObligations: async () => [
            {
              id: "ob-rent",
              description: "Aluguel",
              amountCents: 120000,
            },
          ],
        });

      const { state } = await startConversation(
        {
          text: "Paguei aluguel 1200",
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-rent",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: 120000,
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("persists a bare year-range number as the explicit rent payment amount", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel",
          amountCents: 1,
        }),
        listActiveObligations: async () => [
          {
            id: "ob-rent",
            description: "Aluguel",
            amountCents: 120000,
          },
        ],
      },
    );

    const { state } = await startConversation(
      {
        text: "Paguei aluguel 2000 via Pix",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 200000,
    });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not let a wrong AI target settle a deterministic car ambiguity", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Seguro do carro",
        amountCents: 100,
      }),
      listActiveObligations: async () => [
        {
          id: "ob-car-financing",
          description: "Financiamento do carro",
          amountCents: 90000,
        },
        {
          id: "ob-car-insurance",
          description: "Seguro do carro",
          amountCents: 50000,
        },
      ],
    });

    const started = await startConversation(
      {
        text: "Paguei a parcela do carro por R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(started.state.status).toBe("awaiting_mark_paid_choice");
    expect(started.state.markPaidCandidates?.map(({ id }) => id)).toEqual([
      "ob-car-insurance",
      "ob-car-financing",
    ]);
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const chosen = await applyMessage(
      started.state,
      "Financiamento do carro",
      deps,
      { today: TODAY },
    );

    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledTimes(1);
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car-financing",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 90000,
    });
  });

  it("settles an existing rent template from a Pix-marked payment without rerouting to an expense", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          {
            id: "ob-rent",
            description: "Aluguel",
            amountCents: 120000,
          },
        ],
      },
    );

    const { state } = await startConversation(
      {
        text: "Aluguel pago no Pix 1500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 150000,
    });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not cross-settle insurance when the query explicitly names financing", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-car-insurance",
          description: "Seguro do carro",
          amountCents: 50000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei o financiamento do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toMatch(/não encontrei/i);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it("settles a same-subject obligation when its explicit type also matches", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-car-financing",
          description: "Financiamento do carro",
          amountCents: 90000,
        },
      ],
    });

    const { state } = await startConversation(
      {
        text: "Paguei o financiamento do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        obligationId: "ob-car-financing",
        amountCents: 90000,
      }),
    );
  });

  it.each([
    ["Paguei R$710 financiamento do carro", "ob-car-financing"],
    ["Paguei R$710 parcela solar", "ob-solar"],
  ])(
    "settles a preposition-less amount-first explicit obligation: %s",
    async (text, obligationId) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          {
            id: obligationId,
            description:
              obligationId === "ob-solar"
                ? "Parcela solar"
                : "Financiamento do carro",
            amountCents: 90_000,
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
        expect.objectContaining({ obligationId, amountCents: 71_000 }),
      );
      expect(deps.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("keeps an amount-first obligation payment in the picker when multiple targets match", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-solar-home",
          description: "Parcela solar da casa",
          amountCents: 70_000,
        },
        {
          id: "ob-solar-farm",
          description: "Parcela solar do sítio",
          amountCents: 72_000,
        },
      ],
    });

    const outcome = await startConversation(
      { text: "Paguei R$710 parcela solar", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(outcome.state.status).toBe("awaiting_mark_paid_choice");
    expect(outcome.state.markPaidAmountCents).toBe(71_000);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("keeps a bare financing number ambiguous regardless of magnitude", async () => {
    const { deps, createTransaction, materializeObligationPayment } = buildDeps(
      {
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword: "Financiamento errado",
          amountCents: 1,
        }),
        listActiveObligations: async () => [
          {
            id: "ob-car-financing",
            description: "Financiamento do carro",
            amountCents: 90000,
          },
        ],
      },
    );

    const { state, reply } = await startConversation(
      {
        text: "Paguei o financiamento do carro 1500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toContain(
      "Não ficou claro se 1500 é o valor pago ou o número da parcela.",
    );
    expect(materializeObligationPayment).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each([13, 24])(
    "keeps a bare plausible financing position %s terminal even when AI supplies an amount",
    async (position) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning({
            intent: "mark_paid",
            target: "obligation",
            keyword: "Financiamento do carro",
            amountCents: position * 100,
          }),
          listActiveObligations: async () => [
            {
              id: "ob-car-financing",
              description: "Financiamento do carro",
              amountCents: 90000,
            },
          ],
        });

      const { state, reply } = await startConversation(
        {
          text: `Paguei o financiamento do carro ${position}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("cancelled");
      expect(reply).toContain(
        `Não ficou claro se ${position} é o valor pago ou o número da parcela.`,
      );
      expect(reply).toContain(`R$ ${position}`);
      expect(reply).toContain(`parcela número ${position}`);
      expect(materializeObligationPayment).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([13, 24])(
    "accepts explicit money R$ %s as the financing payment amount",
    async (amountReais) => {
      const { deps, createTransaction, materializeObligationPayment } =
        buildDeps({
          classifyMessage: classifierReturning({
            intent: "mark_paid",
            target: "obligation",
            keyword: "Financiamento errado",
            amountCents: 1,
          }),
          listActiveObligations: async () => [
            {
              id: "ob-car-financing",
              description: "Financiamento do carro",
              amountCents: 90000,
            },
          ],
        });

      const { state } = await startConversation(
        {
          text: `Paguei o financiamento do carro R$ ${amountReais}`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith({
        obligationId: "ob-car-financing",
        month: "2026-07",
        paidOn: TODAY,
        amountCents: amountReais * 100,
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it("does not auto-settle a unique subject-only shorthand", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "carro",
      }),
      listActiveObligations: async () => [
        {
          id: "ob-car-insurance",
          description: "Seguro do carro",
          amountCents: 50000,
        },
      ],
    });

    const { state } = await startConversation(
      { text: "Paguei o carro", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("needs_amount");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("does not settle a broader qualified target from a partial token match", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-car",
          description: "Financiamento do carro",
          amountCents: 90000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei a parcela do seguro do carro R$ 500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toMatch(/não encontrei/i);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("does not treat a shared Portuguese article as an identifying target", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-house",
          description: "Financiamento de uma casa",
          amountCents: 180000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei a parcela de uma moto R$ 500",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toMatch(/não encontrei/i);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["casa", "ob-house"],
    ["moto", "ob-motorcycle"],
  ])(
    "selects the correct %s target after removing Portuguese function words",
    async (target, expectedObligationId) => {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning(null),
        listActiveObligations: async () => [
          {
            id: "ob-house",
            description: "Financiamento de uma casa",
            amountCents: 180000,
          },
          {
            id: "ob-motorcycle",
            description: "Financiamento de uma moto",
            amountCents: 50000,
          },
        ],
      });

      const { state } = await startConversation(
        {
          text: `Paguei a parcela de uma ${target} R$ 500`,
          fromUserId: "user-alvaro",
        },
        deps,
        { today: TODAY },
      );

      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          obligationId: expectedObligationId,
          amountCents: 50000,
        }),
      );
    },
  );

  it("does not auto-settle a sole match based only on a generic token", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-house",
          description: "Financiamento da casa",
          amountCents: 180000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      { text: "financiamento pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("awaiting_mark_paid_choice");
    expect(reply).toContain("Financiamento da casa");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("does not settle from a sole generic financing-token overlap", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-house",
          description: "Financiamento da casa",
          amountCents: 180000,
        },
      ],
    });

    const { state, reply } = await startConversation(
      {
        text: "Paguei o financiamento do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toMatch(/não encontrei/i);
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("selects the correct target among obligations sharing a generic token", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning(null),
      listActiveObligations: async () => [
        {
          id: "ob-house",
          description: "Financiamento da casa",
          amountCents: 180000,
        },
        {
          id: "ob-car",
          description: "Financiamento do carro",
          amountCents: 90000,
        },
      ],
    });

    const { state } = await startConversation(
      {
        text: "Paguei o financiamento do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-car",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 90000,
    });
  });

  it("matches on token overlap: 'placa solar' finds 'Parcela solar'", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "placa solar",
      }),
    });
    const { state } = await startConversation(
      { text: "placa solar pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ obligationId: "ob-solar" }),
    );
  });

  it("is accent-insensitive in both directions", async () => {
    const cases = [
      { keyword: "condominio", description: "Condomínio" },
      { keyword: "condomínio", description: "Condominio" },
    ];
    for (const { keyword, description } of cases) {
      const { deps, materializeObligationPayment } = buildDeps({
        classifyMessage: classifierReturning({
          intent: "mark_paid",
          target: "obligation",
          keyword,
        }),
        listActiveObligations: async () => [
          { id: "ob-cond", description, amountCents: 45000 },
        ],
      });
      const { state } = await startConversation(
        { text: `${keyword} pago`, fromUserId: "user-alvaro" },
        deps,
        { today: TODAY },
      );
      expect(state.status).toBe("saved");
      expect(materializeObligationPayment).toHaveBeenCalledWith(
        expect.objectContaining({ obligationId: "ob-cond" }),
      );
    }
  });
});

describe("mark_paid failure surfaces", () => {
  const MARK_SOLAR: InterpretedIntent = {
    intent: "mark_paid",
    target: "obligation",
    keyword: "solar",
  };

  it("replies gracefully (no crash, terminal state) when materialization throws", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(MARK_SOLAR),
      materializeObligationPayment: vi.fn(async () => {
        throw new Error(
          "materializeObligationPayment failed: month 2026-07 precedes start 2026-10",
        );
      }),
    });
    const { state, reply } = await startConversation(
      { text: "placa solar pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toMatch(/fora do período|não consegui dar baixa/i);
  });

  it("a missing materialize dep does NOT claim the obligation was not found", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(MARK_SOLAR),
      materializeObligationPayment: undefined,
    });
    const { state, reply } = await startConversation(
      { text: "placa solar pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(reply).not.toMatch(/não encontrei/i);
    expect(reply).toMatch(/não está disponível|nao esta disponivel/i);
  });

  it("cancelar during an ambiguous choice cancels without materializing", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento",
      }),
      listActiveObligations: async () => [
        { id: "ob-a", description: "Financiamento solar", amountCents: 1 },
        { id: "ob-b", description: "Financiamento carro", amountCents: 2 },
      ],
    });
    const asked = await startConversation(
      { text: "financiamento pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const cancelled = await applyMessage(asked.state, "cancelar", deps, {
      today: TODAY,
    });
    expect(cancelled.state.status).toBe("cancelled");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

  it("a non-matching choice answer re-asks and does not materialize", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento",
      }),
      listActiveObligations: async () => [
        { id: "ob-a", description: "Financiamento solar", amountCents: 1 },
        { id: "ob-b", description: "Financiamento carro", amountCents: 2 },
      ],
    });
    const asked = await startConversation(
      { text: "financiamento pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const retry = await applyMessage(asked.state, "bicicleta", deps, {
      today: TODAY,
    });
    expect(retry.state.status).toBe("awaiting_mark_paid_choice");
    expect(retry.reply).toContain("Financiamento solar");
    expect(retry.reply).toContain("Financiamento carro");
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });
});

describe("obligation correction failure paths", () => {
  async function startedSolar(deps: ConversationDeps) {
    return startConversation(
      { text: "Parcela solar 710,44 72x", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
  }

  it("'dia 29' clamps the correction to 28 and keeps confirmation", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedSolar(deps);
    const outcome = await applyMessage(started.state, "dia 29", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("awaiting_obligation_confirmation");
    expect(outcome.state.obligationDraft?.dueDay).toBe(28);
    expect(outcome.reply).toContain(
      "Atualizei o vencimento solicitado (dia 29) para o dia 28",
    );
    expect(outcome.reply).toContain("Vence dia 28");
    expect(createObligation).not.toHaveBeenCalled();
  });

  it.each(["dia 0", "dia 32", "dia 100"])(
    "rejects an out-of-range correction without changing the draft: %s",
    async (message) => {
      const { deps } = buildDeps({
        classifyMessage: classifierReturning(SOLAR_INTENT),
      });
      const started = await startedSolar(deps);
      const outcome = await applyMessage(started.state, message, deps, {
        today: TODAY,
      });
      expect(outcome.state).toEqual(started.state);
      expect(outcome.reply).toBe(
        "O dia de vencimento precisa estar entre 1 e 31.",
      );
    },
  );

  it("'conta Inexistente' keeps the draft and replies account-not-found", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedSolar(deps);
    const outcome = await applyMessage(
      started.state,
      "conta Inexistente",
      deps,
      {
        today: TODAY,
      },
    );
    expect(outcome.state.status).toBe("awaiting_obligation_confirmation");
    expect(outcome.reply).toMatch(/não encontrei a conta/i);
  });

  it("'valor abc' and gibberish reply the obligation help text", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedSolar(deps);
    for (const msg of ["valor abc", "sei lá o que"]) {
      const outcome = await applyMessage(started.state, msg, deps, {
        today: TODAY,
      });
      expect(outcome.state.status).toBe("awaiting_obligation_confirmation");
      expect(outcome.reply).toMatch(/não entendi/i);
    }
  });
});

describe("obligation confirmation buttons", () => {
  async function startedObligation(deps: ConversationDeps) {
    return startConversation(
      {
        text: "Parcela solar 710,44 72x a partir de 05/10",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );
  }

  it("attaches Confirmar/Cancelar buttons to the confirmation prompt", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedObligation(deps);

    expect(started.state.status).toBe("awaiting_obligation_confirmation");
    const tokens = started.keyboard?.inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(tokens).toContain(TOKENS.confirm);
    expect(tokens).toContain(TOKENS.cancel);
  });

  it("shows ranked category choices and applies one before confirmation", async () => {
    const { deps } = buildDeps({
      catalog: {
        householdId: "house-1",
        categories: [{ id: "cat-moradia", name: "Moradia" }],
        subcategories: [
          { id: "sub-contas", categoryId: "cat-moradia", name: "Contas" },
        ],
      },
      classifyMessage: classifierReturning({
        intent: "obligation",
        obligation: {
          description: "Internet",
          monthlyAmountCents: 12990,
          categoryCandidates: [
            {
              categoryName: "Moradia",
              subcategoryName: "Contas",
              confidence: 0.9,
              explanation: "Conta recorrente da casa.",
            },
          ],
          unifiedPrimary: true,
        },
      }),
    });
    const started = await startConversation(
      { text: "internet 129,90 todo mês", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.keyboard?.inline_keyboard.flat()).toContainEqual({
      text: "📂 Moradia › Contas",
      callback_data: "cs:0",
    });

    const selected = await applyCallback(started.state, "cs:0", deps, {
      today: TODAY,
    });
    expect(selected.state.obligationDraft).toMatchObject({
      categoryId: "cat-moradia",
      subcategoryId: "sub-contas",
    });
    expect(selected.state.categoryCandidates).toBeUndefined();
  });

  it("a Confirmar tap persists the obligation, exactly like typing confirmar", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedObligation(deps);

    const tapped = await applyCallback(started.state, TOKENS.confirm, deps, {
      today: TODAY,
    });

    expect(createObligation).toHaveBeenCalledTimes(1);
    expect(tapped.state.status).toBe("saved");
  });

  it("a Cancelar tap discards without persisting", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedObligation(deps);

    const tapped = await applyCallback(started.state, TOKENS.cancel, deps, {
      today: TODAY,
    });

    expect(createObligation).not.toHaveBeenCalled();
    expect(tapped.state.status).toBe("cancelled");
  });
});
