import { describe, it, expect } from "vitest";
import { brl } from "./money.js";
import {
  createTransactionDraft,
  isCardPayment,
  createCardBillSettlement,
  type CreateTransactionInput,
} from "./transactions.js";

const HOUSEHOLD = "household-casa";
const ALVARO = "user-alvaro";
const KAROL = "user-karol";

function baseInput(
  overrides: Partial<CreateTransactionInput> = {},
): CreateTransactionInput {
  return {
    householdId: HOUSEHOLD,
    kind: "expense",
    amount: brl(3200),
    occurredOn: "2026-06-21",
    description: "Uber",
    createdByUserId: ALVARO,
    payment: { type: "account", accountId: "acc-checking" },
    ...overrides,
  };
}

describe("createTransactionDraft", () => {
  it("creates a cash (account) expense paid from a checking account", () => {
    const result = createTransactionDraft(
      baseInput({
        kind: "expense",
        amount: brl(3200),
        description: "Uber 32 reais",
        payment: { type: "account", accountId: "acc-checking" },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("expense");
    expect(result.value.amount).toEqual(brl(3200));
    expect(result.value.payment).toEqual({
      type: "account",
      accountId: "acc-checking",
    });
    expect(isCardPayment(result.value)).toBe(false);
  });

  it("creates a basic income transaction", () => {
    const result = createTransactionDraft(
      baseInput({
        kind: "income",
        amount: brl(850000),
        description: "Salario",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("income");
    expect(result.value.amount).toEqual(brl(850000));
  });

  it("defaults responsibility to the household when no responsibleUserId is given", () => {
    const result = createTransactionDraft(baseInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.responsibility).toEqual({ scope: "household" });
    // lançado por is always recorded.
    expect(result.value.createdByUserId).toBe(ALVARO);
  });

  it("assigns user responsibility when responsibleUserId is provided", () => {
    const result = createTransactionDraft(
      baseInput({ createdByUserId: ALVARO, responsibleUserId: KAROL }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.responsibility).toEqual({
      scope: "user",
      userId: KAROL,
    });
    // createdBy (launched by) and responsible can differ.
    expect(result.value.createdByUserId).toBe(ALVARO);
  });

  it("creates a credit card purchase à vista", () => {
    const result = createTransactionDraft(
      baseInput({
        amount: brl(15000),
        description: "Mercado",
        payment: { type: "card", creditCardId: "card-nubank" },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment).toEqual({
      type: "card",
      creditCardId: "card-nubank",
    });
    expect(isCardPayment(result.value)).toBe(true);
  });

  it("returns structured validation errors instead of throwing for a non-positive amount", () => {
    const result = createTransactionDraft(baseInput({ amount: brl(0) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "amount.cents",
        code: "amount_not_positive",
      }),
    );
  });

  it("returns a structured validation error for an invalid date", () => {
    const result = createTransactionDraft(
      baseInput({ occurredOn: "2026-02-31" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "occurredOn", code: "invalid_date" }),
    );
  });

  it("requires a non-empty description", () => {
    const result = createTransactionDraft(baseInput({ description: "   " }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "description",
        code: "description_required",
      }),
    );
  });
});

describe("createCardBillSettlement", () => {
  const valid = {
    householdId: "house-1",
    creditCardId: "card-1",
    accountId: "acct-1",
    billMonth: "2026-07",
    amountCents: 235000,
    paidOn: "2026-07-06",
    createdByUserId: "user-1",
  };

  it("accepts a valid settlement", () => {
    const result = createCardBillSettlement(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(valid);
  });

  it.each([
    ["amountCents", { ...valid, amountCents: 0 }],
    ["amountCents", { ...valid, amountCents: -100 }],
    ["billMonth", { ...valid, billMonth: "2026-13" }],
    ["billMonth", { ...valid, billMonth: "07/2026" }],
    ["creditCardId", { ...valid, creditCardId: "" }],
    ["accountId", { ...valid, accountId: "" }],
    ["householdId", { ...valid, householdId: "" }],
    ["createdByUserId", { ...valid, createdByUserId: "" }],
    ["paidOn", { ...valid, paidOn: "06/07/2026" }],
  ])("rejects invalid %s", (field, input) => {
    const result = createCardBillSettlement(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toContain(field);
  });
});
