// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ObligationPaymentDialog } from "../app/(app)/obligations/payment-dialog.js";

import { ToastProvider } from "../components/ui";

type DialogProps = ComponentProps<typeof ObligationPaymentDialog>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps: DialogProps = {
  obligationId: "obligation-1",
  month: "2026-07",
  description: "Aluguel",
  projectedAmountCents: 124780,
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

function setupAnimationFrame(): void {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
  window.cancelAnimationFrame = () => undefined;
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
          <ObligationPaymentDialog {...initialProps} {...props} />
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

function getOpenButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === "Marcar como paga",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Open button not found");
  }
  return button;
}

function getCancelButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Cancelar",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Cancel button not found");
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

function getAmountInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[name="amount"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Amount input not found");
  }
  return input;
}

function getSurface(container: HTMLElement): HTMLFormElement {
  const surface = container.querySelector(".ff-dialog__surface");
  if (!(surface instanceof HTMLFormElement)) {
    throw new Error("Dialog surface not found");
  }
  return surface;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ObligationPaymentDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setupAnimationFrame();
    installDialogPolyfill();
  });

  it("shows a failed action inline and in a toast, preserving input until close", async () => {
    const action = vi.fn(async () => ({
      ok: false,
      error: "Valor pago inválido.",
    }));
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(getOpenButton(harness.container));
    getAmountInput(harness.container).value = "999,99";
    await act(async () => {
      getSurface(harness.container).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(action).toHaveBeenCalledOnce();
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Valor pago inválido.",
    );
    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Valor pago inválido.",
    );
    expect(getDialog(harness.container).open).toBe(true);
    expect(getAmountInput(harness.container).value).toBe("999,99");
    await click(getCancelButton(harness.container));
    await click(getOpenButton(harness.container));
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
    expect(getAmountInput(harness.container).value).toBe("1247,80");
    harness.unmount();
  });

  it("disables submit while pending, then toasts and closes on success", async () => {
    let finish: (result: { ok: boolean }) => void = () => undefined;
    const action = vi.fn((data: FormData) => {
      expect(data.get("obligationId")).toBe("obligation-1");
      expect(data.get("month")).toBe("2026-07");
      expect(data.get("amount")).toBe("999,99");
      return new Promise<{ ok: boolean }>((resolve) => {
        finish = resolve;
      });
    });
    const harness = createHarness({ ...baseProps, action });
    await harness.render();
    await click(getOpenButton(harness.container));
    getAmountInput(harness.container).value = "999,99";
    await act(async () => {
      getSurface(harness.container).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const submit = harness.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toBe("Registrando…");
    await act(async () => {
      finish({ ok: true });
    });
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toBe("Confirmar pagamento");
    // Closing resets the form, so the projected amount is back for next time.
    expect(getAmountInput(harness.container).value).toBe("1247,80");
    expect(getDialog(harness.container).open).toBe(false);
    expect(document.querySelector(".ff-toast__message")?.textContent).toBe(
      "Pagamento registrado.",
    );
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
    harness.unmount();
  });

  it("opens with showModal, prefilled projected amount and selected amount input", async () => {
    const harness = createHarness();
    await harness.render();

    await click(getOpenButton(harness.container));

    const dialog = getDialog(harness.container);
    const amountInput = getAmountInput(harness.container);
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(amountInput.value).toBe("1247,80");
    expect(amountInput.selectionStart).toBe(0);
    expect(amountInput.selectionEnd).toBe("1247,80".length);

    harness.unmount();
  });

  it("closes from the cancel button", async () => {
    const harness = createHarness();
    await harness.render();

    await click(getOpenButton(harness.container));
    await click(getCancelButton(harness.container));

    const dialog = getDialog(harness.container);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);

    harness.unmount();
  });

  it("closes on backdrop click but not when clicking inside the dialog surface", async () => {
    const harness = createHarness();
    await harness.render();

    await click(getOpenButton(harness.container));
    await click(getSurface(harness.container));

    const dialog = getDialog(harness.container);
    expect(dialog.close).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    await click(dialog);

    expect(dialog.close).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);

    harness.unmount();
  });

  it("resets typed amount on close/reopen and updates for a different obligation", async () => {
    const harness = createHarness();
    await harness.render();

    await click(getOpenButton(harness.container));
    const amountInput = getAmountInput(harness.container);
    amountInput.value = "999,99";

    await click(getCancelButton(harness.container));
    await click(getOpenButton(harness.container));

    expect(getAmountInput(harness.container).value).toBe("1247,80");

    await click(getCancelButton(harness.container));
    await harness.render({
      obligationId: "obligation-2",
      description: "Energia",
      projectedAmountCents: 71044,
    });
    await click(getOpenButton(harness.container));

    expect(getAmountInput(harness.container).value).toBe("710,44");

    harness.unmount();
  });
});
