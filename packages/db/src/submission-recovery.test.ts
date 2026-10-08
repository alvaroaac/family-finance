import { describe, expect, it, vi } from "vitest";
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
    [
      "authoritative absence",
      "22023",
      "card_bill_definitive_no_write_v1",
      true,
    ],
    ["prior-key mismatch", "22023", undefined, false],
    ["inactive member with hidden rows", "42501", undefined, false],
    ["unmarked validation even when RLS is empty", "22023", undefined, false],
    ["unknown transport error", "", "card_bill_definitive_no_write_v1", false],
  ] as const)(
    "classifies %s without an RLS absence lookup",
    async (_label, code, hint, safe) => {
      const from = vi.fn(() => {
        throw new Error("RLS read must not classify a write");
      });
      const client = {
        rpc: async () => ({
          data: null,
          error: { code, hint, details: "details", message: "SQL validation" },
        }),
        from,
      } as unknown as AppSupabaseClient;
      const error = await settleCardBill(client, draft).catch((error) => error);
      expect(error).toBeInstanceOf(CardBillSettlementError);
      expect(error).toMatchObject({
        code,
        hint,
        details: "details",
        definitiveNoWrite: safe,
      });
      expect(from).not.toHaveBeenCalled();
    },
  );
});

describe("legacy household-scoped recovery", () => {
  it.each(["none", "matched", "ambiguous"] as const)(
    "uses the authoritative %s outcome",
    async (outcome) => {
      const rpc = vi.fn(async () => ({ data: outcome, error: null }));
      const client = { rpc } as unknown as AppSupabaseClient;
      expect(await reconcileLegacyCardBillPayment(client, draft)).toBe(outcome);
      expect(rpc).toHaveBeenCalledWith("reconcile_legacy_card_bill_payment", {
        target_household_id: draft.householdId,
        target_credit_card_id: draft.creditCardId,
        target_account_id: draft.accountId,
        target_bill_month: draft.billMonth,
        target_amount_cents: draft.amountCents,
        target_paid_on: draft.paidOn,
        target_created_by_user_id: draft.createdByUserId,
      });
    },
  );
  it("fails closed after deactivation even if RLS would hide the prior payment", async () => {
    await expect(
      reconcileLegacyCardBillPayment(clientFor({}, false, "42501"), draft),
    ).rejects.toThrow("SQL validation");
  });
  it("rejects malformed recovery responses", async () => {
    const client = {
      rpc: async () => ({ data: null, error: null }),
    } as unknown as AppSupabaseClient;
    await expect(reconcileLegacyCardBillPayment(client, draft)).rejects.toThrow(
      "invalid outcome",
    );
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
