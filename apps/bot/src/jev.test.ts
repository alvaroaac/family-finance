import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevClient,
  createJevCategorizer,
  type JevResult,
} from "./jev.js";
import { createCategoryRuntime } from "./category-runtime.js";
import { suggestCategory } from "@family-finance/categorization";
const catalog = {
  householdId: "home",
  categories: [{ id: "food", name: "Alimentação" }],
  subcategories: [{ id: "market", categoryId: "food", name: "Mercado" }],
};
const context = { householdId: "home", description: "Compra supermercado 25" };
const matched: JevResult = {
  decision: "single",
  candidates: [
    {
      categoryId: "food",
      subcategoryId: "market",
      confidence: 0.96,
      explanation: "Mercado",
    },
  ],
  needsFallback: false,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mockResponse(
  decision = "single",
  category = "c1",
  probability = 0.96,
) {
  const decisionProbabilities = {
    single: 0,
    choose: 0,
    propose_new: 0,
    abstain: 0,
    [decision]: 1,
  };
  return {
    answers: {
      decision: {
        type: "choice",
        choice: decision,
        confidence: 1,
        probabilities: decisionProbabilities,
      },
      category: {
        type: "choice",
        choice: category,
        confidence: 0.01,
        probabilities: { unknown: 1 - probability, c0: 0, c1: probability },
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}
describe("Jev categorization", () => {
  it("maps native probabilities to real catalog IDs independently of confidence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(mockResponse())));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.fn();
    const result = await createJevClient({
      apiKey: "key",
      logCall: log,
    }).classify(context.description, catalog);
    expect(result).toMatchObject({
      decision: "single",
      needsFallback: false,
      candidates: [
        { categoryId: "food", subcategoryId: "market", confidence: 0.96 },
      ],
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 20,
        outcome: "ok",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(body.state).toEqual({ text: context.description });
    expect(JSON.stringify(body)).not.toContain("householdId");
  });
  it("rejects invented options and invalid distributions", async () => {
    const body = mockResponse();
    body.answers.category.choice = "invented";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
    );
    expect(
      await createJevClient({ apiKey: "key", logCall: vi.fn() }).classify(
        context.description,
        catalog,
      ),
    ).toBeNull();
  });
  it("does not send catalogs beyond the native choice limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const huge = {
      categories: Array.from({ length: 255 }, (_, i) => ({
        id: String(i),
        name: String(i),
      })),
      subcategories: [],
    };
    expect(
      await createJevClient({ apiKey: "key" }).classify("test", huge),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("aborts a hung request and returns null", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const log = vi.fn();
    const pending = createJevClient({
      apiKey: "key",
      timeoutMs: 100,
      logCall: log,
    }).classify("test", catalog);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timeout" }),
    );
  });
  it("uses Jev first without paying for GPT on a decisive result", async () => {
    const fallback = { categorize: vi.fn() };
    const jev = { classify: vi.fn(async () => matched) };
    expect(
      await createJevCategorizer(jev, fallback).categorize(context, catalog),
    ).toMatchObject({
      categoryName: "Alimentação",
      subcategoryName: "Mercado",
    });
    expect(fallback.categorize).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...matched, needsFallback: true },
    { ...matched, decision: "propose_new" as const, needsFallback: true },
  ])("uses GPT for a failure or uncertain decision", async (result) => {
    const fallback = {
      categorize: vi.fn(async () => ({
        categoryName: "Alimentação",
        subcategoryName: "Mercado",
        confidence: 0.9,
        explanation: "GPT",
      })),
    };
    expect(
      await createJevCategorizer(
        { classify: async () => result },
        fallback,
      ).categorize(context, catalog),
    ).toMatchObject({ explanation: "GPT" });
    expect(fallback.categorize).toHaveBeenCalledTimes(1);
  });
  it("preserves intentional abstention without invoking GPT", async () => {
    const fallback = { categorize: vi.fn() };
    expect(
      await createJevCategorizer(
        {
          classify: async () => ({
            decision: "abstain",
            candidates: [],
            needsFallback: false,
          }),
        },
        fallback,
      ).categorize(context, catalog),
    ).toBeNull();
    expect(fallback.categorize).not.toHaveBeenCalled();
  });
  it("keeps uncertain Jev suggestions review-required if GPT fails", async () => {
    const result = await createJevCategorizer(
      { classify: async () => ({ ...matched, needsFallback: true }) },
      { categorize: async () => null },
    ).categorize(context, catalog);
    expect(result?.confidence).toBeLessThan(0.85);
  });
  it("does not call either provider when household memory is confirmed", async () => {
    const jev = { classify: vi.fn() };
    const fallback = { categorize: vi.fn() };
    const result = await suggestCategory(context, {
      catalog,
      ai: createJevCategorizer(jev, fallback),
      memoryStore: {
        findActiveByHousehold: async () => [
          {
            id: "memory",
            householdId: "home",
            pattern: "supermercado",
            categoryId: "food",
            subcategoryId: "market",
            confidence: 0.99,
            explanation: "confirmed",
            isActive: true,
          },
        ],
      },
    });
    expect(result.suggestion?.source).toBe("memory");
    expect(jev.classify).not.toHaveBeenCalled();
    expect(fallback.categorize).not.toHaveBeenCalled();
  });
  it("constructs Jev and GPT using only their configured keys", () => {
    const jev = vi.fn(() => ({ classify: vi.fn() }));
    const openai = vi.fn(() => ({ complete: vi.fn() }));
    createCategoryRuntime(
      {
        HOUSEHOLD_SLUG: "casa",
        IMPORT_PAID_FALLBACK_ENABLED: "false",
        IMPORT_PAID_FALLBACK_MAX_ITEMS: 10,
        TYPESAFE_API_KEY: "jev-key",
        OPENAI_API_KEY: "gpt-key",
        OPENAI_MODEL: "gpt-test",
        ANTHROPIC_API_KEY: "unused",
      },
      { jev, openai },
    );
    expect(jev).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "jev-key" }),
    );
    expect(openai).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "gpt-key", model: "gpt-test" }),
    );
  });
});
