import { describe, expect, it } from "vitest";

import {
  AI_BATCH_SCHEMA_VERSION,
  MAX_AI_ITEMS_PER_CHUNK,
  aiBatchRequestSchema,
  applyAiBatchReply,
  chunkAiSuggestionItems,
  normalizeMerchantKey,
  normalizeSourceCategoryLabel,
  parseAiBatchReply,
  planCategorizationBatch,
  suggestionCandidatesSchema,
  type BatchCategorizationRow,
  type CategoryCatalog,
  type CategorizationMemoryEntry,
  type SourceCategoryMapping,
} from "./index.js";

const CATALOG: CategoryCatalog = {
  householdId: "house-1",
  categories: [
    { id: "cat-food", name: "Alimentação" },
    { id: "cat-transport", name: "Transporte" },
  ],
  subcategories: [
    { id: "sub-delivery", categoryId: "cat-food", name: "Delivery" },
  ],
};

function row(
  rowKey: string,
  description: string,
  overrides: Partial<BatchCategorizationRow> = {},
): BatchCategorizationRow {
  return {
    rowKey,
    householdId: "house-1",
    description,
    kind: "expense",
    source: "minhas-financas",
    ...overrides,
  };
}

describe("merchant normalization", () => {
  it("folds Unicode/case/spacing and removes only known processor/order noise", () => {
    expect(normalizeMerchantKey("  MP * Café  São João 12  ")).toBe(
      "CAFE SAO JOAO 12",
    );
    expect(normalizeMerchantKey("Café São João 12 PEDIDO ID AB12345")).toBe(
      "CAFE SAO JOAO 12",
    );
    expect(normalizeSourceCategoryLabel("  Alimentação antiga ")).toBe(
      "ALIMENTACAO ANTIGA",
    );
  });

  it("preserves unlabelled numbers to avoid branch collisions", () => {
    expect(normalizeMerchantKey("LOJA 12")).not.toBe(
      normalizeMerchantKey("LOJA 13"),
    );
  });
});

describe("deterministic batch planning", () => {
  const exactMemory: CategorizationMemoryEntry = {
    id: "mem-1",
    householdId: "house-1",
    pattern: "Padaria Azul",
    categoryId: "cat-food",
    subcategoryId: null,
    confidence: 0.97,
    explanation: "Correção confirmada.",
    isActive: true,
    matchKind: "merchant_exact",
    rowKind: "expense",
  };
  const sourceMapping: SourceCategoryMapping = {
    id: "map-1",
    householdId: "house-1",
    source: "minhas-financas",
    sourceLabel: "Comida antiga",
    rowKind: "expense",
    categoryId: "cat-transport",
    isActive: true,
  };

  it("applies user > exact memory > source mapping > rule precedence", () => {
    const plan = planCategorizationBatch(
      [
        row("user", "Padaria Azul", {
          sourceCategory: "Comida antiga",
          explicitChoice: { categoryId: "cat-transport" },
        }),
        row("memory", "padaria azul", { sourceCategory: "Comida antiga" }),
        row("mapping", "Sem merchant conhecido", {
          sourceCategory: "comida ANTIGA",
        }),
        row("rule", "IFOOD *TESTE"),
      ],
      { catalog: CATALOG, memoryEntries: [exactMemory], sourceMappings: [sourceMapping] },
    );
    expect(plan.rows.map((item) => item.selection?.source)).toEqual([
      "user",
      "memory",
      "source_mapping",
      "rule",
    ]);
    expect(plan.aiItems).toHaveLength(0);
  });

  it("scopes memory and source mappings by row kind", () => {
    const plan = planCategorizationBatch(
      [
        row("income", "Padaria Azul", {
          kind: "income",
          sourceCategory: "Comida antiga",
        }),
      ],
      { catalog: CATALOG, memoryEntries: [exactMemory], sourceMappings: [sourceMapping] },
    );
    expect(plan.rows[0]?.status).toBe("unresolved");
    expect(plan.aiItems).toHaveLength(0);
  });

  it("treats suppression as terminal and never emits AI work", () => {
    const suppression: CategorizationMemoryEntry = {
      ...exactMemory,
      id: "suppress",
      categoryId: null,
      matchKind: "suppress",
    };
    const plan = planCategorizationBatch([row("r1", "Padaria Azul")], {
      catalog: CATALOG,
      memoryEntries: [suppression],
    });
    expect(plan.rows[0]?.status).toBe("suppressed");
    expect(plan.aiItems).toHaveLength(0);
  });

  it("groups 100 repeated unresolved merchants into one AI signature", () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row(`r-${index}`, `MP * Café Azul PEDIDO ID ABCDE${index % 10}`),
    );
    const plan = planCategorizationBatch(rows, { catalog: CATALOG });
    expect(plan.aiItems).toHaveLength(1);
    expect(new Set(plan.rows.map((item) => item.aiRequestKey)).size).toBe(1);
  });

  it("caps AI signatures at 50 and chunks at at most 25", () => {
    const rows = Array.from({ length: 70 }, (_, index) =>
      row(`r-${index}`, `MERCHANT ${index}`),
    );
    const plan = planCategorizationBatch(rows, { catalog: CATALOG });
    expect(plan.aiItems).toHaveLength(50);
    const chunks = chunkAiSuggestionItems(plan.aiItems);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_AI_ITEMS_PER_CHUNK)).toBe(true);
    expect(() => chunkAiSuggestionItems(plan.aiItems, 26)).toThrow();
  });
});

describe("strict bounded AI batch contracts", () => {
  it("accepts a bounded request and rejects extra keys/oversized chunks", () => {
    const item = {
      requestKey: "key-1",
      merchantKey: "CAFE AZUL",
      description: "Cafe Azul",
    };
    expect(
      aiBatchRequestSchema.safeParse({
        schemaVersion: AI_BATCH_SCHEMA_VERSION,
        items: [item],
        catalog: {
          categories: CATALOG.categories,
          subcategories: CATALOG.subcategories,
        },
      }).success,
    ).toBe(true);
    expect(
      aiBatchRequestSchema.safeParse({
        schemaVersion: AI_BATCH_SCHEMA_VERSION,
        items: [{ ...item, injected: true }],
        catalog: {
          categories: CATALOG.categories,
          subcategories: CATALOG.subcategories,
        },
      }).success,
    ).toBe(false);
    expect(
      aiBatchRequestSchema.safeParse({
        schemaVersion: AI_BATCH_SCHEMA_VERSION,
        items: Array.from({ length: 26 }, (_, index) => ({ ...item, requestKey: `k-${index}` })),
        catalog: {
          categories: CATALOG.categories,
          subcategories: CATALOG.subcategories,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps valid siblings when one reply item is malformed", () => {
    const parsed = parseAiBatchReply(
      {
        schemaVersion: AI_BATCH_SCHEMA_VERSION,
        items: [
          {
            requestKey: "key-1",
            status: "suggestion",
            categoryId: "cat-food",
            confidence: 0.7,
            explanation: "Parece alimentação.",
          },
          {
            requestKey: "key-2",
            status: "suggestion",
            categoryId: "cat-food",
            confidence: 99,
            explanation: "invalid",
          },
        ],
      },
      ["key-1", "key-2"],
    );
    expect(parsed.valid.map((item) => item.requestKey)).toEqual(["key-1"]);
    expect(parsed.invalidRequestKeys).toContain("key-2");
    expect(parsed.missingRequestKeys).toContain("key-2");
  });

  it("fans a valid grouped AI result back, requires review, and rejects foreign IDs", () => {
    const plan = planCategorizationBatch(
      [row("one", "Cafe Azul"), row("two", "Cafe Azul")],
      { catalog: CATALOG },
    );
    const requestKey = plan.aiItems[0]!.requestKey;
    const applied = applyAiBatchReply(
      plan,
      parseAiBatchReply(
        {
          schemaVersion: AI_BATCH_SCHEMA_VERSION,
          items: [
            {
              requestKey,
              status: "suggestion",
              categoryId: "cat-food",
              subcategoryId: "sub-delivery",
              confidence: 1,
              explanation: "Sugestão do modelo.",
            },
          ],
        },
        [requestKey],
      ),
      "codex",
      CATALOG,
      { modelVersion: "gpt-test", promptVersion: "prompt-v1" },
    );
    expect(applied.plan.rows.every((item) => item.selection?.source === "codex")).toBe(true);
    expect(applied.plan.rows.every((item) => item.candidates[0]?.requiresReview)).toBe(true);
    expect(suggestionCandidatesSchema.safeParse(applied.plan.rows[0]?.candidates).success).toBe(true);

    const invalid = applyAiBatchReply(
      plan,
      parseAiBatchReply(
        {
          schemaVersion: AI_BATCH_SCHEMA_VERSION,
          items: [
            {
              requestKey,
              status: "suggestion",
              categoryId: "foreign-category",
              confidence: 0.9,
              explanation: "Nope.",
            },
          ],
        },
        [requestKey],
      ),
      "haiku",
      CATALOG,
      { modelVersion: "haiku-test", promptVersion: "prompt-v1" },
    );
    expect(invalid.plan.rows[0]?.status).toBe("unresolved");
    expect(invalid.rejectedRequestKeys).toContain(requestKey);
  });

  it("surfaces novel taxonomy proposals without selecting a category", () => {
    const plan = planCategorizationBatch([row("one", "Iguana Shop")], {
      catalog: CATALOG,
    });
    const requestKey = plan.aiItems[0]!.requestKey;
    const applied = applyAiBatchReply(
      plan,
      parseAiBatchReply(
        {
          schemaVersion: AI_BATCH_SCHEMA_VERSION,
          items: [
            {
              requestKey,
              status: "proposal",
              categoryName: "Pets exóticos",
              subcategoryName: "Iguanas",
              confidence: 0.9,
              explanation: "Categoria ainda não existe.",
            },
          ],
        },
        [requestKey],
      ),
      "codex",
      CATALOG,
      { modelVersion: "gpt-test", promptVersion: "prompt-v1" },
    );
    expect(applied.plan.rows[0]?.selection).toBeNull();
    expect(applied.proposals).toHaveLength(1);
  });
});
