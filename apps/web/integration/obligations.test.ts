/**
 * Integration tests for the "/obligations" surface (recurring obligations).
 *
 * `buildObligationsData` — the same composition `loadObligationsData` performs
 * — runs the REAL `@family-finance/db` repositories against the in-memory fake
 * store (./fake-supabase.ts): active-obligation listing with remaining-term
 * math, the current month's unpaid/paid split, the 12-month projection
 * timeline, and mark-paid materialization (idempotent, anti-double-count).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";

import type { AppSupabaseClient } from "@family-finance/db";
import {
  deleteObligationPayment,
  listObligationPayments,
  materializeObligationPayment,
} from "@family-finance/db";

import { buildObligationsData } from "../app/(app)/obligations/queries.js";
import { undoObligationPaymentAction } from "../app/(app)/obligations/actions.js";
import { requireAuthorizedUser } from "../lib/auth.js";
import {
  obligationInputFromForm,
  obligationPaymentFromForm,
} from "../app/(app)/obligations/form.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
} from "./fake-supabase.js";

const mockedSupabase = vi.hoisted(() => ({
  client: null as AppSupabaseClient | null,
}));

vi.mock("../lib/auth.js", () => ({
  requireAuthorizedUser: vi.fn(async () => undefined),
}));

vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => mockedSupabase.client),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const FOREIGN_HOUSEHOLD = "00000000-0000-0000-0000-000000000002";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "acc-corrente";
const OVERRIDE_ACCOUNT = "acc-pix";
const FOREIGN_ACCOUNT = "acc-foreign";

// Inside July 2026.
const NOW = new Date("2026-07-15T12:00:00Z");

function seededClient(): {
  client: AppSupabaseClient;
  store: FakeSupabaseStore;
} {
  const store = new FakeSupabaseStore({
    accounts: [
      { id: ACCOUNT, household_id: HOUSEHOLD, name: "Corrente" },
      { id: OVERRIDE_ACCOUNT, household_id: HOUSEHOLD, name: "Pix" },
      {
        id: FOREIGN_ACCOUNT,
        household_id: FOREIGN_HOUSEHOLD,
        name: "Foreign",
      },
    ],
    obligations: [
      {
        id: "ob-solar",
        household_id: HOUSEHOLD,
        description: "Parcela solar",
        amount_cents: 71044,
        start_month: "2026-05",
        term_months: 72,
        due_day: 5,
        category_id: null,
        subcategory_id: null,
        responsibility_scope: "household",
        responsible_user_id: null,
        account_id: ACCOUNT,
        status: "active",
        created_by_user_id: ALVARO,
      },
      {
        id: "ob-rent",
        household_id: HOUSEHOLD,
        description: "Aluguel",
        amount_cents: 120000,
        start_month: "2026-01",
        term_months: null,
        due_day: 10,
        category_id: null,
        subcategory_id: null,
        responsibility_scope: "household",
        responsible_user_id: null,
        account_id: ACCOUNT,
        status: "active",
        created_by_user_id: ALVARO,
      },
      {
        id: "ob-old",
        household_id: HOUSEHOLD,
        description: "Financiamento antigo",
        amount_cents: 5000,
        start_month: "2020-01",
        term_months: 12,
        due_day: 1,
        category_id: null,
        subcategory_id: null,
        responsibility_scope: "household",
        responsible_user_id: null,
        account_id: ACCOUNT,
        status: "canceled",
        created_by_user_id: ALVARO,
      },
    ],
  });
  const client = createFakeSupabaseClient(
    store,
  ) as unknown as AppSupabaseClient;
  return { client, store };
}

describe("buildObligationsData", () => {
  it("lists active obligations with remaining-term math", async () => {
    const { client } = seededClient();
    const data = await buildObligationsData(client, HOUSEHOLD, NOW);

    expect(data.month).toBe("2026-07");
    expect(data.obligations.map((o) => o.description)).toEqual([
      "Aluguel",
      "Parcela solar",
    ]);

    const solar = data.obligations.find((o) => o.id === "ob-solar");
    expect(solar?.endMonth).toBe("2032-04");
    // Jul/2026 .. Apr/2032 inclusive = 70 months still to pay.
    expect(solar?.remainingMonths).toBe(70);

    const rent = data.obligations.find((o) => o.id === "ob-rent");
    expect(rent?.endMonth).toBeNull();
    expect(rent?.remainingMonths).toBeNull();
  });

  it("splits the current month into unpaid projections and paid actuals", async () => {
    const { client } = seededClient();

    // Pay the rent for July via the real repository + fake RPC.
    await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });

    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.thisMonth.unpaid.map((e) => e.obligationId)).toEqual([
      "ob-solar",
    ]);
    expect(data.thisMonth.paid.map((p) => p.obligationId)).toEqual(["ob-rent"]);
    expect(data.thisMonth.paid[0]?.amountCents).toBe(120000);
  });

  it("builds a 12-month timeline with paid months suppressed", async () => {
    const { client } = seededClient();
    await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-08",
    });

    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.timeline).toHaveLength(12);
    expect(data.timeline[0]?.month).toBe("2026-07");
    expect(data.timeline[11]?.month).toBe("2027-06");

    // July: solar + rent projected. August: rent paid -> its projection is
    // suppressed (entries) but the month's commitment total stays constant.
    expect(data.timeline[0]?.totalCents).toBe(71044 + 120000);
    expect(data.timeline[1]?.entries.map((e) => e.obligationId)).toEqual([
      "ob-solar",
    ]);
    expect(data.timeline[1]?.paidCents).toBe(120000);
    expect(data.timeline[1]?.totalCents).toBe(71044 + 120000);
  });

  it("repeated mark-paid is an idempotent no-op (no double count)", async () => {
    const { client } = seededClient();
    const first = await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });
    const second = await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });
    expect(first.already_paid).toBe(false);
    expect(second.already_paid).toBe(true);

    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.thisMonth.paid).toHaveLength(1);
    expect(data.timeline[0]?.totalCents).toBe(71044 + 120000);
  });
});

describe("undo obligation payments", () => {
  it("marking a month paid then deleting the payment restores unpaid and preserves the timeline total", async () => {
    const { client, store } = seededClient();
    const payment = await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });
    const before = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(before.thisMonth.paid).toHaveLength(1);

    await deleteObligationPayment(client, HOUSEHOLD, payment.transaction.id);

    const after = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(after.thisMonth.paid).toEqual([]);
    expect(after.thisMonth.unpaid.map((entry) => entry.obligationId)).toContain(
      "ob-rent",
    );
    expect(after.timeline.map((entry) => entry.totalCents)).toEqual(
      before.timeline.map((entry) => entry.totalCents),
    );
    expect(store.table("transactions")).toHaveLength(0);
  });

  it.each([
    ["plain transaction", HOUSEHOLD, null],
    ["another household's payment", FOREIGN_HOUSEHOLD, "ob-rent"],
  ])(
    "refuses a %s without deleting it",
    async (_label, householdId, obligationId) => {
      const { client, store } = seededClient();
      const transaction = {
        id: "tx-refused",
        household_id: householdId,
        obligation_id: obligationId,
      };
      store.table("transactions").push(transaction);

      await expect(
        deleteObligationPayment(client, HOUSEHOLD, transaction.id),
      ).rejects.toThrow("Esse lançamento não é um pagamento de obrigação.");
      expect(store.table("transactions")).toEqual([transaction]);
    },
  );

  it("listObligationPayments returns transactionId and paidOn through the paid query entries", async () => {
    const { client } = seededClient();
    const payment = await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
      paidOn: "2026-07-12",
    });

    expect(
      await listObligationPayments(client, HOUSEHOLD, "2026-07", "2026-07"),
    ).toEqual([
      {
        obligationId: "ob-rent",
        month: "2026-07",
        amountCents: 120000,
        transactionId: payment.transaction.id,
        paidOn: "2026-07-12",
      },
    ]);
    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.thisMonth.paid).toEqual([
      {
        obligationId: "ob-rent",
        transactionId: payment.transaction.id,
        description: "Aluguel",
        amountCents: 120000,
        paidOn: "2026-07-12",
      },
    ]);
  });
});

describe("undoObligationPaymentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installClient(): ReturnType<typeof seededClient> {
    const { client, store } = seededClient();
    store.table("household_members").push({
      household_id: HOUSEHOLD,
      user_id: ALVARO,
      is_active: true,
    });
    mockedSupabase.client = {
      ...client,
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: ALVARO } },
          error: null,
        })),
      },
    } as unknown as AppSupabaseClient;
    return { client, store };
  }

  it("deletes the payment and revalidates obligation paths on success", async () => {
    const { client, store } = installClient();
    const payment = await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });
    const form = new FormData();
    form.set("transactionId", payment.transaction.id);

    await expect(undoObligationPaymentAction(form)).resolves.toEqual({
      ok: true,
    });
    expect(requireAuthorizedUser).toHaveBeenCalledOnce();
    expect(store.table("transactions")).toHaveLength(0);
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([
      ["/obligations"],
      ["/resumo"],
      ["/dashboard"],
    ]);
  });

  it("returns repository errors without revalidating", async () => {
    installClient();
    const form = new FormData();
    form.set("transactionId", "missing");

    await expect(undoObligationPaymentAction(form)).resolves.toEqual({
      ok: false,
      error: "Esse lançamento não é um pagamento de obrigação.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns validation errors for a missing transactionId", async () => {
    installClient();
    await expect(undoObligationPaymentAction(new FormData())).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([new Error("Sessão inválida."), "unexpected"])(
    "catches authentication failures including non-Error values: %s",
    async (error) => {
      vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(error);
      await expect(
        undoObligationPaymentAction(new FormData()),
      ).resolves.toEqual({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Não foi possível desfazer o pagamento.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});

describe("paid entries reflect materialized actuals (review F4)", () => {
  it("editing the template amount after payment does not rewrite the paid figure", async () => {
    const { client, store } = seededClient();
    await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
    });

    // Template edited AFTER the payment: paid rows must keep the actual.
    const rent = store
      .table("obligations")
      .find((r) => r.id === "ob-rent") as Record<string, unknown>;
    rent.amount_cents = 999999;

    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.thisMonth.paid[0]?.amountCents).toBe(120000);
    expect(data.timeline[0]?.paidCents).toBe(120000);
  });
});

describe("obligationInputFromForm (review F9 — server-action input parsing)", () => {
  function form(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }
  const IDS = { householdId: HOUSEHOLD, createdByUserId: ALVARO };
  const BASE = {
    description: "Parcela solar",
    amount: "710,44",
    startMonth: "2026-10",
    termMonths: "72",
    dueDay: "5",
    accountId: ACCOUNT,
  };

  it("maps the happy path: pt-BR amount to cents, term to number", () => {
    expect(obligationInputFromForm(form(BASE), IDS)).toEqual({
      householdId: HOUSEHOLD,
      description: "Parcela solar",
      amountCents: 71044,
      startMonth: "2026-10",
      termMonths: 72,
      dueDay: 5,
      accountId: ACCOUNT,
      createdByUserId: ALVARO,
      category: undefined,
    });
  });

  it("blank term means indefinite (null); category flows through when set", () => {
    const input = obligationInputFromForm(
      form({ ...BASE, termMonths: "", categoryId: "cat-1" }),
      IDS,
    );
    expect(input.termMonths).toBeNull();
    expect(input.category).toEqual({ categoryId: "cat-1" });
  });

  it.each([
    ["non-numeric amount", { amount: "abc" }],
    ["zero amount", { amount: "0" }],
    ["mixed term '12abc'", { termMonths: "12abc" }],
    ["zero dueDay", { dueDay: "0" }],
    ["missing description", { description: " " }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      obligationInputFromForm(form({ ...BASE, ...patch }), IDS),
    ).toThrow();
  });
});

describe("mark-paid default occurred date (no paidOn)", () => {
  it("defaults occurred_on to the month's due day", async () => {
    const { client, store } = seededClient();
    await materializeObligationPayment(client, {
      obligationId: "ob-rent", // due_day 10
      month: "2026-07",
    });
    const tx = store
      .table("transactions")
      .find((r) => r.obligation_id === "ob-rent");
    expect(tx?.occurred_on).toBe("2026-07-10");
  });
});

describe("obligationPaymentFromForm", () => {
  function paymentForm(amount: string): FormData {
    const data = new FormData();
    data.set("obligationId", "ob-rent");
    data.set("month", "2026-07");
    data.set("amount", amount);
    return data;
  }

  it("maps a pt-BR actual payment amount to cents", () => {
    expect(obligationPaymentFromForm(paymentForm("1.247,80"))).toEqual({
      obligationId: "ob-rent",
      month: "2026-07",
      amountCents: 124780,
    });
  });

  it.each(["", "0", "-1", "abc"])("rejects invalid amount %j", (amount) => {
    expect(() => obligationPaymentFromForm(paymentForm(amount))).toThrow();
  });
});

describe("mark-paid actual amount", () => {
  it("records the actual for this month without changing future forecasts", async () => {
    const { client } = seededClient();
    await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
      amountCents: 124780,
    });

    const data = await buildObligationsData(client, HOUSEHOLD, NOW);
    expect(data.thisMonth.paid[0]?.amountCents).toBe(124780);
    expect(
      data.timeline[1]?.entries.find(
        (entry) => entry.obligationId === "ob-rent",
      )?.amountCents,
    ).toBe(120000);
  });

  it("uses an account override only for the materialized payment", async () => {
    const { client, store } = seededClient();
    await materializeObligationPayment(client, {
      obligationId: "ob-rent",
      month: "2026-07",
      accountId: OVERRIDE_ACCOUNT,
    });

    const transaction = store
      .table("transactions")
      .find((row) => row.obligation_id === "ob-rent");
    const obligation = store
      .table("obligations")
      .find((row) => row.id === "ob-rent");
    expect(transaction?.account_id).toBe(OVERRIDE_ACCOUNT);
    expect(obligation?.account_id).toBe(ACCOUNT);
  });

  it("rejects an account override that does not exist", async () => {
    const { client, store } = seededClient();

    await expect(
      materializeObligationPayment(client, {
        obligationId: "ob-rent",
        month: "2026-07",
        accountId: "acc-missing",
      }),
    ).rejects.toThrow("account acc-missing not found in obligation household");
    expect(store.table("transactions")).toHaveLength(0);
  });

  it("rejects an account override owned by another household", async () => {
    const { client, store } = seededClient();

    await expect(
      materializeObligationPayment(client, {
        obligationId: "ob-rent",
        month: "2026-07",
        accountId: FOREIGN_ACCOUNT,
      }),
    ).rejects.toThrow(
      `account ${FOREIGN_ACCOUNT} not found in obligation household`,
    );
    expect(store.table("transactions")).toHaveLength(0);
  });
});
