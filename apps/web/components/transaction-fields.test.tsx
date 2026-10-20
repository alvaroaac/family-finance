// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TransactionFields,
  emptyTransactionFieldValues,
  toTransactionFormData,
  validateTransactionFields,
  type TransactionFieldKey,
  type TransactionFieldOptions,
  type TransactionFieldValues,
} from "./transaction-fields";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const options: TransactionFieldOptions = {
  accounts: [{ id: "acct-1", name: "Conta Corrente" }],
  cards: [{ id: "card-1", name: "Cartão Roxo" }],
  categories: [
    { id: "cat-1", name: "Alimentação", kind: "expense" },
    { id: "cat-2", name: "Lazer", kind: "expense" },
    { id: "cat-3", name: "Renda", kind: "income" },
  ],
  subcategories: [{ id: "sub-1", categoryId: "cat-1", name: "Mercado" }],
  responsibles: [
    { value: "household", label: "Casa" },
    { value: "member-1", label: "Membro" },
  ],
};

const base: TransactionFieldValues = emptyTransactionFieldValues(
  options,
  "2026-10-20",
);

type Props = ComponentProps<typeof TransactionFields>;

let container: HTMLDivElement;
let root: Root;
let changes: Array<[TransactionFieldKey, unknown]>;

beforeEach(() => {
  changes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  values: Partial<TransactionFieldValues> = {},
  props: Partial<Omit<Props, "values" | "onChange" | "options">> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <TransactionFields
        values={{ ...base, ...values }}
        onChange={(key, value) => changes.push([key, value])}
        options={options}
        {...props}
      />,
    );
  });
}

function field(name: string): HTMLInputElement | HTMLSelectElement | null {
  return container.querySelector(`[name="${name}"]`);
}

function labelFor(name: string): HTMLLabelElement {
  const control = field(name);
  const label = control && container.querySelector(`label[for="${control.id}"]`);
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error(`Label not found for ${name}`);
  }
  return label;
}

function optionValues(name: string): string[] {
  return [...(field(name) as HTMLSelectElement).options].map((o) => o.value);
}

async function select(name: string, value: string): Promise<void> {
  const element = field(name) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function clickRadio(text: string): Promise<void> {
  const radio = [...container.querySelectorAll('[role="radio"]')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(radio instanceof HTMLElement)) throw new Error(`Radio ${text}`);
  await act(async () => {
    radio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("toTransactionFormData", () => {
  it("posts the exact keys and values of Novo lançamento", () => {
    const formData = toTransactionFormData({
      kind: "expense",
      amount: "120,00",
      description: "Feira do mês",
      occurredOn: "2026-10-05",
      categoryId: "cat-1",
      subcategoryId: "sub-1",
      payment: "card:card-1",
      purchaseMode: "parcelado",
      installmentCount: 3,
      responsible: "member-1",
    });

    expect([...formData.entries()]).toEqual([
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
    ]);
  });

  it("posts à vista for anything that is not a card expense", () => {
    const account = toTransactionFormData({
      ...base,
      payment: "account:acct-1",
      purchaseMode: "parcelado",
    });
    const income = toTransactionFormData({
      ...base,
      kind: "income",
      payment: "card:card-1",
      purchaseMode: "parcelado",
    });

    expect(account.get("purchaseMode")).toBe("avista");
    expect(income.get("purchaseMode")).toBe("avista");
  });
});

describe("emptyTransactionFieldValues", () => {
  it("starts an expense on the first account, owned by the household", () => {
    expect(base).toEqual({
      kind: "expense",
      amount: "",
      description: "",
      occurredOn: "2026-10-20",
      categoryId: "",
      subcategoryId: "",
      payment: "account:acct-1",
      purchaseMode: "avista",
      installmentCount: 2,
      responsible: "household",
    });
  });

  it("falls back to the first card, then to no payment", () => {
    expect(
      emptyTransactionFieldValues({ ...options, accounts: [] }, "2026-10-20")
        .payment,
    ).toBe("card:card-1");
    expect(
      emptyTransactionFieldValues(
        { ...options, accounts: [], cards: [] },
        "2026-10-20",
      ).payment,
    ).toBe("");
  });
});

describe("validateTransactionFields", () => {
  const valid = { ...base, amount: "56,13", description: "Padaria" };

  it("accepts a complete draft", () => {
    expect(validateTransactionFields(valid)).toBeNull();
  });

  it("returns today's pt-BR pre-check messages", () => {
    expect(validateTransactionFields({ ...valid, amount: "abc" })).toBe(
      'Não entendi o valor — use algo como "56,13".',
    );
    expect(validateTransactionFields({ ...valid, amount: "0" })).toBe(
      'Não entendi o valor — use algo como "56,13".',
    );
    expect(validateTransactionFields({ ...valid, description: "  " })).toBe(
      "A descrição não pode ficar vazia.",
    );
    expect(validateTransactionFields({ ...valid, payment: "" })).toBe(
      "Escolha a conta ou o cartão do lançamento.",
    );
    expect(
      validateTransactionFields({
        ...valid,
        payment: "card:card-1",
        purchaseMode: "parcelado",
        installmentCount: 1,
      }),
    ).toBe("Informe pelo menos 2 parcelas.");
  });
});

describe("TransactionFields", () => {
  it("lays the fields out in the design order with the design labels", async () => {
    await render();

    const labels = [...container.querySelectorAll("label")].map(
      (label) => label.firstChild?.textContent,
    );
    expect(labels).toEqual([
      "Valor",
      "Data",
      "Descrição",
      "Conta / cartão",
      "Quem",
      "Categoria",
    ]);
    expect(container.textContent).toContain("Detalhes");
    expect(container.textContent).toContain("R$");
    expect(field("amount")?.getAttribute("inputmode")).toBe("decimal");
    expect(field("description")?.getAttribute("placeholder")).toBe(
      "Ex.: Mercado Guanabara",
    );
    expect((field("categoryId") as HTMLSelectElement).options[0]?.text).toBe(
      "Escolha…",
    );
  });

  it("shows Despesa/Receita as a segmented control", async () => {
    await render();
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")]))
      .toEqual([
        ["Despesa", "true"],
        ["Receita", "false"],
      ]);
  });

  it("switching to Receita drops the expense category and the card", async () => {
    await render({
      categoryId: "cat-1",
      subcategoryId: "sub-1",
      payment: "card:card-1",
      purchaseMode: "parcelado",
    });
    await clickRadio("Receita");

    expect(changes).toEqual([
      ["kind", "income"],
      ["categoryId", ""],
      ["subcategoryId", ""],
      ["payment", "account:acct-1"],
      ["purchaseMode", "avista"],
    ]);
  });

  it("for income, lists only income categories and no cards", async () => {
    await render({ kind: "income" });

    expect(optionValues("categoryId")).toEqual(["", "cat-3"]);
    expect(optionValues("payment")).toEqual(["", "account:acct-1"]);
  });

  it("for an expense, lists expense categories, accounts and cards", async () => {
    await render();

    expect(optionValues("categoryId")).toEqual(["", "cat-1", "cat-2"]);
    expect(optionValues("payment")).toEqual([
      "",
      "account:acct-1",
      "card:card-1",
    ]);
  });

  it("changing the category clears a subcategory that no longer belongs", async () => {
    await render({ categoryId: "cat-1", subcategoryId: "sub-1" });
    await select("categoryId", "cat-2");

    expect(changes).toEqual([
      ["categoryId", "cat-2"],
      ["subcategoryId", ""],
    ]);
  });

  it("switching payment away from a card resets the purchase mode", async () => {
    await render({ payment: "card:card-1", purchaseMode: "parcelado" });
    await select("payment", "account:acct-1");

    expect(changes).toEqual([
      ["payment", "account:acct-1"],
      ["purchaseMode", "avista"],
    ]);
  });

  it("shows Subcategoria only when the category has subcategories", async () => {
    await render();
    expect(field("subcategoryId")).toBeNull();

    await render({ categoryId: "cat-2" });
    expect(field("subcategoryId")).toBeNull();

    await render({ categoryId: "cat-1" });
    expect(optionValues("subcategoryId")).toEqual(["", "sub-1"]);
    expect(labelFor("subcategoryId").firstChild?.textContent).toBe(
      "Subcategoria",
    );
  });

  it("shows Forma only for a card expense and Parcelas only when parcelado", async () => {
    await render();
    expect(field("purchaseMode")).toBeNull();

    await render({ kind: "income", payment: "card:card-1" });
    expect(field("purchaseMode")).toBeNull();

    await render({ payment: "card:card-1" });
    expect(optionValues("purchaseMode")).toEqual(["avista", "parcelado"]);
    expect(field("installmentCount")).toBeNull();

    await render({ payment: "card:card-1", purchaseMode: "parcelado" });
    const parcelas = field("installmentCount") as HTMLInputElement;
    expect(labelFor("installmentCount").firstChild?.textContent).toBe(
      "Parcelas",
    );
    expect([parcelas.min, parcelas.max]).toEqual(["2", "48"]);
  });

  it("marks AI-filled fields with the IA pill and the tinted style", async () => {
    await render(
      { kind: "expense" },
      { aiFilled: new Set<TransactionFieldKey>(["amount", "kind"]) },
    );

    expect(labelFor("amount").textContent).toBe("ValorIA");
    expect(
      container.querySelector(".ff-txfields__money")?.classList,
    ).toContain("ff-txfields--ai");
    expect(labelFor("description").textContent).toBe("Descrição");
    expect(field("description")?.classList).not.toContain("ff-txfields--ai");
    expect(container.querySelector(".ff-txfields__head")?.textContent).toContain(
      "DetalhesIA",
    );
  });

  it("tints selects the AI filled and leaves the rest plain", async () => {
    await render(
      {},
      { aiFilled: new Set<TransactionFieldKey>(["payment"]) },
    );

    expect(field("payment")?.closest(".ff-select")?.classList).toContain(
      "ff-txfields--ai",
    );
    expect(field("responsible")?.closest(".ff-select")?.classList).not.toContain(
      "ff-txfields--ai",
    );
  });

  it("gives Categoria the warn border on request", async () => {
    await render();
    expect(field("categoryId")?.closest(".ff-select")?.classList).not.toContain(
      "ff-txfields--warn",
    );

    await render({}, { categoryHighlight: "warn" });
    expect(field("categoryId")?.closest(".ff-select")?.classList).toContain(
      "ff-txfields--warn",
    );
  });

  it("renders the category action next to the Categoria label", async () => {
    await render({}, { categoryAction: <button type="button">+ Nova categoria</button> });

    const row = labelFor("categoryId").parentElement;
    expect(row?.querySelector("button")?.textContent).toBe("+ Nova categoria");
  });
});
