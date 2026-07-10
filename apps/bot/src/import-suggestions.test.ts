import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createImportSuggestionHandler,
  type ImportSuggestionRequest,
} from "./import-suggestions.js";
import type { CodexProcessRunner } from "./codex.js";

function request(itemCount = 2): ImportSuggestionRequest {
  return {
    version: 1,
    requestId: "5d07fecd-dde8-4cb8-b0aa-fb8fdd259214",
    scopeKey: "household-1",
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
    fallback: { haiku: true, maxPaidItems: 1 },
  };
}

function runnerWith(value: unknown): CodexProcessRunner {
  return async (run) => {
    await writeFile(run.outputPath, JSON.stringify(value), "utf8");
    return { exitCode: 0, timedOut: false, stderr: "" };
  };
}

describe("createImportSuggestionHandler", () => {
  it("returns ranked existing-category suggestions from Codex", async () => {
    const handler = createImportSuggestionHandler({
      codexEnabled: true,
      codexModel: "gpt-test",
      codexTimeoutMs: 1000,
      codexHome: "/tmp/family-finance-codex-test",
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

    const result = await handler(request(1));
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
    const handler = createImportSuggestionHandler({
      codexEnabled: true,
      codexModel: "gpt-test",
      codexTimeoutMs: 1000,
      codexHome: "/tmp/family-finance-codex-test",
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

    const result = await handler(request(1));
    expect(result.body).toMatchObject({
      outcome: "unavailable",
      unresolvedKeys: ["row-1"],
    });
  });

  it("keeps valid siblings when another Codex item is invalid", async () => {
    const handler = createImportSuggestionHandler({
      codexEnabled: true,
      codexModel: "gpt-test",
      codexTimeoutMs: 1000,
      codexHome: "/tmp/family-finance-codex-test",
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
    const result = await handler(request(2));
    expect(result.body).toMatchObject({
      outcome: "partial",
      items: [{ key: "row-1" }],
      unresolvedKeys: ["row-2"],
    });
  });

  it("sends only capped unresolved items to Haiku", async () => {
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
    const handler = createImportSuggestionHandler({
      codexEnabled: false,
      codexModel: "unused",
      codexTimeoutMs: 1000,
      codexHome: "/tmp/family-finance-codex-test",
      haikuClient: { complete },
    });

    const result = await handler(request(2));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0]?.[0])).toContain('"key":"row-1"');
    expect(String(complete.mock.calls[0]?.[0])).not.toContain('"key":"row-2"');
    expect(result.body).toMatchObject({
      outcome: "partial",
      unresolvedKeys: ["row-2"],
    });
  });
});
