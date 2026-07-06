import { describe, expect, it } from "vitest";

import {
  addMonthsYm,
  createObligationDraft,
  obligationEndMonth,
  paidKey,
  projectObligations,
  type ProjectableObligation,
} from "./obligations.js";

describe("addMonthsYm", () => {
  it("adds months across year boundaries", () => {
    expect(addMonthsYm("2026-10", 71)).toBe("2032-09");
    expect(addMonthsYm("2026-12", 1)).toBe("2027-01");
    expect(addMonthsYm("2026-01", -1)).toBe("2025-12");
    expect(addMonthsYm("2026-05", 0)).toBe("2026-05");
  });

  it("rejects malformed months", () => {
    expect(() => addMonthsYm("2026-13", 1)).toThrow();
    expect(() => addMonthsYm("2026-1", 1)).toThrow();
    expect(() => addMonthsYm("solar", 1)).toThrow();
  });
});

describe("obligationEndMonth", () => {
  it("derives the last due month from the term", () => {
    expect(obligationEndMonth("2026-10", 72)).toBe("2032-09");
    expect(obligationEndMonth("2026-10", 1)).toBe("2026-10");
  });

  it("is null for indefinite obligations", () => {
    expect(obligationEndMonth("2026-10", null)).toBeNull();
  });
});

describe("createObligationDraft", () => {
  const base = {
    householdId: "house-1",
    description: "Parcela solar",
    amountCents: 71044,
    startMonth: "2026-10",
    termMonths: 72,
    dueDay: 5,
    accountId: "acc-1",
    createdByUserId: "user-1",
  };

  it("accepts the solar financing example", () => {
    const result = createObligationDraft(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      householdId: "house-1",
      description: "Parcela solar",
      amountCents: 71044,
      startMonth: "2026-10",
      termMonths: 72,
      dueDay: 5,
      category: {},
      responsibility: { scope: "household" },
      accountId: "acc-1",
      createdByUserId: "user-1",
    });
  });

  it("normalizes an omitted term to null (indefinite)", () => {
    const result = createObligationDraft({ ...base, termMonths: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.termMonths).toBeNull();
  });

  it("assigns user responsibility when responsibleUserId is set", () => {
    const result = createObligationDraft({
      ...base,
      responsibleUserId: "user-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.responsibility).toEqual({
      scope: "user",
      userId: "user-2",
    });
  });

  it("trims the description and keeps the category ref", () => {
    const result = createObligationDraft({
      ...base,
      description: "  Aluguel  ",
      category: { categoryId: "cat-1", subcategoryId: "sub-1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBe("Aluguel");
    expect(result.value.category).toEqual({
      categoryId: "cat-1",
      subcategoryId: "sub-1",
    });
  });

  it.each([
    ["dueDay 0", { dueDay: 0 }],
    ["dueDay 29", { dueDay: 29 }],
    ["amount 0", { amountCents: 0 }],
    ["negative amount", { amountCents: -100 }],
    ["fractional amount", { amountCents: 10.5 }],
    ["bad startMonth", { startMonth: "2026-13" }],
    ["empty description", { description: "   " }],
    ["termMonths 0", { termMonths: 0 }],
    ["fractional term", { termMonths: 1.5 }],
    ["empty accountId", { accountId: "" }],
  ])("rejects %s", (_label, patch) => {
    const result = createObligationDraft({ ...base, ...patch });
    expect(result.ok).toBe(false);
  });
});

describe("projectObligations", () => {
  const solar: ProjectableObligation = {
    id: "ob-solar",
    description: "Parcela solar",
    amountCents: 71044,
    startMonth: "2026-10",
    termMonths: 72,
    dueDay: 5,
    accountId: "acc-1",
    status: "active",
  };
  const rent: ProjectableObligation = {
    id: "ob-rent",
    description: "Aluguel",
    amountCents: 120000,
    startMonth: "2026-01",
    termMonths: null,
    dueDay: 10,
    accountId: "acc-1",
    status: "active",
  };

  it("clips a fixed-term obligation to its own window", () => {
    // Window straddles the start: only oct..dec 2026 project.
    const entries = projectObligations([solar], {
      fromMonth: "2026-08",
      toMonth: "2026-12",
    });
    expect(entries.map((e) => e.month)).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
    expect(entries[0]).toEqual({
      obligationId: "ob-solar",
      month: "2026-10",
      amountCents: 71044,
      description: "Parcela solar",
      dueDay: 5,
      accountId: "acc-1",
    });
  });

  it("stops projecting after the term ends", () => {
    const entries = projectObligations([solar], {
      fromMonth: "2032-08",
      toMonth: "2032-12",
    });
    expect(entries.map((e) => e.month)).toEqual(["2032-08", "2032-09"]);
  });

  it("fills the whole window for indefinite obligations", () => {
    const entries = projectObligations([rent], {
      fromMonth: "2026-11",
      toMonth: "2027-02",
    });
    expect(entries.map((e) => e.month)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("suppresses months already paid", () => {
    const paid = new Set([paidKey("ob-rent", "2026-12")]);
    const entries = projectObligations([rent], {
      fromMonth: "2026-11",
      toMonth: "2027-01",
      paid,
    });
    expect(entries.map((e) => e.month)).toEqual(["2026-11", "2027-01"]);
  });

  it("excludes non-active obligations", () => {
    const canceled: ProjectableObligation = { ...rent, status: "canceled" };
    const ended: ProjectableObligation = { ...solar, status: "ended" };
    expect(
      projectObligations([canceled, ended], {
        fromMonth: "2026-10",
        toMonth: "2026-12",
      }),
    ).toEqual([]);
  });

  it("sorts by month then description", () => {
    const entries = projectObligations([solar, rent], {
      fromMonth: "2026-10",
      toMonth: "2026-11",
    });
    expect(
      entries.map((e) => `${e.month} ${e.description}`),
    ).toEqual([
      "2026-10 Aluguel",
      "2026-10 Parcela solar",
      "2026-11 Aluguel",
      "2026-11 Parcela solar",
    ]);
  });

  it("returns [] for no obligations or an inverted window", () => {
    expect(
      projectObligations([], { fromMonth: "2026-01", toMonth: "2026-12" }),
    ).toEqual([]);
    expect(
      projectObligations([rent], { fromMonth: "2026-12", toMonth: "2026-01" }),
    ).toEqual([]);
  });
});
