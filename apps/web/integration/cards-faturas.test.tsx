// @vitest-environment jsdom

/**
 * /cards "Faturas" section — card-bill-payments Task 5.
 *
 *  1. `parseFaturaParam`: only `YYYY-MM` selects a month view (C30).
 *  2. `loadFaturasView` on the in-memory fake store (real db repositories):
 *     default view = pending closed fatura above the open one (P9); month view
 *     = one block per card.
 *  3. Server render of `FaturasSection` (actions mocked): block copy, the
 *     corrected-total hint and the zero-accounts hint (E10).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AppSupabaseClient,
  CardBillOverview,
  CreditCardRow,
} from "@family-finance/db";
import { summarizeCardBill } from "@family-finance/domain";

vi.mock("../app/(app)/cards/actions", () => {
  const idle = async () => ({ status: "idle" as const });
  return {
    payCardBillAction: idle,
    undoCardBillPaymentAction: idle,
    closeCardBillAction: idle,
    reopenCardBillAction: idle,
    setCardBillTotalAction: idle,
  };
});

import {
  loadFaturasView,
  parseFaturaParam,
  type FaturasView,
} from "../app/(app)/cards/faturas";
import { FaturasSection } from "../app/(app)/cards/faturas-section";
import { ToastProvider } from "../components/ui/toast";
import { formatBrlCents } from "../lib/format";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const TODAY = "2026-07-15";

const ROXINHO: CreditCardRow = {
  id: "card-roxinho",
  household_id: HOUSEHOLD,
  name: "Roxinho",
  closing_day: 28,
  due_day: 5,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function cardCharge(
  id: string,
  occurredOn: string,
  invoiceMonth: string,
  amountCents: number,
): Record<string, unknown> {
  return {
    id,
    household_id: HOUSEHOLD,
    kind: "expense",
    amount_cents: amountCents,
    occurred_on: occurredOn,
    description: "Mercado no cartão",
    category_id: null,
    subcategory_id: null,
    account_id: null,
    credit_card_id: ROXINHO.id,
    installment_id: null,
    invoice_month: invoiceMonth,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: ALVARO,
    import_batch_id: null,
    created_at: `${occurredOn}T12:00:00Z`,
    updated_at: `${occurredOn}T12:00:00Z`,
  };
}

/** Roxinho: June fatura (auto-closed 28/06, unpaid) + a July open charge. */
function client(): AppSupabaseClient {
  const store = new FakeSupabaseStore({
    credit_cards: [ROXINHO],
    transactions: [
      cardCharge("tx-jun", "2026-06-12", "2026-06", 20000),
      cardCharge("tx-jul", "2026-07-03", "2026-07", 4500),
    ],
  });
  return createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
}

describe("parseFaturaParam (C30)", () => {
  it("accepts YYYY-MM", () => {
    expect(parseFaturaParam("2026-09")).toBe("2026-09");
    expect(parseFaturaParam("2026-12")).toBe("2026-12");
  });

  it.each([
    undefined,
    "",
    "2026-13",
    "2026-00",
    "2026-9",
    "26-09",
    "2026-09-01",
    "setembro",
    ["2026-09"],
  ])("falls back to the default view for %j", (value) => {
    expect(parseFaturaParam(value)).toBeNull();
  });
});

describe("loadFaturasView", () => {
  it("default view: pending closed fatura above the open one (P9)", async () => {
    const view = await loadFaturasView(client(), HOUSEHOLD, null, TODAY);
    expect(view.month).toBeNull();
    expect(view.cards).toHaveLength(1);
    const [entry] = view.cards;
    expect(entry?.card.id).toBe(ROXINHO.id);
    expect(entry?.faturas.map((f) => f.month)).toEqual(["2026-06", "2026-07"]);
    expect(entry?.faturas.map((f) => f.summary.status)).toEqual([
      "closed_unpaid",
      "open",
    ]);
    expect(entry?.faturas[1]?.summary.totalCents).toBe(4500);
  });

  it("month view: one block per card for that month", async () => {
    const view = await loadFaturasView(client(), HOUSEHOLD, "2026-06", TODAY);
    expect(view.month).toBe("2026-06");
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.faturas).toHaveLength(1);
    expect(view.cards[0]?.faturas[0]).toMatchObject({
      month: "2026-06",
      closingDate: "2026-06-28",
      summary: { closed: true, totalCents: 20000 },
    });
  });

  it("an invalid ?fatura= renders the default view", async () => {
    const view = await loadFaturasView(
      client(),
      HOUSEHOLD,
      parseFaturaParam("2026-13"),
      TODAY,
    );
    expect(view.month).toBeNull();
    expect(view.cards[0]?.faturas).toHaveLength(2);
  });
});

function overview(over: Partial<CardBillOverview>): CardBillOverview {
  return {
    card: ROXINHO,
    month: "2026-06",
    closingDate: "2026-06-28",
    summary: summarizeCardBill({
      closed: true,
      chargesCents: 20000,
      totalOverrideCents: null,
      paymentCents: [],
    }),
    payments: [],
    ...over,
  };
}

function renderSection(
  view: FaturasView,
  accounts: Array<{ id: string; name: string }>,
): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(FaturasSection, { view, accounts, todaySp: TODAY }),
    ),
  );
  return host;
}

const ACCOUNTS = [{ id: "acc-corrente", name: "Conta Itaú" }];

describe("FaturasSection", () => {
  it("renders the pending block with corrected total, payments and an open payment form", () => {
    const pending = overview({
      summary: summarizeCardBill({
        closed: true,
        chargesCents: 20000,
        totalOverrideCents: 18000,
        paymentCents: [5000],
      }),
      payments: [
        {
          id: "pay-1",
          creditCardId: ROXINHO.id,
          accountId: "acc-corrente",
          amountCents: 5000,
          paidOn: "2026-07-10",
          billMonth: "2026-06",
        },
      ],
    });
    const open = overview({
      month: "2026-07",
      closingDate: "2026-07-28",
      summary: summarizeCardBill({
        closed: false,
        chargesCents: 4500,
        totalOverrideCents: null,
        paymentCents: [],
      }),
    });
    const host = renderSection(
      { month: null, cards: [{ card: ROXINHO, faturas: [pending, open] }] },
      ACCOUNTS,
    );
    const text = host.textContent ?? "";

    expect(text).toContain("Faturas de agora");
    expect(text).toContain("Fatura 06/2026");
    expect(text).toContain("fecha 28/06");
    expect(text).toContain("Fatura 07/2026");
    expect(text).toContain(
      `total ajustado (soma dos lançamentos: ${formatBrlCents(20000)})`,
    );
    expect(text).toContain(`10/07/2026 · Conta Itaú · ${formatBrlCents(5000)}`);
    expect(text).toContain("Desfazer");
    expect(text).toContain("Reabrir");
    expect(text).toContain("Ajustar total");
    expect(text).toContain("Fechar fatura");
    expect(text).not.toContain("Voltar para agora");

    // Closed + owing → the payment form is already open, prefilled with what's left.
    const amount = host.querySelector<HTMLInputElement>('input[name="amount"]');
    expect(amount?.value).toBe("130,00");
    expect(
      host.querySelector<HTMLInputElement>('input[name="paidOn"]')?.max,
    ).toBe(TODAY);
    // Open fatura → collapsed behind "Pagar fatura".
    expect(text).toContain("Pagar fatura");
    // Each payment form carries its own idempotency key.
    const keys = [
      ...host.querySelectorAll<HTMLInputElement>(
        'input[name="idempotencyKey"]',
      ),
    ].map((input) => input.value);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("month view shows the month heading and the way back", () => {
    const host = renderSection(
      { month: "2026-06", cards: [{ card: ROXINHO, faturas: [overview({})] }] },
      ACCOUNTS,
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Faturas de 06/2026");
    expect(host.querySelector('a[href="/cards"]')?.textContent).toBe(
      "Voltar para agora",
    );
    expect(text).not.toContain("total ajustado");
  });

  it("zero accounts → hint linking to /accounts instead of the payment form (E10)", () => {
    const host = renderSection(
      { month: null, cards: [{ card: ROXINHO, faturas: [overview({})] }] },
      [],
    );
    expect(host.textContent).toContain(
      "Cadastre uma conta para registrar pagamentos.",
    );
    expect(host.querySelector('a[href="/accounts"]')).not.toBeNull();
    expect(host.querySelector('input[name="amount"]')).toBeNull();
    expect(host.textContent).not.toContain("Pagar fatura");
  });
});
