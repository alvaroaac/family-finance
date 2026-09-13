// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ImportsPage from "../app/(app)/imports/page";
import { ToastProvider } from "../components/ui";

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

let container: HTMLDivElement;
let root: Root;

function row(sourceLine: number, description: string, cents: number) {
  return {
    sourceLine,
    description,
    occurredOn: `2026-08-${String(sourceLine + 9).padStart(2, "0")}`,
    amount: { cents, currency: "BRL" },
    kind: "expense",
  };
}
const ROWS = [
  row(1, "IFOOD *RESTAURANTE", 4500),
  row(2, "IFOOD *RESTAURANTE", 3200),
  row(3, "UBER TRIP", 1800),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  mocks.preview.mockResolvedValue({
    ok: true,
    requestKey: "preview",
    previewToken: "token",
    fileFingerprint: "fp-1",
    normalizedFingerprint: "nfp-1",
    parserVersion: "1",
    snapshot: {},
    preview: { source: "nubank-ofx", rows: ROWS, errors: [], duplicates: [] },
    categorizationPlan: {
      rows: ROWS.map(() => ({ status: "unresolved", candidates: [] })),
      aiItems: [],
    },
    priorDispositions: {},
    accounts: [{ id: "acc-1", name: "Conta corrente" }],
    categories: [
      { id: "food", name: "Alimentação" },
      { id: "transport", name: "Transporte" },
    ],
    subcategories: [{ id: "delivery", categoryId: "food", name: "Delivery" }],
    creditCards: [],
  });
  mocks.resolve.mockResolvedValue({
    ok: true,
    duplicateIndices: [],
    claimIdsByIndex: {},
    groupDuplicateIndices: [],
    groupClaimIdsByIndex: {},
    groupMatchesByIndex: {},
    groupMatchCountsByIndex: {},
    groupReviewRequiredIndices: [],
    flatMatchesByIndex: {},
  });
  mocks.confirm.mockResolvedValue({ ok: false, message: "stop at boundary" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(text),
  );
  if (!result) throw new Error(`Button missing: ${text}`);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function clickLabel(label: string) {
  await act(async () =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click(),
  );
}
async function select(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function selectValue(label: string): string | undefined {
  return container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )?.value;
}
function dialogText(): string {
  return container.querySelector("dialog[open]")?.textContent ?? "";
}
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
}
async function chooseAccount() {
  await select("Conta de destino", "acc-1");
}
function groupLabels(): string[] {
  return [...container.querySelectorAll(".ff-preview__label")].map(
    (el) => el.textContent ?? "",
  );
}

it("groups rows by merchant and applies the group category to every row", async () => {
  await openPreview();
  await chooseAccount();
  expect(groupLabels()).toEqual(["IFOOD *RESTAURANTE", "UBER TRIP"]);
  expect(container.textContent).toContain("2 lançamentos");

  await select("Categoria do grupo IFOOD *RESTAURANTE", "food");
  await select("Subcategoria do grupo IFOOD *RESTAURANTE", "delivery");
  await select("Categoria do grupo UBER TRIP", "transport");
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Lembrar IFOOD *RESTAURANTE"]',
    )!.checked,
  ).toBe(true);
  await clickLabel("Lembrar UBER TRIP");

  await click("Gravar 3 lançamentos");
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "acc-1",
      selectedIndices: [0, 1, 2],
      mapping: {
        0: { categoryId: "food", subcategoryId: "delivery" },
        1: { categoryId: "food", subcategoryId: "delivery" },
        2: { categoryId: "transport", subcategoryId: undefined },
      },
      learning: {
        0: { merchant: true },
        1: { merchant: true },
        2: { merchant: false },
      },
    }),
  );
});

it("lets one row leave the group and shows the group as mixed", async () => {
  await openPreview();
  await chooseAccount();
  await select("Categoria do grupo IFOOD *RESTAURANTE", "food");
  await clickLabel("Ver lançamentos de IFOOD *RESTAURANTE");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((el) => el.textContent?.includes("mudar só esta"))!
      .click();
  });
  await select("Categoria linha 1", "transport");
  expect(selectValue("Categoria do grupo IFOOD *RESTAURANTE")).toBe("food");
  expect(selectValue("Categoria linha 1")).toBe("transport");

  await select("Categoria do grupo IFOOD *RESTAURANTE", "transport");
  expect(selectValue("Categoria linha 1")).toBe("transport");
  await click("segue o grupo");
  expect(selectValue("Categoria linha 1")).toBeUndefined();
  await select("Categoria do grupo UBER TRIP", "transport");
  await click("Gravar 3 lançamentos");
  expect(mocks.confirm.mock.calls[0]![0].mapping).toEqual({
    0: { categoryId: "transport", subcategoryId: undefined },
    1: { categoryId: "transport", subcategoryId: undefined },
    2: { categoryId: "transport", subcategoryId: undefined },
  });
});

it("keeps Gravar enabled and explains what is missing in a dialog", async () => {
  await openPreview();
  const gravar = button("Gravar 3 lançamentos");
  expect(gravar.disabled).toBe(false);
  expect(container.textContent).toContain("2 pendências antes de gravar");
  await click("Gravar 3 lançamentos");
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(dialogText()).toContain("Ainda não dá pra gravar");
  expect(dialogText()).toContain("Falta 1 coisa antes de gravar");
  expect(dialogText()).toContain("Conta ou cartão de destino não escolhido");
  expect(dialogText()).toContain("Lançamentos sem categoria");
  expect(dialogText()).toContain("IFOOD *RESTAURANTE ×2");
  await click("Escolher");
  expect(container.querySelector("dialog[open]")).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Conta de destino",
  );

  await chooseAccount();
  expect(container.textContent).toContain("1 pendência antes de gravar");
  await click("Gravar 3 lançamentos");
  expect(dialogText()).toContain("Gravar sem categoria?");
  expect(dialogText()).toContain("3 lançamentos vão entrar sem categoria");
  await click("Gravar mesmo assim");
  expect(mocks.confirm).toHaveBeenCalledOnce();
});

it("filters groups by pending category and by search", async () => {
  await openPreview();
  await chooseAccount();
  await select("Categoria do grupo UBER TRIP", "transport");
  await click("Sem categoria");
  expect(groupLabels()).toEqual(["IFOOD *RESTAURANTE"]);
  await click("Todos");
  await act(async () => {
    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Buscar estabelecimento"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(search, "uber");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(groupLabels()).toEqual(["UBER TRIP"]);
});

it("saves a draft on 'Continuar depois' and restores it for the same file", async () => {
  await openPreview();
  await chooseAccount();
  await select("Categoria do grupo UBER TRIP", "transport");
  await clickLabel("Importar estabelecimento IFOOD *RESTAURANTE");
  await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
  expect(container.textContent).toContain("Rascunho salvo às");
  await click("Continuar depois");
  expect(container.querySelector('[data-testid="preview-list"]')).toBeNull();
  expect(window.localStorage.getItem("ff-import-draft:fp-1")).not.toBeNull();

  await openPreview();
  expect(selectValue("Categoria do grupo UBER TRIP")).toBe("transport");
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Importar estabelecimento IFOOD *RESTAURANTE"]',
    )!.checked,
  ).toBe(false);
  expect(container.textContent).toContain("Rascunho salvo às");
  mocks.confirm.mockResolvedValue({ ok: true, message: "ok" });
  await chooseAccount();
  await click("Gravar 1 lançamento");
  expect(window.localStorage.getItem("ff-import-draft:fp-1")).toBeNull();
});
