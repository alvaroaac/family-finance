import { describe, expect, it } from "vitest";
import { entrySchema } from "@family-finance/mobile-contracts";
const id = "00000000-0000-4000-8000-000000000001";
const valid = {
  id,
  description: "Mercado",
  amountCents: 100,
  kind: "expense",
  date: "2026-09-05",
  categoryId: null,
  subcategoryId: null,
  accountId: id,
  creditCardId: null,
  responsibleUserId: null,
  installmentCount: 1,
};
describe("native write contract", () => {
  it("accepts an ordinary account expense", () =>
    expect(entrySchema.safeParse(valid).success).toBe(true));
  it.each([
    { amountCents: 0 },
    { amountCents: -100 },
    { amountCents: 10.5 },
    { amountCents: 1e12 },
    { date: "2026-02-30" },
    { kind: "transfer" },
    { accountId: null },
    { creditCardId: id },
    { installmentCount: 3 },
    { description: " " },
  ])("rejects invalid or ambiguous financial data %j", (patch) =>
    expect(entrySchema.safeParse({ ...valid, ...patch }).success).toBe(false),
  );
  it("accepts installments only for card expenses", () => {
    expect(
      entrySchema.safeParse({
        ...valid,
        accountId: null,
        creditCardId: id,
        installmentCount: 3,
      }).success,
    ).toBe(true);
    expect(
      entrySchema.safeParse({
        ...valid,
        kind: "income",
        accountId: null,
        creditCardId: id,
      }).success,
    ).toBe(false);
  });
});
