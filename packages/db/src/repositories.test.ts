import { describe, it, expect } from "vitest";
import { createTransactionDraft, createInstallmentPlan } from "@family-finance/domain";
import {
  transactionInsertFromDraft,
  mapTransactionRow,
  monthDateRange,
  summarizeMonth,
  accountInsert,
  investmentBucketInsert,
  creditCardInsert,
  installmentGroupInsertFromPlan,
  installmentInsertsFromPlan,
} from "./repositories.js";
import type { TransactionRow } from "./types.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const USER = "11111111-1111-1111-1111-111111111111";

describe("transactionInsertFromDraft", () => {
  it("maps an account expense draft to an insert row with the account column set", () => {
    const result = createTransactionDraft({
      householdId: HOUSEHOLD,
      kind: "expense",
      amount: { currency: "BRL", cents: 1599 },
      occurredOn: "2026-06-22",
      description: "Café",
      createdByUserId: USER,
      payment: { type: "account", accountId: "acc-1" },
      category: { categoryId: "cat-1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = transactionInsertFromDraft(result.value);
    expect(row).toMatchObject({
      household_id: HOUSEHOLD,
      kind: "expense",
      amount_cents: 1599,
      occurred_on: "2026-06-22",
      description: "Café",
      category_id: "cat-1",
      subcategory_id: null,
      account_id: "acc-1",
      credit_card_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
      import_batch_id: null,
    });
  });

  it("maps a card draft with a responsible user to the card column and user scope", () => {
    const result = createTransactionDraft({
      householdId: HOUSEHOLD,
      kind: "expense",
      amount: { currency: "BRL", cents: 5000 },
      occurredOn: "2026-06-10",
      description: "Mercado",
      createdByUserId: USER,
      payment: { type: "card", creditCardId: "card-9" },
      responsibleUserId: USER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = transactionInsertFromDraft(result.value, {
      importBatchId: "batch-7",
    });
    expect(row.account_id).toBeNull();
    expect(row.credit_card_id).toBe("card-9");
    expect(row.responsibility_scope).toBe("user");
    expect(row.responsible_user_id).toBe(USER);
    expect(row.import_batch_id).toBe("batch-7");
  });
});

describe("mapTransactionRow", () => {
  it("surfaces money as a domain MoneyAmount", () => {
    const row: TransactionRow = {
      id: "tx-1",
      household_id: HOUSEHOLD,
      kind: "income",
      amount_cents: 250000,
      occurred_on: "2026-06-01",
      description: "Salário",
      category_id: null,
      subcategory_id: null,
      account_id: "acc-1",
      credit_card_id: null,
      installment_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
      import_batch_id: null,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    };
    const mapped = mapTransactionRow(row);
    expect(mapped.amount).toEqual({ currency: "BRL", cents: 250000 });
    expect(mapped.kind).toBe("income");
    expect(mapped.householdId).toBe(HOUSEHOLD);
  });
});

describe("monthDateRange", () => {
  it("returns inclusive ISO bounds for a 30-day month", () => {
    expect(monthDateRange("2026-06")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("handles February in a leap year", () => {
    expect(monthDateRange("2024-02")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });

  it("rejects a malformed month", () => {
    expect(() => monthDateRange("2026-13")).toThrow();
    expect(() => monthDateRange("2026/06")).toThrow();
  });
});

describe("summarizeMonth", () => {
  it("sums income and expense and computes balance, ignoring transfers", () => {
    const summary = summarizeMonth("2026-06", [
      { kind: "income", amount_cents: 300000 },
      { kind: "expense", amount_cents: 1599 },
      { kind: "expense", amount_cents: 5000 },
      { kind: "transfer", amount_cents: 99999 },
    ]);
    expect(summary).toEqual({
      month: "2026-06",
      incomeCents: 300000,
      expenseCents: 6599,
      balanceCents: 293401,
    });
  });

  it("returns zeros for an empty month", () => {
    expect(summarizeMonth("2026-07", [])).toEqual({
      month: "2026-07",
      incomeCents: 0,
      expenseCents: 0,
      balanceCents: 0,
    });
  });
});

// --- Task 9: accounts / investment buckets / credit cards inserts ----------

describe("accountInsert", () => {
  it("builds a household-scoped checking account insert payload", () => {
    expect(
      accountInsert({ householdId: HOUSEHOLD, kind: "checking", name: "  Conta Nubank  " }),
    ).toEqual({
      household_id: HOUSEHOLD,
      kind: "checking",
      name: "Conta Nubank",
    });
  });

  it("builds an investment account insert payload", () => {
    expect(
      accountInsert({ householdId: HOUSEHOLD, kind: "investment", name: "Tesouro" }),
    ).toEqual({
      household_id: HOUSEHOLD,
      kind: "investment",
      name: "Tesouro",
    });
  });
});

describe("investmentBucketInsert", () => {
  it("builds a caixinha insert payload keyed by slug", () => {
    expect(
      investmentBucketInsert({
        householdId: HOUSEHOLD,
        slug: "independencia_financeira",
        name: "Aposentadoria",
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      slug: "independencia_financeira",
      name: "Aposentadoria",
    });
  });
});

describe("creditCardInsert", () => {
  it("includes optional closing/due days when provided", () => {
    expect(
      creditCardInsert({
        householdId: HOUSEHOLD,
        name: "Nubank Roxinho",
        closingDay: 10,
        dueDay: 17,
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      name: "Nubank Roxinho",
      closing_day: 10,
      due_day: 17,
    });
  });

  it("nulls the optional day columns when omitted", () => {
    expect(
      creditCardInsert({ householdId: HOUSEHOLD, name: "Cartão simples" }),
    ).toEqual({
      household_id: HOUSEHOLD,
      name: "Cartão simples",
      closing_day: null,
      due_day: null,
    });
  });
});

describe("installment plan inserts", () => {
  it("maps a parcelado plan into one group insert and N installment inserts that sum to the total", () => {
    const planResult = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-1",
      description: "Geladeira",
      totalAmount: { currency: "BRL", cents: 100000 },
      installmentCount: 3,
      purchasedOn: "2026-06-15",
      createdByUserId: USER,
      category: { categoryId: "cat-casa" },
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const group = installmentGroupInsertFromPlan(planResult.value);
    expect(group).toMatchObject({
      household_id: HOUSEHOLD,
      credit_card_id: "card-1",
      description: "Geladeira",
      total_amount_cents: 100000,
      installment_count: 3,
      purchased_on: "2026-06-15",
      category_id: "cat-casa",
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
    });

    const groupId = "group-xyz";
    const rows = installmentInsertsFromPlan(planResult.value, groupId);
    expect(rows).toHaveLength(3);
    // Earlier parcels absorb the remainder (100000 / 3 -> 33334, 33333, 33333).
    expect(rows.map((r) => r.amount_cents)).toEqual([33334, 33333, 33333]);
    expect(rows.reduce((sum, r) => sum + r.amount_cents, 0)).toBe(100000);
    // Due months are contiguous starting at the purchase month.
    expect(rows.map((r) => r.due_month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(row.installment_group_id).toBe(groupId);
      expect(row.household_id).toBe(HOUSEHOLD);
      expect(row.credit_card_id).toBe("card-1");
      expect(row.installment_count).toBe(3);
      expect(row.category_id).toBe("cat-casa");
      expect(row.created_by_user_id).toBe(USER);
      expect(row.responsibility_scope).toBe("household");
      expect(row.responsible_user_id).toBeNull();
    }
  });

  it("carries a responsible user through to the group and installments", () => {
    const planResult = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-2",
      description: "Notebook",
      totalAmount: { currency: "BRL", cents: 240000 },
      installmentCount: 1,
      purchasedOn: "2026-12-20",
      createdByUserId: USER,
      responsibleUserId: USER,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const group = installmentGroupInsertFromPlan(planResult.value);
    expect(group.responsibility_scope).toBe("user");
    expect(group.responsible_user_id).toBe(USER);

    const rows = installmentInsertsFromPlan(planResult.value, "g1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.due_month).toBe("2026-12");
    expect(rows[0]?.amount_cents).toBe(240000);
    expect(rows[0]?.responsibility_scope).toBe("user");
    expect(rows[0]?.responsible_user_id).toBe(USER);
  });
});
