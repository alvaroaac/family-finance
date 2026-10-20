// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CaptureDraft } from "../../app/(app)/capture/actions";
import {
  emptyTransactionFieldValues,
  type TransactionFieldOptions,
} from "../transaction-fields";
import { CAPTURE_DRAFT_KEY, useCaptureDraft } from "./use-capture-draft";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const CARD = "00000000-0000-4000-8000-000000000002";
const FOOD = "00000000-0000-4000-8000-000000000003";
const FUN = "00000000-0000-4000-8000-000000000004";
const MARKET = "00000000-0000-4000-8000-000000000005";
const MEMBER = "00000000-0000-4000-8000-000000000006";

const options: TransactionFieldOptions = {
  accounts: [{ id: ACCOUNT, name: "Conta Corrente" }],
  cards: [{ id: CARD, name: "Cartão Roxo" }],
  categories: [
    { id: FOOD, name: "Alimentação", kind: "expense" },
    { id: FUN, name: "Lazer", kind: "expense" },
  ],
  subcategories: [{ id: MARKET, categoryId: FOOD, name: "Mercado" }],
  responsibles: [
    { value: "household", label: "Casa" },
    { value: MEMBER, label: "Membro" },
  ],
};
const defaults = emptyTransactionFieldValues(options, "2026-10-20");

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    description: "Mercado",
    amountCents: 8500,
    date: "2026-10-19",
    kind: "expense",
    categoryId: FOOD,
    subcategoryId: MARKET,
    accountId: ACCOUNT,
    installmentCount: 1,
    candidates: [],
    explanation: "Regra: mercado → Alimentação",
    needsReview: false,
    ...overrides,
  };
}

type Hook = ReturnType<typeof useCaptureDraft>;
let hook: Hook;
let container: HTMLDivElement;
let root: Root;

function Harness() {
  hook = useCaptureDraft(defaults);
  return null;
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

beforeEach(async () => {
  localStorage.clear();
  await mount();
});

afterEach(unmount);

describe("applyDraft", () => {
  it("fills untouched keys and marks exactly those as filled by the AI", async () => {
    await act(async () => hook.applyDraft(draft(), options));

    expect(hook.values).toEqual({
      ...defaults,
      kind: "expense",
      amount: "85,00",
      description: "Mercado",
      occurredOn: "2026-10-19",
      categoryId: FOOD,
      subcategoryId: MARKET,
      payment: `account:${ACCOUNT}`,
      responsible: "household",
    });
    expect([...hook.aiFilled].sort()).toEqual(
      [
        "amount",
        "categoryId",
        "description",
        "kind",
        "occurredOn",
        "payment",
        "responsible",
        "subcategoryId",
      ].sort(),
    );
  });

  it("never overwrites a key the user edited and drops its AI mark", async () => {
    await act(async () => hook.applyDraft(draft(), options));
    await act(async () => hook.setField("amount", "12,00"));

    expect(hook.aiFilled.has("amount")).toBe(false);

    await act(async () =>
      hook.applyDraft(draft({ amountCents: 9900, description: "Feira" }), options),
    );

    expect(hook.values.amount).toBe("12,00");
    expect(hook.aiFilled.has("amount")).toBe(false);
    expect(hook.values.description).toBe("Feira");
    expect(hook.aiFilled.has("description")).toBe(true);
  });

  it("maps a card installment to parcelado with its count", async () => {
    await act(async () =>
      hook.applyDraft(
        draft({ accountId: undefined, creditCardId: CARD, installmentCount: 3 }),
        options,
      ),
    );

    expect(hook.values.payment).toBe(`card:${CARD}`);
    expect(hook.values.purchaseMode).toBe("parcelado");
    expect(hook.values.installmentCount).toBe(3);
    expect(hook.aiFilled.has("purchaseMode")).toBe(true);
    expect(hook.aiFilled.has("installmentCount")).toBe(true);
  });

  it("maps the responsible member and defaults an absent one to the household", async () => {
    await act(async () =>
      hook.applyDraft(draft({ responsibleUserId: MEMBER }), options),
    );
    expect(hook.values.responsible).toBe(MEMBER);

    await act(async () => hook.discard());
    await act(async () =>
      hook.applyDraft(draft({ responsibleUserId: undefined }), options),
    );
    expect(hook.values.responsible).toBe("household");
  });

  it("leaves the category empty when the draft needs review and exposes the candidates by name", async () => {
    await act(async () =>
      hook.applyDraft(
        draft({
          needsReview: true,
          categoryId: undefined,
          subcategoryId: undefined,
          candidates: [
            { categoryId: FOOD, subcategoryId: MARKET, explanation: "a" },
            { categoryId: FUN, explanation: "b" },
          ],
        }),
        options,
      ),
    );

    expect(hook.values.categoryId).toBe("");
    expect(hook.aiFilled.has("categoryId")).toBe(false);
    expect(hook.result).toEqual({
      explanation: "Regra: mercado → Alimentação",
      needsReview: true,
      candidates: [
        { categoryId: FOOD, subcategoryId: MARKET, name: "Alimentação" },
        { categoryId: FUN, name: "Lazer" },
      ],
    });
  });
});

describe("persistence", () => {
  it("persists text and values on every change and restores them on the next mount", async () => {
    await act(async () => hook.setText("85 no mercado"));
    await act(async () => hook.setField("amount", "85,00"));

    const stored = JSON.parse(localStorage.getItem(CAPTURE_DRAFT_KEY) ?? "null");
    expect(stored).toMatchObject({ text: "85 no mercado", values: { amount: "85,00" } });

    await unmount();
    await mount();

    expect(hook.text).toBe("85 no mercado");
    expect(hook.values.amount).toBe("85,00");
  });

  it.each([
    ["not JSON", "{oops"],
    ["a wrong shape", JSON.stringify({ text: 3, values: [] })],
    ["values missing keys", JSON.stringify({ text: "oi", values: { amount: 5 } })],
  ])("ignores a stored value that is %s", async (_label, raw) => {
    await unmount();
    localStorage.setItem(CAPTURE_DRAFT_KEY, raw);
    await mount();

    expect(hook.text).toBe("");
    expect(hook.values).toEqual(defaults);
  });

  it("discard clears state, AI marks, edit protection and storage", async () => {
    await act(async () => hook.setText("85 no mercado"));
    await act(async () => hook.setField("amount", "1,00"));
    await act(async () => hook.applyDraft(draft(), options));
    await act(async () => hook.discard());

    expect(hook.text).toBe("");
    expect(hook.values).toEqual(defaults);
    expect(hook.aiFilled.size).toBe(0);
    expect(hook.result).toBeNull();
    expect(localStorage.getItem(CAPTURE_DRAFT_KEY)).toBeNull();

    await act(async () => hook.applyDraft(draft(), options));
    expect(hook.values.amount).toBe("85,00");
  });
});
