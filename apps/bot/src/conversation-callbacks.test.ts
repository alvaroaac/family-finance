import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";
import type { CategorizationResult } from "@family-finance/categorization";

const TODAY = "2026-07-04";

const CATALOG = {
  householdId: "house-1",
  categories: [
    { id: "cat-transport", name: "Transporte" },
    { id: "cat-food", name: "Alimentação" },
  ],
  subcategories: [],
};

const UNCATEGORIZED: CategorizationResult = {
  status: "uncategorized",
  suggestion: null,
  requiresConfirmation: true,
};

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  return {
    householdId: "house-1",
    catalog: CATALOG,
    defaultAccountId: "acct-1",
    resolveCardId: () => undefined,
    resolveAccountId: () => "acct-1",
    resolveResponsibleUserId: (name: string) =>
      name.trim().toLowerCase() === "karol" ? "user-karol" : undefined,
    memberDisplayName: (userId: string) =>
      userId === "user-karol" ? "Karol" : userId === "user-alvaro" ? "Alvaro" : undefined,
    suggestCategory: vi.fn(async () => UNCATEGORIZED),
    createTransaction: vi.fn(async () => ({ id: "tx-1" })),
    logInteraction: vi.fn(async () => undefined),
    listActiveMembers: () => [
      { userId: "user-alvaro", displayName: "Alvaro" },
      { userId: "user-karol", displayName: "Karol" },
    ],
    ...overrides,
  };
}

async function draftState(deps: ConversationDeps): Promise<ConversationState> {
  const outcome = await startConversation(
    { text: "Petz 90 reais", fromUserId: "user-alvaro" },
    deps,
    { today: TODAY },
  );
  return outcome.state;
}

describe("keyboards on text outcomes", () => {
  it("startConversation attaches the confirmation keyboard when awaiting confirmation", async () => {
    const deps = makeDeps();
    const outcome = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]).toEqual({
      text: "✅ Confirmar",
      callback_data: "cf",
    });
  });

  it("a typed correction re-attaches the confirmation keyboard", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyMessage(state, "valor 45,90", deps, { today: TODAY });
    expect(outcome.keyboard).toBeDefined();
  });
});

describe("applyCallback: cf / cx", () => {
  it("cf persists exactly like typed confirmar (parity)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(outcome.state.status).toBe("saved");
    expect(outcome.transactionId).toBe("tx-1");
    expect(outcome.reply).toContain("Lançamento salvo");
    expect(outcome.keyboard).toBeUndefined();
  });

  it("cx cancels exactly like typed cancelar", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cx", deps, { today: TODAY });
    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.reply).toContain("não salvei");
  });

  it("typed and tapped confirm produce the same persisted draft", async () => {
    const depsA = makeDeps();
    const depsB = makeDeps();
    const stateA = await draftState(depsA);
    const stateB = await draftState(depsB);
    await applyMessage(stateA, "confirmar", depsA, { today: TODAY });
    await applyCallback(stateB, "cf", depsB, { today: TODAY });
    const draftA = (depsA.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const draftB = (depsB.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(draftB).toEqual(draftA);
  });
});

describe("applyCallback: grids and picks", () => {
  it("cats replies with the category grid and keeps the state", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "cats", deps, { today: TODAY });
    expect(outcome.state.status).toBe("awaiting_confirmation");
    expect(outcome.reply).toBe("Escolha a categoria:");
    const flat = outcome.keyboard?.inline_keyboard.flat() ?? [];
    expect(flat.map((b) => b.callback_data)).toEqual([
      "ct:cat-food",
      "ct:cat-transport",
      "nc",
    ]);
  });

  it("ct:<id> assigns the category and re-sends the summary (parity with typed)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "ct:cat-food", deps, { today: TODAY });
    expect(outcome.state.draft.categoryId).toBe("cat-food");
    expect(outcome.reply).toContain("Categoria: Alimentação");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
  });

  it("ct with an unknown id answers a toast and keeps the state", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "ct:cat-nope", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("não encontrada");
    expect(outcome.state.draft.categoryId).toBeUndefined();
  });

  it("resp replies with the responsável grid (Casa + members)", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "resp", deps, { today: TODAY });
    const flat = outcome.keyboard?.inline_keyboard.flat() ?? [];
    expect(flat.map((b) => b.callback_data)).toEqual([
      "rs:house",
      "rs:user-alvaro",
      "rs:user-karol",
    ]);
  });

  it("rs:house moves responsibility to the house; rs:<id> to the member", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const house = await applyCallback(state, "rs:house", deps, { today: TODAY });
    expect(house.state.draft.responsibleUserId).toBeUndefined();
    expect(house.reply).toContain("Responsável: Casa");

    const karol = await applyCallback(state, "rs:user-karol", deps, { today: TODAY });
    expect(karol.state.draft.responsibleUserId).toBe("user-karol");
    expect(karol.reply).toContain("Responsável: Karol");
  });
});

describe("applyCallback: stale states and double-taps", () => {
  it("double-tap on cf after saved answers Já salvo, no second insert", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const first = await applyCallback(state, "cf", deps, { today: TODAY });
    const second = await applyCallback(first.state, "cf", deps, { today: TODAY });
    expect(second.silent).toBe(true);
    expect(second.toast).toBe("Já salvo ✅");
    expect(deps.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("any token on a cancelled conversation answers Sessão expirada", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const cancelled = await applyCallback(state, "cx", deps, { today: TODAY });
    const late = await applyCallback(cancelled.state, "ct:cat-food", deps, { today: TODAY });
    expect(late.silent).toBe(true);
    expect(late.toast).toContain("Sessão expirada");
  });

  it("an unknown token never crashes — answers Sessão expirada and ignores", async () => {
    const deps = makeDeps();
    const state = await draftState(deps);
    const outcome = await applyCallback(state, "wat:???", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("Sessão expirada");
    expect(outcome.state).toBe(state);
  });

  it("tokens on obligation states answer Sessão expirada (buttons are expense-only)", async () => {
    const deps = makeDeps();
    const state: ConversationState = {
      status: "awaiting_obligation_confirmation",
      draft: (await draftState(deps)).draft,
    };
    const outcome = await applyCallback(state, "cf", deps, { today: TODAY });
    expect(outcome.silent).toBe(true);
    expect(outcome.toast).toContain("Sessão expirada");
  });
});

const PROPOSAL: CategorizationResult = {
  status: "pending_new_category",
  suggestion: { confidence: 0.9, explanation: "Petz é um pet shop.", source: "ai" },
  pendingCategory: {
    categoryName: "Pets",
    subcategoryName: null,
    confidence: 0.9,
    explanation: "Petz é um pet shop.",
  },
  requiresConfirmation: true,
};

function proposalDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  return makeDeps({
    suggestCategory: vi.fn(async () => PROPOSAL),
    listAllCategories: vi.fn(async () => [
      { id: "cat-transport", name: "Transporte", isActive: true },
      { id: "cat-food", name: "Alimentação", isActive: true },
    ]),
    createCategory: vi.fn(async () => ({ id: "cat-pets" })),
    restoreCategory: vi.fn(async () => undefined),
    seedCategorizationMemory: vi.fn(async () => undefined),
    ...overrides,
  });
}

describe("AI new-category proposal", () => {
  it("startConversation surfaces the proposal in state, summary, and keyboard", async () => {
    const deps = proposalDeps();
    const outcome = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(outcome.state.proposedCategoryName).toBe("Pets");
    expect(outcome.reply).toContain('Categoria: "Pets" (nova — sugerida)');
    expect(outcome.reply).toContain("Sugestão: Petz é um pet shop.");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]).toEqual({
      text: '✅ Confirmar (cria "Pets")',
      callback_data: "nca",
    });
  });

  it("nca creates the category, seeds memory, and persists the transaction", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(start.state, "nca", deps, { today: TODAY });

    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(deps.seedCategorizationMemory).toHaveBeenCalledWith({
      pattern: "petz",
      categoryId: "cat-pets",
      confidence: 0.95,
      explanation: `criada pelo usuário via bot em ${TODAY}`,
    });
    expect(outcome.state.status).toBe("saved");
    const draft = (deps.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(draft.category).toEqual({ categoryId: "cat-pets", subcategoryId: undefined });
    expect(outcome.reply).toContain("Pets");
  });

  it("typed confirmar with a pending proposal behaves exactly like nca (parity)", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyMessage(start.state, "confirmar", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(deps.seedCategorizationMemory).toHaveBeenCalledTimes(1);
    expect(outcome.state.status).toBe("saved");
  });

  it("dedupe: an ACTIVE case/accent-insensitive match is assigned, not duplicated", async () => {
    const deps = proposalDeps({
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-x", name: "PÉTS", isActive: true },
      ]),
    });
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyCallback(start.state, "nca", deps, { today: TODAY });
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(deps.restoreCategory).not.toHaveBeenCalled();
    const seeded = (deps.seedCategorizationMemory as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(seeded.categoryId).toBe("cat-pets-x");
  });

  it("dedupe: an INACTIVE match is reactivated and assigned", async () => {
    const deps = proposalDeps({
      listAllCategories: vi.fn(async () => [
        { id: "cat-pets-old", name: "pets", isActive: false },
      ]),
    });
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    await applyCallback(start.state, "nca", deps, { today: TODAY });
    expect(deps.restoreCategory).toHaveBeenCalledWith("cat-pets-old");
    expect(deps.createCategory).not.toHaveBeenCalled();
  });

  it("nocat drops the proposal and returns to the plain confirmation", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const outcome = await applyCallback(start.state, "nocat", deps, { today: TODAY });
    expect(outcome.state.proposedCategoryName).toBeUndefined();
    expect(outcome.reply).toContain("Categoria: Sem categoria (a definir)");
    expect(outcome.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe("cf");
    // Dropping the proposal never writes memory or creates anything.
    expect(deps.createCategory).not.toHaveBeenCalled();
    expect(deps.seedCategorizationMemory).not.toHaveBeenCalled();
  });

  it("a regular ct:<id> pick clears the proposal and seeds NOTHING", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz 90 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const picked = await applyCallback(start.state, "ct:cat-food", deps, { today: TODAY });
    expect(picked.state.proposedCategoryName).toBeUndefined();
    await applyCallback(picked.state, "cf", deps, { today: TODAY });
    expect(deps.seedCategorizationMemory).not.toHaveBeenCalled();
  });

  it("keeps the proposal when confirm arrives before the amount", async () => {
    const deps = proposalDeps();
    const start = await startConversation(
      { text: "Petz", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(start.state.status).toBe("needs_amount");
    expect(start.state.proposedCategoryName).toBe("Pets");

    // Confirm without an amount: no create/seed yet, proposal must survive.
    const early = await applyMessage(start.state, "confirmar", deps, { today: TODAY });
    expect(early.state.status).toBe("needs_amount");
    expect(early.state.proposedCategoryName).toBe("Pets");
    expect(deps.createCategory).not.toHaveBeenCalled();

    // Supply the amount, then confirm: the full nca-equivalent path runs.
    const withAmount = await applyMessage(early.state, "valor 90", deps, { today: TODAY });
    expect(withAmount.state.proposedCategoryName).toBe("Pets");
    const done = await applyMessage(withAmount.state, "confirmar", deps, { today: TODAY });
    expect(deps.createCategory).toHaveBeenCalledWith("Pets");
    expect(done.state.status).toBe("saved");
  });
});
