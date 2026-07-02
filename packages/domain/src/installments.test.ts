import { describe, it, expect } from "vitest";
import { brl } from "./money.js";
import {
  createInstallmentPlan,
  type CreateInstallmentPlanInput,
} from "./installments.js";

const HOUSEHOLD = "household-casa";
const ALVARO = "user-alvaro";

function baseInput(
  overrides: Partial<CreateInstallmentPlanInput> = {},
): CreateInstallmentPlanInput {
  return {
    householdId: HOUSEHOLD,
    creditCardId: "card-nubank",
    description: "Geladeira",
    totalAmount: brl(120000),
    installmentCount: 12,
    purchasedOn: "2026-06-21",
    createdByUserId: ALVARO,
    ...overrides,
  };
}

describe("createInstallmentPlan", () => {
  it("creates a single installment for an à vista (1x) card purchase", () => {
    const result = createInstallmentPlan(
      baseInput({
        description: "Mercado",
        totalAmount: brl(15000),
        installmentCount: 1,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installments).toHaveLength(1);
    const [only] = result.value.installments;
    expect(only?.number).toBe(1);
    expect(only?.amount).toEqual(brl(15000));
    expect(only?.dueMonth).toBe("2026-06");
    expect(result.value.group.installmentCount).toBe(1);
  });

  it("generates 12 monthly installments with stable, contiguous due months", () => {
    const result = createInstallmentPlan(
      baseInput({ totalAmount: brl(120000), installmentCount: 12 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { installments } = result.value;
    expect(installments).toHaveLength(12);

    // Each parcel is 1000 cents and they sum to the total.
    const sum = installments.reduce((acc, i) => acc + i.amount.cents, 0);
    expect(sum).toBe(120000);
    expect(installments.every((i) => i.amount.cents === 10000)).toBe(true);

    // Stable, contiguous due months crossing the year boundary.
    const dueMonths = installments.map((i) => i.dueMonth);
    expect(dueMonths).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
    ]);

    // 1-based numbering.
    expect(installments.map((i) => i.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("splits an indivisible total into integer cents that sum back exactly", () => {
    const result = createInstallmentPlan(
      baseInput({ totalAmount: brl(10000), installmentCount: 3 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cents = result.value.installments.map((i) => i.amount.cents);
    // 10000 / 3 -> earlier parcels absorb the remainder cent.
    expect(cents).toEqual([3334, 3333, 3333]);
    expect(cents.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("keeps due months stable regardless of purchase day-of-month (no month drift)", () => {
    const result = createInstallmentPlan(
      baseInput({
        purchasedOn: "2026-01-31",
        totalAmount: brl(30000),
        installmentCount: 3,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installments.map((i) => i.dueMonth)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("defaults responsibility to household and propagates it to every installment", () => {
    const result = createInstallmentPlan(baseInput({ installmentCount: 2 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.group.responsibility).toEqual({ scope: "household" });
    expect(
      result.value.installments.every(
        (i) => i.responsibility.scope === "household",
      ),
    ).toBe(true);
  });

  describe("closingDay (invoice timing)", () => {
    it("pushes the first dueMonth to the next month when purchased after closing", () => {
      const result = createInstallmentPlan(
        baseInput({
          purchasedOn: "2026-07-10",
          closingDay: 5,
          totalAmount: brl(30000),
          installmentCount: 3,
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.installments.map((i) => i.dueMonth)).toEqual([
        "2026-08",
        "2026-09",
        "2026-10",
      ]);
    });

    it("keeps the purchase month when purchased ON the closing day (not after)", () => {
      const result = createInstallmentPlan(
        baseInput({
          purchasedOn: "2026-07-05",
          closingDay: 5,
          installmentCount: 1,
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.installments[0]?.dueMonth).toBe("2026-07");
    });

    it("rolls over the year when a post-closing December purchase lands in January", () => {
      const result = createInstallmentPlan(
        baseInput({
          purchasedOn: "2026-12-20",
          closingDay: 15,
          installmentCount: 1,
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.installments[0]?.dueMonth).toBe("2027-01");
    });

    it.each([0, 29, 1.5])(
      "rejects invalid closingDay %s with a validation error on the field",
      (closingDay) => {
        const result = createInstallmentPlan(baseInput({ closingDay }));

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: "closingDay" }),
        );
      },
    );

    it("leaves behavior unchanged when closingDay is omitted (regression)", () => {
      const withOmitted = createInstallmentPlan(
        baseInput({ purchasedOn: "2026-07-10", installmentCount: 3 }),
      );

      expect(withOmitted.ok).toBe(true);
      if (!withOmitted.ok) return;
      expect(withOmitted.value.installments.map((i) => i.dueMonth)).toEqual([
        "2026-07",
        "2026-08",
        "2026-09",
      ]);
    });
  });

  it("returns structured validation errors for an invalid installment count", () => {
    const result = createInstallmentPlan(baseInput({ installmentCount: 0 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "installmentCount",
        code: "invalid_installment_count",
      }),
    );
  });
});
