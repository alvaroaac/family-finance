/**
 * Integration tests for the "/resumo" quick daily dashboard — v1.0 Task 5.
 *
 * Two layers, both offline:
 *  1. The PURE presentation helpers (month label, spending comparison copy).
 *  2. `buildResumoData` — the same composition `loadResumoData` performs —
 *     running the REAL `@family-finance/db` repositories against the in-memory
 *     fake store (./fake-supabase.ts): delta sign vs the previous month,
 *     PER-CARD projected invoice (direct card purchases + parcelas due in the
 *     month), pending-review count, and the recent list capped at 5.
 */

import { describe, it, expect, beforeEach } from "vitest";

import type { AppSupabaseClient } from "@family-finance/db";

import {
  buildResumoData,
  monthLabelPtBr,
  spendingComparisonLabel,
} from "../app/(app)/resumo/queries.js";
import { formatBrlCents } from "../lib/format.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const CARD_ROX = "card-roxinho";
const CARD_AZUL = "card-azulzinho";

// Inside July 2026 — previous month is June.
const NOW = new Date("2026-07-15T12:00:00Z");

// ---------------------------------------------------------------------------
// 1. Pure presentation helpers
// ---------------------------------------------------------------------------

describe("monthLabelPtBr", () => {
  it("renders YYYY-MM as a pt-BR month label", () => {
    expect(monthLabelPtBr("2026-07")).toBe("julho de 2026");
    expect(monthLabelPtBr("2025-12")).toBe("dezembro de 2025");
  });
});

describe("spendingComparisonLabel", () => {
  it("positive delta = spending LESS than the previous month", () => {
    // NOTE: formatBrlCents uses a non-breaking space after "R$".
    expect(spendingComparisonLabel(32000, "2026-06")).toBe(
      `${formatBrlCents(32000)} a menos que junho 🌱`,
    );
  });

  it("negative delta = spending MORE than the previous month", () => {
    expect(spendingComparisonLabel(-4550, "2026-06")).toBe(
      `${formatBrlCents(4550)} a mais que junho`,
    );
  });

  it("zero delta = same rhythm", () => {
    expect(spendingComparisonLabel(0, "2026-06")).toBe(
      "No mesmo ritmo de junho",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. buildResumoData on the fake store
// ---------------------------------------------------------------------------

type TxSeed = {
  id: string;
  kind?: "expense" | "income" | "transfer";
  amount_cents?: number;
  occurred_on: string;
  description: string;
  category_id?: string | null;
  credit_card_id?: string | null;
  account_id?: string | null;
  bill_month?: string;
  created_at?: string;
};

function tx(seed: TxSeed): Record<string, unknown> {
  return {
    kind: "expense",
    amount_cents: 1000,
    category_id: "cat-mercado",
    subcategory_id: null,
    account_id: null,
    credit_card_id: null,
    installment_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: ALVARO,
    import_batch_id: null,
    household_id: HOUSEHOLD,
    created_at: `${seed.occurred_on}T12:00:00Z`,
    updated_at: `${seed.occurred_on}T12:00:00Z`,
    ...seed,
  };
}

function installment(seed: {
  id: string;
  credit_card_id: string;
  amount_cents: number;
  due_month: string;
}): Record<string, unknown> {
  return {
    household_id: HOUSEHOLD,
    installment_group_id: "group-1",
    number: 1,
    installment_count: 3,
    description: "Parcela",
    category_id: null,
    subcategory_id: null,
    responsibility_scope: "household",
    responsible_user_id: ALVARO,
    created_by_user_id: ALVARO,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...seed,
  };
}

/**
 * July 2026 (current): expenses 45000 + card purchases; June (previous):
 * 77000 in expenses, so the family is spending R$ 320,00 LESS in July.
 */
function seedStore(): FakeSupabaseStore {
  const seed: FakeDatabaseSeed = {
    transactions: [
      // --- July (current month) expenses: 30000 + 15000 = 45000 off-card...
      tx({
        id: "tx-jul-mercado",
        occurred_on: "2026-07-02",
        description: "Mercado",
        amount_cents: 30000,
      }),
      tx({
        id: "tx-jul-farmacia",
        occurred_on: "2026-07-05",
        description: "Farmácia",
        amount_cents: 15000,
        category_id: null, // pending review #1
      }),
      // ...plus 5000 on the Roxinho card => July expenseCents = 50000.
      tx({
        id: "tx-jul-card-rox",
        occurred_on: "2026-07-08",
        description: "Restaurante no cartão",
        amount_cents: 5000,
        credit_card_id: CARD_ROX,
        category_id: null, // pending review #2
      }),
      // A refund ON the card: counts as income, must NOT add card pressure.
      tx({
        id: "tx-jul-card-refund",
        kind: "income",
        occurred_on: "2026-07-09",
        description: "Estorno cartão",
        amount_cents: 2000,
        credit_card_id: CARD_ROX,
      }),
      // Income + transfer in July: ignored by expenseCents; the transfer has
      // no category but must NOT count as pending review.
      tx({
        id: "tx-jul-salario",
        kind: "income",
        occurred_on: "2026-07-01",
        description: "Salário",
        amount_cents: 700000,
      }),
      tx({
        id: "tx-jul-transfer",
        kind: "transfer",
        occurred_on: "2026-07-03",
        description: "Para a caixinha",
        amount_cents: 10000,
        category_id: null,
      }),
      // --- June (previous month): 82000 in expenses => delta 32000 (less!).
      tx({
        id: "tx-jun-1",
        occurred_on: "2026-06-10",
        description: "Mercado de junho",
        amount_cents: 60000,
      }),
      tx({
        id: "tx-jun-2",
        occurred_on: "2026-06-20",
        description: "Luz de junho",
        amount_cents: 22000,
        category_id: null, // pending review #3 (older month still pending)
      }),
    ],
    credit_cards: [
      {
        id: CARD_ROX,
        household_id: HOUSEHOLD,
        name: "Roxinho",
        closing_day: 28,
        due_day: 5,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: CARD_AZUL,
        household_id: HOUSEHOLD,
        name: "Azulzinho",
        closing_day: null,
        due_day: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    installments: [
      // Roxinho: 3334 due in July + one due in August (ignored this month).
      installment({
        id: "inst-rox-jul",
        credit_card_id: CARD_ROX,
        amount_cents: 3334,
        due_month: "2026-07",
      }),
      installment({
        id: "inst-rox-ago",
        credit_card_id: CARD_ROX,
        amount_cents: 3334,
        due_month: "2026-08",
      }),
      // Azulzinho: only installments, no direct purchases.
      installment({
        id: "inst-azul-jul",
        credit_card_id: CARD_AZUL,
        amount_cents: 10000,
        due_month: "2026-07",
      }),
    ],
  };
  return new FakeSupabaseStore(seed);
}

let client: AppSupabaseClient;

beforeEach(() => {
  client = createFakeSupabaseClient(seedStore()) as unknown as AppSupabaseClient;
});

describe("buildResumoData", () => {
  it("computes the composite gasto total: conta + cartão (compras diretas e parcelas)", async () => {
    const data = await buildResumoData(client, HOUSEHOLD, NOW);
    expect(data.month).toBe("2026-07");
    // Conta = expenses off-card: 30000 + 15000 = 45000 (the 5000 card charge
    // moves to the card side so nothing is double-counted).
    expect(data.accountSpentCents).toBe(45000);
    // Cartão = direct card purchases 5000 (refund ignored) + parcelas due in
    // July 3334 + 10000 = 18334.
    expect(data.cardSpentCents).toBe(18334);
    // Hero total = conta + cartão.
    expect(data.totalSpentCents).toBe(45000 + 18334);
    // June composite = 82000 expenses + 0 parcelas => delta 82000 - 63334.
    expect(data.deltaVsPreviousCents).toBe(82000 - 63334);
    expect(data.loadError).toBeNull();
  });

  it("projects the invoice PER CARD: direct purchases + parcelas due this month", async () => {
    const data = await buildResumoData(client, HOUSEHOLD, NOW);
    // listCreditCards orders by name: Azulzinho first.
    expect(data.cards).toEqual([
      { id: CARD_AZUL, name: "Azulzinho", projectedCents: 10000, settled: false },
      // 5000 direct (refund ignored) + 3334 July parcela; August parcela out.
      { id: CARD_ROX, name: "Roxinho", projectedCents: 8334, settled: false },
    ]);
  });

  it("marks a card settled when a kind='transfer' bill payment exists for the month", async () => {
    const store = seedStore();
    store.table("transactions").push(
      tx({
        id: "tx-jul-pagamento-rox",
        kind: "transfer",
        occurred_on: "2026-07-10",
        description: "Pagamento fatura Roxinho",
        amount_cents: 8334,
        credit_card_id: CARD_ROX,
        account_id: "acc-corrente",
        category_id: null,
        bill_month: "2026-07",
      }),
    );
    const settledClient = createFakeSupabaseClient(
      store,
    ) as unknown as AppSupabaseClient;
    const data = await buildResumoData(settledClient, HOUSEHOLD, NOW);
    expect(data.cards).toEqual([
      { id: CARD_AZUL, name: "Azulzinho", projectedCents: 10000, settled: false },
      { id: CARD_ROX, name: "Roxinho", projectedCents: 8334, settled: true },
    ]);
  });

  it("counts pending review across months, excluding transfers", async () => {
    const data = await buildResumoData(client, HOUSEHOLD, NOW);
    expect(data.pendingCount).toBe(3);
  });

  it("caps the recent list at 5, newest first", async () => {
    const data = await buildResumoData(client, HOUSEHOLD, NOW);
    expect(data.recent).toHaveLength(5);
    expect(data.recent.map((t) => t.id)).toEqual([
      "tx-jul-card-refund",
      "tx-jul-card-rox",
      "tx-jul-farmacia",
      "tx-jul-transfer",
      "tx-jul-mercado",
    ]);
  });
});

describe("buildResumoData — obrigações fixas", () => {
  it("surfaces the month's fixed-obligation total (projected-unpaid + paid)", async () => {
    const store = seedStore();
    store.table("obligations").push({
      id: "ob-solar",
      household_id: HOUSEHOLD,
      description: "Parcela solar",
      amount_cents: 71044,
      start_month: "2026-05",
      term_months: 72,
      due_day: 5,
      category_id: null,
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      account_id: "acc-corrente",
      status: "active",
      created_by_user_id: ALVARO,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    });
    const obligationsClient = createFakeSupabaseClient(
      store,
    ) as unknown as AppSupabaseClient;
    const data = await buildResumoData(obligationsClient, HOUSEHOLD, NOW);
    expect(data.obligationsCents).toBe(71044);
  });

  it("is zero when the household has no obligations", async () => {
    const data = await buildResumoData(client, HOUSEHOLD, NOW);
    expect(data.obligationsCents).toBe(0);
  });
});
