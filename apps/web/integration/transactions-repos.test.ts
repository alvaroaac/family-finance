/**
 * Fake-store integration tests for the v1.0 Task 2 repositories: the REAL
 * `@family-finance/db` functions run unchanged against the in-memory fake (see
 * ./fake-supabase.ts), so filtering, pagination (`.range` + exact count),
 * `.ilike` search, edit/delete rules, member profiles, caixinha balance and
 * the last-bot-interaction read are exercised over the same code path
 * production uses. There are NO live network calls.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  findTransactionsFiltered,
  updateTransaction,
  deleteTransaction,
  listHouseholdMembers,
  updateHouseholdMember,
  updateInvestmentBucketBalance,
  findLastBotInteraction,
  type AppSupabaseClient,
} from "@family-finance/db";

import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const OTHER_HOUSEHOLD = "00000000-0000-0000-0000-000000000002";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const KAROL = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "acc-nubank";
const CARD = "card-roxinho";
const CAT_MERCADO = "cat-mercado";

type TxSeed = {
  id: string;
  kind?: "expense" | "income" | "transfer";
  amount_cents?: number;
  occurred_on: string;
  description: string;
  category_id?: string | null;
  account_id?: string | null;
  credit_card_id?: string | null;
  installment_id?: string | null;
  responsibility_scope?: "household" | "user";
  responsible_user_id?: string | null;
  household_id?: string;
  created_at?: string;
};

function tx(seed: TxSeed): Record<string, unknown> {
  return {
    kind: "expense",
    amount_cents: 1000,
    category_id: null,
    subcategory_id: null,
    account_id: null,
    credit_card_id: null,
    installment_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: ALVARO,
    import_batch_id: null,
    household_id: HOUSEHOLD,
    created_at: `${seed.occurred_on}T12:00:00Z`,
    updated_at: `${seed.occurred_on}T12:00:00Z`,
    ...seed,
  };
}

function seedStore(): FakeSupabaseStore {
  const seed: FakeDatabaseSeed = {
    transactions: [
      tx({
        id: "tx-mercado",
        occurred_on: "2026-06-05",
        description: "Mercado Pão de Açúcar",
        amount_cents: 25000,
        category_id: CAT_MERCADO,
        account_id: ACCOUNT,
        responsibility_scope: "user",
        responsible_user_id: ALVARO,
      }),
      tx({
        id: "tx-farmacia",
        occurred_on: "2026-06-10",
        description: "Farmácia",
        amount_cents: 4500,
        credit_card_id: CARD,
      }),
      tx({
        id: "tx-salario",
        kind: "income",
        occurred_on: "2026-06-01",
        description: "Salário",
        amount_cents: 900000,
        category_id: "cat-renda",
        account_id: ACCOUNT,
      }),
      tx({
        id: "tx-transfer",
        kind: "transfer",
        occurred_on: "2026-06-15",
        description: "Aporte caixinha",
        amount_cents: 50000,
        account_id: ACCOUNT,
      }),
      tx({
        id: "tx-parcela",
        occurred_on: "2026-06-20",
        description: "Geladeira 1/3",
        amount_cents: 33334,
        credit_card_id: CARD,
        installment_id: "inst-1",
      }),
      tx({
        id: "tx-maio",
        occurred_on: "2026-05-28",
        description: "Mercado do mês passado",
        amount_cents: 19900,
        category_id: CAT_MERCADO,
        account_id: ACCOUNT,
      }),
      tx({
        id: "tx-vizinho",
        occurred_on: "2026-06-08",
        description: "Mercado da outra casa",
        household_id: OTHER_HOUSEHOLD,
      }),
    ],
    household_members: [
      {
        id: "member-alvaro",
        household_id: HOUSEHOLD,
        user_id: ALVARO,
        role: "owner",
        is_active: true,
        display_name: "Álvaro",
        telegram_user_id: 123456,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "member-karol",
        household_id: HOUSEHOLD,
        user_id: KAROL,
        role: "member",
        is_active: true,
        display_name: null,
        telegram_user_id: null,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    ],
    investment_buckets: [
      {
        id: "bucket-filhos",
        household_id: HOUSEHOLD,
        slug: "filhos",
        name: "Filhos",
        balance_cents: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    bot_interactions: [
      {
        id: "bi-1",
        household_id: HOUSEHOLD,
        channel: "telegram",
        input_kind: "text",
        transaction_id: null,
        created_at: "2026-06-10T09:00:00Z",
        updated_at: "2026-06-10T09:00:00Z",
      },
      {
        id: "bi-2",
        household_id: HOUSEHOLD,
        channel: "telegram",
        input_kind: "voice",
        transaction_id: "tx-farmacia",
        created_at: "2026-06-12T18:30:00Z",
        updated_at: "2026-06-12T18:30:00Z",
      },
    ],
  };
  return new FakeSupabaseStore(seed);
}

let store: FakeSupabaseStore;
let client: AppSupabaseClient;

beforeEach(() => {
  store = seedStore();
  client = createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
});

describe("findTransactionsFiltered", () => {
  it("returns the household's month, newest first, with the exact total", async () => {
    const page = await findTransactionsFiltered(client, HOUSEHOLD, {
      month: "2026-06",
    });
    expect(page.total).toBe(5); // tx-maio (May) and tx-vizinho (other house) excluded
    expect(page.rows.map((r) => r.id)).toEqual([
      "tx-parcela",
      "tx-transfer",
      "tx-farmacia",
      "tx-mercado",
      "tx-salario",
    ]);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(50);
  });

  it("filters by account, card, category and responsible", async () => {
    const byAccount = await findTransactionsFiltered(client, HOUSEHOLD, {
      accountId: ACCOUNT,
    });
    expect(byAccount.rows.map((r) => r.id).sort()).toEqual([
      "tx-maio",
      "tx-mercado",
      "tx-salario",
      "tx-transfer",
    ]);

    const byCard = await findTransactionsFiltered(client, HOUSEHOLD, {
      creditCardId: CARD,
    });
    expect(byCard.rows.map((r) => r.id).sort()).toEqual([
      "tx-farmacia",
      "tx-parcela",
    ]);

    const byCategory = await findTransactionsFiltered(client, HOUSEHOLD, {
      categoryId: CAT_MERCADO,
    });
    expect(byCategory.rows.map((r) => r.id).sort()).toEqual([
      "tx-maio",
      "tx-mercado",
    ]);

    const byUser = await findTransactionsFiltered(client, HOUSEHOLD, {
      responsible: ALVARO,
    });
    expect(byUser.rows.map((r) => r.id)).toEqual(["tx-mercado"]);

    const byHouse = await findTransactionsFiltered(client, HOUSEHOLD, {
      responsible: "household",
    });
    expect(byHouse.total).toBe(5);
    expect(byHouse.rows.map((r) => r.id)).not.toContain("tx-mercado");
  });

  it("pendingOnly keeps uncategorized non-transfers (needsReview rule)", async () => {
    const page = await findTransactionsFiltered(client, HOUSEHOLD, {
      pendingOnly: true,
    });
    expect(page.rows.map((r) => r.id).sort()).toEqual([
      "tx-farmacia",
      "tx-parcela",
    ]);
  });

  it("searches the description case-insensitively, treating %/_ literally", async () => {
    const page = await findTransactionsFiltered(client, HOUSEHOLD, {
      search: "mercado",
    });
    expect(page.rows.map((r) => r.id).sort()).toEqual([
      "tx-maio",
      "tx-mercado",
    ]);

    const weird = await findTransactionsFiltered(client, HOUSEHOLD, {
      search: "100% mercado",
    });
    expect(weird.total).toBe(0); // '%' must not act as a wildcard
  });

  it("paginates with a stable exact total across pages", async () => {
    const page1 = await findTransactionsFiltered(
      client,
      HOUSEHOLD,
      { month: "2026-06" },
      1,
      2,
    );
    expect(page1.rows.map((r) => r.id)).toEqual(["tx-parcela", "tx-transfer"]);
    expect(page1.total).toBe(5);

    const page3 = await findTransactionsFiltered(
      client,
      HOUSEHOLD,
      { month: "2026-06" },
      3,
      2,
    );
    expect(page3.rows.map((r) => r.id)).toEqual(["tx-salario"]);
    expect(page3.total).toBe(5);
    expect(page3.page).toBe(3);
    expect(page3.pageSize).toBe(2);
  });
});

describe("updateTransaction / deleteTransaction", () => {
  it("applies a partial edit only to the household's row", async () => {
    await updateTransaction(client, HOUSEHOLD, "tx-farmacia", {
      categoryId: "cat-saude",
      description: "Farmácia São João",
      responsibility: { scope: "user", userId: KAROL },
      occurredOn: "2026-06-11",
    });
    const row = store
      .table("transactions")
      .find((r) => r.id === "tx-farmacia");
    expect(row).toMatchObject({
      category_id: "cat-saude",
      description: "Farmácia São João",
      responsibility_scope: "user",
      responsible_user_id: KAROL,
      occurred_on: "2026-06-11",
    });

    // Wrong household: nothing changes.
    await updateTransaction(client, OTHER_HOUSEHOLD, "tx-mercado", {
      description: "hackeado",
    });
    expect(
      store.table("transactions").find((r) => r.id === "tx-mercado")
        ?.description,
    ).toBe("Mercado Pão de Açúcar");
  });

  it("deletes a plain transaction but refuses a parcela with a pt-BR error", async () => {
    await deleteTransaction(client, HOUSEHOLD, "tx-farmacia");
    expect(
      store.table("transactions").some((r) => r.id === "tx-farmacia"),
    ).toBe(false);

    await expect(
      deleteTransaction(client, HOUSEHOLD, "tx-parcela"),
    ).rejects.toThrow(/grupo do parcelamento/);
    expect(
      store.table("transactions").some((r) => r.id === "tx-parcela"),
    ).toBe(true);
  });
});

describe("household members", () => {
  it("lists members with display name + telegram id surfaced", async () => {
    const members = await listHouseholdMembers(client, HOUSEHOLD);
    expect(members).toEqual([
      {
        id: "member-alvaro",
        userId: ALVARO,
        role: "owner",
        isActive: true,
        displayName: "Álvaro",
        telegramUserId: 123456,
      },
      {
        id: "member-karol",
        userId: KAROL,
        role: "member",
        isActive: true,
        displayName: null,
        telegramUserId: null,
      },
    ]);
  });

  it("updates profile fields, storing a blank display name as null", async () => {
    await updateHouseholdMember(client, HOUSEHOLD, "member-karol", {
      displayName: "  Karol  ",
      telegramUserId: 654321,
    });
    expect(
      store.table("household_members").find((r) => r.id === "member-karol"),
    ).toMatchObject({ display_name: "Karol", telegram_user_id: 654321 });

    await updateHouseholdMember(client, HOUSEHOLD, "member-karol", {
      displayName: "   ",
      telegramUserId: null,
    });
    expect(
      store.table("household_members").find((r) => r.id === "member-karol"),
    ).toMatchObject({ display_name: null, telegram_user_id: null });
  });

  it("rejects a non-integer telegram id before writing", async () => {
    await expect(
      updateHouseholdMember(client, HOUSEHOLD, "member-karol", {
        telegramUserId: 1.5,
      }),
    ).rejects.toThrow(/Telegram/);
  });
});

describe("updateInvestmentBucketBalance", () => {
  it("persists a valid integer balance in cents", async () => {
    await updateInvestmentBucketBalance(
      client,
      HOUSEHOLD,
      "bucket-filhos",
      123456,
    );
    expect(
      store.table("investment_buckets").find((r) => r.id === "bucket-filhos")
        ?.balance_cents,
    ).toBe(123456);
  });
});

describe("findLastBotInteraction", () => {
  it("returns the newest interaction's summary fields", async () => {
    const last = await findLastBotInteraction(client, HOUSEHOLD);
    // The fake store does not project columns, so match on the contract fields.
    expect(last).toMatchObject({
      created_at: "2026-06-12T18:30:00Z",
      input_kind: "voice",
      transaction_id: "tx-farmacia",
    });
  });

  it("returns null when the household has no interactions", async () => {
    const last = await findLastBotInteraction(client, OTHER_HOUSEHOLD);
    expect(last).toBeNull();
  });
});
