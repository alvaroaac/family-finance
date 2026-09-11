// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ImportsPage from "../app/(app)/imports/page";
import { ToastProvider } from "../components/ui/toast";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  resolve: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../app/(app)/imports/actions", () => ({
  previewImport: mocks.preview,
  resolveImportTargets: mocks.resolve,
  confirmImport: mocks.confirm,
  suggestImportCategories: vi.fn(),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const match = {
  installmentGroupId: "group-1",
  updatedAt: "2026-09-11T00:00:00Z",
  creditCardId: "card-1",
  cardName: "Nubank",
  description: "Utensílios da cozinha",
  totalAmountCents: 15100,
  purchasedOn: "2026-08-01",
  installmentNumber: 2,
  installmentCount: 2,
  amountCents: 7550,
  confidence: "very_strong",
  exactAmount: true,
  amountDifferenceCents: 0,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue({
    ok: true,
    requestKey: "preview",
    snapshot: {},
    preview: { source: "nubank-ofx", rows: [], errors: [], duplicates: [] },
    categorizationPlan: { rows: [], aiItems: [] },
    priorDispositions: {},
    accounts: [],
    categories: [],
    subcategories: [],
    creditCards: [{ id: "card-1", name: "Nubank" }],
    mp: {
      groups: [
        {
          description: "Milium Loja",
          estimatedTotalCents: 15100,
          installmentCount: 2,
          installmentNumber: 2,
          perInstallmentCents: 7550,
          purchasedOn: "2026-08-01",
        },
      ],
      dbDuplicateIndices: [],
      installmentRowIndices: [],
    },
  });
  mocks.resolve.mockResolvedValue({
    ok: true,
    duplicateIndices: [],
    claimIdsByIndex: {},
    groupReviewRequiredIndices: [0],
    groupMatchCountsByIndex: { 0: 1 },
    flatMatchesByIndex: {},
    groupDuplicateIndices: [0],
    groupClaimIdsByIndex: {},
    groupMatchesByIndex: { 0: [match] },
  });
  mocks.confirm.mockResolvedValue({
    ok: true,
    message: "Importação confirmada",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function openPreview() {
  await act(async () =>
    root.render(
      <ToastProvider>
        <ImportsPage />
      </ToastProvider>,
    ),
  );
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await act(async () => {
    const card = container.querySelector<HTMLSelectElement>(
      '[aria-label="Cartão de destino"]',
    )!;
    card.value = "card-1";
    card.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
it("prefills the divergent label and confirms a link even when every detected group was initially skipped", async () => {
  await openPreview();
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Descrição da compra Milium Loja"]',
    )!.value,
  ).toBe("Utensílios da cozinha");
  expect(container.textContent).toContain("Nome no banco: Milium Loja");
  await act(async () => button("Manter o existente").click());
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  expect(button("Gravar importação").disabled).toBe(false);
  await act(async () => button("Gravar importação").click());
  expect(mocks.confirm.mock.calls[0]![0].groups).toEqual([
    expect.objectContaining({
      description: "Milium Loja",
      purchaseDescription: "Utensílios da cozinha",
      existingGroupId: "group-1",
      existingGroupUpdatedAt: "2026-09-11T00:00:00Z",
    }),
  ]);
});
it("does not repeat the bank name when the existing description only differs in case or spacing", async () => {
  mocks.resolve.mockResolvedValue({
    ...(await mocks.resolve()),
    groupMatchesByIndex: { 0: [{ ...match, description: "  MILIUM   LOJA " }] },
  });
  await openPreview();
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Descrição da compra Milium Loja"]',
    )!.value,
  ).toBe("");
});
it("requires choosing one candidate when two purchases match", async () => {
  mocks.resolve.mockResolvedValue({
    ...(await mocks.resolve()),
    groupMatchesByIndex: {
      0: [
        match,
        { ...match, installmentGroupId: "group-2", description: "Ferramentas" },
      ],
    },
  });
  await openPreview();
  expect(button("Manter o existente").disabled).toBe(true);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        '[aria-label="Selecionar Ferramentas para Milium Loja"]',
      )!
      .click(),
  );
  await act(async () => button("Manter o existente").click());
  await act(async () => button("Gravar importação").click());
  expect(mocks.confirm.mock.calls[0]![0].groups[0]).toMatchObject({
    existingGroupId: "group-2",
    purchaseDescription: "Ferramentas",
  });
});
