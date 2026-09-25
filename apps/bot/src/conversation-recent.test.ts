import { describe, expect, it, vi } from "vitest";

import type { CategoryCatalog } from "@family-finance/categorization";

import {
  applyMessage,
  parseRecentExpensesCommand,
  startConversation,
  type ConversationDeps,
  type ConversationState,
  type RecentExpenseItem,
} from "./conversation.js";

const TODAY = "2026-09-03";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [
    { id: "cat-health", name: "Saúde" },
    { id: "cat-food", name: "Alimentação" },
  ],
  subcategories: [
    { id: "sub-medicine", categoryId: "cat-health", name: "Remédios" },
  ],
};

const ITEMS: RecentExpenseItem[] = [
  {
    id: "tx-1",
    amountCents: 4590,
    occurredOn: "2026-09-02",
    description: "Farmácia",
    categoryId: "cat-health",
    subcategoryId: "sub-medicine",
    accountId: null,
    creditCardId: "card-nubank",
    responsibleUserId: "user-karol",
  },
  {
    id: "tx-2",
    amountCents: 23000,
    occurredOn: "2026-09-01",
    description: "Mercado",
    categoryId: null,
    subcategoryId: null,
    accountId: "acct-house",
    creditCardId: null,
    responsibleUserId: null,
  },
];

function buildDeps(overrides: Partial<ConversationDeps> = {}) {
  const classifyMessage = vi.fn();
  const interpretText = vi.fn();
  const suggestCategory = vi.fn(async () => ({
    status: "uncategorized" as const,
    suggestion: null,
    requiresConfirmation: false,
  }));
  const listRecentExpenses = vi.fn(async () => ITEMS);
  const logInteraction = vi.fn(async () => undefined);
  const deps: ConversationDeps = {
    householdId: "house-1",
    catalog: CATALOG,
    defaultAccountId: "acct-house",
    resolveCardId: () => undefined,
    resolveAccountId: () => "acct-house",
    resolveResponsibleUserId: () => undefined,
    memberDisplayName: (id) => (id === "user-karol" ? "Karol" : undefined),
    accountNameById: (id) =>
      id === "acct-house" ? "Conta da casa" : undefined,
    cardNameById: (id) => (id === "card-nubank" ? "Nubank" : undefined),
    suggestCategory,
    createTransaction: vi.fn(async () => ({ id: "tx-new" })),
    logInteraction,
    classifyMessage,
    interpretText,
    listRecentExpenses,
    ...overrides,
  };
  return {
    deps,
    classifyMessage,
    interpretText,
    suggestCategory,
    listRecentExpenses,
    logInteraction,
  };
}

function pendingState(): ConversationState {
  return {
    status: "awaiting_confirmation",
    draft: {
      amountCents: 3200,
      description: "Uber",
      occurredOn: TODAY,
      kind: "expense",
      accountId: "acct-house",
      createdByUserId: "user-alvaro",
      inputKind: "text",
      needsAttention: false,
    },
  };
}

describe("recent expenses command", () => {
  it("bypasses AI and returns the formatted latest expenses", async () => {
    const mocks = buildDeps();
    const outcome = await startConversation(
      { text: "últimos 10", fromUserId: "user-alvaro" },
      mocks.deps,
      { today: TODAY },
    );

    expect(mocks.listRecentExpenses).toHaveBeenCalledWith(10);
    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("Últimos 2 lançamentos:");
    expect(outcome.reply).toContain("Saúde > Remédios · Nubank · Karol");
    expect(outcome.reply).toContain(
      "Sem categoria (a definir) · Conta da casa · Casa",
    );
    expect(mocks.classifyMessage).not.toHaveBeenCalled();
    expect(mocks.interpretText).not.toHaveBeenCalled();
    expect(mocks.suggestCategory).not.toHaveBeenCalled();
    expect(mocks.logInteraction).toHaveBeenCalledWith({
      fromUserId: "user-alvaro",
      inputKind: "text",
      messageText: "últimos 10",
    });
  });

  it.each([
    ["últimos", 5],
    ["últimos 40", 15],
  ])("uses the expected limit for %s", async (text, limit) => {
    const mocks = buildDeps();
    await startConversation({ text, fromUserId: "user-alvaro" }, mocks.deps, {
      today: TODAY,
    });
    expect(mocks.listRecentExpenses).toHaveBeenCalledWith(limit);
  });

  it("preserves an active draft and omits its keyboard", async () => {
    const { deps } = buildDeps();
    const state = pendingState();
    const outcome = await applyMessage(state, "extrato", deps, {
      today: TODAY,
    });
    expect(outcome.state).toBe(state);
    expect(outcome.keyboard).toBeUndefined();
    expect(outcome.reply).toContain("Últimos 2 lançamentos:");
  });

  it("reports an unavailable dependency", async () => {
    const { deps } = buildDeps({ listRecentExpenses: undefined });
    const outcome = await startConversation(
      { text: "listar gastos", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.reply).toBe(
      "A lista de lançamentos não está disponível agora. Tente de novo em instantes.",
    );
  });

  it("reports query failures", async () => {
    const { deps } = buildDeps({
      listRecentExpenses: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const outcome = await startConversation(
      { text: "lista", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.reply).toBe(
      "A lista de lançamentos não está disponível agora. Tente de novo em instantes.",
    );
  });

  it("reports an empty list", async () => {
    const { deps } = buildDeps({ listRecentExpenses: vi.fn(async () => []) });
    const outcome = await startConversation(
      { text: "extrato 10", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.reply).toBe("Nenhum lançamento registrado ainda.");
  });
});

describe("parseRecentExpensesCommand", () => {
  it.each([
    ["últimos", 5],
    ["ultimos", 5],
    ["últimas", 5],
    ["ultimas", 5],
    ["últimos 10", 10],
    ["ultimas 5", 5],
    ["últimos 15 lançamentos", 15],
    ["ultimos 10 gastos", 10],
    ["últimas 5 despesas", 5],
    ["últimos lançamentos", 5],
    ["listar", 5],
    ["lista", 5],
    ["listar gastos", 5],
    ["listar 10 despesas", 10],
    ["lista lançamentos", 5],
    ["extrato", 5],
    ["extrato 10", 10],
    ["listar ultimos 10 gastos", 10],
    ["listar os últimos 10 lançamentos", 10],
    ["lista as últimas 5 despesas", 5],
    ["mostrar despesas", 5],
    ["mostra os últimos 15", 15],
    ["extrato despesas", 5],
    ["gastos", 5],
    [" últimos 40 ", 15],
    ["últimos 0", 1],
  ])("parses %s", (text, limit) => {
    expect(parseRecentExpensesCommand(text)).toEqual({ limit });
  });

  it.each([
    "mercado 50",
    "últimos dias fui ao mercado 50",
    "listar despesas agora",
    "os 10",
    "10",
    "",
  ])("does not match %s", (text) => {
    expect(parseRecentExpensesCommand(text)).toBeNull();
  });
});
