// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NewObligationDialog,
  summarize,
} from "../app/(app)/obligations/new-obligation-dialog.js";

import { ToastProvider } from "../components/ui";

type DialogProps = ComponentProps<typeof NewObligationDialog>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** `formatBrlCents` uses pt-BR currency formatting: R$ + NBSP + digits. */
const NBSP = "\u00a0";

const baseProps: DialogProps = {
  accounts: [
    { id: "account-itau", name: "Conta Itaú" },
    { id: "account-nubank", name: "Conta Nubank" },
  ],
  categories: [{ id: "category-moradia", name: "Moradia" }],
  currentMonth: "2026-10",
  monthTotals: { "2026-10": 1499666 },
  action: async () => ({ ok: true }),
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
          <NewObligationDialog {...initialProps} {...props} />
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
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
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

async function fillTheWholeForm(container: HTMLElement): Promise<void> {
  await fill(getInput(container, "description"), "Placas solares");
  await fill(getInput(container, "amount"), "710,44");
  await fill(getSelect(container, "startMonth"), "2026-10");
  await fill(getInput(container, "dueDay"), "5");
  await click(buttonWithText(container, "Parcelado"));
  await fill(getInput(container, "termMonths"), "72");
  await fill(getSelect(container, "accountId"), "account-itau");
  await fill(getSelect(container, "categoryId"), "category-moradia");
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    getForm(container).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("summarize", () => {
  const parcelado = {
    description: "Placas solares",
    amountCents: 71044,
    startMonth: "2026-10",
    dueDay: 5,
    termMode: "installments" as const,
    termMonths: 72,
    accountName: "Conta Itaú",
  };

  it("builds the parcelado sentence with the term range", () => {
    expect(summarize(parcelado, {}).main).toBe(
      `Placas solares — R$${NBSP}710,44 por mês, 72 vezes, de out/2026 a set/2032. Vence dia 5, sai da Conta Itaú.`,
    );
  });

  it("builds the sem-prazo variant", () => {
    const main = summarize(
      { ...parcelado, termMode: "indefinite", termMonths: null },
      {},
    ).main;
    expect(main).toBe(
      `Placas solares — R$${NBSP}710,44 por mês, todo mês a partir de out/2026. Vence dia 5, sai da Conta Itaú.`,
    );
  });

  it("adds the new amount to the month's projected total", () => {
    expect(summarize(parcelado, { "2026-10": 1499666 }).impact).toBe(
      `A partir de outubro de 2026, o mês da casa passa a R$${NBSP}15.707,10.`,
    );
  });

  it("has no impact line for a start month outside the window", () => {
    expect(summarize(parcelado, { "2026-11": 1499666 }).impact).toBeNull();
  });

  it("stays quiet until the essentials are filled in", () => {
    expect(summarize({ ...parcelado, description: "  " }, {}).main).toBeNull();
    expect(summarize({ ...parcelado, amountCents: null }, {}).main).toBeNull();
    expect(summarize({ ...parcelado, termMonths: null }, {}).main).toBeNull();
  });
});

describe("NewObligationDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installDialogPolyfill();
  });

  it("lists the months from currentMonth − 3 to currentMonth + 12", async () => {
    const harness = createHarness();
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));

    const options = [...getSelect(harness.container, "startMonth").options];
    expect(options).toHaveLength(16);
    expect(options[0]?.value).toBe("2026-07");
    expect(options[0]?.textContent).toBe("julho de 2026");
    expect(options[15]?.value).toBe("2027-10");
    expect(options[15]?.textContent).toBe("outubro de 2027");
    expect(getSelect(harness.container, "startMonth").value).toBe("2026-10");

    harness.unmount();
  });

  it("shows the term badge on Parcelado and hides it on Sem prazo", async () => {
    const harness = createHarness();
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fill(getInput(harness.container, "amount"), "710,44");

    expect(harness.container.querySelector(".ff-badge")).toBeNull();

    await click(buttonWithText(harness.container, "Parcelado"));
    await fill(getInput(harness.container, "termMonths"), "72");

    expect(harness.container.querySelector(".ff-badge")?.textContent).toBe(
      `até set/2032 · total R$${NBSP}51.151,68`,
    );

    await click(buttonWithText(harness.container, "Sem prazo"));

    expect(harness.container.querySelector(".ff-badge")).toBeNull();
    expect(
      harness.container.querySelector('input[name="termMonths"]'),
    ).toBeNull();

    harness.unmount();
  });

  it("posts termMode and termMonths and keeps a failed submit open", async () => {
    const posted: FormData[] = [];
    const action = vi.fn(async (formData: FormData) => {
      posted.push(formData);
      return { ok: false, error: "Conta de pagamento inválida." };
    });
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fillTheWholeForm(harness.container);
    await submit(harness.container);

    expect(action).toHaveBeenCalledOnce();
    const data = posted[0];
    expect(data?.get("description")).toBe("Placas solares");
    expect(data?.get("amount")).toBe("710,44");
    expect(data?.get("startMonth")).toBe("2026-10");
    expect(data?.get("dueDay")).toBe("5");
    expect(data?.get("termMode")).toBe("installments");
    expect(data?.get("termMonths")).toBe("72");
    expect(data?.get("accountId")).toBe("account-itau");
    expect(data?.get("categoryId")).toBe("category-moradia");

    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Conta de pagamento inválida.",
    );
    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Conta de pagamento inválida.",
    );
    expect(getDialog(harness.container).open).toBe(true);
    expect(getInput(harness.container, "description").value).toBe(
      "Placas solares",
    );

    harness.unmount();
  });

  it("omits termMonths when the obligation has no term", async () => {
    const posted: FormData[] = [];
    const action = vi.fn(async (formData: FormData) => {
      posted.push(formData);
      return { ok: true };
    });
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fill(getInput(harness.container, "description"), "Aluguel");
    await fill(getInput(harness.container, "amount"), "710,44");
    await fill(getInput(harness.container, "dueDay"), "5");
    await submit(harness.container);

    const data = posted[0];
    expect(data?.get("termMode")).toBe("indefinite");
    expect(data?.get("termMonths")).toBeNull();

    harness.unmount();
  });

  it("toasts, resets and closes after a successful create", async () => {
    const harness = createHarness();
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fillTheWholeForm(harness.container);
    await submit(harness.container);

    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Obrigação criada.",
    );
    expect(getDialog(harness.container).open).toBe(false);

    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    expect(getInput(harness.container, "description").value).toBe("");
    expect(getInput(harness.container, "amount").value).toBe("");
    expect(
      harness.container.querySelector('input[name="termMonths"]'),
    ).toBeNull();
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();

    harness.unmount();
  });

  it("refuses an unparseable amount before calling the action", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fill(getInput(harness.container, "description"), "Aluguel");
    await fill(getInput(harness.container, "amount"), "abc");
    await fill(getInput(harness.container, "dueDay"), "5");
    await submit(harness.container);

    expect(action).not.toHaveBeenCalled();
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Não entendi o valor — use algo como "710,44".',
    );
    expect(getDialog(harness.container).open).toBe(true);

    harness.unmount();
  });

  it("shows the live summary once the essentials are filled in", async () => {
    const harness = createHarness();
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fillTheWholeForm(harness.container);

    const summary = harness.container.querySelector(".ff-oblig-summary");
    expect(summary?.textContent).toContain(
      `Placas solares — R$${NBSP}710,44 por mês, 72 vezes, de out/2026 a set/2032.`,
    );
    expect(summary?.textContent).toContain(
      `A partir de outubro de 2026, o mês da casa passa a R$${NBSP}15.707,10.`,
    );

    harness.unmount();
  });

  it("wraps the trigger in the mobile sticky bar when asked", async () => {
    const harness = createHarness();
    await harness.render({ trigger: "sticky" });

    const sticky = harness.container.querySelector(".ff-sticky-cta");
    expect(sticky?.querySelector("button")?.textContent).toBe(
      "+ Nova obrigação",
    );

    await harness.render({ trigger: "header" });
    expect(harness.container.querySelector(".ff-sticky-cta")).toBeNull();

    harness.unmount();
  });

  it("disables the submit while the action is in flight", async () => {
    let finish: (result: { ok: boolean }) => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(buttonWithText(harness.container, "+ Nova obrigação"));
    await fillTheWholeForm(harness.container);
    await submit(harness.container);

    const button = harness.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Criando…");

    await act(async () => {
      finish({ ok: true });
    });

    harness.unmount();
  });
});
