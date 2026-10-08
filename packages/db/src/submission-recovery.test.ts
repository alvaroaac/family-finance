import { describe, expect, it } from "vitest";
import {
  CardBillSettlementError,
  findInstallmentPurchaseFirstDueMonth,
  reconcileLegacyCardBillPayment,
  settleCardBill,
  type AppSupabaseClient,
} from "./repositories.js";

type Row = Record<string, unknown>;
const draft = {
  householdId: "house-1",
  creditCardId: "card-1",
  accountId: "account-1",
  billMonth: "2026-09",
  paidOn: "2026-10-08",
  amountCents: 5000,
  createdByUserId: "user-1",
  idempotencyKey: "payment-key",
};
const payment = {
  id: "payment-1",
  household_id: "house-1",
  credit_card_id: "card-1",
  kind: "transfer",
  account_id: "account-1",
  bill_month: "2026-09",
  occurred_on: "2026-10-08",
  amount_cents: 5000,
  created_by_user_id: "user-1",
  idempotency_key: null,
};
function clientFor(
  tables: Record<string, Row[]>,
  failRead = false,
  code = "22023",
) {
  return {
    rpc: async () => ({
      data: null,
      error: {
        code,
        message: "SQL validation",
        details: "details",
        hint: "hint",
      },
    }),
    from(table: string) {
      let rows = tables[table] ?? [];
      const finish = () => ({
        data: rows,
        error: failRead ? { message: "read failed" } : null,
      });
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        is(column: string, value: unknown) {
          rows = rows.filter((row) => (row[column] ?? null) === value);
          return query;
        },
        async maybeSingle() {
          return { ...finish(), data: rows[0] ?? null };
        },
        async single() {
          return { ...finish(), data: rows[0] ?? null };
        },
        then(resolve: (result: ReturnType<typeof finish>) => unknown) {
          return Promise.resolve(finish()).then(resolve);
        },
      };
      return query;
    },
  } as unknown as AppSupabaseClient;
}

describe("settlement outcome classification", () => {
  it.each([
    ["no prior payment", [], false, "22023", true],
    [
      "prior payment under this key",
      [{ ...payment, idempotency_key: draft.idempotencyKey }],
      false,
      "22023",
      false,
    ],
    ["failed reconciliation read", [], true, "22023", false],
    ["unknown/transport error", [], false, "", false],
    [
      "same key in another household",
      [
        {
          ...payment,
          household_id: "other-house",
          idempotency_key: draft.idempotencyKey,
        },
      ],
      false,
      "22023",
      true,
    ],
  ] as const)(
    "classifies %s without losing SQL details",
    async (_label, rows, failRead, code, safe) => {
      const error = await settleCardBill(
        clientFor({ transactions: [...rows] }, failRead, code),
        draft,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(CardBillSettlementError);
      expect(error).toMatchObject({
        code,
        details: "details",
        hint: "hint",
        definitiveNoWrite: safe,
      });
    },
  );
});

describe("legacy household-scoped recovery", () => {
  it("does not reconcile another household's null-key payment", async () => {
    expect(
      await reconcileLegacyCardBillPayment(
        clientFor({
          transactions: [{ ...payment, household_id: "other-house" }],
        }),
        draft,
      ),
    ).toBe("none");
  });
  it("fails closed when legacy payment lookup is unavailable", async () => {
    await expect(
      reconcileLegacyCardBillPayment(clientFor({}, true), draft),
    ).rejects.toThrow("read failed");
  });
  it("recovers the original first month for the household's matching purchase key", async () => {
    const tables = {
      installment_groups: [
        {
          id: "other-group",
          household_id: "other-house",
          idempotency_key: "purchase-key",
        },
        {
          id: "our-group",
          household_id: "house-1",
          idempotency_key: "purchase-key",
        },
      ],
      installments: [
        {
          household_id: "other-house",
          installment_group_id: "other-group",
          number: 1,
          due_month: "2026-11",
        },
        {
          household_id: "house-1",
          installment_group_id: "our-group",
          number: 1,
          due_month: "2026-09",
        },
      ],
    };
    expect(
      await findInstallmentPurchaseFirstDueMonth(
        clientFor(tables),
        "house-1",
        "purchase-key",
      ),
    ).toBe("2026-09");
    expect(
      await findInstallmentPurchaseFirstDueMonth(
        clientFor(tables),
        "third-house",
        "purchase-key",
      ),
    ).toBeNull();
  });
  it("does not resolve a new month for an existing purchase with missing schedule", async () => {
    await expect(
      findInstallmentPurchaseFirstDueMonth(
        clientFor({
          installment_groups: [
            {
              id: "our-group",
              household_id: "house-1",
              idempotency_key: "purchase-key",
            },
          ],
        }),
        "house-1",
        "purchase-key",
      ),
    ).rejects.toThrow("invalid first parcel");
  });
});
