// @vitest-environment jsdom

/**
 * FormData parity for "Novo lançamento": written against the form before the
 * field set moved into `TransactionFields`, so it proves the extraction (and
 * the restyle) posts exactly the same keys and values to
 * `createManualTransactionAction`.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewTransactionForm } from "../app/(app)/transactions/new-transaction-form.js";
import { ToastProvider } from "../components/ui";

const action = vi.hoisted(() => ({
  calls: [] as Array<Array<[string, string]>>,
}));

vi.mock("../app/(app)/transactions/actions.js", () => ({
  createManualTransactionAction: vi.fn(async (formData: FormData) => {
    action.calls.push(
      [...formData.entries()].map(([key, value]) => [key, String(value)]),
    );
    return { ok: true };
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  accounts: [{ id: "acct-1", name: "Conta Corrente" }],
  cards: [{ id: "card-1", name: "Cartão Roxo" }],
  categories: [
    { id: "cat-1", name: "Alimentação", kind: "expense" as const },
    { id: "cat-2", name: "Renda", kind: "income" as const },
  ],
  subcategories: [{ id: "sub-1", categoryId: "cat-1", name: "Mercado" }],
  responsibles: [
    { value: "household", label: "Casa" },
    { value: "member-1", label: "Membro" },
  ],
  initiallyOpen: true,
};

let container: HTMLDivElement;
let unmount: () => void;

beforeEach(async () => {
  action.calls = [];
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <NewTransactionForm {...props} />
      </ToastProvider>,
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
});

afterEach(() => unmount());

function byName<T extends HTMLInputElement | HTMLSelectElement>(
  name: string,
): T {
  const element = container.querySelector(`[name="${name}"]`);
  if (element === null) throw new Error(`Field not found: ${name}`);
  return element as T;
}

async function fill(name: string, value: string): Promise<void> {
  const element = byName(name);
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

async function clickButton(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function chooseIncome(): Promise<void> {
  const tipo = container.querySelector('select[aria-label="Tipo"]');
  if (tipo instanceof HTMLSelectElement) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set?.call(tipo, "income");
      tipo.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return;
  }
  await clickButton("Receita");
}

describe("NewTransactionForm FormData parity", () => {
  it("posts a parcelado card expense with every field", async () => {
    await fill("amount", "120,00");
    await fill("description", "Feira do mês");
    await fill("occurredOn", "2026-10-05");
    await fill("categoryId", "cat-1");
    await fill("subcategoryId", "sub-1");
    await fill("payment", "card:card-1");
    await fill("purchaseMode", "parcelado");
    await fill("installmentCount", "3");
    await fill("responsible", "member-1");
    await clickButton("Salvar lançamento");

    expect(action.calls).toEqual([
      [
        ["kind", "expense"],
        ["amount", "120,00"],
        ["description", "Feira do mês"],
        ["occurredOn", "2026-10-05"],
        ["categoryId", "cat-1"],
        ["subcategoryId", "sub-1"],
        ["payment", "card:card-1"],
        ["purchaseMode", "parcelado"],
        ["installmentCount", "3"],
        ["responsible", "member-1"],
      ],
    ]);
  });

  it("posts an account expense with the defaults", async () => {
    await fill("amount", "56,13");
    await fill("description", "Padaria");
    await fill("occurredOn", "2026-10-06");
    await clickButton("Salvar lançamento");

    expect(action.calls).toEqual([
      [
        ["kind", "expense"],
        ["amount", "56,13"],
        ["description", "Padaria"],
        ["occurredOn", "2026-10-06"],
        ["categoryId", ""],
        ["subcategoryId", ""],
        ["payment", "account:acct-1"],
        ["purchaseMode", "avista"],
        ["installmentCount", "2"],
        ["responsible", "household"],
      ],
    ]);
  });

  it("posts income à vista on the first account after leaving a parcelado card", async () => {
    await fill("payment", "card:card-1");
    await fill("purchaseMode", "parcelado");
    await chooseIncome();
    await fill("amount", "3000");
    await fill("description", "Salário");
    await fill("occurredOn", "2026-10-07");
    await fill("categoryId", "cat-2");
    await clickButton("Salvar lançamento");

    expect(action.calls).toEqual([
      [
        ["kind", "income"],
        ["amount", "3000"],
        ["description", "Salário"],
        ["occurredOn", "2026-10-07"],
        ["categoryId", "cat-2"],
        ["subcategoryId", ""],
        ["payment", "account:acct-1"],
        ["purchaseMode", "avista"],
        ["installmentCount", "2"],
        ["responsible", "household"],
      ],
    ]);
  });

  it("keeps the pt-BR pre-check and does not post an invalid amount", async () => {
    await fill("description", "Padaria");
    await clickButton("Salvar lançamento");

    expect(action.calls).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Não entendi o valor — use algo como "56,13".',
    );
  });
});
