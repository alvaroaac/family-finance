import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createCodexMessageClassifier,
  withClassifierFallback,
  type CodexProcessRunner,
} from "./codex.js";
import {
  applyCallback,
  startConversation,
  type ConversationDeps,
} from "./conversation.js";

const OPTIONS = {
  today: "2026-07-09",
  parserHints: { amountCents: 12345, description: "Giassi" },
  knownCards: [{ id: "card-1", name: "Nubank" }],
  catalog: {
    householdId: "house-1",
    categories: [{ id: "cat-food", name: "Alimentação" }],
    subcategories: [
      { id: "sub-market", categoryId: "cat-food", name: "Mercado" },
    ],
  },
};

const VALID = {
  action: "interpret_only",
  intent: "plain",
  description: "Giassi",
  merchant: "Giassi",
  item: null,
  amount_cents: 12345,
  monthly_amount_cents: null,
  per_installment_cents: null,
  installment_count: null,
  occurred_on: null,
  start_month: null,
  due_day: null,
  card_id: "card-1",
  card_name: "Nubank",
  mark_paid_target: null,
  category_hint: "Alimentação",
  category_candidates: [
    {
      category: "Alimentação",
      subcategory: "Mercado",
      confidence: 0.98,
      explanation: "Giassi é supermercado.",
    },
  ],
  proposed_taxonomy_change: null,
};

function classifier(runner: CodexProcessRunner) {
  return createCodexMessageClassifier({
    enabled: true,
    model: "gpt-5.5",
    timeoutMs: 1000,
    codexHome: "/tmp/family-finance-codex-test-home",
    runner,
  });
}

describe("Codex unified primary", () => {
  it("makes one schema-constrained call with parser/card/catalog context", async () => {
    const runner = vi.fn<CodexProcessRunner>(async (request) => {
      await writeFile(request.outputPath, JSON.stringify(VALID));
      return { exitCode: 0, timedOut: false, stderr: "" };
    });
    const result = await classifier(runner)("giassi 123,45 no nubank", OPTIONS);
    expect(runner).toHaveBeenCalledTimes(1);
    const request = runner.mock.calls[0]?.[0];
    expect(request?.prompt).toContain("12345");
    expect(request?.prompt).toContain("Nubank");
    expect(request?.prompt).toContain("Alimentação");
    expect(result).toMatchObject({
      intent: "plain",
      expense: {
        description: "Giassi",
        amountCents: 12345,
        categoryCandidates: [{ categoryName: "Alimentação" }],
      },
    });
  });

  it.each([
    [
      "missing binary",
      { exitCode: null, timedOut: false, stderr: "", errorCode: "ENOENT" },
    ],
    [
      "not logged in",
      { exitCode: 1, timedOut: false, stderr: "login required" },
    ],
    ["timeout", { exitCode: null, timedOut: true, stderr: "" }],
    ["nonzero exit", { exitCode: 2, timedOut: false, stderr: "failed" }],
  ])("falls back on %s", async (_name, outcome) => {
    const primary = classifier(async () => outcome);
    const fallback = vi.fn(async () => ({
      intent: "plain" as const,
      expense: { description: "legacy" },
    }));
    const chained = withClassifierFallback(primary, fallback, () => undefined);
    expect(await chained?.("x", OPTIONS)).toMatchObject({ intent: "plain" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back on missing output and invalid schema", async () => {
    for (const runner of [
      async () => ({ exitCode: 0, timedOut: false, stderr: "" }),
      async (request: Parameters<CodexProcessRunner>[0]) => {
        await writeFile(request.outputPath, '{"action":"write"}');
        return { exitCode: 0, timedOut: false, stderr: "" };
      },
    ]) {
      const fallback = vi.fn(async () => null);
      const chained = withClassifierFallback(
        classifier(runner as CodexProcessRunner),
        fallback,
        () => undefined,
      );
      await chained?.("x", OPTIONS);
      expect(fallback).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["plain installment leakage", { ...VALID, installment_count: 2 }],
    ["invalid calendar date", { ...VALID, occurred_on: "2026-02-31" }],
    ["unknown card id", { ...VALID, card_id: "card-unknown" }],
    [
      "duplicate candidates",
      {
        ...VALID,
        category_candidates: [
          VALID.category_candidates[0],
          VALID.category_candidates[0],
        ],
      },
    ],
    [
      "invalid installment XOR",
      {
        ...VALID,
        intent: "card_installment",
        installment_count: 12,
        amount_cents: 120000,
        per_installment_cents: 10000,
      },
    ],
    [
      "obligation missing monthly amount",
      {
        ...VALID,
        intent: "obligation",
        amount_cents: null,
        card_id: null,
        card_name: null,
      },
    ],
  ])("rejects semantic invalidity: %s", async (_name, output) => {
    const primary = classifier(async (request) => {
      await writeFile(request.outputPath, JSON.stringify(output));
      return { exitCode: 0, timedOut: false, stderr: "" };
    });
    const fallback = vi.fn(async () => null);
    await withClassifierFallback(
      primary,
      fallback,
      () => undefined,
    )?.("x", OPTIONS);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does not invoke Anthropic when Codex succeeds", async () => {
    const primary = classifier(async (request) => {
      await writeFile(request.outputPath, JSON.stringify(VALID));
      return { exitCode: 0, timedOut: false, stderr: "" };
    });
    const fallback = vi.fn(async () => null);
    await withClassifierFallback(
      primary,
      fallback,
      () => undefined,
    )?.("giassi 123,45", OPTIONS);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    [
      "solar obligation",
      {
        ...VALID,
        intent: "obligation",
        description: "Placas solares",
        amount_cents: null,
        monthly_amount_cents: 71044,
        installment_count: 72,
        card_id: null,
        card_name: null,
        category_candidates: [],
      },
      "obligation",
    ],
    [
      "Mercado Livre installment",
      {
        ...VALID,
        intent: "card_installment",
        description: "Mercado Livre",
        amount_cents: 120000,
        installment_count: 12,
        category_candidates: [],
      },
      "card_installment",
    ],
  ])(
    "uses exactly one Codex and zero Anthropic calls for %s",
    async (_name, output, intent) => {
      const runner = vi.fn<CodexProcessRunner>(async (request) => {
        await writeFile(request.outputPath, JSON.stringify(output));
        return { exitCode: 0, timedOut: false, stderr: "" };
      });
      const anthropic = vi.fn(async () => null);
      const result = await withClassifierFallback(
        classifier(runner),
        anthropic,
        () => undefined,
      )?.("mensagem", OPTIONS);
      expect(result?.intent).toBe(intent);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(anthropic).not.toHaveBeenCalled();
    },
  );

  it("persists top-3 existing choices in state, skips second AI, and clears them on tap", async () => {
    const codex = classifier(async (request) => {
      await writeFile(request.outputPath, JSON.stringify(VALID));
      return { exitCode: 0, timedOut: false, stderr: "" };
    });
    const suggestCategory = vi.fn(async () => ({
      status: "uncategorized" as const,
      suggestion: null,
      requiresConfirmation: true,
    }));
    const deps: ConversationDeps = {
      householdId: "house-1",
      catalog: OPTIONS.catalog,
      defaultAccountId: "account-1",
      resolveCardId: () => undefined,
      resolveAccountId: () => "account-1",
      resolveResponsibleUserId: () => undefined,
      suggestCategory,
      createTransaction: async () => ({ id: "tx-1" }),
      logInteraction: async () => undefined,
      classifyMessage: codex,
      listActiveCards: () => [{ id: "card-1", name: "Nubank" }],
    };
    const started = await startConversation(
      { text: "giassi 123,45 no nubank", fromUserId: "user-1" },
      deps,
      { today: OPTIONS.today },
    );
    expect(suggestCategory).not.toHaveBeenCalled();
    expect(started.state.draft.cardId).toBe("card-1");
    expect(started.state.draft.accountId).toBeUndefined();
    expect(started.state.categoryCandidates).toEqual([
      {
        categoryId: "cat-food",
        categoryName: "Alimentação",
        subcategoryId: "sub-market",
        subcategoryName: "Mercado",
        confidence: 0.98,
        explanation: "Giassi é supermercado.",
      },
    ]);
    expect(started.keyboard?.inline_keyboard.flat()).toContainEqual({
      text: "📂 Alimentação › Mercado",
      callback_data: "cs:0",
    });

    // DB state is JSONB; this round-trip exercises restart persistence.
    const restartedState = JSON.parse(JSON.stringify(started.state));
    const selected = await applyCallback(restartedState, "cs:0", deps);
    expect(selected.state.draft.categoryId).toBe("cat-food");
    expect(selected.state.draft.subcategoryId).toBe("sub-market");
    expect(selected.state.categoryCandidates).toBeUndefined();
  });
});
