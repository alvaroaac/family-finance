import { describe, it, expect } from "vitest";

import {
  CONFIDENCE,
  scoreConfidence,
  needsConfirmation,
  type ConfidenceTier,
} from "./confidence.js";
import {
  matchRules,
  defaultRuleSet,
  type CategorizationRule,
} from "./rules.js";
import {
  matchMemory,
  describeMemory,
  type CategorizationMemoryEntry,
  type CategorizationMemoryStore,
} from "./memory.js";
import {
  suggestCategory,
  type CategoryCatalog,
  type CategorizationContext,
  type AiCategorizer,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures (synthetic — no real personal financial data).
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
  return {
    householdId: "house-1",
    description,
    ...overrides,
  };
}

describe("confidence", () => {
  it("clamps scores into the [0,1] range", () => {
    expect(scoreConfidence(-5)).toBe(0);
    expect(scoreConfidence(2)).toBe(1);
    expect(scoreConfidence(0.42)).toBeCloseTo(0.42, 5);
  });

  it("maps scores to tiers and flags low confidence for confirmation", () => {
    const high: ConfidenceTier = "high";
    expect(needsConfirmation(CONFIDENCE.HIGH)).toBe(false);
    expect(needsConfirmation(CONFIDENCE.LOW)).toBe(true);
    expect(needsConfirmation(0)).toBe(true);
    // A confident memory/rule match should not require confirmation.
    expect<ConfidenceTier>(high).toBe("high");
  });
});

describe("deterministic rules", () => {
  it("matches a known merchant token in the description (IFOOD -> Alimentação > Delivery)", () => {
    const result = matchRules(ctx("Compra IFOOD *RESTAURANTE"), defaultRuleSet());
    expect(result).not.toBeNull();
    expect(result?.categoryName).toBe("Alimentação");
    expect(result?.subcategoryName).toBe("Delivery");
    expect(result?.confidence).toBeGreaterThanOrEqual(CONFIDENCE.HIGH);
    expect(result?.explanation).toMatch(/IFOOD/i);
  });

  it("is case-insensitive and ignores unrelated descriptions", () => {
    expect(matchRules(ctx("ifood delivery"), defaultRuleSet())).not.toBeNull();
    expect(matchRules(ctx("pagamento boleto xyz"), defaultRuleSet())).toBeNull();
  });

  it("custom rules can target merchant explicitly", () => {
    const rules: CategorizationRule[] = [
      {
        id: "uber-rule",
        field: "description",
        contains: "UBER",
        categoryName: "Transporte",
        confidence: 0.9,
      },
    ];
    const result = matchRules(ctx("UBER *TRIP help.uber.com"), rules);
    expect(result?.categoryName).toBe("Transporte");
  });
});

describe("categorization memory", () => {
  const memory: CategorizationMemoryEntry[] = [
    {
      id: "mem-1",
      householdId: "house-1",
      pattern: "IFOOD",
      categoryId: "cat-food",
      subcategoryId: "sub-delivery",
      confidence: 0.97,
      explanation: 'descrição contém "IFOOD" -> Alimentação > Delivery',
      isActive: true,
    },
    {
      id: "mem-2",
      householdId: "house-1",
      pattern: "ZZZ-DISABLED",
      categoryId: "cat-other",
      subcategoryId: null,
      confidence: 0.99,
      explanation: "disabled entry",
      isActive: false,
    },
  ];

  it("matches an active memory entry by pattern substring", () => {
    const hit = matchMemory(ctx("Pedido IFOOD entrega"), memory);
    expect(hit?.categoryId).toBe("cat-food");
    expect(hit?.subcategoryId).toBe("sub-delivery");
  });

  it("never matches a disabled (inactive) memory entry", () => {
    expect(matchMemory(ctx("ZZZ-DISABLED charge"), memory)).toBeNull();
  });

  it("matches exact merchant keys conservatively and scopes by row kind", () => {
    const exact: CategorizationMemoryEntry = {
      ...memory[0]!,
      pattern: "Café Azul 12",
      matchKind: "merchant_exact",
      rowKind: "expense",
    };
    expect(matchMemory(ctx("MP * CAFE AZUL 12"), [exact])).not.toBeNull();
    expect(matchMemory(ctx("CAFE AZUL 13"), [exact])).toBeNull();
    expect(matchMemory(ctx("CAFE AZUL 12", { kind: "income" }), [exact])).toBeNull();
  });

  it("produces a human-readable explanation a power user can audit", () => {
    const explanation = describeMemory(
      {
        id: "m",
        householdId: "house-1",
        pattern: "IFOOD",
        categoryId: "cat-food",
        subcategoryId: "sub-delivery",
        confidence: 0.97,
        explanation: "",
        isActive: true,
      },
      CATALOG,
    );
    expect(explanation).toBe(
      'descrição contém "IFOOD" -> Alimentação > Delivery',
    );
  });
});

describe("suggestCategory engine", () => {
  it("terminates the cascade for an explicit suppression memory", async () => {
    let aiCalled = false;
    const result = await suggestCategory(ctx("IFOOD *LANCHE"), {
      catalog: CATALOG,
      memoryStore: {
        async findActiveByHousehold() {
          return [
            {
              id: "suppress",
              householdId: "house-1",
              pattern: "IFOOD *LANCHE",
              categoryId: null,
              subcategoryId: null,
              confidence: 1,
              explanation: "Sempre deixar sem categoria.",
              isActive: true,
              matchKind: "suppress",
              rowKind: "expense",
            },
          ];
        },
      },
      ai: {
        async categorize() {
          aiCalled = true;
          return null;
        },
      },
    });
    expect(result.status).toBe("uncategorized");
    expect(result.suppressed).toBe(true);
    expect(aiCalled).toBe(false);
  });
  it("memory match improves a suggestion over a bare rule match", async () => {
    const store: CategorizationMemoryStore = {
      async findActiveByHousehold() {
        return [
          {
            id: "mem-1",
            householdId: "house-1",
            pattern: "PADARIA DO ZE",
            categoryId: "cat-food",
            subcategoryId: "sub-market",
            confidence: 0.96,
            explanation:
              'descrição contém "PADARIA DO ZE" -> Alimentação > Mercado',
            isActive: true,
          },
        ];
      },
    };

    // Without memory: no deterministic rule matches "PADARIA DO ZE" -> pending/low.
    const withoutMemory = await suggestCategory(ctx("PADARIA DO ZE 123"), {
      catalog: CATALOG,
    });
    expect(withoutMemory.status).not.toBe("matched");

    // With memory: a prior correction now drives a confident match.
    const withMemory = await suggestCategory(ctx("PADARIA DO ZE 123"), {
      catalog: CATALOG,
      memoryStore: store,
    });
    expect(withMemory.status).toBe("matched");
    expect(withMemory.suggestion?.macroCategoryId).toBe("cat-food");
    expect(withMemory.suggestion?.subcategoryId).toBe("sub-market");
    expect(withMemory.suggestion?.confidence).toBeGreaterThan(
      withoutMemory.suggestion?.confidence ?? 0,
    );
    expect(withMemory.suggestion?.source).toBe("memory");
  });

  it("deterministic rule match yields a confident suggestion with explanation", async () => {
    const result = await suggestCategory(ctx("IFOOD *LANCHE"), {
      catalog: CATALOG,
    });
    expect(result.status).toBe("matched");
    expect(result.suggestion?.macroCategoryId).toBe("cat-food");
    expect(result.suggestion?.subcategoryId).toBe("sub-delivery");
    expect(result.suggestion?.source).toBe("rule");
    expect(result.suggestion?.explanation).toMatch(/IFOOD/i);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("low-confidence suggestion requests confirmation", async () => {
    const ai: AiCategorizer = {
      async categorize() {
        return {
          categoryName: "Alimentação",
          subcategoryName: null,
          confidence: CONFIDENCE.LOW, // deliberately low
          explanation: "Heurística de IA com baixa confiança.",
        };
      },
    };
    const result = await suggestCategory(ctx("transacao obscura 9981"), {
      catalog: CATALOG,
      ai,
    });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.suggestion?.source).toBe("ai");
    expect(result.suggestion?.confidence).toBeLessThan(CONFIDENCE.HIGH);
  });

  it("a novel description AI cannot map to an existing category stays PENDING (never auto-creates)", async () => {
    const ai: AiCategorizer = {
      async categorize() {
        return {
          // A brand-new macro category that does not exist in the catalog.
          categoryName: "Petshop Exótico",
          subcategoryName: "Iguanas",
          confidence: 0.95,
          explanation: "IA propôs uma nova categoria.",
        };
      },
    };
    const result = await suggestCategory(ctx("RACAO IGUANA EXOTICA LTDA"), {
      catalog: CATALOG,
      ai,
    });
    expect(result.status).toBe("pending_new_category");
    expect(result.requiresConfirmation).toBe(true);
    // The proposed (unresolved) name is surfaced for review, but no id exists.
    expect(result.pendingCategory?.categoryName).toBe("Petshop Exótico");
    expect(result.suggestion?.macroCategoryId).toBeUndefined();
  });

  it("surfaces an unknown subcategory under a real macro instead of silently dropping it", async () => {
    const result = await suggestCategory(ctx("restaurante peculiar"), {
      catalog: CATALOG,
      ai: {
        async categorize() {
          return {
            categoryName: "Alimentação",
            subcategoryName: "Restaurante temático",
            confidence: 0.8,
            explanation: "Subcategoria ainda não existe.",
          };
        },
      },
    });
    expect(result.status).toBe("pending_new_subcategory");
    expect(result.suggestion?.macroCategoryId).toBe("cat-food");
    expect(result.suggestion?.subcategoryId).toBeUndefined();
    expect(result.pendingCategory?.subcategoryName).toBe("Restaurante temático");
  });

  it("with no rule, memory, or AI, returns an uncategorized pending result needing confirmation", async () => {
    const result = await suggestCategory(ctx("algo totalmente desconhecido"), {
      catalog: CATALOG,
    });
    expect(result.status).toBe("uncategorized");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.suggestion).toBeNull();
  });

  it("AI match to an EXISTING category resolves to real ids (not pending)", async () => {
    const ai: AiCategorizer = {
      async categorize() {
        return {
          categoryName: "Transporte",
          subcategoryName: null,
          confidence: 0.9,
          explanation: "IA reconheceu transporte.",
        };
      },
    };
    const result = await suggestCategory(ctx("corrida aplicativo 99"), {
      catalog: CATALOG,
      ai,
    });
    expect(result.status).toBe("matched");
    expect(result.suggestion?.macroCategoryId).toBe("cat-transport");
    expect(result.suggestion?.source).toBe("ai");
  });
});
