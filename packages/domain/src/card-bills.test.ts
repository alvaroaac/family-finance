import { describe, it, expect } from "vitest";
import { brl } from "./money.js";
import { createInstallmentPlan } from "./installments.js";
import {
  cardBillBadge,
  cardBillClosingDate,
  cardFaturaPair,
  firstOpenInvoiceMonth,
  isCardBillClosed,
  shiftInstallmentPlan,
  summarizeCardBill,
  type CardBillStatus,
} from "./card-bills.js";

describe("cardBillClosingDate", () => {
  it("uses the closing day within the month", () => {
    expect(cardBillClosingDate(28, "2026-10")).toBe("2026-10-28");
  });

  it("clamps closing day 31 to the last day of shorter months", () => {
    expect(cardBillClosingDate(31, "2026-04")).toBe("2026-04-30");
    expect(cardBillClosingDate(31, "2026-02")).toBe("2026-02-28");
    expect(cardBillClosingDate(31, "2028-02")).toBe("2028-02-29");
  });
});

describe("isCardBillClosed", () => {
  const base = { closingDay: 28, month: "2026-10", override: null } as const;

  it("is open on the closing day itself (C1, C5)", () => {
    expect(isCardBillClosed({ ...base, todaySp: "2026-10-28" })).toBe(false);
  });

  it("auto-closes the day after the closing day", () => {
    expect(isCardBillClosed({ ...base, todaySp: "2026-10-29" })).toBe(true);
  });

  it("stays open before the closing day", () => {
    expect(isCardBillClosed({ ...base, todaySp: "2026-10-10" })).toBe(false);
  });

  it("stays open for future months", () => {
    expect(
      isCardBillClosed({ ...base, month: "2026-11", todaySp: "2026-10-29" }),
    ).toBe(false);
  });

  it("closes a past month", () => {
    expect(
      isCardBillClosed({ ...base, month: "2026-09", todaySp: "2026-10-01" }),
    ).toBe(true);
  });

  it("clamps closing day 31 in April and February (C3)", () => {
    const apr = { closingDay: 31, month: "2026-04", override: null } as const;
    expect(isCardBillClosed({ ...apr, todaySp: "2026-04-30" })).toBe(false);
    expect(isCardBillClosed({ ...apr, todaySp: "2026-05-01" })).toBe(true);
    const feb = { closingDay: 31, month: "2026-02", override: null } as const;
    expect(isCardBillClosed({ ...feb, todaySp: "2026-02-28" })).toBe(false);
    expect(isCardBillClosed({ ...feb, todaySp: "2026-03-01" })).toBe(true);
    const leap = { closingDay: 31, month: "2028-02", override: null } as const;
    expect(isCardBillClosed({ ...leap, todaySp: "2028-02-29" })).toBe(false);
    expect(isCardBillClosed({ ...leap, todaySp: "2028-03-01" })).toBe(true);
  });

  it("never auto-closes without a closing day (C4)", () => {
    const input = { closingDay: null, month: "2020-01", todaySp: "2026-10-06" };
    expect(isCardBillClosed({ ...input, override: null })).toBe(false);
    expect(isCardBillClosed({ ...input, override: "closed" })).toBe(true);
  });

  it("override closed beats an open date (C7)", () => {
    expect(
      isCardBillClosed({ ...base, todaySp: "2026-10-10", override: "closed" }),
    ).toBe(true);
  });

  it("override open beats auto-close (C8)", () => {
    expect(
      isCardBillClosed({ ...base, todaySp: "2026-10-30", override: "open" }),
    ).toBe(false);
  });
});

describe("summarizeCardBill", () => {
  function summary(
    closed: boolean,
    chargesCents: number,
    paymentCents: number[],
    totalOverrideCents: number | null = null,
  ) {
    return summarizeCardBill({
      closed,
      chargesCents,
      totalOverrideCents,
      paymentCents,
    });
  }

  it("uses the live charges for an open fatura", () => {
    expect(summary(false, 10000, [])).toEqual({
      closed: false,
      chargesCents: 10000,
      totalCents: 10000,
      totalOverrideCents: null,
      paidCents: 0,
      remainingCents: 10000,
      overpaidCents: 0,
      status: "open",
    });
  });

  it("ignores the override while open", () => {
    expect(summary(false, 10000, [], 5000).totalCents).toBe(10000);
  });

  it("uses the override once closed", () => {
    const result = summary(true, 10000, [], 9000);
    expect(result.totalCents).toBe(9000);
    expect(result.chargesCents).toBe(10000);
    expect(result.totalOverrideCents).toBe(9000);
  });

  it("treats an override of 0 as a real total (C21)", () => {
    const result = summary(true, 10000, [], 0);
    expect(result.totalCents).toBe(0);
    expect(result.status).toBe("nothing_due");
  });

  it("sums multiple payments", () => {
    const result = summary(true, 10000, [3000, 2000]);
    expect(result.paidCents).toBe(5000);
    expect(result.remainingCents).toBe(5000);
  });

  it.each<[string, boolean, number, number[], CardBillStatus]>([
    ["open, nothing paid", false, 10000, [], "open"],
    ["open, total 0, nothing paid", false, 0, [], "open"],
    ["open, partial (C24)", false, 10000, [4000], "open_partial"],
    ["open, covered (C23)", false, 10000, [10000], "open_covered"],
    ["open, overpaid", false, 10000, [12000], "open_covered"],
    ["open, total 0 but paid", false, 0, [500], "open_covered"],
    ["closed, nothing due", true, 0, [], "nothing_due"],
    ["closed, unpaid", true, 10000, [], "closed_unpaid"],
    ["closed, partial (E2)", true, 10000, [4000], "closed_partial"],
    ["closed, completed (E3)", true, 10000, [4000, 6000], "paid"],
    ["closed, overpaid (E4)", true, 10000, [12000], "paid"],
    ["closed, total 0 but paid", true, 0, [500], "paid"],
  ])("%s", (_name, closed, charges, payments, status) => {
    expect(summary(closed, charges, payments).status).toBe(status);
  });

  it("reports remaining and overpaid amounts", () => {
    const partial = summary(true, 10000, [4000]);
    expect(partial.remainingCents).toBe(6000);
    expect(partial.overpaidCents).toBe(0);
    const over = summary(true, 10000, [12500]);
    expect(over.remainingCents).toBe(0);
    expect(over.overpaidCents).toBe(2500);
  });
});

describe("cardBillBadge", () => {
  function badge(closed: boolean, charges: number, payments: number[]) {
    return cardBillBadge(
      summarizeCardBill({
        closed,
        chargesCents: charges,
        totalOverrideCents: null,
        paymentCents: payments,
      }),
    );
  }

  it("renders every status with exact copy", () => {
    expect(badge(false, 10000, [])).toBe("aberta");
    expect(badge(false, 10000, [4000])).toBe("aberta · R$ 40,00 pago");
    expect(badge(false, 10000, [10000])).toBe("aberta · paga até agora");
    expect(badge(true, 0, [])).toBe("nada a pagar");
    expect(badge(true, 123456, [])).toBe("fechada · a pagar R$ 1.234,56");
    expect(badge(true, 10000, [4000])).toBe(
      "fechada · parcial, falta R$ 60,00",
    );
    expect(badge(true, 10000, [10000])).toBe("paga ✅");
    expect(badge(true, 10000, [12500])).toBe("paga ✅ · R$ 25,00 a mais");
  });
});

describe("firstOpenInvoiceMonth", () => {
  it("returns the start month when it is open", () => {
    expect(firstOpenInvoiceMonth("2026-10", () => false)).toBe("2026-10");
  });

  it("skips consecutive closed months (C9)", () => {
    const closed = new Set(["2026-10", "2026-11"]);
    expect(firstOpenInvoiceMonth("2026-10", (m) => closed.has(m))).toBe(
      "2026-12",
    );
  });

  it("crosses the year boundary", () => {
    const closed = new Set(["2026-12"]);
    expect(firstOpenInvoiceMonth("2026-12", (m) => closed.has(m))).toBe(
      "2027-01",
    );
  });

  it("allows 24 closed months followed by an open one", () => {
    let calls = 0;
    const month = firstOpenInvoiceMonth("2026-01", () => ++calls <= 24);
    expect(month).toBe("2028-01");
    expect(calls).toBe(25);
  });

  it("throws after 25 closed months", () => {
    let calls = 0;
    expect(() =>
      firstOpenInvoiceMonth("2026-10", () => ++calls <= 25),
    ).toThrow();
    expect(calls).toBe(25);
  });
});

describe("cardFaturaPair", () => {
  function item(closed: boolean, charges: number, payments: number[]) {
    return {
      summary: summarizeCardBill({
        closed,
        chargesCents: charges,
        totalOverrideCents: null,
        paymentCents: payments,
      }),
    };
  }
  const open = item(false, 5000, []);

  it("surfaces a closed unpaid previous fatura (P2)", () => {
    const previous = item(true, 10000, []);
    expect(cardFaturaPair({ open, previous })).toEqual({
      pending: previous,
      open,
    });
  });

  it("surfaces a closed partial previous fatura (P1)", () => {
    const previous = item(true, 10000, [4000]);
    expect(cardFaturaPair({ open, previous }).pending).toBe(previous);
  });

  it("drops a paid previous fatura (P3)", () => {
    expect(
      cardFaturaPair({ open, previous: item(true, 10000, [10000]) }).pending,
    ).toBeNull();
  });

  it("drops a nothing_due previous fatura (P4)", () => {
    expect(
      cardFaturaPair({ open, previous: item(true, 0, []) }).pending,
    ).toBeNull();
  });

  it("drops an overpaid previous fatura (P4)", () => {
    expect(
      cardFaturaPair({ open, previous: item(true, 10000, [12000]) }).pending,
    ).toBeNull();
  });

  it("drops a previous fatura that is not closed", () => {
    expect(
      cardFaturaPair({ open, previous: item(false, 10000, []) }).pending,
    ).toBeNull();
  });

  it("has no pending without a previous fatura (P6)", () => {
    expect(cardFaturaPair({ open, previous: null })).toEqual({
      pending: null,
      open,
    });
  });
});

describe("shiftInstallmentPlan", () => {
  const planResult = createInstallmentPlan({
    householdId: "house-1",
    creditCardId: "card-1",
    description: "Geladeira",
    totalAmount: brl(30000),
    installmentCount: 3,
    purchasedOn: "2026-11-20",
    createdByUserId: "user-1",
  });
  if (!planResult.ok) throw new Error("fixture plan invalid");
  const plan = planResult.value;

  it("moves every parcel forward, across the year boundary", () => {
    const shifted = shiftInstallmentPlan(plan, 2);
    expect(shifted.installments.map((i) => i.dueMonth)).toEqual([
      "2027-01",
      "2027-02",
      "2027-03",
    ]);
  });

  it("keeps everything else", () => {
    const shifted = shiftInstallmentPlan(plan, 1);
    expect(shifted.group).toEqual(plan.group);
    expect(
      shifted.installments.map(({ dueMonth: _, ...rest }) => rest),
    ).toEqual(plan.installments.map(({ dueMonth: _, ...rest }) => rest));
  });

  it("returns an equal plan for 0 months", () => {
    expect(shiftInstallmentPlan(plan, 0)).toEqual(plan);
  });

  it("does not mutate the input", () => {
    const before = structuredClone(plan);
    shiftInstallmentPlan(plan, 3);
    expect(plan).toEqual(before);
  });
});
