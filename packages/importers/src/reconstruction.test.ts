import { describe, it, expect } from "vitest";
import { brl } from "@family-finance/domain";
import {
  splitFlatAndInstallmentRows,
  matchExistingGroup,
} from "./reconstruction.js";
import type { NormalizedImportRow } from "./types.js";

function row(over: Partial<NormalizedImportRow>): NormalizedImportRow {
  return {
    sourceLine: 2,
    occurredOn: "2026-05-30",
    description: "LOJA",
    amount: brl(41661),
    kind: "expense",
    ...over,
  };
}

describe("splitFlatAndInstallmentRows", () => {
  it("keeps flat rows and converts parcela rows into inferred groups", () => {
    const rows = [
      row({ description: "SUPERMERCADO" }),
      row({
        description: "MERCADOLIVRE*LOJA",
        occurredOn: "2026-05-02",
        installment: { number: 14, count: 18 },
      }),
    ];
    const { flatRowIndices, groups } = splitFlatAndInstallmentRows(rows, "2026-06");
    expect(flatRowIndices).toEqual([0]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      rowIndex: 1,
      installmentNumber: 14,
      installmentCount: 18,
      perInstallmentCents: 41661,
      estimatedTotalCents: 41661 * 18,
      purchaseMonth: "2025-05", // 2026-06 − 13 months
      purchasedOn: "2025-05-02", // row day 02 carried into the inferred month
    });
  });

  it("clamps the purchase day to the inferred month's length", () => {
    const rows = [
      row({
        occurredOn: "2026-05-31",
        installment: { number: 4, count: 6 },
      }),
    ];
    const { groups } = splitFlatAndInstallmentRows(rows, "2026-05");
    // 2026-05 − 3 = 2026-02; day 31 -> 28
    expect(groups[0]?.purchasedOn).toBe("2026-02-28");
  });

  it("parcela 1 de N stays in the statement month", () => {
    const rows = [
      row({ occurredOn: "2026-06-10", installment: { number: 1, count: 3 } }),
    ];
    const { groups } = splitFlatAndInstallmentRows(rows, "2026-06");
    expect(groups[0]?.purchaseMonth).toBe("2026-06");
    expect(groups[0]?.purchasedOn).toBe("2026-06-10");
  });
});

describe("matchExistingGroup", () => {
  const inferred = {
    rowIndex: 0,
    sourceLine: 2,
    description: "MERCADOLIVRE*LOJA",
    installmentNumber: 14,
    installmentCount: 18,
    perInstallmentCents: 41661,
    estimatedTotalCents: 749898,
    purchaseMonth: "2025-05",
    purchasedOn: "2025-05-02",
  };

  it("matches on normalized description + count + purchase month", () => {
    const existing = [
      { description: "  mercadolivre*loja ", installmentCount: 18, purchasedOn: "2025-05-15" },
    ];
    expect(matchExistingGroup(inferred, existing)).toBe(0);
  });

  it("returns null when count or month differ", () => {
    expect(
      matchExistingGroup(inferred, [
        { description: "MERCADOLIVRE*LOJA", installmentCount: 12, purchasedOn: "2025-05-02" },
        { description: "MERCADOLIVRE*LOJA", installmentCount: 18, purchasedOn: "2025-06-02" },
      ]),
    ).toBeNull();
  });
});
