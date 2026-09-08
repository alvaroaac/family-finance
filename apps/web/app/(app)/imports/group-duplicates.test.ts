import { describe, expect, it } from "vitest";

import {
  findInstallmentCandidateMatches,
  hasLegacyInstallmentGroupOnCard,
  hasUniqueVeryStrongMatch,
  type ExistingInstallmentCandidate,
} from "./group-duplicates";

const inferred = {
  rowIndex: 0,
  sourceLine: 2,
  description: "Notebook",
  installmentCount: 10,
  installmentNumber: 2,
  purchasedOn: "2026-06-01",
  purchaseMonth: "2026-06",
  perInstallmentCents: 10000,
  estimatedTotalCents: 100000,
};

describe("legacy installment duplicate scope", () => {
  it("matches only on the selected card", () => {
    const existing = [
      {
        creditCardId: "card-a",
        description: "Notebook",
        installmentCount: 10,
        purchasedOn: "2026-06-01",
      },
    ];
    expect(hasLegacyInstallmentGroupOnCard(inferred, "card-a", existing)).toBe(
      true,
    );
    expect(hasLegacyInstallmentGroupOnCard(inferred, "card-b", existing)).toBe(
      false,
    );
  });
});

const candidate = (
  overrides: Partial<ExistingInstallmentCandidate> = {},
): ExistingInstallmentCandidate => ({
  installmentGroupId: "group-1",
  creditCardId: "card-a",
  cardName: "Mercado Pago",
  description: "Teclado sem fio",
  totalAmountCents: 41990,
  purchasedOn: "2026-08-24",
  installmentNumber: 1,
  installmentCount: 10,
  amountCents: 4199,
  ...overrides,
});

describe("installment candidate confidence", () => {
  const statementGroup = {
    ...inferred,
    description: "MARKETPLACE*LOJA",
    installmentNumber: 1,
    installmentCount: 10,
    perInstallmentCents: 4199,
    estimatedTotalCents: 41990,
    purchaseMonth: "2026-08",
    purchasedOn: "2026-08-17",
  };

  it("marks different statement and dashboard descriptions very strong when value, count and card match", () => {
    const matches = findInstallmentCandidateMatches(statementGroup, "card-a", [
      candidate(),
    ]);

    expect(matches).toMatchObject([
      {
        description: "Teclado sem fio",
        confidence: "very_strong",
        exactAmount: true,
        amountDifferenceCents: 0,
      },
    ]);
    expect(hasUniqueVeryStrongMatch(matches)).toBe(true);
  });

  it("uses medium for amount alone and strong when the count also matches", () => {
    const matches = findInstallmentCandidateMatches(statementGroup, "card-a", [
      candidate({
        installmentGroupId: "amount-only",
        creditCardId: "card-b",
        installmentCount: 4,
      }),
      candidate({
        installmentGroupId: "amount-count",
        creditCardId: "card-b",
      }),
    ]);

    expect(matches.map((match) => match.confidence)).toEqual([
      "strong",
      "medium",
    ]);
  });

  it("demotes fuzzy matches and rejects a value outside the bounded tolerance", () => {
    const matches = findInstallmentCandidateMatches(statementGroup, "card-a", [
      candidate({ installmentGroupId: "under-five", amountCents: 4000 }),
      candidate({ installmentGroupId: "under-ten", amountCents: 3850 }),
      candidate({ installmentGroupId: "over-ten", amountCents: 3700 }),
      candidate({
        installmentGroupId: "fuzzy-without-count",
        amountCents: 4100,
        installmentCount: 4,
      }),
    ]);

    expect(
      matches.map((match) => [match.installmentGroupId, match.confidence]),
    ).toEqual([
      ["under-five", "strong"],
      ["under-ten", "medium"],
    ]);
  });

  it("does not treat the same installment position as a uniqueness signal", () => {
    const matches = findInstallmentCandidateMatches(statementGroup, "card-a", [
      candidate({
        installmentGroupId: "different-value",
        amountCents: 9999,
        installmentNumber: 1,
      }),
    ]);

    expect(matches).toEqual([]);
  });

  it("does not call two equally strong purchases unique", () => {
    const matches = findInstallmentCandidateMatches(statementGroup, "card-a", [
      candidate({ installmentGroupId: "group-1" }),
      candidate({ installmentGroupId: "group-2", description: "Teclado" }),
    ]);

    expect(hasUniqueVeryStrongMatch(matches)).toBe(false);
  });
});
