/**
 * Conversation tests for the recurring-obligations flows (PR-1):
 *
 *  - obligation create: classify -> SUMMARY confirmation -> confirmar persists
 *    via deps.createObligation (never before), with valor/dia/conta corrections
 *  - mark_paid{obligation}: keyword match (single/ambiguous/none), send-date
 *    paidOn, idempotent repeat
 *  - deferred card intents reply "em breve" verbatim and stay terminal
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
    resolveAccountIdByName: (name: string) =>
      name.trim().toLowerCase() === "nubank" ? "acct-nubank" : undefined,
    accountNameById: (id: string) =>
      id === "acct-1"
        ? "Conta corrente"
        : id === "acct-nubank"
          ? "Nubank"
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
    expect(reply).toContain("Solar");
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
      description: "Solar",
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
    });
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

describe("deferred card intents (PR-2)", () => {
  it("card_installment replies the exact em-breve copy", async () => {
    const { deps, createTransaction } = buildDeps({
      classifyMessage: classifierReturning({ intent: "card_installment" }),
    });
    const { state, reply } = await startConversation(
      { text: "notebook 3600 em 12x no nubank", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(createTransaction).not.toHaveBeenCalled();
    expect(reply).toBe(
      "Compra parcelada no cartão ainda não dá pra registrar por aqui — em breve. Por ora, cadastre em Cartões no painel.",
    );
  });

  it("mark_paid{card} replies the exact em-breve copy", async () => {
    const { deps } = buildDeps({
      classifyMessage: classifierReturning({
        intent: "mark_paid",
        target: "card",
        keyword: "nubank",
      }),
    });
    const { state, reply } = await startConversation(
      { text: "nubank pago", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(state.status).toBe("cancelled");
    expect(reply).toBe(
      "Baixa de fatura do cartão ainda não está disponível por aqui — em breve.",
    );
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
