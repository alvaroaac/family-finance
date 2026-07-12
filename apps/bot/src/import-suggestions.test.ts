import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createImportSuggestionHandler,
  type ImportSuggestionRequest,
} from "./import-suggestions.js";
import type { CodexProcessRunner } from "./codex.js";

function request(itemCount = 2): ImportSuggestionRequest {
  return {
    version: 2,
    requestId: "5d07fecd-dde8-4cb8-b0aa-fb8fdd259214",
    scopeKey: "10000000-0000-4000-8000-000000000001",
    budgetKey: "65309e17-b968-4b29-92c4-b12945479686",
    actorUserId: "a9bcdb2e-ad9a-4659-9ae8-bf8487f4522a",
    catalog: {
      categories: [{ id: "food", name: "Alimentação" }],
      subcategories: [{ id: "market", categoryId: "food", name: "Mercado" }],
    },
    items: Array.from({ length: itemCount }, (_, index) => ({
      key: `row-${index + 1}`,
      description: `GIASSI ${index + 1}`,
      amountCents: 1000 + index,
      occurredOn: "2026-07-10",
    })),
  };
}

function runnerWith(value: unknown): CodexProcessRunner {
  return async (run) => {
    await writeFile(run.outputPath, JSON.stringify(value), "utf8");
    return { exitCode: 0, timedOut: false, stderr: "" };
  };
}

describe("createImportSuggestionHandler", () => {
  function handler(
    overrides: Partial<
      Parameters<typeof createImportSuggestionHandler>[0]
    > = {},
  ) {
    return createImportSuggestionHandler({
      codexEnabled: true,
      codexModel: "gpt-test",
      codexTimeoutMs: 1000,
      codexHome: "/tmp/family-finance-codex-test",
      paidFallbackEnabled: false,
      paidFallbackMaxItems: 1,
      paidFallbackProvider: "anthropic",
      paidFallbackModel: "claude-test",
      reservePaidItems: vi.fn(async (input) => input.requestedItems),
      recordPaidResult: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it("returns ranked existing-category suggestions from Codex", async () => {
    const run = handler({
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: "market",
                confidence: 0.92,
                explanation: "Supermercado",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });

    const result = await run(request(1));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "success",
      items: [
        {
          key: "row-1",
          candidates: [{ categoryId: "food", provider: "codex" }],
        },
      ],
      unresolvedKeys: [],
    });
  });

  it("rejects model output that invents category ids", async () => {
    const run = handler({
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "invented",
                subcategoryId: null,
                confidence: 1,
                explanation: "Nope",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });

    const result = await run(request(1));
    expect(result.body).toMatchObject({
      outcome: "unavailable",
      unresolvedKeys: ["row-1"],
    });
  });

  it("keeps valid siblings when another Codex item is invalid", async () => {
    const run = handler({
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: null,
                confidence: 0.9,
                explanation: "ok",
              },
            ],
            proposedTaxonomyChange: null,
          },
          {
            key: "row-2",
            candidates: [
              {
                categoryId: "invented",
                subcategoryId: null,
                confidence: 0.9,
                explanation: "bad",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });
    const result = await run(request(2));
    expect(result.body).toMatchObject({
      outcome: "partial",
      items: [{ key: "row-1" }],
      unresolvedKeys: ["row-2"],
    });
  });

  it("reserves and sends only operationally missing items to paid fallback", async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: "market",
                confidence: 0.8,
                explanation: "Mercado",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    );
    const reservePaidItems = vi.fn(async () => 1);
    const recordPaidResult = vi.fn(async () => undefined);
    const run = handler({
      codexEnabled: false,
      paidFallbackEnabled: true,
      paidFallbackClient: { complete },
      reservePaidItems,
      recordPaidResult,
    });

    const result = await run(request(2));
    expect(reservePaidItems).toHaveBeenCalledWith(
      expect.objectContaining({ requestedItems: 1, previewMaxItems: 1 }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0]?.[0])).toContain('"key":"row-1"');
    expect(String(complete.mock.calls[0]?.[0])).not.toContain('"key":"row-2"');
    expect(result.body).toMatchObject({
      outcome: "partial",
      items: [
        {
          key: "row-1",
          candidates: [{ provider: "paid_fallback" }],
        },
      ],
      unresolvedKeys: ["row-2"],
    });
    expect(recordPaidResult).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-test",
        outcome: "success",
        resolvedItems: 1,
      }),
    );
  });

  it("does not spend paid quota on a deliberate Codex abstention", async () => {
    const reservePaidItems = vi.fn(async () => 1);
    const complete = vi.fn();
    const run = handler({
      paidFallbackEnabled: true,
      paidFallbackClient: { complete },
      reservePaidItems,
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });

    const result = await run(request(1));
    expect(result.body).toMatchObject({
      outcome: "unavailable",
      unresolvedKeys: ["row-1"],
    });
    expect(reservePaidItems).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back only for keys omitted from otherwise successful Codex output", async () => {
    const reservePaidItems = vi.fn(async (input) => input.requestedItems);
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          {
            key: "row-2",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: null,
                confidence: 0.8,
                explanation: "fallback",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    );
    const run = handler({
      paidFallbackEnabled: true,
      paidFallbackMaxItems: 10,
      paidFallbackClient: { complete },
      reservePaidItems,
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: null,
                confidence: 0.9,
                explanation: "codex",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });

    const result = await run(request(2));
    expect(reservePaidItems).toHaveBeenCalledWith(
      expect.objectContaining({ requestedItems: 1 }),
    );
    expect(String(complete.mock.calls[0]?.[0])).toContain('"key":"row-2"');
    expect(String(complete.mock.calls[0]?.[0])).not.toContain('"key":"row-1"');
    expect(result.body).toMatchObject({
      outcome: "success",
      unresolvedKeys: [],
    });
  });

  it("does not reserve paid quota when Codex resolves the batch", async () => {
    const reservePaidItems = vi.fn(async () => 1);
    const run = handler({
      paidFallbackEnabled: true,
      paidFallbackClient: { complete: vi.fn() },
      reservePaidItems,
      codexRunner: runnerWith({
        items: [
          {
            key: "row-1",
            candidates: [
              {
                categoryId: "food",
                subcategoryId: null,
                confidence: 0.9,
                explanation: "ok",
              },
            ],
            proposedTaxonomyChange: null,
          },
        ],
      }),
    });

    await run(request(1));
    expect(reservePaidItems).not.toHaveBeenCalled();
  });

  it("accepts legacy v1 requests during bot-first rolling deploys without paid fallback", async () => {
    const reservePaidItems = vi.fn(async () => 1);
    const complete = vi.fn();
    const run = handler({
      codexEnabled: false,
      paidFallbackEnabled: true,
      paidFallbackClient: { complete },
      reservePaidItems,
    });

    const current = request(1);
    const result = await run({
      version: 1,
      requestId: current.requestId,
      scopeKey: current.scopeKey,
      catalog: current.catalog,
      items: current.items,
      fallback: { haiku: true, maxPaidItems: 1 },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ version: 1, outcome: "unavailable" });
    expect(reservePaidItems).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
