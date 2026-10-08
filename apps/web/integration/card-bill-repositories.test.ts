import { describe, expect, it } from "vitest";
import {
  closeCardBill,
  reopenCardBill,
  setCardBillTotal,
  getCardBillOverview,
  getCardFaturaPairs,
  getMonthlySummary,
  getCardPressure,
  settleCardBill,
  findCardBillPayments,
  deleteCardBillPayment,
  type AppSupabaseClient,
} from "@family-finance/db";
import { createFakeSupabaseClient, FakeSupabaseStore } from "./fake-supabase";

function fixture() {
  const store = new FakeSupabaseStore({
    credit_cards: [
      {
        id: "card-1",
        household_id: "house-1",
        name: "Nubank",
        closing_day: 28,
        due_day: 5,
      },
    ],
    accounts: [{ id: "account-1", household_id: "house-1", name: "Conta" }],
    card_bill_closures: [
      {
        household_id: "house-1",
        credit_card_id: "card-1",
        bill_month: "2026-10",
        state: "closed",
        total_override_cents: null,
      },
    ],
    transactions: [
      {
        id: "charge-1",
        household_id: "house-1",
        credit_card_id: "card-1",
        account_id: null,
        kind: "expense",
        occurred_on: "2026-10-30",
        invoice_month: "2026-11",
        amount_cents: 1000,
        bill_month: null,
      },
    ],
    installments: [
      {
        id: "parcel-1",
        household_id: "house-1",
        credit_card_id: "card-1",
        due_month: "2026-10",
        amount_cents: 500,
      },
    ],
  });
  const client = createFakeSupabaseClient(
    store,
  ) as unknown as AppSupabaseClient;
  return { store, client };
}
const input = {
  householdId: "house-1",
  creditCardId: "card-1",
  month: "2026-10",
  totalOverrideCents: null,
  userId: "user-1",
};
const draft = {
  householdId: "house-1",
  creditCardId: "card-1",
  accountId: "account-1",
  billMonth: "2026-10",
  amountCents: 300,
  paidOn: "2026-10-06",
  createdByUserId: "user-1",
  idempotencyKey: "payment-key",
};

describe("card bill repositories against the web fake", () => {
  it("reads seeded closures, attribution, and payments without changing spending (D12)", async () => {
    const { client, store } = fixture();
    store.table("transactions").push({
      id: "payment-seed",
      household_id: "house-1",
      kind: "transfer",
      credit_card_id: "card-1",
      account_id: "account-1",
      amount_cents: 200,
      bill_month: "2026-10",
      invoice_month: null,
      occurred_on: "2026-10-06",
    });
    const pairs = await getCardFaturaPairs(client, "house-1", "2026-10-06");
    expect(pairs[0]).toMatchObject({
      pending: {
        month: "2026-10",
        summary: {
          chargesCents: 500,
          paidCents: 200,
          remainingCents: 300,
          status: "closed_partial",
        },
      },
      open: { month: "2026-11", summary: { chargesCents: 1000, paidCents: 0 } },
    });
    const beforeSummary = await getMonthlySummary(client, "house-1", "2026-10");
    const beforePressure = await getCardPressure(client, "house-1", "2026-10");
    expect(beforeSummary.expenseCents).toBe(1000);
    expect(beforePressure.totalCents).toBe(1500);
    await closeCardBill(client, { ...input, totalOverrideCents: 900 });
    await settleCardBill(client, draft);
    expect(await getMonthlySummary(client, "house-1", "2026-10")).toEqual(
      beforeSummary,
    );
    expect(await getCardPressure(client, "house-1", "2026-10")).toEqual(
      beforePressure,
    );
  });

  it("upserts a closure, adjusts its total, then clears the override on reopen", async () => {
    const { client, store } = fixture();
    await closeCardBill(client, { ...input, totalOverrideCents: 500 });
    expect(store.table("card_bill_closures")).toHaveLength(1);
    expect(store.table("card_bill_closures")[0]).toMatchObject({
      state: "closed",
      total_override_cents: null,
      updated_by_user_id: "user-1",
    });
    await setCardBillTotal(client, { ...input, totalOverrideCents: 700 });
    expect(
      (
        await getCardBillOverview(client, "house-1", "2026-10", "2026-10-30")
      )[0]!.summary.totalCents,
    ).toBe(700);
    await reopenCardBill(client, input);
    expect(
      (
        await getCardBillOverview(client, "house-1", "2026-10", "2026-10-30")
      )[0]!.summary,
    ).toMatchObject({
      closed: false,
      totalCents: 500,
      totalOverrideCents: null,
    });
  });

  it("supports separate payments, key replay, and undo", async () => {
    const { client } = fixture();
    const first = await settleCardBill(client, draft);
    expect(first.replayed).toBe(false);
    expect(first.transaction).toMatchObject({
      invoice_month: null,
      idempotency_key: draft.idempotencyKey,
    });
    expect(await settleCardBill(client, draft)).toMatchObject({
      replayed: true,
      transaction: { id: first.transaction.id },
    });
    await settleCardBill(client, {
      ...draft,
      idempotencyKey: "second-key",
      amountCents: 200,
    });
    expect(
      await findCardBillPayments(client, "house-1", ["2026-10"]),
    ).toHaveLength(2);
    await deleteCardBillPayment(client, "house-1", first.transaction.id);
    expect(
      await findCardBillPayments(client, "house-1", ["2026-10"]),
    ).toHaveLength(1);
    await expect(
      deleteCardBillPayment(client, "house-1", "charge-1"),
    ).rejects.toThrow("Pagamento não encontrado.");
  });

  it("rejects reuse of a payment key with different data", async () => {
    const { client } = fixture();
    await settleCardBill(client, draft);
    await expect(
      settleCardBill(client, { ...draft, amountCents: 999 }),
    ).rejects.toThrow("idempotency key reused with a different payment");
  });
});
