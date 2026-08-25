import { describe, it, expect } from "vitest";
import {
  createTransactionDraft,
  createInstallmentPlan,
} from "@family-finance/domain";
import {
  transactionInsertFromDraft,
  mapTransactionRow,
  monthDateRange,
  summarizeMonth,
  accountInsert,
  investmentBucketInsert,
  creditCardInsert,
  installmentGroupInsertFromPlan,
  installmentInsertsFromPlan,
  createInstallmentPurchase,
  currentMonth,
  summarizeCardPressure,
  mapUpcomingInstallment,
  mapDashboardTransaction,
  needsReview,
  transactionUpdateFromPatch,
  updateInvestmentBucketBalance,
  updateTransaction,
  updateInstallmentGroup,
  deleteTransaction,
  findMemberByTelegramUserId,
  resolveTelegramMember,
  getMonthlySummary,
  loadBotConversation,
  saveBotConversation,
  deleteBotConversation,
  obligationInsertFromDraft,
  mapObligationRow,
  obligationMonthYm,
  summarizeObligationsPressure,
  obligationUpdateFromChanges,
  createCategory,
  createSubcategory,
  restoreSubcategory,
  settleCardBill,
  findCardBillSettlements,
  confirmImportV2,
  type AppSupabaseClient,
} from "./repositories.js";
import { createServiceRoleClient } from "./index.js";
import type { TransactionRow, InstallmentRow, ObligationRow } from "./types.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const USER = "11111111-1111-1111-1111-111111111111";

describe("transactionInsertFromDraft", () => {
  it("maps an account expense draft to an insert row with the account column set", () => {
    const result = createTransactionDraft({
      householdId: HOUSEHOLD,
      kind: "expense",
      amount: { currency: "BRL", cents: 1599 },
      occurredOn: "2026-06-22",
      description: "Café",
      createdByUserId: USER,
      payment: { type: "account", accountId: "acc-1" },
      category: { categoryId: "cat-1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = transactionInsertFromDraft(result.value);
    expect(row).toMatchObject({
      household_id: HOUSEHOLD,
      kind: "expense",
      amount_cents: 1599,
      occurred_on: "2026-06-22",
      description: "Café",
      category_id: "cat-1",
      subcategory_id: null,
      account_id: "acc-1",
      credit_card_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
      import_batch_id: null,
    });
  });

  it("maps a card draft with a responsible user to the card column and user scope", () => {
    const result = createTransactionDraft({
      householdId: HOUSEHOLD,
      kind: "expense",
      amount: { currency: "BRL", cents: 5000 },
      occurredOn: "2026-06-10",
      description: "Mercado",
      createdByUserId: USER,
      payment: { type: "card", creditCardId: "card-9" },
      responsibleUserId: USER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = transactionInsertFromDraft(result.value, {
      importBatchId: "batch-7",
    });
    expect(row.account_id).toBeNull();
    expect(row.credit_card_id).toBe("card-9");
    expect(row.responsibility_scope).toBe("user");
    expect(row.responsible_user_id).toBe(USER);
    expect(row.import_batch_id).toBe("batch-7");
  });
});

describe("mapTransactionRow", () => {
  it("surfaces money as a domain MoneyAmount", () => {
    const row: TransactionRow = {
      id: "tx-1",
      household_id: HOUSEHOLD,
      kind: "income",
      amount_cents: 250000,
      occurred_on: "2026-06-01",
      description: "Salário",
      category_id: null,
      subcategory_id: null,
      account_id: "acc-1",
      credit_card_id: null,
      installment_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
      import_batch_id: null,
      obligation_id: null,
      obligation_month: null,
      bill_month: null,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    };
    const mapped = mapTransactionRow(row);
    expect(mapped.amount).toEqual({ currency: "BRL", cents: 250000 });
    expect(mapped.kind).toBe("income");
    expect(mapped.householdId).toBe(HOUSEHOLD);
  });
});

describe("monthDateRange", () => {
  it("returns inclusive ISO bounds for a 30-day month", () => {
    expect(monthDateRange("2026-06")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("handles February in a leap year", () => {
    expect(monthDateRange("2024-02")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });

  it("rejects a malformed month", () => {
    expect(() => monthDateRange("2026-13")).toThrow();
    expect(() => monthDateRange("2026/06")).toThrow();
  });
});

describe("summarizeMonth", () => {
  it("sums income and expense and computes balance, ignoring transfers", () => {
    const summary = summarizeMonth("2026-06", [
      { kind: "income", amount_cents: 300000 },
      { kind: "expense", amount_cents: 1599 },
      { kind: "expense", amount_cents: 5000 },
      { kind: "transfer", amount_cents: 99999 },
    ]);
    expect(summary).toEqual({
      month: "2026-06",
      incomeCents: 300000,
      expenseCents: 6599,
      balanceCents: 293401,
    });
  });

  it("returns zeros for an empty month", () => {
    expect(summarizeMonth("2026-07", [])).toEqual({
      month: "2026-07",
      incomeCents: 0,
      expenseCents: 0,
      balanceCents: 0,
    });
  });
});

// --- Task 9: accounts / investment buckets / credit cards inserts ----------

describe("accountInsert", () => {
  it("builds a household-scoped checking account insert payload", () => {
    expect(
      accountInsert({
        householdId: HOUSEHOLD,
        kind: "checking",
        name: "  Conta Nubank  ",
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      kind: "checking",
      name: "Conta Nubank",
    });
  });

  it("builds an investment account insert payload", () => {
    expect(
      accountInsert({
        householdId: HOUSEHOLD,
        kind: "investment",
        name: "Tesouro",
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      kind: "investment",
      name: "Tesouro",
    });
  });
});

describe("investmentBucketInsert", () => {
  it("builds a caixinha insert payload keyed by slug", () => {
    expect(
      investmentBucketInsert({
        householdId: HOUSEHOLD,
        slug: "independencia_financeira",
        name: "Aposentadoria",
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      slug: "independencia_financeira",
      name: "Aposentadoria",
    });
  });
});

describe("creditCardInsert", () => {
  it("includes optional closing/due days when provided", () => {
    expect(
      creditCardInsert({
        householdId: HOUSEHOLD,
        name: "Nubank Roxinho",
        closingDay: 10,
        dueDay: 17,
      }),
    ).toEqual({
      household_id: HOUSEHOLD,
      name: "Nubank Roxinho",
      closing_day: 10,
      due_day: 17,
    });
  });

  it("nulls the optional day columns when omitted", () => {
    expect(
      creditCardInsert({ householdId: HOUSEHOLD, name: "Cartão simples" }),
    ).toEqual({
      household_id: HOUSEHOLD,
      name: "Cartão simples",
      closing_day: null,
      due_day: null,
    });
  });
});

describe("installment plan inserts", () => {
  it("maps a parcelado plan into one group insert and N installment inserts that sum to the total", () => {
    const planResult = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-1",
      description: "Geladeira",
      totalAmount: { currency: "BRL", cents: 100000 },
      installmentCount: 3,
      purchasedOn: "2026-06-15",
      createdByUserId: USER,
      category: { categoryId: "cat-casa" },
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const group = installmentGroupInsertFromPlan(planResult.value);
    expect(group).toMatchObject({
      household_id: HOUSEHOLD,
      credit_card_id: "card-1",
      description: "Geladeira",
      total_amount_cents: 100000,
      installment_count: 3,
      purchased_on: "2026-06-15",
      category_id: "cat-casa",
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: USER,
      idempotency_key: null,
    });

    expect(
      installmentGroupInsertFromPlan(planResult.value, {
        idempotencyKey: "bot-confirmation-1",
      }).idempotency_key,
    ).toBe("bot-confirmation-1");

    const groupId = "group-xyz";
    const rows = installmentInsertsFromPlan(planResult.value, groupId);
    expect(rows).toHaveLength(3);
    // Earlier parcels absorb the remainder (100000 / 3 -> 33334, 33333, 33333).
    expect(rows.map((r) => r.amount_cents)).toEqual([33334, 33333, 33333]);
    expect(rows.reduce((sum, r) => sum + r.amount_cents, 0)).toBe(100000);
    // Due months are contiguous starting at the purchase month.
    expect(rows.map((r) => r.due_month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(row.installment_group_id).toBe(groupId);
      expect(row.household_id).toBe(HOUSEHOLD);
      expect(row.credit_card_id).toBe("card-1");
      expect(row.installment_count).toBe(3);
      expect(row.category_id).toBe("cat-casa");
      expect(row.created_by_user_id).toBe(USER);
      expect(row.responsibility_scope).toBe("household");
      expect(row.responsible_user_id).toBeNull();
    }
  });

  it("carries a responsible user through to the group and installments", () => {
    const planResult = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-2",
      description: "Notebook",
      totalAmount: { currency: "BRL", cents: 240000 },
      installmentCount: 1,
      purchasedOn: "2026-12-20",
      createdByUserId: USER,
      responsibleUserId: USER,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const group = installmentGroupInsertFromPlan(planResult.value);
    expect(group.responsibility_scope).toBe("user");
    expect(group.responsible_user_id).toBe(USER);

    const rows = installmentInsertsFromPlan(planResult.value, "g1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.due_month).toBe("2026-12");
    expect(rows[0]?.amount_cents).toBe(240000);
    expect(rows[0]?.responsibility_scope).toBe("user");
    expect(rows[0]?.responsible_user_id).toBe(USER);
  });

  it("passes the stable key to the RPC and returns its authoritative replayed rows", async () => {
    const planResult = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: "card-1",
      description: "Notebook",
      totalAmount: { currency: "BRL", cents: 120000 },
      installmentCount: 2,
      purchasedOn: "2026-07-10",
      createdByUserId: USER,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;
    let rpcArgs: Record<string, unknown> | undefined;
    const client = {
      async rpc(_name: string, args: Record<string, unknown>) {
        rpcArgs = args;
        return {
          data: {
            group: {
              id: "group-existing",
              credit_card_id: "card-1",
              description: "Notebook",
              total_amount_cents: 120000,
              installment_count: 2,
              purchased_on: "2026-07-10",
            },
            installments: [
              { id: "parcel-1", number: 1, due_month: "2026-08" },
              { id: "parcel-2", number: 2, due_month: "2026-09" },
            ],
          },
          error: null,
        };
      },
    } as unknown as AppSupabaseClient;

    const result = await createInstallmentPurchase(client, planResult.value, {
      idempotencyKey: "stable-confirmation-key",
    });

    expect(
      (rpcArgs?.group_payload as { idempotency_key?: string }).idempotency_key,
    ).toBe("stable-confirmation-key");
    expect(result.group.id).toBe("group-existing");
    expect(result.installments[0]?.due_month).toBe("2026-08");
  });
});

// --- Task 10: dashboard aggregation ----------------------------------------

describe("currentMonth", () => {
  it("formats a date as YYYY-MM in the Casa timezone", () => {
    expect(currentMonth(new Date("2026-03-09T12:00:00Z"))).toBe("2026-03");
    expect(currentMonth(new Date("2027-01-01T01:30:00Z"))).toBe("2026-12");
  });
});

describe("summarizeCardPressure", () => {
  it("sums card expenses and due installments, ignoring card refunds (income)", () => {
    const pressure = summarizeCardPressure(
      "2026-06",
      [
        { kind: "expense", amount_cents: 5000 },
        { kind: "expense", amount_cents: 12000 },
        { kind: "income", amount_cents: 3000 }, // refund on the card: ignored
      ],
      [{ amount_cents: 33334 }, { amount_cents: 33333 }],
    );
    expect(pressure).toEqual({
      month: "2026-06",
      directCents: 17000,
      installmentCents: 66667,
      totalCents: 83667,
    });
  });

  it("returns zeros when nothing is on the card this month", () => {
    expect(summarizeCardPressure("2026-07", [], [])).toEqual({
      month: "2026-07",
      directCents: 0,
      installmentCents: 0,
      totalCents: 0,
    });
  });
});

describe("mapUpcomingInstallment", () => {
  it("maps an installment row to the dashboard upcoming-parcel shape", () => {
    const row: Pick<
      InstallmentRow,
      | "id"
      | "description"
      | "number"
      | "installment_count"
      | "amount_cents"
      | "due_month"
      | "credit_card_id"
    > = {
      id: "inst-1",
      description: "Geladeira",
      number: 2,
      installment_count: 3,
      amount_cents: 33333,
      due_month: "2026-07",
      credit_card_id: "card-1",
    };
    expect(mapUpcomingInstallment(row)).toEqual({
      id: "inst-1",
      description: "Geladeira",
      number: 2,
      installmentCount: 3,
      amountCents: 33333,
      dueMonth: "2026-07",
      creditCardId: "card-1",
    });
  });
});

describe("mapDashboardTransaction", () => {
  it("flags category presence and card payment", () => {
    expect(
      mapDashboardTransaction({
        id: "tx-1",
        kind: "expense",
        amount_cents: 1599,
        occurred_on: "2026-06-22",
        description: "Café",
        category_id: null,
        credit_card_id: "card-1",
      }),
    ).toEqual({
      id: "tx-1",
      kind: "expense",
      amountCents: 1599,
      occurredOn: "2026-06-22",
      description: "Café",
      hasCategory: false,
      onCard: true,
    });

    expect(
      mapDashboardTransaction({
        id: "tx-2",
        kind: "income",
        amount_cents: 250000,
        occurred_on: "2026-06-01",
        description: "Salário",
        category_id: "cat-1",
        credit_card_id: null,
      }),
    ).toMatchObject({ hasCategory: true, onCard: false });
  });
});

describe("needsReview", () => {
  it("flags uncategorized expense/income but not transfers or categorized rows", () => {
    expect(needsReview({ kind: "expense", category_id: null })).toBe(true);
    expect(needsReview({ kind: "income", category_id: null })).toBe(true);
    expect(needsReview({ kind: "expense", category_id: "cat-1" })).toBe(false);
    expect(needsReview({ kind: "transfer", category_id: null })).toBe(false);
  });
});

// --- Task 2 (v1.0): transaction patch mapping + bucket balance validation ---

/** A client that explodes on ANY use — proves validation runs before I/O. */
const explodingClient = new Proxy(
  {},
  {
    get() {
      throw new Error("unexpected database access");
    },
  },
) as AppSupabaseClient;

describe("transactionUpdateFromPatch", () => {
  it("maps a full patch to the column-keyed update object", () => {
    expect(
      transactionUpdateFromPatch({
        categoryId: "cat-1",
        subcategoryId: "sub-1",
        description: "  Mercado do mês  ",
        responsibility: { scope: "user", userId: USER },
        occurredOn: "2026-06-22",
      }),
    ).toEqual({
      category_id: "cat-1",
      subcategory_id: "sub-1",
      description: "Mercado do mês",
      responsibility_scope: "user",
      responsible_user_id: USER,
      occurred_on: "2026-06-22",
    });
  });

  it("maps household responsibility to scope household + null user", () => {
    expect(
      transactionUpdateFromPatch({ responsibility: { scope: "household" } }),
    ).toEqual({
      responsibility_scope: "household",
      responsible_user_id: null,
    });
  });

  it("keeps explicit nulls for category/subcategory (un-categorize)", () => {
    expect(
      transactionUpdateFromPatch({ categoryId: null, subcategoryId: null }),
    ).toEqual({ category_id: null, subcategory_id: null });
  });

  it("omits fields that are not present in the patch", () => {
    expect(transactionUpdateFromPatch({})).toEqual({});
    expect(transactionUpdateFromPatch({ description: "Café" })).toEqual({
      description: "Café",
    });
  });

  it("rejects an occurredOn that is not an ISO date", () => {
    for (const bad of ["22/06/2026", "2026-6-2", "2026-06-22T10:00:00Z", ""]) {
      expect(() => transactionUpdateFromPatch({ occurredOn: bad })).toThrow(
        /data/i,
      );
    }
  });

  it("rejects an empty description when present", () => {
    expect(() => transactionUpdateFromPatch({ description: "   " })).toThrow(
      /descrição/i,
    );
  });

  it("maps amountCents and rejects non-positive or non-integer values", () => {
    expect(transactionUpdateFromPatch({ amountCents: 4590 })).toEqual({
      amount_cents: 4590,
    });
    for (const bad of [0, -100, 12.5]) {
      expect(() => transactionUpdateFromPatch({ amountCents: bad })).toThrow(
        /valor/i,
      );
    }
  });

  it("maps a payment swap to BOTH columns in one update (account and card)", () => {
    expect(
      transactionUpdateFromPatch({
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).toEqual({ credit_card_id: "card-1", account_id: null });
    expect(
      transactionUpdateFromPatch({
        payment: { type: "account", accountId: "acct-1" },
      }),
    ).toEqual({ account_id: "acct-1", credit_card_id: null });
  });

  it("rejects a payment patch with an empty id", () => {
    expect(() =>
      transactionUpdateFromPatch({
        payment: { type: "account", accountId: "" },
      }),
    ).toThrow(/conta/i);
    expect(() =>
      transactionUpdateFromPatch({
        payment: { type: "card", creditCardId: "" },
      }),
    ).toThrow(/cartão/i);
  });
});

describe("updateInvestmentBucketBalance validation", () => {
  it("rejects a negative balance before touching the database", async () => {
    await expect(
      updateInvestmentBucketBalance(explodingClient, HOUSEHOLD, "bucket-1", -1),
    ).rejects.toThrow(/saldo/i);
  });

  it("rejects a non-integer balance before touching the database", async () => {
    await expect(
      updateInvestmentBucketBalance(
        explodingClient,
        HOUSEHOLD,
        "bucket-1",
        100.5,
      ),
    ).rejects.toThrow(/saldo/i);
  });

  it("rejects a non-finite balance before touching the database", async () => {
    await expect(
      updateInvestmentBucketBalance(
        explodingClient,
        HOUSEHOLD,
        "bucket-1",
        Number.NaN,
      ),
    ).rejects.toThrow(/saldo/i);
  });
});

// --- Task 8 (v1.0): service-role client + telegram lookup + conversations ---

describe("createServiceRoleClient", () => {
  it("constructs a client with session persistence and token refresh disabled", () => {
    const client = createServiceRoleClient({
      supabaseUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "service-role-test-key",
    });
    // No network happens on construction. The auth client keeps the options it
    // was constructed with, so we assert the bot-safe posture directly.
    const auth = client.auth as unknown as {
      persistSession: boolean;
      autoRefreshToken: boolean;
    };
    expect(auth.persistSession).toBe(false);
    expect(auth.autoRefreshToken).toBe(false);
  });
});

/**
 * Minimal fake Supabase client for the Task 8 repositories: records the table,
 * filters, and payloads it saw and returns a canned response. Chainable like
 * the real PostgREST builder for the few methods these repositories use.
 */
function createRecordingClient(response: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  const calls: {
    table?: string;
    select?: string;
    eq: Array<[string, unknown]>;
    upsert?: unknown;
    deleted?: boolean;
  } = { eq: [] };
  const result = { data: response.data ?? null, error: response.error ?? null };
  const builder = {
    select(columns: string) {
      calls.select = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.eq.push([column, value]);
      return builder;
    },
    upsert(payload: unknown) {
      calls.upsert = payload;
      return Promise.resolve(result);
    },
    delete() {
      calls.deleted = true;
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(resolve: (value: typeof result) => unknown) {
      return Promise.resolve(result).then(resolve);
    },
  };
  const client = {
    from(table: string) {
      calls.table = table;
      return builder;
    },
  } as unknown as AppSupabaseClient;
  return { client, calls };
}

/**
 * Fake client for updateTransaction and deleteTransaction tests.
 * Returns a pre-configured row when selecting by household_id + id,
 * and returns success on update/delete.
 */
function fakeClientWithRow(rowData: Partial<TransactionRow> = {}) {
  const defaultRow: TransactionRow = {
    id: "tx-1",
    household_id: HOUSEHOLD,
    kind: "expense",
    amount_cents: 1000,
    occurred_on: "2026-07-01",
    description: "Test",
    category_id: null,
    subcategory_id: null,
    account_id: "acct-1",
    credit_card_id: null,
    installment_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: USER,
    import_batch_id: null,
    obligation_id: null,
    obligation_month: null,
    bill_month: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
  const row = { ...defaultRow, ...rowData };
  let selectCalled = false;
  let updateCalled = false;
  let eqFilters: Array<[string, unknown]> = [];

  const builder = {
    select() {
      selectCalled = true;
      return builder;
    },
    update() {
      updateCalled = true;
      return builder;
    },
    eq(column: string, value: unknown) {
      eqFilters.push([column, value]);
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: selectCalled ? row : null, error: null });
    },
    then(resolve: (value: { data: null; error: null }) => unknown) {
      return Promise.resolve({
        data: updateCalled ? null : null,
        error: null,
      }).then(resolve);
    },
  };

  const client = {
    from() {
      return builder;
    },
  } as unknown as AppSupabaseClient;

  return client;
}

describe("updateInstallmentGroup", () => {
  /** Records every update per table so the group+parcels propagation is visible. */
  function fakeGroupClient() {
    const updates: Array<{
      table: string;
      changes: Record<string, unknown>;
      filters: Array<[string, unknown]>;
    }> = [];
    const client = {
      from(table: string) {
        const entry = {
          table,
          changes: {} as Record<string, unknown>,
          filters: [] as Array<[string, unknown]>,
        };
        const builder = {
          update(changes: Record<string, unknown>) {
            entry.changes = changes;
            updates.push(entry);
            return builder;
          },
          eq(column: string, value: unknown) {
            entry.filters.push([column, value]);
            return builder;
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      },
    } as unknown as AppSupabaseClient;
    return { client, updates };
  }

  it("patches the group and its parcels with the same categorization", async () => {
    const { client, updates } = fakeGroupClient();
    await updateInstallmentGroup(client, HOUSEHOLD, "group-1", {
      categoryId: "cat-1",
      subcategoryId: null,
    });
    expect(updates.map((u) => u.table)).toEqual([
      "installment_groups",
      "installments",
    ]);
    const group = updates.find((u) => u.table === "installment_groups");
    const parcels = updates.find((u) => u.table === "installments");
    expect(group?.changes).toEqual({
      category_id: "cat-1",
      subcategory_id: null,
    });
    expect(group?.filters).toContainEqual(["household_id", HOUSEHOLD]);
    expect(group?.filters).toContainEqual(["id", "group-1"]);
    expect(parcels?.changes).toEqual({
      category_id: "cat-1",
      subcategory_id: null,
    });
    expect(parcels?.filters).toContainEqual([
      "installment_group_id",
      "group-1",
    ]);
  });

  it("is a no-op for an empty patch", async () => {
    const { client, updates } = fakeGroupClient();
    await updateInstallmentGroup(client, HOUSEHOLD, "group-1", {});
    expect(updates).toHaveLength(0);
  });
});

describe("updateTransaction with parcela guard", () => {
  it("refuses amount/payment edits on a parcela row (installment_id set), pt-BR", async () => {
    const client = fakeClientWithRow({ installment_id: "inst-1" });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", { amountCents: 1000 }),
    ).rejects.toThrow(/parcelamento/i);
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", {
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).rejects.toThrow(/parcelamento/i);
  });

  it("still allows description/category edits on a parcela row", async () => {
    const client = fakeClientWithRow({ installment_id: "inst-1" });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", { description: "Café" }),
    ).resolves.toBeUndefined();
  });
});

describe("updateTransaction with income+card guard", () => {
  it("rejects a card payment patch on an income row, pt-BR", async () => {
    const client = fakeClientWithRow({ kind: "income", installment_id: null });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", {
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).rejects.toThrow(/conta/i);
  });

  it("allows an account payment patch on an income row", async () => {
    const client = fakeClientWithRow({ kind: "income", installment_id: null });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", {
        payment: { type: "account", accountId: "acct-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("still allows a card payment patch on an expense row (regression)", async () => {
    const client = fakeClientWithRow({ kind: "expense", installment_id: null });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", {
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("updateTransaction with transfer guard", () => {
  it("rejects a payment patch on a transfer row (card-bill settlement), pt-BR", async () => {
    const client = fakeClientWithRow({
      installment_id: null,
      kind: "transfer",
    });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", {
        payment: { type: "account", accountId: "a2" },
      }),
    ).rejects.toThrow(/Transferência tem conta e cartão fixos/);
  });

  it("still allows an amountCents-only edit on a transfer row", async () => {
    const client = fakeClientWithRow({
      installment_id: null,
      kind: "transfer",
    });
    await expect(
      updateTransaction(client, HOUSEHOLD, "tx-1", { amountCents: 5000 }),
    ).resolves.toBeUndefined();
  });
});

describe("settleCardBill", () => {
  it("calls the RPC with snake_case target args and returns the result", async () => {
    const result = {
      transaction: { id: "tx-1", bill_month: "2026-07" },
      already_paid: false,
    };
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: result, error: null };
      },
    } as unknown as AppSupabaseClient;

    const out = await settleCardBill(client, {
      householdId: "house-1",
      creditCardId: "card-1",
      accountId: "acct-1",
      billMonth: "2026-07",
      amountCents: 235000,
      paidOn: "2026-07-06",
      createdByUserId: "user-1",
    });
    expect(out).toEqual(result);
    expect(calls[0]).toEqual({
      name: "settle_card_bill",
      args: {
        target_household_id: "house-1",
        target_credit_card_id: "card-1",
        target_account_id: "acct-1",
        target_bill_month: "2026-07",
        target_amount_cents: 235000,
        target_paid_on: "2026-07-06",
        target_created_by_user_id: "user-1",
      },
    });
  });

  it("throws on RPC error", async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as AppSupabaseClient;
    await expect(
      settleCardBill(client, {
        householdId: "house-1",
        creditCardId: "card-1",
        accountId: "acct-1",
        billMonth: "2026-07",
        amountCents: 235000,
        paidOn: "2026-07-06",
        createdByUserId: "user-1",
      }),
    ).rejects.toThrow("settleCardBill failed: boom");
  });
});

describe("confirmImportV2", () => {
  const batch = {
    household_id: HOUSEHOLD,
    source: "mercado_pago_pdf" as const,
    request_key: "22222222-2222-4222-8222-222222222222",
    payload_fingerprint: "a".repeat(64),
    created_by_user_id: USER,
    parser_version: "mercado-pago-pdf@1",
  };

  const items = [
    {
      household_id: HOUSEHOLD,
      disposition: "imported" as const,
      source_line: 2,
      occurred_on: "2026-07-02",
      amount_cents: -1990,
      description: "Padaria",
      fingerprint_version: 1,
      base_fingerprint: "b".repeat(64),
      occurrence_no: 1,
      card_last4: "1234",
      transaction: {
        household_id: HOUSEHOLD,
        kind: "expense" as const,
        amount_cents: 1990,
        occurred_on: "2026-07-02",
        description: "Padaria",
        category_id: null,
        subcategory_id: null,
        account_id: null,
        credit_card_id: "33333333-3333-4333-8333-333333333333",
        installment_id: null,
        responsibility_scope: "household" as const,
        responsible_user_id: null,
        created_by_user_id: USER,
        obligation_id: null,
        obligation_month: null,
        bill_month: null,
      },
    },
  ];

  it("passes the immutable batch and item payloads to the atomic v2 RPC", async () => {
    const result = {
      batch: { id: "batch-1" },
      imported_rows: 1,
      duplicate_rows: 0,
      error_rows: 0,
      excluded_rows: 0,
      transactions_created: 1,
      installment_groups_created: 0,
      replayed: false,
    };
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: result, error: null };
      },
    } as unknown as AppSupabaseClient;

    await expect(confirmImportV2(client, batch, items)).resolves.toEqual(
      result,
    );
    expect(calls).toEqual([
      {
        name: "confirm_import_v2",
        args: { batch_payload: batch, items_payload: items },
      },
    ]);
  });

  it("names RPC failures at the repository boundary", async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: "claim failed" } }),
    } as unknown as AppSupabaseClient;
    await expect(confirmImportV2(client, batch, items)).rejects.toThrow(
      "confirmImportV2 failed: claim failed",
    );
  });
});

describe("findCardBillSettlements", () => {
  it("queries transfer rows for the household + month and maps the result", async () => {
    const { client, calls } = createRecordingClient({
      data: [
        {
          credit_card_id: "card-1",
          amount_cents: 235000,
          occurred_on: "2026-07-06",
        },
      ],
    });
    const out = await findCardBillSettlements(client, HOUSEHOLD, "2026-07");
    expect(calls.table).toBe("transactions");
    expect(calls.select).toBe("credit_card_id, amount_cents, occurred_on");
    expect(calls.eq).toEqual([
      ["household_id", HOUSEHOLD],
      ["kind", "transfer"],
      ["bill_month", "2026-07"],
    ]);
    expect(out).toEqual([
      { creditCardId: "card-1", amountCents: 235000, paidOn: "2026-07-06" },
    ]);
  });

  it("throws on a database error", async () => {
    const { client } = createRecordingClient({ error: { message: "boom" } });
    await expect(
      findCardBillSettlements(client, HOUSEHOLD, "2026-07"),
    ).rejects.toThrow("findCardBillSettlements failed: boom");
  });
});

describe("findMemberByTelegramUserId", () => {
  it("maps an active member row to the bot identity shape", async () => {
    const { client, calls } = createRecordingClient({
      data: {
        household_id: HOUSEHOLD,
        user_id: USER,
        display_name: "Karol",
      },
    });
    const identity = await findMemberByTelegramUserId(client, 987654321);
    expect(identity).toEqual({
      householdId: HOUSEHOLD,
      userId: USER,
      displayName: "Karol",
    });
    expect(calls.table).toBe("household_members");
    expect(calls.eq).toContainEqual(["telegram_user_id", 987654321]);
    expect(calls.eq).toContainEqual(["is_active", true]);
  });

  it("returns null when no member is linked to the telegram id", async () => {
    const { client } = createRecordingClient({ data: null });
    await expect(findMemberByTelegramUserId(client, 42)).resolves.toBeNull();
  });

  it("throws on a database error", async () => {
    const { client } = createRecordingClient({ error: { message: "boom" } });
    await expect(findMemberByTelegramUserId(client, 42)).rejects.toThrow(
      /findMemberByTelegramUserId failed: boom/,
    );
  });
});

describe("bot conversation store repositories", () => {
  it("loadBotConversation returns the stored state and timestamp", async () => {
    const { client, calls } = createRecordingClient({
      data: {
        chat_id: 555,
        state: { status: "awaiting_confirmation" },
        updated_at: "2026-07-01T12:00:00.000Z",
      },
    });
    await expect(loadBotConversation(client, 555)).resolves.toEqual({
      state: { status: "awaiting_confirmation" },
      updatedAt: "2026-07-01T12:00:00.000Z",
    });
    expect(calls.table).toBe("bot_conversations");
    expect(calls.eq).toContainEqual(["chat_id", 555]);
  });

  it("loadBotConversation returns null when there is no row", async () => {
    const { client } = createRecordingClient({ data: null });
    await expect(loadBotConversation(client, 555)).resolves.toBeNull();
  });

  it("saveBotConversation upserts the state keyed by chat id with a fresh updated_at", async () => {
    const { client, calls } = createRecordingClient({});
    const before = Date.now();
    await saveBotConversation(client, 555, { status: "drafting" });
    expect(calls.table).toBe("bot_conversations");
    const payload = calls.upsert as {
      chat_id: number;
      state: unknown;
      updated_at: string;
    };
    expect(payload.chat_id).toBe(555);
    expect(payload.state).toEqual({ status: "drafting" });
    expect(Date.parse(payload.updated_at)).toBeGreaterThanOrEqual(before);
  });

  it("deleteBotConversation deletes by chat id", async () => {
    const { client, calls } = createRecordingClient({});
    await deleteBotConversation(client, 555);
    expect(calls.table).toBe("bot_conversations");
    expect(calls.deleted).toBe(true);
    expect(calls.eq).toContainEqual(["chat_id", 555]);
  });

  it("save and delete surface database errors", async () => {
    const failing = createRecordingClient({ error: { message: "nope" } });
    await expect(saveBotConversation(failing.client, 1, {})).rejects.toThrow(
      /saveBotConversation failed: nope/,
    );
    const failingDelete = createRecordingClient({ error: { message: "nope" } });
    await expect(
      deleteBotConversation(failingDelete.client, 1),
    ).rejects.toThrow(/deleteBotConversation failed: nope/);
  });
});

describe("obligationInsertFromDraft", () => {
  const draft = {
    householdId: HOUSEHOLD,
    description: "Parcela solar",
    amountCents: 71044,
    startMonth: "2026-10",
    termMonths: 72 as number | null,
    dueDay: 5,
    category: {},
    responsibility: { scope: "household" as const },
    accountId: "acc-1",
    createdByUserId: USER,
  };

  it("maps a household-responsibility draft", () => {
    expect(obligationInsertFromDraft(draft)).toEqual({
      household_id: HOUSEHOLD,
      description: "Parcela solar",
      amount_cents: 71044,
      start_month: "2026-10",
      term_months: 72,
      due_day: 5,
      category_id: null,
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      account_id: "acc-1",
      status: "active",
      created_by_user_id: USER,
    });
  });

  it("maps user responsibility, category and an indefinite term", () => {
    const insert = obligationInsertFromDraft({
      ...draft,
      termMonths: null,
      category: { categoryId: "cat-1", subcategoryId: "sub-1" },
      responsibility: { scope: "user", userId: USER },
    });
    expect(insert.term_months).toBeNull();
    expect(insert.category_id).toBe("cat-1");
    expect(insert.subcategory_id).toBe("sub-1");
    expect(insert.responsibility_scope).toBe("user");
    expect(insert.responsible_user_id).toBe(USER);
  });
});

describe("mapObligationRow", () => {
  it("maps a row to the domain-facing shape", () => {
    const row: ObligationRow = {
      id: "ob-1",
      household_id: HOUSEHOLD,
      description: "Aluguel",
      amount_cents: 120000,
      start_month: "2026-01",
      term_months: null,
      due_day: 10,
      category_id: "cat-1",
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      account_id: "acc-1",
      status: "active",
      created_by_user_id: USER,
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
    };
    expect(mapObligationRow(row)).toEqual({
      id: "ob-1",
      householdId: HOUSEHOLD,
      description: "Aluguel",
      amountCents: 120000,
      startMonth: "2026-01",
      termMonths: null,
      dueDay: 10,
      categoryId: "cat-1",
      subcategoryId: null,
      responsibilityScope: "household",
      responsibleUserId: null,
      accountId: "acc-1",
      status: "active",
      createdByUserId: USER,
    });
  });
});

describe("obligationMonthYm", () => {
  it("converts the obligation_month date to YYYY-MM", () => {
    expect(obligationMonthYm("2026-10-01")).toBe("2026-10");
  });
  it("throws on malformed dates", () => {
    expect(() => obligationMonthYm("2026-10")).toThrow();
  });
});

describe("summarizeObligationsPressure", () => {
  it("sums projected-unpaid and paid actuals separately", () => {
    const projected = [
      {
        obligationId: "ob-1",
        month: "2026-07",
        amountCents: 71044,
        description: "Solar",
        dueDay: 5,
        accountId: "acc-1",
      },
      {
        obligationId: "ob-2",
        month: "2026-07",
        amountCents: 120000,
        description: "Aluguel",
        dueDay: 10,
        accountId: "acc-1",
      },
    ];
    const paidRows = [{ amount_cents: 50000 }];
    expect(
      summarizeObligationsPressure("2026-07", projected, paidRows),
    ).toEqual({
      month: "2026-07",
      projectedUnpaidCents: 191044,
      paidCents: 50000,
      totalCents: 241044,
    });
  });

  it("is all zeros when nothing projects and nothing was paid", () => {
    expect(summarizeObligationsPressure("2026-07", [], [])).toEqual({
      month: "2026-07",
      projectedUnpaidCents: 0,
      paidCents: 0,
      totalCents: 0,
    });
  });
});

describe("obligationUpdateFromChanges", () => {
  it("maps partial changes to columns and ignores absent keys", () => {
    expect(
      obligationUpdateFromChanges({ amountCents: 80000, dueDay: 7 }),
    ).toEqual({ amount_cents: 80000, due_day: 7 });
    expect(obligationUpdateFromChanges({})).toEqual({});
  });

  it("rejects invalid amounts and due days", () => {
    expect(() => obligationUpdateFromChanges({ amountCents: 0 })).toThrow();
    expect(() => obligationUpdateFromChanges({ dueDay: 29 })).toThrow();
    expect(() => obligationUpdateFromChanges({ description: "  " })).toThrow();
  });
});

describe("createCategory", () => {
  it("inserts an ACTIVE category scoped to the household and returns the row", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = {
      from(table: string) {
        expect(table).toBe("categories");
        return {
          insert(payload: Record<string, unknown>) {
            captured = payload;
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: "cat-new",
                        household_id: "house-1",
                        name: "Pets",
                        is_active: true,
                        created_at: "2026-07-04T00:00:00Z",
                        updated_at: "2026-07-04T00:00:00Z",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    const row = await createCategory(client, "house-1", "Pets");

    expect(captured).toEqual({
      household_id: "house-1",
      name: "Pets",
      is_active: true,
    });
    expect(row.id).toBe("cat-new");
  });

  it("throws a named error when the insert fails", async () => {
    const client = {
      from() {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: null, error: { message: "boom" } };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    await expect(createCategory(client, "house-1", "Pets")).rejects.toThrow(
      /createCategory failed: boom/,
    );
  });
});

describe("createSubcategory", () => {
  it("inserts an active subcategory under the parent category", async () => {
    let captured: unknown;
    const client = {
      from(table: string) {
        expect(table).toBe("subcategories");
        return {
          insert(payload: unknown) {
            captured = payload;
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: "sub-new",
                        household_id: "house-1",
                        category_id: "cat-food",
                        name: "Restaurante temático",
                        is_active: true,
                        created_at: "2026-07-04T00:00:00Z",
                        updated_at: "2026-07-04T00:00:00Z",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    const row = await createSubcategory(
      client,
      "house-1",
      "cat-food",
      "Restaurante temático",
    );

    expect(captured).toEqual({
      household_id: "house-1",
      category_id: "cat-food",
      name: "Restaurante temático",
      is_active: true,
    });
    expect(row.id).toBe("sub-new");
  });

  it("throws a named error when subcategory insert fails", async () => {
    const client = {
      from() {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: null, error: { message: "boom" } };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as AppSupabaseClient;

    await expect(
      createSubcategory(client, "house-1", "cat-food", "Pets"),
    ).rejects.toThrow(/createSubcategory failed: boom/);
  });
});

describe("restoreSubcategory", () => {
  it("reactivates a household-scoped subcategory", async () => {
    const eqs: Array<[string, string]> = [];
    let captured: unknown;
    const client = {
      from(table: string) {
        expect(table).toBe("subcategories");
        const builder = {
          error: null,
          update(payload: unknown) {
            captured = payload;
            return builder;
          },
          eq(field: string, value: string) {
            eqs.push([field, value]);
            return builder;
          },
        };
        return builder;
      },
    } as unknown as AppSupabaseClient;

    await restoreSubcategory(client, "house-1", "sub-old");

    expect(captured).toEqual({ is_active: true });
    expect(eqs).toEqual([
      ["household_id", "house-1"],
      ["id", "sub-old"],
    ]);
  });
});

describe("resolveTelegramMember (review: id back-fill clears username)", () => {
  /** Recording client: null on the id lookup, a member on the username lookup,
   * capturing the back-fill update payload. */
  function client() {
    const updates: Array<{
      payload: Record<string, unknown>;
      eq: Array<[string, unknown]>;
    }> = [];
    let call = 0;
    const build = () => {
      const eqs: Array<[string, unknown]> = [];
      let updatePayload: Record<string, unknown> | undefined;
      const b: Record<string, unknown> = {
        select() {
          return b;
        },
        update(payload: Record<string, unknown>) {
          updatePayload = payload;
          return b;
        },
        eq(col: string, val: unknown) {
          eqs.push([col, val]);
          if (updatePayload !== undefined) {
            updates.push({ payload: updatePayload, eq: eqs.slice() });
            return Promise.resolve({ data: null, error: null });
          }
          return b;
        },
        maybeSingle() {
          call += 1;
          // 1st select = by telegram_user_id (miss); 2nd = by username (hit).
          if (call === 1) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({
            data: {
              id: "member-1",
              household_id: HOUSEHOLD,
              user_id: USER,
              display_name: "Karol",
            },
            error: null,
          });
        },
      };
      return b;
    };
    const c = { from: () => build() } as unknown as AppSupabaseClient;
    return { c, updates };
  }

  it("clears telegram_username when back-filling the numeric id", async () => {
    const { c, updates } = client();
    const identity = await resolveTelegramMember(c, {
      telegramUserId: 555,
      telegramUsername: "karol",
    });
    expect(identity).toEqual({
      householdId: HOUSEHOLD,
      userId: USER,
      displayName: "Karol",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toEqual({
      telegram_user_id: 555,
      telegram_username: null,
    });
    expect(updates[0]?.eq).toContainEqual(["id", "member-1"]);
  });
});

describe("getMonthlySummary pagination (review: no 1000-row cap on money sums)", () => {
  /** A fake that caps each .range() page like PostgREST's max_rows, so the
   * repository must page to see every row. */
  function pagingClient(
    rows: Array<{ kind: string; amount_cents: number }>,
    cap = 1000,
  ) {
    const build = () => {
      let rangeFrom = 0;
      let rangeTo = Number.MAX_SAFE_INTEGER;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        lte: () => b,
        not: () => b,
        range(from: number, to: number) {
          rangeFrom = from;
          rangeTo = to;
          const pageSpan = Math.min(to - from + 1, cap);
          const page = rows.slice(from, from + pageSpan);
          return Promise.resolve({ data: page, error: null });
        },
      };
      return b;
    };
    return { from: () => build() } as unknown as AppSupabaseClient;
  }

  it("sums income/expense across more than 1000 rows", async () => {
    // 2500 expense rows of 100 cents each = 250000; the naive single select
    // would stop at 1000 (=100000).
    const rows = Array.from({ length: 2500 }, () => ({
      kind: "expense",
      amount_cents: 100,
    }));
    const client = pagingClient(rows);
    const summary = await getMonthlySummary(client, HOUSEHOLD, "2026-07");
    expect(summary.expenseCents).toBe(250000);
  });
});
