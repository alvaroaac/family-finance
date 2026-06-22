import { describe, it, expect } from "vitest";
import { createTransactionDraft } from "@family-finance/domain";
import {
  transactionInsertFromDraft,
  mapTransactionRow,
  monthDateRange,
  summarizeMonth,
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
