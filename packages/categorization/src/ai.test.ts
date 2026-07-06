import { describe, it, expect, vi } from "vitest";

import {
  createAiCategorizer,
  type AiCompletionClient,
} from "./ai.js";
import {
  suggestCategory,
  type CategoryCatalog,
  type CategorizationContext,
} from "./index.js";
import { CONFIDENCE } from "./confidence.js";

// ---------------------------------------------------------------------------
// Fixtures (synthetic — no real personal financial data, no real provider).
// ---------------------------------------------------------------------------

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [
    { id: "cat-food", name: "Alimentação" },
    { id: "cat-transport", name: "Transporte" },
    { id: "cat-other", name: "Outros" },
  ],
  subcategories: [
    { id: "sub-delivery", categoryId: "cat-food", name: "Delivery" },
    { id: "sub-market", categoryId: "cat-food", name: "Mercado" },
  ],
};

function ctx(
  description: string,
  overrides: Partial<CategorizationContext> = {},
): CategorizationContext {
  return { householdId: "house-1", description, ...overrides };
}

/** A mocked completion client that returns a canned JSON string. */
function mockClient(reply: string | null): {
  client: AiCompletionClient;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(async () => reply);
  return { client: { complete }, complete };
}

describe("createAiCategorizer", () => {
  it("returns a structured suggestion (confidence + explanation) parsed from the model JSON", async () => {
    const { client, complete } = mockClient(
      JSON.stringify({
        categoryName: "Transporte",
        subcategoryName: null,
        confidence: 0.8,
        explanation: "Corrida de aplicativo identificada como transporte.",
      }),
    );
    const categorizer = createAiCategorizer(client);

    const out = await categorizer.categorize(ctx("corrida 99 app"), CATALOG);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(out).not.toBeNull();
    expect(out?.categoryName).toBe("Transporte");
    expect(out?.confidence).toBeCloseTo(0.8, 5);
    expect(out?.explanation.length).toBeGreaterThan(0);
  });

  it("passes the household catalog names into the prompt (no invented options)", async () => {
    const { client, complete } = mockClient(
      JSON.stringify({
        categoryName: "Alimentação",
        subcategoryName: "Delivery",
        confidence: 0.7,
        explanation: "Pedido de comida por aplicativo.",
      }),
    );
    const categorizer = createAiCategorizer(client);
    await categorizer.categorize(ctx("pedido de comida"), CATALOG);

    const prompt = complete.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Alimentação");
    expect(prompt).toContain("Transporte");
    expect(prompt).toContain("pedido de comida");
  });

  it("returns null when the model abstains or replies with non-JSON (safe fallback)", async () => {
    const abstain = createAiCategorizer(mockClient("não sei").client);
    expect(await abstain.categorize(ctx("xyz"), CATALOG)).toBeNull();

    const empty = createAiCategorizer(mockClient(null).client);
    expect(await empty.categorize(ctx("xyz"), CATALOG)).toBeNull();
  });

  it("returns null when the JSON is missing required fields (confidence/explanation)", async () => {
    const categorizer = createAiCategorizer(
      mockClient(JSON.stringify({ categoryName: "Transporte" })).client,
    );
    expect(await categorizer.categorize(ctx("xyz"), CATALOG)).toBeNull();
  });

  it("never throws if the client itself fails — degrades to null", async () => {
    const failing: AiCompletionClient = {
      complete: async () => {
        throw new Error("provider unavailable");
      },
    };
    const categorizer = createAiCategorizer(failing);
    await expect(categorizer.categorize(ctx("xyz"), CATALOG)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration with the engine: AI is the LAST resort, gated by confidence,
// and a novel category proposed by AI stays PENDING (never auto-created).
// ---------------------------------------------------------------------------

describe("AI fallback through suggestCategory", () => {
  it("is NOT called when a deterministic rule already matches (high confidence)", async () => {
    const { client, complete } = mockClient(
      JSON.stringify({
        categoryName: "Alimentação",
        subcategoryName: "Delivery",
        confidence: 0.9,
        explanation: "IA.",
      }),
    );
    const ai = createAiCategorizer(client);

    // "IFOOD" is a deterministic rule -> engine should never reach AI.
    const result = await suggestCategory(ctx("IFOOD *LANCHE"), {
      catalog: CATALOG,
      ai,
    });

    expect(result.status).toBe("matched");
    expect(result.suggestion?.source).toBe("rule");
    expect(complete).not.toHaveBeenCalled();
  });

  it("IS called when no rule matches, and a low-confidence AI result requires confirmation", async () => {
    const { client, complete } = mockClient(
      JSON.stringify({
        categoryName: "Alimentação",
        subcategoryName: null,
        confidence: CONFIDENCE.LOW,
        explanation: "Heurística incerta.",
      }),
    );
    const ai = createAiCategorizer(client);

    const result = await suggestCategory(ctx("transacao obscura 9981"), {
      catalog: CATALOG,
      ai,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("matched");
    expect(result.suggestion?.source).toBe("ai");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("a novel category proposed by AI stays PENDING (never auto-creates)", async () => {
    const ai = createAiCategorizer(
      mockClient(
        JSON.stringify({
          categoryName: "Petshop Exótico",
          subcategoryName: "Iguanas",
          confidence: 0.95,
          explanation: "IA propôs categoria nova.",
        }),
      ).client,
    );

    const result = await suggestCategory(ctx("RACAO IGUANA EXOTICA"), {
      catalog: CATALOG,
      ai,
    });

    expect(result.status).toBe("pending_new_category");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.suggestion?.macroCategoryId).toBeUndefined();
  });
});
