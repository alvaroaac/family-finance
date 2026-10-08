import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import type { AppSupabaseClient } from "@family-finance/db";

import * as actions from "../app/(app)/cards/actions.js";
import { createManualTransactionAction } from "../app/(app)/transactions/actions.js";
import { requireAuthorizedUser } from "../lib/auth.js";
import {
  createFakeSupabaseClient,
  FakeSupabaseStore,
} from "./fake-supabase.js";

const session = vi.hoisted(() => ({
  client: null as AppSupabaseClient | null,
}));
vi.mock("../lib/auth.js", () => ({ requireAuthorizedUser: vi.fn() }));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => session.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const HOUSEHOLD = "house-1";
const USER = "user-1";
const CARD = "card-1";
const ACCOUNT = "account-1";
const idle = { status: "idle" } as const;

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    creditCardId: CARD,
    billMonth: "2026-10",
    amount: "1.234,56",
    paidOn: "2026-10-06",
    accountId: ACCOUNT,
    idempotencyKey: "payment-key",
    householdId: "forged-household",
    userId: "forged-user",
    createdByUserId: "forged-user",
    total: "",
    ...fields,
  }))
    data.set(key, value);
  return data;
}

function fixture() {
  const store = new FakeSupabaseStore({
    household_members: [
      { household_id: HOUSEHOLD, user_id: USER, is_active: true },
    ],
    credit_cards: [
      { id: CARD, household_id: HOUSEHOLD, name: "Nubank", closing_day: 28 },
    ],
    accounts: [{ id: ACCOUNT, household_id: HOUSEHOLD, name: "Conta" }],
    transactions: [
      {
        id: "charge-1",
        household_id: HOUSEHOLD,
        credit_card_id: CARD,
        kind: "expense",
        amount_cents: 10000,
        occurred_on: "2026-10-01",
        invoice_month: "2026-10",
        bill_month: null,
      },
    ],
  });
  const fake = createFakeSupabaseClient(store);
  const client = {
    ...fake,
    from: vi.fn(fake.from),
    rpc: vi.fn(fake.rpc),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: USER } },
        error: null,
      })),
    },
  };
  session.client = client as unknown as AppSupabaseClient;
  return { store, client };
}

function expectRevalidation() {
  expect(vi.mocked(revalidatePath).mock.calls).toEqual([
    ["/cards"],
    ["/resumo"],
    ["/dashboard"],
    ["/transactions"],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthorizedUser)
    .mockReset()
    .mockResolvedValue({ email: "test@example.com", householdId: HOUSEHOLD });
  vi.useFakeTimers();
  // UTC has already advanced to the next day; São Paulo is still October 6.
  vi.setSystemTime(new Date("2026-10-07T01:30:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("payCardBillAction", () => {
  it("parses BRL money, derives household/user from session, and revalidates", async () => {
    const { store, client } = fixture();
    expect(await actions.payCardBillAction(idle, form())).toEqual({
      status: "success",
      message: "Pagamento registrado.",
    });
    expect(client.rpc).toHaveBeenCalledWith("settle_card_bill", {
      target_household_id: HOUSEHOLD,
      target_credit_card_id: CARD,
      target_account_id: ACCOUNT,
      target_bill_month: "2026-10",
      target_amount_cents: 123456,
      target_paid_on: "2026-10-06",
      target_created_by_user_id: USER,
      target_idempotency_key: "payment-key",
    });
    expect(
      store.table("transactions").filter((row) => row.kind === "transfer"),
    ).toHaveLength(1);
    expect(requireAuthorizedUser).toHaveBeenCalled();
    expectRevalidation();
  });

  it.each(["2026-09", "2026-12"])(
    "allows a past/future bill month %s (E5/E6)",
    async (billMonth) => {
      const { store } = fixture();
      expect(
        await actions.payCardBillAction(idle, form({ billMonth })),
      ).toEqual({
        status: "success",
        message: "Pagamento registrado.",
      });
      expect(store.table("transactions").at(-1)?.bill_month).toBe(billMonth);
    },
  );

  it("treats an idempotent replay as success and revalidates again (E11)", async () => {
    const { store, client } = fixture();
    await actions.payCardBillAction(idle, form());
    vi.mocked(revalidatePath).mockClear();
    expect(await actions.payCardBillAction(idle, form())).toEqual({
      status: "success",
      message: "Pagamento registrado.",
    });
    expect((await client.rpc.mock.results[1]?.value)?.data).toMatchObject({
      replayed: true,
    });
    expect(
      store.table("transactions").filter((row) => row.kind === "transfer"),
    ).toHaveLength(1);
    expectRevalidation();
  });

  it("maps a reused key with different payload to the payment error (E12)", async () => {
    const { store } = fixture();
    await actions.payCardBillAction(idle, form());
    vi.mocked(revalidatePath).mockClear();
    expect(
      await actions.payCardBillAction(idle, form({ amount: "10,00" })),
    ).toEqual({
      status: "error",
      message: "Não foi possível registrar o pagamento.",
    });
    expect(
      store.table("transactions").filter((row) => row.kind === "transfer"),
    ).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " ",
    "0",
    "0,00",
    "-1,00",
    "garbage",
    "12abc",
    "1,2,3",
    "Infinity",
    "99999999999999999999",
  ])("rejects invalid amount %j without an RPC (E7)", async (amount) => {
    const { client } = fixture();
    expect(await actions.payCardBillAction(idle, form({ amount }))).toEqual({
      status: "error",
      message: "Informe um valor maior que zero.",
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ accountId: "" }, "Escolha a conta de onde saiu o pagamento."],
    [{ paidOn: "2026-10-07" }, "A data do pagamento não pode ser no futuro."],
    [{ paidOn: "" }, "Não foi possível registrar o pagamento."],
    [{ paidOn: "2026-02-30" }, "Não foi possível registrar o pagamento."],
    [{ idempotencyKey: "" }, "Não foi possível registrar o pagamento."],
    [{ creditCardId: "" }, "Não foi possível registrar o pagamento."],
  ])("validates %j before the RPC", async (fields, message) => {
    const { client } = fixture();
    expect(await actions.payCardBillAction(idle, form(fields))).toEqual({
      status: "error",
      message,
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps RPC errors to exact copy without exposing database details", async () => {
    const { client } = fixture();
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "private database detail" },
    });
    expect(await actions.payCardBillAction(idle, form())).toEqual({
      status: "error",
      message: "Não foi possível registrar o pagamento.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

const billActions = [
  ["pay", actions.payCardBillAction, "Não foi possível registrar o pagamento."],
  [
    "close",
    actions.closeCardBillAction,
    "Não foi possível atualizar a fatura.",
  ],
  [
    "reopen",
    actions.reopenCardBillAction,
    "Não foi possível atualizar a fatura.",
  ],
  [
    "total",
    actions.setCardBillTotalAction,
    "Não foi possível atualizar a fatura.",
  ],
] as const;

describe("bill action validation and session failures", () => {
  for (const [name, action, failure] of billActions) {
    it.each(["", "2026-00", "2026-13", "2026-1", "2026-10-01", "bad"])(
      `${name}: rejects month %j without writes`,
      async (billMonth) => {
        const { client, store } = fixture();
        expect(await action(idle, form({ billMonth }))).toEqual({
          status: "error",
          message: "Mês da fatura inválido.",
        });
        expect(client.rpc).not.toHaveBeenCalled();
        expect(store.table("card_bill_closures")).toHaveLength(0);
        expect(revalidatePath).not.toHaveBeenCalled();
      },
    );

    it(`${name}: masks persistence failures`, async () => {
      const { client } = fixture();
      const from = client.from.getMockImplementation()!;
      client.rpc.mockRejectedValueOnce(new Error("private detail"));
      client.from.mockImplementation((table) => {
        if (table === "card_bill_closures") throw new Error("private detail");
        return from(table);
      });
      expect(await action(idle, form())).toEqual({
        status: "error",
        message: failure,
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  for (const [name, action, failure] of [
    ...billActions,
    [
      "undo",
      actions.undoCardBillPaymentAction,
      "Não foi possível desfazer o pagamento.",
    ],
  ] as const) {
    it(`${name}: authorization failure prevents writes`, async () => {
      const { client } = fixture();
      vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(
        new Error("unauthorized"),
      );
      expect(await action(idle, form({ transactionId: "payment-1" }))).toEqual({
        status: "error",
        message: failure,
      });
      expect(client.from).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it(`${name}: missing household prevents writes`, async () => {
      const { client, store } = fixture();
      store.table("household_members").splice(0);
      expect(await action(idle, form({ transactionId: "payment-1" }))).toEqual({
        status: "error",
        message: failure,
      });
      expect(store.table("card_bill_closures")).toHaveLength(0);
      expect(store.table("transactions")).toHaveLength(1);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it(`${name}: missing authenticated user prevents writes`, async () => {
      const { client, store } = fixture();
      client.auth.getUser.mockResolvedValueOnce({
        data: { user: null as never },
        error: null,
      });
      expect(await action(idle, form({ transactionId: "payment-1" }))).toEqual({
        status: "error",
        message: failure,
      });
      expect(store.table("card_bill_closures")).toHaveLength(0);
      expect(store.table("transactions")).toHaveLength(1);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }
});

describe("closing, reopening, and adjusting totals", () => {
  it.each([
    ["", null],
    ["100,00", null],
    ["120,50", 12050],
    ["0", 0],
  ])(
    "closes with total %j and session ownership (C17/C18/C21)",
    async (total, storedTotal) => {
      const { store } = fixture();
      expect(await actions.closeCardBillAction(idle, form({ total }))).toEqual({
        status: "success",
        message: "Fatura fechada.",
      });
      expect(store.table("card_bill_closures")).toEqual([
        expect.objectContaining({
          household_id: HOUSEHOLD,
          credit_card_id: CARD,
          bill_month: "2026-10",
          state: "closed",
          total_override_cents: storedTotal,
          updated_by_user_id: USER,
        }),
      ]);
      expectRevalidation();
    },
  );

  it("reopens and clears a corrected total (C20)", async () => {
    const { store } = fixture();
    await actions.closeCardBillAction(idle, form({ total: "120,00" }));
    vi.mocked(revalidatePath).mockClear();
    expect(await actions.reopenCardBillAction(idle, form())).toEqual({
      status: "success",
      message: "Fatura reaberta.",
    });
    expect(store.table("card_bill_closures")).toEqual([
      expect.objectContaining({
        household_id: HOUSEHOLD,
        state: "open",
        total_override_cents: null,
        updated_by_user_id: USER,
      }),
    ]);
    expectRevalidation();
  });

  it.each([
    ["1.234,56", 123456],
    ["0,00", 0],
    ["", null],
  ])("adjusts/clears a total %j (C19/C21)", async (total, storedTotal) => {
    const { store } = fixture();
    await actions.setCardBillTotalAction(idle, form({ total: "150,00" }));
    vi.mocked(revalidatePath).mockClear();
    expect(await actions.setCardBillTotalAction(idle, form({ total }))).toEqual(
      {
        status: "success",
        message: "Total atualizado.",
      },
    );
    expect(store.table("card_bill_closures")[0]).toMatchObject({
      household_id: HOUSEHOLD,
      state: "closed",
      total_override_cents: storedTotal,
      updated_by_user_id: USER,
    });
    expectRevalidation();
  });

  for (const action of [
    actions.closeCardBillAction,
    actions.setCardBillTotalAction,
  ]) {
    it("rejects a file submitted as the total instead of clearing the override", async () => {
      const { store } = fixture();
      const data = form();
      data.set("total", new Blob(["garbage"]), "total.txt");
      expect(await action(idle, data)).toEqual({
        status: "error",
        message: "Informe um total válido (zero ou mais).",
      });
      expect(store.table("card_bill_closures")).toHaveLength(0);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
    it.each([
      "-1",
      "garbage",
      "12abc",
      "1,2,3",
      "Infinity",
      "99999999999999999999",
    ])("rejects invalid total %j before persistence (C22)", async (total) => {
      const { store, client } = fixture();
      expect(await action(idle, form({ total }))).toEqual({
        status: "error",
        message: "Informe um total válido (zero ou mais).",
      });
      expect(store.table("card_bill_closures")).toHaveLength(0);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }
});

describe("undoCardBillPaymentAction", () => {
  it("reports undo failure with the correct fallback copy", async () => {
    fixture();
    vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(
      new Error("session unavailable"),
    );
    expect(
      await actions.undoCardBillPaymentAction(
        idle,
        form({ transactionId: "payment-1" }),
      ),
    ).toEqual({
      status: "error",
      message: "Não foi possível desfazer o pagamento.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes only the session household payment and revalidates (E13)", async () => {
    const { store } = fixture();
    await actions.payCardBillAction(idle, form());
    const transactionId = String(store.table("transactions").at(-1)?.id);
    vi.mocked(revalidatePath).mockClear();
    expect(
      await actions.undoCardBillPaymentAction(idle, form({ transactionId })),
    ).toEqual({
      status: "success",
      message: "Pagamento desfeito.",
    });
    expect(store.table("transactions")).toHaveLength(1);
    expectRevalidation();
  });

  it.each(["charge-1", "foreign-payment", "missing"])(
    "refuses %s and deletes nothing (E14)",
    async (transactionId) => {
      const { store } = fixture();
      store.table("transactions").push({
        id: "foreign-payment",
        household_id: "other-house",
        kind: "transfer",
        bill_month: "2026-10",
      });
      expect(
        await actions.undoCardBillPaymentAction(idle, form({ transactionId })),
      ).toEqual({
        status: "error",
        message: "Pagamento não encontrado.",
      });
      expect(store.table("transactions")).toHaveLength(2);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});

describe("installment preview/save with open faturas", () => {
  const purchase = {
    creditCardId: CARD,
    description: "Compra parcelada",
    totalCents: 10001,
    installmentCount: 3,
    purchasedOn: "2026-10-01",
  };

  it.each([false, true])(
    "preview/save have identical months, closed first bill = %s (C15)",
    async (closed) => {
      const { store } = fixture();
      if (closed)
        store.table("card_bill_closures").push({
          household_id: HOUSEHOLD,
          credit_card_id: CARD,
          bill_month: "2026-10",
          state: "closed",
          total_override_cents: null,
        });
      const preview = await actions.previewCardPurchase(purchase);
      expect(preview).toMatchObject({
        ok: true,
        shiftedFrom: closed ? "2026-10" : null,
      });
      if (!preview.ok) throw new Error(preview.message);
      const months = closed
        ? ["2026-11", "2026-12", "2027-01"]
        : ["2026-10", "2026-11", "2026-12"];
      expect(preview.parcels.map((parcel) => parcel.dueMonth)).toEqual(months);
      expect(store.table("installments")).toHaveLength(0);
      expect(await actions.saveCardPurchase(purchase)).toEqual({
        ok: true,
        message: "Compra parcelada registrada: 3 parcelas geradas.",
        shiftedFrom: closed ? "2026-10" : null,
      });
      expect(store.table("installments").map((row) => row.due_month)).toEqual(
        months,
      );
      expect(
        store.table("installments").map((row) => row.amount_cents),
      ).toEqual([3334, 3334, 3333]);
      expect(store.table("installment_groups")[0]).toMatchObject({
        household_id: HOUSEHOLD,
        created_by_user_id: USER,
      });
      expectRevalidation();
    },
  );

  it("save à vista includes shiftedFrom null", async () => {
    fixture();
    expect(
      await actions.saveCardPurchase({ ...purchase, installmentCount: 1 }),
    ).toEqual({
      ok: true,
      message: "Compra à vista registrada no cartão.",
      shiftedFrom: null,
    });
    expectRevalidation();
  });

  it("backdated parcels skip automatically closed months using today's São Paulo date", async () => {
    const { store } = fixture();
    const input = { ...purchase, purchasedOn: "2026-07-10" };
    const preview = await actions.previewCardPurchase(input);
    expect(preview).toMatchObject({ ok: true, shiftedFrom: "2026-07" });
    if (!preview.ok) throw new Error(preview.message);
    const months = ["2026-10", "2026-11", "2026-12"];
    expect(preview.parcels.map((parcel) => parcel.dueMonth)).toEqual(months);
    expect(await actions.saveCardPurchase(input)).toMatchObject({
      ok: true,
      shiftedFrom: "2026-07",
    });
    expect(store.table("installments").map((row) => row.due_month)).toEqual(
      months,
    );
  });

  it("manual transaction entry also persists the shifted installments", async () => {
    const { store } = fixture();
    store.table("card_bill_closures").push({
      household_id: HOUSEHOLD,
      credit_card_id: CARD,
      bill_month: "2026-10",
      state: "closed",
      total_override_cents: null,
    });
    expect(
      await createManualTransactionAction(
        form({
          kind: "expense",
          amount: "100,01",
          description: purchase.description,
          occurredOn: purchase.purchasedOn,
          payment: `card:${CARD}`,
          purchaseMode: "parcelado",
          installmentCount: "3",
          responsible: "household",
        }),
      ),
    ).toEqual({ ok: true });
    expect(store.table("installments").map((row) => row.due_month)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
  });
});
