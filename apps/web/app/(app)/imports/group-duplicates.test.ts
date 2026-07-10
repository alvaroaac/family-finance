import { describe, expect, it } from "vitest";

import { hasLegacyInstallmentGroupOnCard } from "./group-duplicates";

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
