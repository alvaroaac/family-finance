import { describe, expect, it, vi } from "vitest";
import { createInstallmentPlan, addMonthsYm } from "@family-finance/domain";
import {
  closeCardBill,
  reopenCardBill,
  setCardBillTotal,
  findCardBillPayments,
  findCardBillClosures,
  deleteCardBillPayment,
  getCardBillCharges,
  getCardBillOverview,
  getCardFaturaPairs,
  planWithOpenFaturas,
  createInstallmentPurchase,
  settleCardBill,
  type AppSupabaseClient,
} from "./index.js";

type Row = Record<string, unknown>;
const HOUSEHOLD = "house-1";
const card = (id = "card-1", closingDay: number | null = 28): Row => ({
  id,
  household_id: HOUSEHOLD,
  name: id,
  closing_day: closingDay,
  due_day: 5,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
});
const charge = (amount: number, month = "2026-10", extra: Row = {}): Row => ({
  id: "charge-1",
  household_id: HOUSEHOLD,
  credit_card_id: "card-1",
  kind: "expense",
  amount_cents: amount,
  invoice_month: month,
  occurred_on: "2026-10-30",
  ...extra,
});
const payment = (amount: number, month = "2026-10", extra: Row = {}): Row => ({
  id: "payment-1",
  household_id: HOUSEHOLD,
  credit_card_id: "card-1",
  account_id: "account-1",
  kind: "transfer",
  bill_month: month,
  invoice_month: null,
  amount_cents: amount,
  occurred_on: "2026-10-06",
  ...extra,
});
const closure = (month = "2026-10", extra: Row = {}): Row => ({
  household_id: HOUSEHOLD,
  credit_card_id: "card-1",
  bill_month: month,
  state: "closed",
  total_override_cents: null,
  ...extra,
});

/** Recording, filtering mock: exercises query scoping as well as returned data. */
function mockClient(
  seed: Record<string, Row[]> = {},
  error: string | null = null,
) {
  const tables = { ...seed };
  const calls: { table: string; operations: [string, ...unknown[]][] }[] = [];
  const rpc = vi.fn(async () => ({
    data: { transaction: { id: "tx-1" }, replayed: false },
    error: null,
  }));
  const client = {
    rpc,
    from(table: string) {
      const operations: [string, ...unknown[]][] = [];
      calls.push({ table, operations });
      let rows = tables[table] ?? [];
      let filtered = [...rows];
      let remove = false;
      let upsert: Row | null = null;
      let conflict = "";
      let single = false;
      const query = {
        select(columns: string) {
          operations.push(["select", columns]);
          return query;
        },
        eq(column: string, value: unknown) {
          operations.push(["eq", column, value]);
          filtered = filtered.filter((r) => r[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          operations.push(["in", column, values]);
          filtered = filtered.filter((r) => values.includes(r[column]));
          return query;
        },
        not(column: string, operator: string, value: unknown) {
          operations.push(["not", column, operator, value]);
          filtered = filtered.filter((r) => r[column] != null);
          return query;
        },
        order(column: string) {
          operations.push(["order", column]);
          return query;
        },
        range(from: number, to: number) {
          operations.push(["range", from, to]);
          filtered = filtered.slice(from, to + 1);
          return query;
        },
        delete() {
          remove = true;
          operations.push(["delete"]);
          return query;
        },
        upsert(payload: Row, options: { onConflict: string }) {
          upsert = payload;
          conflict = options.onConflict;
          operations.push(["upsert", payload, options]);
          return query;
        },
        single() {
          single = true;
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          if (error !== null)
            return Promise.resolve(
              resolve({ data: null, error: { message: error } }),
            );
          if (remove) tables[table] = rows.filter((r) => !filtered.includes(r));
          if (upsert !== null) {
            const payload = upsert;
            const existing = rows.find((r) =>
              conflict.split(",").every((key) => r[key] === payload[key]),
            );
            if (existing) Object.assign(existing, payload);
            else {
              rows.push({ ...payload });
              tables[table] = rows;
            }
          }
          return Promise.resolve(
            resolve({
              data: single ? (filtered[0] ?? null) : filtered,
              error: null,
            }),
          );
        },
      };
      return query;
    },
  } as unknown as AppSupabaseClient;
  return { client, calls, tables, rpc };
}

const input = {
  householdId: HOUSEHOLD,
  creditCardId: "card-1",
  month: "2026-10",
  totalOverrideCents: null,
  userId: "user-1",
};

describe("card bill repositories", () => {
  it.each([false, true])(
    "sends the payment key and returns replayed=%s",
    async (replayed) => {
      const { client, rpc } = mockClient();
      rpc.mockResolvedValueOnce({
        data: { transaction: { id: "tx-1" }, replayed },
        error: null,
      });
      const result = await settleCardBill(client, {
        householdId: HOUSEHOLD,
        creditCardId: "card-1",
        accountId: "account-1",
        amountCents: 500,
        billMonth: "2026-10",
        paidOn: "2026-10-06",
        createdByUserId: "user-1",
        idempotencyKey: "payment-key",
      });
      expect(result).toEqual({ transaction: { id: "tx-1" }, replayed });
      expect(rpc).toHaveBeenCalledWith(
        "settle_card_bill",
        expect.objectContaining({ target_idempotency_key: "payment-key" }),
      );
    },
  );

  it("reads payments for all requested bill months, regardless of payment date", async () => {
    const { client, calls } = mockClient({
      transactions: [
        payment(400, "2026-09"),
        payment(600, "2026-11", { id: "payment-2" }),
        payment(900, "2026-10"),
        payment(100, "2026-09", { household_id: "other" }),
        charge(50, "2026-09", { bill_month: "2026-09" }),
      ],
    });
    expect(
      await findCardBillPayments(client, HOUSEHOLD, ["2026-09", "2026-11"]),
    ).toEqual([
      {
        id: "payment-1",
        creditCardId: "card-1",
        accountId: "account-1",
        amountCents: 400,
        paidOn: "2026-10-06",
        billMonth: "2026-09",
      },
      {
        id: "payment-2",
        creditCardId: "card-1",
        accountId: "account-1",
        amountCents: 600,
        paidOn: "2026-10-06",
        billMonth: "2026-11",
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("reads closures scoped to household and requested months", async () => {
    const { client, calls } = mockClient({
      card_bill_closures: [
        closure(),
        closure("2026-11", { state: "open" }),
        closure("2026-10", { household_id: "other" }),
      ],
    });
    expect(
      await findCardBillClosures(client, HOUSEHOLD, ["2026-10", "2026-11"]),
    ).toEqual([
      {
        creditCardId: "card-1",
        month: "2026-10",
        state: "closed",
        totalOverrideCents: null,
      },
      {
        creditCardId: "card-1",
        month: "2026-11",
        state: "open",
        totalOverrideCents: null,
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("skips queries for empty month lists", async () => {
    const { client, calls } = mockClient();
    expect(await findCardBillClosures(client, HOUSEHOLD, [])).toEqual([]);
    expect(await findCardBillPayments(client, HOUSEHOLD, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("sums invoice attribution and parcels using existing expense sign rules (C27, C28, E17)", async () => {
    const { client, calls } = mockClient({
      transactions: [
        charge(1000, "2026-11"),
        charge(-200, "2026-11", { id: "refund" }),
        charge(500, "2026-11", { kind: "income" }),
        payment(900, "2026-11"),
        charge(300, "2026-10"),
        charge(700, "2026-11", { household_id: "other" }),
        charge(600, "2026-11", { credit_card_id: "card-2" }),
      ],
      installments: [
        {
          household_id: HOUSEHOLD,
          credit_card_id: "card-1",
          due_month: "2026-11",
          amount_cents: 250,
        },
        {
          household_id: HOUSEHOLD,
          credit_card_id: "card-2",
          due_month: "2026-11",
          amount_cents: 900,
        },
      ],
    });
    expect(
      await getCardBillCharges(client, HOUSEHOLD, "card-1", "2026-11"),
    ).toBe(1050);
    expect(
      await getCardBillCharges(client, HOUSEHOLD, "card-1", "2026-10"),
    ).toBe(300);
    expect(JSON.stringify(calls)).not.toContain('"occurred_on"');
  });

  it.each([null, 1000, 1200, 0])(
    "closes with total %s, normalizing only the live sum (C17, C18)",
    async (total) => {
      const { client, tables } = mockClient({ transactions: [charge(1000)] });
      await closeCardBill(client, { ...input, totalOverrideCents: total });
      expect(tables.card_bill_closures).toEqual([
        expect.objectContaining({
          household_id: HOUSEHOLD,
          credit_card_id: "card-1",
          bill_month: "2026-10",
          state: "closed",
          total_override_cents: total === 1000 ? null : total,
          updated_by_user_id: "user-1",
          updated_at: expect.any(String),
        }),
      ]);
      expect(
        Number.isNaN(
          Date.parse(tables.card_bill_closures![0]!.updated_at as string),
        ),
      ).toBe(false);
    },
  );

  it.each([null, 1000, 1200, 0])(
    "sets total %s, normalizing only the live sum",
    async (total) => {
      const { client, tables } = mockClient({
        transactions: [charge(1000)],
        card_bill_closures: [
          closure("2026-10", { total_override_cents: 1200 }),
        ],
      });
      await setCardBillTotal(client, { ...input, totalOverrideCents: total });
      expect(tables.card_bill_closures).toHaveLength(1);
      expect(tables.card_bill_closures![0]).toMatchObject({
        state: "closed",
        total_override_cents: total === 1000 ? null : total,
        updated_by_user_id: "user-1",
      });
    },
  );

  it("updates an existing closure, clears its override and records the actor on reopen (C20)", async () => {
    const { client, tables } = mockClient({
      card_bill_closures: [closure("2026-10", { total_override_cents: 1200 })],
    });
    await reopenCardBill(client, input);
    expect(tables.card_bill_closures).toHaveLength(1);
    expect(tables.card_bill_closures![0]).toMatchObject({
      state: "open",
      total_override_cents: null,
      updated_by_user_id: "user-1",
      updated_at: expect.any(String),
    });
  });

  it("sets and clears a corrected total on an automatically closed bill (C19)", async () => {
    const { client, tables } = mockClient({
      credit_cards: [card()],
      transactions: [charge(1000)],
    });
    await setCardBillTotal(client, { ...input, totalOverrideCents: 1300 });
    expect(
      (
        await getCardBillOverview(client, HOUSEHOLD, "2026-10", "2026-10-30")
      )[0]!.summary.totalCents,
    ).toBe(1300);
    await setCardBillTotal(client, input);
    expect(tables.card_bill_closures![0]!.total_override_cents).toBeNull();
    expect(
      (
        await getCardBillOverview(client, HOUSEHOLD, "2026-10", "2026-10-30")
      )[0]!.summary.totalCents,
    ).toBe(1000);
  });

  it("deletes a bill payment (E13)", async () => {
    const { client, tables } = mockClient({
      transactions: [payment(500), charge(1000)],
    });
    await deleteCardBillPayment(client, HOUSEHOLD, "payment-1");
    expect(tables.transactions).toEqual([charge(1000)]);
  });

  it.each([
    charge(1000),
    payment(500, "2026-10", { household_id: "other" }),
    payment(500, "2026-10", { bill_month: null }),
  ])("rejects undo for a non-payment or foreign row (E14)", async (row) => {
    const { client, tables } = mockClient({ transactions: [row] });
    await expect(
      deleteCardBillPayment(client, HOUSEHOLD, row.id as string),
    ).rejects.toThrow("Pagamento não encontrado.");
    expect(tables.transactions).toEqual([row]);
  });

  it.each([
    ["2026-09", "paid", true],
    ["2026-11", "open_covered", false],
  ] as const)(
    "overview includes %s payments independently of their date (E4–E6)",
    async (month, status, closed) => {
      const { client } = mockClient({
        credit_cards: [card(), card("card-2", null)],
        transactions: [
          charge(1000, month),
          payment(600, month),
          payment(500, month, { id: "payment-2" }),
        ],
      });
      const overview = await getCardBillOverview(
        client,
        HOUSEHOLD,
        month,
        "2026-10-06",
      );
      expect(overview).toHaveLength(2);
      expect(overview[0]).toMatchObject({
        month,
        closingDate: `${month}-28`,
        summary: {
          chargesCents: 1000,
          totalCents: 1000,
          paidCents: 1100,
          remainingCents: 0,
          overpaidCents: 100,
          status,
          closed,
        },
      });
      expect(overview[0]!.payments).toHaveLength(2);
      expect(overview[1]).toMatchObject({
        closingDate: null,
        summary: { status: "open", totalCents: 0 },
      });
    },
  );

  it.each([null, 1500])(
    "closed totals follow edited/deleted charges unless overridden by %s (C12, C14)",
    async (override) => {
      const rows = [charge(1000), payment(800)];
      const { client } = mockClient({
        credit_cards: [card()],
        transactions: rows,
        card_bill_closures: [
          closure("2026-10", { total_override_cents: override }),
        ],
      });
      rows[0]!.amount_cents = 700;
      let summary = (
        await getCardBillOverview(client, HOUSEHOLD, "2026-10", "2026-10-06")
      )[0]!.summary;
      expect(summary).toMatchObject({
        chargesCents: 700,
        totalCents: override ?? 700,
        paidCents: 800,
      });
      rows.splice(0, 1);
      summary = (
        await getCardBillOverview(client, HOUSEHOLD, "2026-10", "2026-10-06")
      )[0]!.summary;
      expect(summary).toMatchObject({
        chargesCents: 0,
        totalCents: override ?? 0,
        overpaidCents: override === null ? 800 : 0,
      });
    },
  );

  it("batch pairs pick current manually closed and next open, ignoring older debt (P5–P7)", async () => {
    const { client, calls } = mockClient({
      credit_cards: [card(), card("card-2", null)],
      card_bill_closures: [closure()],
      transactions: [
        charge(1000),
        charge(500, "2026-09"),
        charge(200, "2026-11"),
        payment(300),
      ],
    });
    const pairs = await getCardFaturaPairs(client, HOUSEHOLD, "2026-10-06");
    expect(pairs[0]).toMatchObject({
      pending: { month: "2026-10", summary: { status: "closed_partial" } },
      open: { month: "2026-11", summary: { totalCents: 200 } },
    });
    expect(pairs[1]).toMatchObject({
      pending: null,
      open: { month: "2026-10" },
    });
    expect(calls.filter((c) => c.table === "card_bill_closures")).toHaveLength(
      1,
    );
    expect(
      calls.filter(
        (c) =>
          c.table === "transactions" &&
          c.operations.some(
            (o) => o[0] === "eq" && o[1] === "kind" && o[2] === "transfer",
          ),
      ),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.table === "installments")).toHaveLength(1);
  });

  it("only surfaces one month back and honors reopened automatic closures (P7, C8)", async () => {
    const { client } = mockClient({
      credit_cards: [card()],
      card_bill_closures: [closure("2026-09", { state: "open" })],
      transactions: [charge(1000, "2026-08"), charge(300, "2026-09")],
    });
    expect(
      (await getCardFaturaPairs(client, HOUSEHOLD, "2026-10-06"))[0],
    ).toMatchObject({ pending: null, open: { month: "2026-10" } });
    expect(
      (
        await getCardBillOverview(client, HOUSEHOLD, "2026-09", "2026-10-06")
      )[0]!.summary.closed,
    ).toBe(false);
  });

  it.each([1000, 1100])(
    "paid/overpaid previous bill collapses the pair (P3, P4)",
    async (paid) => {
      const { client } = mockClient({
        credit_cards: [card()],
        transactions: [charge(1000, "2026-09"), payment(paid, "2026-09")],
      });
      expect(
        (await getCardFaturaPairs(client, HOUSEHOLD, "2026-10-06"))[0]!.pending,
      ).toBeNull();
    },
  );

  it("walks consecutive closed months across the year with one closure read", async () => {
    const { client, calls } = mockClient({
      credit_cards: [card()],
      card_bill_closures: [closure("2026-12"), closure("2027-01")],
    });
    expect(
      (await getCardFaturaPairs(client, HOUSEHOLD, "2026-12-06"))[0]!.open
        .month,
    ).toBe("2027-02");
    expect(calls.filter((c) => c.table === "card_bill_closures")).toHaveLength(
      1,
    );
  });

  it("finds the open month after exactly 24 closed months", async () => {
    const { client, calls } = mockClient({
      credit_cards: [card()],
      card_bill_closures: Array.from({ length: 24 }, (_, i) =>
        closure(addMonthsYm("2026-10", i)),
      ),
    });
    expect(
      (await getCardFaturaPairs(client, HOUSEHOLD, "2026-10-06"))[0]!.open
        .month,
    ).toBe("2028-10");
    const query = calls.find((call) => call.table === "card_bill_closures");
    expect(query?.operations).toContainEqual([
      "in",
      "bill_month",
      [
        "2026-09",
        ...Array.from({ length: 25 }, (_, i) => addMonthsYm("2026-10", i)),
      ],
    ]);
  });

  it("propagates the domain limit after 25 closed months", async () => {
    const { client } = mockClient({
      credit_cards: [card()],
      card_bill_closures: Array.from({ length: 25 }, (_, i) =>
        closure(addMonthsYm("2026-10", i)),
      ),
    });
    await expect(
      getCardFaturaPairs(client, HOUSEHOLD, "2026-10-06"),
    ).rejects.toThrow("No open fatura within 24 months");
  });

  it("shifts the whole parcel plan deterministically and leaves purchase RPC payload stable (C15, C16)", async () => {
    const generated = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-1",
      description: "Compra",
      totalAmount: { currency: "BRL", cents: 1001 },
      installmentCount: 3,
      purchasedOn: "2026-12-06",
      createdByUserId: "user-1",
    });
    if (!generated.ok) throw new Error("fixture invalid");
    const { client, rpc, calls } = mockClient({
      credit_cards: [card()],
      card_bill_closures: [closure("2026-12"), closure("2027-01")],
    });
    const before = structuredClone(generated.value);
    const first = await planWithOpenFaturas(
      client,
      HOUSEHOLD,
      generated.value,
      "2026-12-06",
    );
    const replay = await planWithOpenFaturas(
      client,
      HOUSEHOLD,
      generated.value,
      "2026-12-06",
    );
    expect(first).toEqual(replay);
    expect(first.shiftedFrom).toBe("2026-12");
    expect(first.plan.installments.map((p) => p.dueMonth)).toEqual([
      "2027-02",
      "2027-03",
      "2027-04",
    ]);
    expect(first.plan.installments.map((p) => p.amount.cents)).toEqual([
      334, 334, 333,
    ]);
    expect(first.plan.group).toEqual(before.group);
    expect(generated.value).toEqual(before);
    rpc.mockResolvedValue({
      data: { group: {}, installments: [] },
      error: null,
    } as never);
    await createInstallmentPurchase(client, first.plan, {
      idempotencyKey: "purchase-key",
    });
    await createInstallmentPurchase(client, replay.plan, {
      idempotencyKey: "purchase-key",
    });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(calls.filter((c) => c.table === "card_bill_closures")).toHaveLength(
      2,
    );
  });

  it.each([
    ["2027-02", ["2027-02", "2027-03", "2027-04"], "2026-12"],
    ["2026-12", ["2026-12", "2027-01", "2027-02"], null],
    ["2026-11", ["2026-12", "2027-01", "2027-02"], null],
  ])(
    "uses pinned open month %s without querying closures",
    async (month, dueMonths, shiftedFrom) => {
      const generated = createInstallmentPlan({
        householdId: HOUSEHOLD,
        creditCardId: "card-1",
        description: "Compra",
        totalAmount: { currency: "BRL", cents: 1001 },
        installmentCount: 3,
        purchasedOn: "2026-12-06",
        createdByUserId: "user-1",
      });
      if (!generated.ok) throw new Error("fixture invalid");
      const { client, calls } = mockClient({
        credit_cards: [card()],
        card_bill_closures: [closure(month)],
      });
      const result = await planWithOpenFaturas(
        client,
        HOUSEHOLD,
        generated.value,
        "2027-03-06",
        month,
      );
      expect(
        result.plan.installments.map((installment) => installment.dueMonth),
      ).toEqual(dueMonths);
      expect(result.shiftedFrom).toBe(shiftedFrom);
      expect(
        calls.filter((call) => call.table === "card_bill_closures"),
      ).toHaveLength(0);
      if (shiftedFrom === null) expect(result.plan).toBe(generated.value);
    },
  );

  it("returns an open first parcel plan unchanged", async () => {
    const generated = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-1",
      description: "Compra",
      totalAmount: { currency: "BRL", cents: 1000 },
      installmentCount: 2,
      purchasedOn: "2026-10-06",
      createdByUserId: "user-1",
    });
    if (!generated.ok) throw new Error("fixture invalid");
    const { client } = mockClient({ credit_cards: [card()] });
    expect(
      await planWithOpenFaturas(
        client,
        HOUSEHOLD,
        generated.value,
        "2026-10-06",
      ),
    ).toEqual({ plan: generated.value, shiftedFrom: null });
  });

  it("paginates batch reads so large bills do not lose charges or payments", async () => {
    const { client } = mockClient({
      credit_cards: [card()],
      transactions: Array.from({ length: 1001 }, (_, i) =>
        charge(10, "2026-10", { id: `charge-${i}` }),
      ).concat(
        Array.from({ length: 1001 }, (_, i) =>
          payment(5, "2026-10", { id: `payment-${i}` }),
        ),
      ),
    });
    expect(
      (
        await getCardBillOverview(client, HOUSEHOLD, "2026-10", "2026-10-06")
      )[0]!.summary,
    ).toMatchObject({ chargesCents: 10010, paidCents: 5005 });
  });

  it.each([
    [
      "payments",
      (client: AppSupabaseClient) =>
        findCardBillPayments(client, HOUSEHOLD, ["2026-10"]),
    ],
    [
      "closures",
      (client: AppSupabaseClient) =>
        findCardBillClosures(client, HOUSEHOLD, ["2026-10"]),
    ],
    [
      "charges",
      (client: AppSupabaseClient) =>
        getCardBillCharges(client, HOUSEHOLD, "card-1", "2026-10"),
    ],
    ["close", (client: AppSupabaseClient) => closeCardBill(client, input)],
    ["reopen", (client: AppSupabaseClient) => reopenCardBill(client, input)],
    ["total", (client: AppSupabaseClient) => setCardBillTotal(client, input)],
    [
      "undo",
      (client: AppSupabaseClient) =>
        deleteCardBillPayment(client, HOUSEHOLD, "payment-1"),
    ],
  ] as const)("propagates database errors for %s", async (_, action) => {
    const { client } = mockClient({}, "boom");
    await expect(action(client)).rejects.toThrow("boom");
  });
});
