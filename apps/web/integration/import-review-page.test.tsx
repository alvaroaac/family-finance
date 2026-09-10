// @vitest-environment jsdom
import { act } from "react";
import { readFileSync, writeFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportsPage from "../app/(app)/imports/page";
import { ToastProvider } from "../components/ui";
import type {
  ResolveImportTargetsResult,
  InstallmentCandidateMatch,
} from "../app/(app)/imports/actions";
import { reviewPreview, CARD } from "./import-review-fixtures";

const actions = vi.hoisted(() => ({
  preview: vi.fn(),
  resolve: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../app/(app)/imports/actions", () => ({
  previewImport: actions.preview,
  resolveImportTargets: actions.resolve,
  confirmImport: actions.confirm,
  suggestImportCategories: vi.fn(),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function match(id = "existing"): InstallmentCandidateMatch {
  return {
    installmentGroupId: id,
    creditCardId: CARD,
    cardName: "Cartão A",
    description: `Teclado ${id}`,
    totalAmountCents: 41000,
    purchasedOn: "2026-08-24",
    installmentNumber: 1,
    installmentCount: 10,
    amountCents: 4100,
    confidence: "strong",
    exactAmount: false,
    amountDifferenceCents: 99,
  };
}
function resolved(
  matches: InstallmentCandidateMatch[] = [match()],
  count = matches.length,
): ResolveImportTargetsResult {
  return {
    ok: true,
    duplicateIndices: [],
    claimIdsByIndex: {},
    groupDuplicateIndices: [],
    groupClaimIdsByIndex: {},
    groupMatchesByIndex: count ? { 0: matches } : {},
    groupMatchCountsByIndex: count ? { 0: count } : {},
    groupReviewRequiredIndices: count ? [0] : [],
    flatMatchesByIndex: {},
  };
}
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
async function selectCard(value = CARD) {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Cartão de destino"]',
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function preview() {
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
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(actions.preview).toHaveBeenCalledOnce();
}
beforeEach(() => {
  vi.clearAllMocks();
  actions.preview.mockResolvedValue(reviewPreview());
  actions.resolve.mockResolvedValue(resolved());
  actions.confirm.mockResolvedValue({
    ok: false,
    message: "Stopped at test persistence boundary",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("import comparison decisions", () => {
  it("requires explicit replacement confirmation and clears it after changing the card", async () => {
    const response = resolved([]);
    if (!response.ok) throw new Error("fixture");
    response.groupReviewRequiredIndices = [0];
    response.flatMatchesByIndex = {
      0: [
        {
          transactionId: "flat",
          updatedAt: "2026-08-16T12:00:00Z",
          description: "MARKETPLACE LOJA 1",
          amountCents: 41990,
          occurredOn: "2026-08-16",
          instrumentName: "Conta da casa",
          differentInstrument: true,
          confidence: "strong",
          categoryId: null,
          subcategoryId: null,
        },
      ],
    };
    actions.resolve.mockResolvedValue(response);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    await preview();
    await selectCard();
    expect(container.textContent).toContain("pagamento diferente");
    if (process.env.REPLACEMENT_UI_ARTIFACT) {
      const css =
        readFileSync("app/globals.css", "utf8") +
        readFileSync("components/ui/ui.css", "utf8");
      writeFileSync(
        process.env.REPLACEMENT_UI_ARTIFACT,
        `<!doctype html><html lang="pt-BR" data-theme="salvia" style="--ff-font-body:system-ui;--ff-font-display:Georgia"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><main style="max-width:1200px;margin:auto;padding:24px">${container.innerHTML}</main></body></html>`,
      );
    }
    await click("Substituir por parcelamento");
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
    await click("Substituir por parcelamento");
    expect(confirm).toHaveBeenCalledTimes(2);
    await click("Gravar");
    expect(actions.confirm.mock.calls[0]![0].groups[0]).toMatchObject({
      replaceTransaction: { id: "flat", updatedAt: "2026-08-16T12:00:00Z" },
      purchasedOn: "2026-08-16",
    });
    actions.confirm.mockClear();
    await selectCard("other-card");
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Substituição selecionada");
  });
  it("blocks confirmation while resolution is pending, then requires a decision", async () => {
    const pending = deferred<ResolveImportTargetsResult>();
    actions.resolve.mockReturnValue(pending.promise);
    await preview();
    await selectCard();
    expect(button("Gravar").disabled).toBe(true);
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
    await act(async () => pending.resolve(resolved()));
    expect(button("Gravar").disabled).toBe(false);
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "escolha manter ou importar mesmo assim",
    );
  });
  it.each([false, true])(
    "keeps confirmation blocked after lookup failure (rejection=%s) and supports retry",
    async (reject) => {
      if (reject) actions.resolve.mockRejectedValueOnce(new Error("network"));
      else
        actions.resolve.mockResolvedValueOnce({
          ok: false,
          message: "Consulta indisponível",
        });
      await preview();
      await selectCard();
      expect(button("Gravar").disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      await click("Tentar comparações novamente");
      expect(button("Gravar").disabled).toBe(false);
    },
  );
  it("omits a kept existing purchase while submitting another selected item", async () => {
    await preview();
    await selectCard();
    await click("Manter o existente");
    await click("Gravar");
    expect(actions.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ groups: [], selectedIndices: [1] }),
    );
  });
  it("forwards a valid reason and includes the explicitly imported purchase", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(" São compras diferentes ");
    await preview();
    await selectCard();
    await click("Importar mesmo assim");
    await click("Gravar");
    expect(actions.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [
          expect.objectContaining({
            sourceGroupIndex: 0,
            override: { reason: "São compras diferentes" },
          }),
        ],
      }),
    );
  });
  it.each([null, "abc"])(
    "does not authorize importing after a cancelled/short reason: %s",
    async (reason) => {
      vi.spyOn(window, "prompt").mockReturnValue(reason);
      await preview();
      await selectCard();
      await click("Importar mesmo assim");
      await click("Gravar");
      expect(actions.confirm).not.toHaveBeenCalled();
    },
  );
  it("ignores stale destination results and requires a new decision after remapping", async () => {
    const stale = deferred<ResolveImportTargetsResult>();
    const current = deferred<ResolveImportTargetsResult>();
    actions.resolve
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await preview();
    await selectCard();
    await selectCard("other-card");
    await act(async () => stale.resolve(resolved([], 0)));
    expect(button("Gravar").disabled).toBe(true);
    await act(async () => current.resolve(resolved()));
    await click("Manter o existente");
    await selectCard();
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
  });
  it("replaces bounded candidate pages without discarding the user's decision", async () => {
    actions.resolve.mockResolvedValueOnce(
      resolved(
        Array.from({ length: 5 }, (_, i) => match(String(i))),
        12,
      ),
    );
    actions.resolve.mockResolvedValueOnce(
      resolved(
        Array.from({ length: 5 }, (_, i) => match(String(i + 5))),
        12,
      ),
    );
    await preview();
    await selectCard();
    await click("Manter o existente");
    await click("Próximas");
    expect(actions.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ matchPage: { groupIndex: 0, offset: 5 } }),
    );
    expect(container.querySelectorAll(".ff-group-match")).toHaveLength(5);
    expect(container.textContent).toContain("6–10 de 12");
    expect(container.textContent).not.toContain("Teclado 0");
    await click("Gravar");
    expect(actions.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ groups: [] }),
    );
  });
  it("offers explicit decisions for a legacy purchase without same-month candidates", async () => {
    actions.resolve.mockResolvedValue({
      ...resolved([], 0),
      groupReviewRequiredIndices: [0],
    });
    vi.spyOn(window, "prompt").mockReturnValue("São compras diferentes");
    await preview();
    await selectCard();
    await click("Gravar");
    expect(actions.confirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain("mesma descrição");
    await click("Importar mesmo assim");
    await click("Gravar");
    expect(actions.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [
          expect.objectContaining({
            override: { reason: "São compras diferentes" },
          }),
        ],
      }),
    );
  });
  it("ignores a stale pagination response after the destination changes", async () => {
    const pending = deferred<ResolveImportTargetsResult>();
    actions.resolve.mockResolvedValueOnce(
      resolved(
        Array.from({ length: 5 }, (_, i) => match(String(i))),
        12,
      ),
    );
    actions.resolve.mockReturnValueOnce(pending.promise);
    actions.resolve.mockResolvedValueOnce(resolved([match("new-card")]));
    await preview();
    await selectCard();
    await click("Próximas");
    await selectCard("other-card");
    await act(async () => pending.resolve(resolved([match("stale-page")], 12)));
    expect(container.textContent).toContain("Teclado new-card");
    expect(container.textContent).not.toContain("stale-page");
  });
});
