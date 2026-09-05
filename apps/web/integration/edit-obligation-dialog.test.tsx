// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditObligationDialog } from "../app/(app)/obligations/edit-obligation-dialog.js";
import type { ObligationListItem } from "../app/(app)/obligations/queries.js";
import { termProgress } from "../app/(app)/obligations/view-model.js";

import { parseReaisToCents } from "../lib/format.js";

import { ToastProvider } from "../components/ui";

type DialogProps = ComponentProps<typeof EditObligationDialog>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** `formatBrlCents` uses pt-BR currency formatting: R$ + NBSP + digits. */
const NBSP = "\u00a0";

const CURRENT_MONTH = "2026-08";

/** Kicks from the Editar mockup: parcela 12 of 48, set/2025 → ago/2029. */
const kicks: ObligationListItem = {
  id: "obligation-kicks",
  householdId: "household-1",
  description: "Kicks",
  amountCents: 238000,
  startMonth: "2025-09",
  termMonths: 48,
  dueDay: 15,
  categoryId: "category-carro",
  subcategoryId: null,
  responsibilityScope: "household",
  responsibleUserId: null,
  accountId: "account-nubank",
  status: "active",
  createdByUserId: "user-1",
  endMonth: "2029-08",
  remainingMonths: 37,
};

const baseProps: DialogProps = {
  item: kicks,
  progress: termProgress(kicks, CURRENT_MONTH),
  currentMonth: CURRENT_MONTH,
  accounts: [
    { id: "account-itau", name: "Conta Itaú" },
    { id: "account-nubank", name: "Conta Nubank" },
  ],
  categories: [
    { id: "category-carro", name: "Carro" },
    { id: "category-moradia", name: "Moradia" },
  ],
  updateAction: async () => ({ ok: true }),
  cancelAction: async () => ({ ok: true }),
};

function installDialogPolyfill(): void {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });

  HTMLDialogElement.prototype.close = vi.fn(function close(
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
}

function createHarness(initialProps: DialogProps = baseProps): {
  container: HTMLDivElement;
  render: (props?: Partial<DialogProps>) => Promise<void>;
  unmount: () => void;
} {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  async function render(props: Partial<DialogProps> = {}): Promise<void> {
    await act(async () => {
      root.render(
        <ToastProvider>
          <EditObligationDialog {...initialProps} {...props} />
        </ToastProvider>,
      );
    });
  }

  return {
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonWithText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function buttonWithLabel(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function getDialog(container: HTMLElement): HTMLDialogElement {
  const dialog = container.querySelector("dialog");
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error("Dialog not found");
  }
  return dialog;
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector(".ff-dialog__surface");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Dialog form not found");
  }
  return form;
}

function getInput(container: HTMLElement, name: string): HTMLInputElement {
  const input = container.querySelector(`input[name="${name}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${name}`);
  }
  return input;
}

function getSelect(container: HTMLElement, name: string): HTMLSelectElement {
  const select = container.querySelector(`select[name="${name}"]`);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Select not found: ${name}`);
  }
  return select;
}

function textOf(container: HTMLElement, selector: string): string {
  return container.querySelector(selector)?.textContent ?? "";
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Drive a controlled React field through its native value setter. */
async function fill(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  await act(async () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    getForm(container).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

async function openDialog(harness: {
  container: HTMLDivElement;
  render: (props?: Partial<DialogProps>) => Promise<void>;
}): Promise<void> {
  await harness.render();
  await click(buttonWithLabel(harness.container, "Editar Kicks"));
}

describe("EditObligationDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installDialogPolyfill();
  });

  it("opens from a pencil labelled with the obligation", async () => {
    const harness = createHarness();
    await harness.render();

    const trigger = buttonWithLabel(harness.container, "Editar Kicks");
    expect(trigger.className).toContain("ff-iconbtn");
    expect(getDialog(harness.container).open).toBe(false);

    await click(trigger);
    expect(getDialog(harness.container).open).toBe(true);
    harness.unmount();
  });

  it("gives Nome initial focus", async () => {
    const harness = createHarness();
    await openDialog(harness);
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    expect(document.activeElement).toBe(
      getInput(harness.container, "description"),
    );
    harness.unmount();
  });

  it("re-seeds the amount from refreshed props on reopen", async () => {
    const harness = createHarness();
    await openDialog(harness);
    await fill(getInput(harness.container, "amount"), "2.999,00");
    await click(buttonWithLabel(harness.container, "Fechar"));
    const item = { ...kicks, amountCents: 248050 };
    await harness.render({ item, progress: termProgress(item, CURRENT_MONTH) });
    await click(buttonWithLabel(harness.container, "Editar Kicks"));
    expect(getInput(harness.container, "amount").value).toBe("2.480,50");
    harness.unmount();
  });

  it("round-trips the pre-filled amount with a thousands separator", async () => {
    expect(parseReaisToCents("2.380,00")).toBe(238000);
    const posted: FormData[] = [];
    const harness = createHarness({
      ...baseProps,
      updateAction: async (data) => {
        posted.push(data);
        return { ok: true };
      },
    });
    await openDialog(harness);
    await submit(harness.container);
    expect(posted[0]?.get("amount")).toBe("2.380,00");
    expect(parseReaisToCents(String(posted[0]?.get("amount")))).toBe(238000);
    harness.unmount();
  });

  it("renders the progress sentence for a running term", async () => {
    const harness = createHarness();
    await openDialog(harness);

    const panel = textOf(harness.container, ".ff-oblig-progress");
    expect(panel).toContain(
      "Parcela 12 de 48 · começou em set/2025 · termina em ago/2029",
    );
    expect(panel).toContain(`faltam R$${NBSP}88.060,00`);
    expect(panel).toContain(
      "Prazo e primeiro mês não mudam — pra isso, encerre esta e crie outra.",
    );
    expect(harness.container.querySelector(".ff-track__fill")).not.toBeNull();
    harness.unmount();
  });

  it("renders the Sem prazo variant without a track", async () => {
    const harness = createHarness({
      ...baseProps,
      item: { ...kicks, termMonths: null, endMonth: null },
      progress: { kind: "indefinite" },
    });
    await harness.render();
    await click(buttonWithLabel(harness.container, "Editar Kicks"));

    expect(textOf(harness.container, ".ff-oblig-progress")).toContain(
      "Sem prazo · desde set/2025",
    );
    expect(harness.container.querySelector(".ff-track")).toBeNull();
    harness.unmount();
  });

  it("renders the Começa em variant for a future term", async () => {
    const harness = createHarness({
      ...baseProps,
      item: { ...kicks, startMonth: "2026-11" },
      progress: { kind: "future", startMonth: "2026-11", termMonths: 48 },
    });
    await harness.render();
    await click(buttonWithLabel(harness.container, "Editar Kicks"));

    expect(textOf(harness.container, ".ff-oblig-progress")).toContain(
      "Começa em nov/2026",
    );
    harness.unmount();
  });

  it("pre-fills the editable fields from the obligation", async () => {
    const harness = createHarness();
    await openDialog(harness);

    expect(getInput(harness.container, "description").value).toBe("Kicks");
    expect(getInput(harness.container, "amount").value).toBe("2.380,00");
    expect(getInput(harness.container, "dueDay").value).toBe("15");
    expect(getSelect(harness.container, "accountId").value).toBe(
      "account-nubank",
    );
    expect(getSelect(harness.container, "categoryId").value).toBe(
      "category-carro",
    );
    expect(getInput(harness.container, "obligationId").value).toBe(
      "obligation-kicks",
    );
    expect(
      harness.container.querySelector('input[name="termMonths"]'),
    ).toBeNull();
    expect(
      harness.container.querySelector('input[name="startMonth"]'),
    ).toBeNull();
    harness.unmount();
  });

  it("calls updateAction with the five editable fields plus the id", async () => {
    const posted: FormData[] = [];
    const updateAction = vi.fn(async (formData: FormData) => {
      posted.push(formData);
      return { ok: true };
    });
    const harness = createHarness({ ...baseProps, updateAction });
    await openDialog(harness);

    await fill(getInput(harness.container, "description"), "Kicks 2020");
    await fill(getInput(harness.container, "amount"), "2.480,50");
    await fill(getInput(harness.container, "dueDay"), "20");
    await fill(getSelect(harness.container, "accountId"), "account-itau");
    await fill(getSelect(harness.container, "categoryId"), "category-moradia");
    await submit(harness.container);

    expect(updateAction).toHaveBeenCalledOnce();
    const data = posted[0];
    expect(data?.get("obligationId")).toBe("obligation-kicks");
    expect(data?.get("description")).toBe("Kicks 2020");
    expect(data?.get("amount")).toBe("2.480,50");
    expect(data?.get("dueDay")).toBe("20");
    expect(data?.get("accountId")).toBe("account-itau");
    expect(data?.get("categoryId")).toBe("category-moradia");

    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Obrigação atualizada.",
    );
    expect(getDialog(harness.container).open).toBe(false);
    harness.unmount();
  });

  it("posts an empty categoryId when the category is cleared", async () => {
    const posted: FormData[] = [];
    const updateAction = vi.fn(async (formData: FormData) => {
      posted.push(formData);
      return { ok: true };
    });
    const harness = createHarness({ ...baseProps, updateAction });
    await openDialog(harness);

    await fill(getSelect(harness.container, "categoryId"), "");
    await submit(harness.container);

    expect(posted[0]?.get("categoryId")).toBe("");
    harness.unmount();
  });

  it("keeps a failed save open with a role=alert complaint", async () => {
    const updateAction = vi.fn(async () => ({
      ok: false,
      error: "Conta de pagamento inválida.",
    }));
    const harness = createHarness({ ...baseProps, updateAction });
    await openDialog(harness);
    await submit(harness.container);

    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Conta de pagamento inválida.",
    );
    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Conta de pagamento inválida.",
    );
    expect(getDialog(harness.container).open).toBe(true);
    harness.unmount();
  });

  it.each([
    ["description", "", "O nome não pode ficar vazio."],
    ["amount", "abc", 'Não entendi o valor — use algo como "710,44".'],
    ["dueDay", "29", "Escolha o dia do vencimento, de 1 a 28."],
    ["accountId", "", "Escolha a conta de onde a obrigação sai."],
  ])(
    "shows pt-BR feedback for %s=%s on submit click",
    async (name, value, message) => {
      const updateAction = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({ ...baseProps, updateAction });
      await openDialog(harness);
      await fill(
        name === "accountId"
          ? getSelect(harness.container, name)
          : getInput(harness.container, name),
        value,
      );

      // A real submit click exercises constraint validation before onSubmit.
      await click(buttonWithText(harness.container, "Salvar alterações"));

      expect(updateAction).not.toHaveBeenCalled();
      expect(
        harness.container.querySelector('[role="alert"]')?.textContent,
      ).toBe(message);
      expect(getForm(harness.container).noValidate).toBe(true);
      harness.unmount();
    },
  );

  it("disables encerrar and shows Salvando… while the save is in flight", async () => {
    let finish: (result: { ok: boolean }) => void = () => undefined;
    const updateAction = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = createHarness({ ...baseProps, updateAction });
    await openDialog(harness);
    await submit(harness.container);

    const button = harness.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Salvando…");
    expect(buttonWithText(harness.container, "Encerrar…").disabled).toBe(true);

    await act(async () => {
      finish({ ok: true });
    });
    harness.unmount();
  });

  it("disables save and confirm controls while encerrar is in flight", async () => {
    let finish: (result: { ok: boolean }) => void = () => undefined;
    const cancelAction = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = createHarness({ ...baseProps, cancelAction });
    await openDialog(harness);
    await click(buttonWithText(harness.container, "Encerrar…"));
    await click(buttonWithText(harness.container, "Sim, encerrar"));
    for (const label of [
      "Salvar alterações",
      "Encerrar…",
      "Deixa pra lá",
      "Encerrando…",
    ]) {
      expect(buttonWithText(harness.container, label).disabled).toBe(true);
    }
    await act(async () => {
      finish({ ok: true });
    });
    harness.unmount();
  });

  it("reveals the encerrar confirm, hides it again, and encerra", async () => {
    const posted: FormData[] = [];
    const cancelAction = vi.fn(async (formData: FormData) => {
      posted.push(formData);
      return { ok: true };
    });
    const harness = createHarness({ ...baseProps, cancelAction });
    await openDialog(harness);

    expect(
      harness.container.querySelector(".ff-danger-zone__confirm"),
    ).toBeNull();

    const toggle = buttonWithText(harness.container, "Encerrar…");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(harness.container, ".ff-danger-zone__confirm")).toContain(
      "Encerrar Kicks? A partir de setembro, esta obrigação sai dos próximos meses. As 12 parcelas pagas continuam nas transações.",
    );

    await click(buttonWithText(harness.container, "Deixa pra lá"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      harness.container.querySelector(".ff-danger-zone__confirm"),
    ).toBeNull();
    expect(cancelAction).not.toHaveBeenCalled();

    await click(buttonWithText(harness.container, "Encerrar…"));
    await click(buttonWithText(harness.container, "Sim, encerrar"));

    expect(cancelAction).toHaveBeenCalledOnce();
    expect(posted[0]?.get("obligationId")).toBe("obligation-kicks");
    expect([...(posted[0] ?? new FormData()).keys()]).toEqual(["obligationId"]);
    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Obrigação encerrada.",
    );
    expect(getDialog(harness.container).open).toBe(false);
    harness.unmount();
  });

  it("keeps the dialog open when encerrar is refused", async () => {
    const cancelAction = vi.fn(async () => ({
      ok: false,
      error: "Obrigação já encerrada.",
    }));
    const harness = createHarness({ ...baseProps, cancelAction });
    await openDialog(harness);
    await click(buttonWithText(harness.container, "Encerrar…"));
    await click(buttonWithText(harness.container, "Sim, encerrar"));

    expect(
      harness.container.querySelector('.ff-danger-zone [role="alert"]')
        ?.textContent,
    ).toBe("Obrigação já encerrada.");
    expect(getDialog(harness.container).open).toBe(true);
    harness.unmount();
  });

  it("resets edits and the confirm row when the dialog closes", async () => {
    const harness = createHarness();
    await openDialog(harness);
    await fill(getInput(harness.container, "description"), "Outro nome");
    await click(buttonWithText(harness.container, "Encerrar…"));
    await click(buttonWithText(harness.container, "Cancelar"));

    expect(getDialog(harness.container).open).toBe(false);
    await click(buttonWithLabel(harness.container, "Editar Kicks"));
    expect(getInput(harness.container, "description").value).toBe("Kicks");
    expect(
      harness.container.querySelector(".ff-danger-zone__confirm"),
    ).toBeNull();
    harness.unmount();
  });
});
