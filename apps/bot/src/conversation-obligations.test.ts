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

  it("preserves an explicit past start year in deterministic fallback", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(null),
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

  it("creates a Pix-backed obligation when Pix is explicit", async () => {
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

describe("mark_paid{obligation} flow", () => {
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

  it("uses an explicitly named Pix account instead of the obligation default", async () => {
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
      accountId: "acct-pix",
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

  it("clarifies whether a bare payment number is an amount or installment position", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "internet",
        amountCents: 5000,
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
      {
        text: "Paguei a parcela da internet 50",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("cancelled");
    expect(reply).toBe(
      "Não ficou claro se 50 é o valor pago ou o número da parcela. Envie “R$ 50” para informar o valor ou “parcela número 50” para informar a posição.",
    );
    expect(materializeObligationPayment).not.toHaveBeenCalled();
  });

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
        accountId: "acct-pix",
      });
      expect(createTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["R$ 50", 5000, "50,00"],
    ["número 50", undefined, "119,90"],
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

  it("lets a valid AI payment intent resolve deterministic ambiguity", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "financiamento carro",
        amountCents: 90000,
      }),
    });

    const { state } = await startConversation(
      {
        text: "Paguei a parcela do carro R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 90000,
    });
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
          description: "Financiamento carro",
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
    expect(asked.reply).toContain("Financiamento carro");
    expect(materializeObligationPayment).not.toHaveBeenCalled();

    const chosen = await applyMessage(asked.state, "carro", deps, {
      today: TODAY,
    });
    expect(chosen.state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
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

    await applyMessage(asked.state, "carro", deps, { today: TODAY });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-carro",
      month: "2026-07",
      paidOn: TODAY,
      amountCents: 95500,
    });
  });

  it("preserves an explicit account while resolving an ambiguous obligation", async () => {
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
    expect(asked.state.markPaidAccountId).toBe("acct-pix");

    await applyMessage(asked.state, "sala", deps, { today: TODAY });
    expect(materializeObligationPayment).toHaveBeenCalledWith({
      obligationId: "ob-rent-office",
      month: "2026-07",
      paidOn: TODAY,
      accountId: "acct-pix",
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
});

// ---------------------------------------------------------------------------
// Review fixes (PR #3): failure paths, matching robustness, error surfaces.
// ---------------------------------------------------------------------------

describe("mark_paid keyword matching robustness", () => {
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

  it("uses the AI-specific financing target to resolve a deterministic car ambiguity", async () => {
    const { deps, materializeObligationPayment } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento do carro",
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

    const { state } = await startConversation(
      {
        text: "Paguei a parcela do carro por R$ 900",
        fromUserId: "user-alvaro",
      },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("saved");
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
      accountId: "acct-pix",
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

  it("allows a unique subject-only shorthand without inventing a target type", async () => {
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

    expect(state.status).toBe("saved");
    expect(materializeObligationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ obligationId: "ob-car-insurance" }),
    );
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

  it("'dia 29' keeps the draft and explains the 1–28 rule", async () => {
    const { deps, createObligation } = buildDeps({
      classifyMessage: classifierReturning(SOLAR_INTENT),
    });
    const started = await startedSolar(deps);
    const outcome = await applyMessage(started.state, "dia 29", deps, {
      today: TODAY,
    });
    expect(outcome.state.status).toBe("awaiting_obligation_confirmation");
    expect(outcome.reply).toMatch(/entre 1 e 28/);
    expect(createObligation).not.toHaveBeenCalled();
  });

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
