// @vitest-environment jsdom
import { act } from "react";
import { planCategorizationBatch } from "@family-finance/categorization";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import ImportsPage from "../app/(app)/imports/page";
import { ToastProvider } from "../components/ui";
import { reviewPreview } from "./import-review-fixtures";
const actions = vi.hoisted(() => ({
  preview: vi.fn(),
  suggest: vi.fn(),
  resolve: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../app/(app)/imports/actions", () => ({
  previewImport: actions.preview,
  suggestImportCategories: actions.suggest,
  resolveImportTargets: actions.resolve,
  confirmImport: actions.confirm,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("Jev import suggestions", () => {
  it("shows Jev provenance and waits for explicit acceptance", async () => {
    const fixture = reviewPreview();
    fixture.categories = [{ id: "food", name: "Alimentação" }];
    fixture.categorizationPlan = planCategorizationBatch(
      fixture.snapshot.rows.map((row, i) => ({
        rowKey: `row-${i}`,
        householdId: "home",
        description: row.description,
        kind: row.kind,
      })),
      {
        catalog: {
          householdId: "home",
          categories: fixture.categories,
          subcategories: [],
        },
      },
    );
    actions.preview.mockResolvedValue(fixture);
    actions.suggest.mockResolvedValue({
      ok: true,
      suggestions: [
        {
          rowKey: "row-1",
          categoryId: "food",
          confidence: 0.96,
          explanation: "Mercado",
          provider: "jev",
        },
      ],
      proposals: [],
      unresolvedCount: 0,
      providerRuns: [],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ToastProvider>
            <ImportsPage />
          </ToastProvider>,
        ),
      );
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      const suggest = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Sugerir categorias"),
      )!;
      await act(async () => suggest.click());
      const accept = [...container.querySelectorAll("button")].find(
        (b) =>
          b.textContent?.includes("usar Alimentação") &&
          b.textContent.includes("Jev"),
      );
      expect(accept).toBeDefined();
      expect(actions.confirm).not.toHaveBeenCalled();
      await act(async () => accept!.click());
      expect(
        [...container.querySelectorAll("button")].some(
          (b) =>
            b.textContent?.includes("usar Alimentação") &&
            b.textContent.includes("Jev"),
        ),
      ).toBe(false);
      expect(actions.confirm).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.clearAllMocks();
    }
  });
});
