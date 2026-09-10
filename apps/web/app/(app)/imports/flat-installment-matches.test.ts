import { describe, it, expect } from "vitest";
import type { TransactionRow } from "@family-finance/db";
import { findFlatInstallmentMatches } from "./flat-installment-matches";

const purchase = {
  description: "Prevencar",
  totalAmountCents: 69750,
  purchasedOn: "2026-08-18",
};
const original: TransactionRow = {
  id: "original",
  household_id: "home",
  kind: "expense",
  amount_cents: 69750,
  description: "Prevencar",
  occurred_on: "2026-08-17",
  credit_card_id: "nubank",
  account_id: null,
  category_id: "insurance",
  subcategory_id: null,
  installment_id: null,
  import_batch_id: null,
  obligation_id: null,
  obligation_month: null,
  bill_month: null,
  responsibility_scope: "household",
  responsible_user_id: null,
  created_by_user_id: "user",
  created_at: "2026-08-17",
  updated_at: "2026-08-17",
};
describe("manual expense to installment candidates", () => {
  it("matches Prevencar by total, normalized name, and purchase month", () => {
    expect(
      findFlatInstallmentMatches(purchase, "nubank", [
        { ...original, description: " PRÉVENCAR " },
      ])[0],
    ).toMatchObject({
      transactionId: "original",
      confidence: "very_strong",
      categoryId: "insurance",
    });
  });
  it("shows a different payment instrument as strong, never automatic", () => {
    expect(
      findFlatInstallmentMatches(purchase, "nubank", [
        { ...original, credit_card_id: null, account_id: "account" },
      ])[0],
    ).toMatchObject({ confidence: "strong", differentInstrument: true });
  });
  it.each([
    { amount_cents: 23250 },
    { amount_cents: 69749 },
    { description: "Outra compra" },
    { occurred_on: "2026-07-18" },
    { installment_id: "parcel" },
    { import_batch_id: "batch" },
    { obligation_id: "obligation" },
    { kind: "income" as const },
  ])("rejects incompatible or already-linked expenses %j", (change) => {
    expect(
      findFlatInstallmentMatches(purchase, "nubank", [
        { ...original, ...change },
      ]),
    ).toEqual([]);
  });
  it("retains every candidate when two purchases look identical", () => {
    expect(
      findFlatInstallmentMatches(purchase, "nubank", [
        original,
        { ...original, id: "second" },
      ]),
    ).toHaveLength(2);
  });
});
