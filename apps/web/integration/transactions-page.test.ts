/**
 * Integration tests for the "/transactions" (Transações) screen — v1.0 Task 4.
 *
 * Two layers, both offline:
 *  1. The PURE page helpers (searchParams -> filters, month stepping, href
 *     building, FormData -> TransactionPatch) that the server component and the
 *     server actions share.
 *  2. The REAL `@family-finance/db` repositories driven the way the page drives
 *     them, against the in-memory fake store (see ./fake-supabase.ts): a
 *     60-transaction seed across two months (including one parcela row) so the
 *     50-per-page pagination, filters, inline edit and the guarded delete are
 *     exercised over the same code path production uses.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  findTransactionsFiltered,
  updateTransaction,
  deleteTransaction,
  listHouseholdMembers,
  type AppSupabaseClient,
} from "@family-finance/db";

import {
  parseTransactionsSearchParams,
  shiftMonth,
  transactionsHref,
  transactionPatchFromFormData,
  manualEntryFromFormData,
  PAGE_SIZE,
} from "../app/(app)/transactions/filters.js";
import { NewTransactionForm } from "../app/(app)/transactions/new-transaction-form.js";
import { ToastProvider } from "../components/ui/toast.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

// ---------------------------------------------------------------------------
// 0. NewTransactionForm render tests
// ---------------------------------------------------------------------------

describe("NewTransactionForm", () => {
  const formProps = {
    accounts: [{ id: "acct-1", name: "Conta Corrente" }],
    cards: [{ id: "card-1", name: "Nubank" }],
    categories: [{ id: "cat-1", name: "Alimentação" }],
    subcategories: [{ id: "sub-1", categoryId: "cat-1", name: "Mercado" }],
    responsibles: [
      { value: "household", label: "Casa" },
      { value: "user-alvaro", label: "Alvaro" },
    ],
    initiallyOpen: true,
  };

  it("renders the open panel with every field and both payment options", () => {
    const html = renderToStaticMarkup(
      createElement(ToastProvider, null, createElement(NewTransactionForm, formProps)),
    );
    expect(html).toContain("Novo lançamento");
    expect(html).toContain('name="amount"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="occurredOn"');
    expect(html).toContain('value="account:acct-1"');
    expect(html).toContain('value="card:card-1"');
    expect(html).toContain("Conta: Conta Corrente");
    expect(html).toContain("Cartão: Nubank");
  });

  it("starts collapsed (button only) when initiallyOpen is false", () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(NewTransactionForm, { ...formProps, initiallyOpen: false }),
      ),
    );
    expect(html).toContain("+ Lançamento");
    expect(html).not.toContain('name="amount"');
  });
});

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const KAROL = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "acc-nubank";
const CARD = "card-roxinho";
const CAT_MERCADO = "cat-mercado";

const NOW = new Date("2026-06-18T12:00:00Z");

// ---------------------------------------------------------------------------
// 1. Pure page helpers
// ---------------------------------------------------------------------------

describe("parseTransactionsSearchParams", () => {
  it("defaults to the current month, page 1, no extra filters", () => {
    const parsed = parseTransactionsSearchParams({}, NOW);
    expect(parsed.month).toBe("2026-06");
    expect(parsed.page).toBe(1);
    expect(parsed.filters).toEqual({ month: "2026-06" });
  });

  it("maps every URL param onto the repository filters", () => {
    const parsed = parseTransactionsSearchParams(
      {
        month: "2026-05",
        account: ACCOUNT,
        card: CARD,
        category: CAT_MERCADO,
        resp: "household",
        pending: "1",
        q: "mercado",
        page: "3",
      },
      NOW,
    );
    expect(parsed.month).toBe("2026-05");
    expect(parsed.page).toBe(3);
    expect(parsed.filters).toEqual({
      month: "2026-05",
      accountId: ACCOUNT,
      creditCardId: CARD,
      categoryId: CAT_MERCADO,
      responsible: "household",
      pendingOnly: true,
      search: "mercado",
    });
  });

  it("ignores blank/invalid values (month, page) and array params use the first value", () => {
    const parsed = parseTransactionsSearchParams(
      {
        month: "junho",
        account: "",
        resp: KAROL,
        page: "zero",
        q: ["pizza", "ignored"],
      },
      NOW,
    );
    expect(parsed.month).toBe("2026-06"); // invalid month -> current
    expect(parsed.page).toBe(1);
    expect(parsed.filters).toEqual({
      month: "2026-06",
      responsible: KAROL,
      search: "pizza",
    });
  });
});

describe("shiftMonth", () => {
  it("steps across year boundaries in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-06", 1)).toBe("2026-07");
  });
});

describe("transactionsHref", () => {
  it("serializes only the non-default params, resetting page 1", () => {
    expect(transactionsHref({ month: "2026-06" })).toBe(
      "/transactions?month=2026-06",
    );
    expect(
      transactionsHref({
        month: "2026-06",
        account: ACCOUNT,
        pending: true,
        q: "mercado",
        page: 2,
      }),
    ).toBe(
      `/transactions?month=2026-06&account=${ACCOUNT}&pending=1&q=mercado&page=2`,
    );
    expect(transactionsHref({ month: "2026-06", page: 1 })).toBe(
      "/transactions?month=2026-06",
    );
  });
});

describe("transactionPatchFromFormData", () => {
  it("builds a patch only from the keys present", () => {
    const fd = new FormData();
    fd.set("description", "Padaria da esquina");
    expect(transactionPatchFromFormData(fd)).toEqual({
      description: "Padaria da esquina",
    });
    expect(transactionPatchFromFormData(new FormData())).toEqual({});
  });

  it("maps empty category/subcategory selects to null", () => {
    const fd = new FormData();
    fd.set("categoryId", "");
    fd.set("subcategoryId", "");
    expect(transactionPatchFromFormData(fd)).toEqual({
      categoryId: null,
      subcategoryId: null,
    });

    const fd2 = new FormData();
    fd2.set("categoryId", CAT_MERCADO);
    fd2.set("subcategoryId", "sub-hortifruti");
    expect(transactionPatchFromFormData(fd2)).toEqual({
      categoryId: CAT_MERCADO,
      subcategoryId: "sub-hortifruti",
    });
  });

  it("maps the responsible select to a responsibility patch", () => {
    const casa = new FormData();
    casa.set("responsible", "household");
    expect(transactionPatchFromFormData(casa)).toEqual({
      responsibility: { scope: "household" },
    });

    const user = new FormData();
    user.set("responsible", KAROL);
    expect(transactionPatchFromFormData(user)).toEqual({
      responsibility: { scope: "user", userId: KAROL },
    });
  });

  it("passes occurredOn through for the repo's strict validation", () => {
    const fd = new FormData();
    fd.set("occurredOn", "2026-06-11");
    expect(transactionPatchFromFormData(fd)).toEqual({
      occurredOn: "2026-06-11",
    });
  });
});

describe("manualEntryFromFormData", () => {
  function form(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }
  const base = {
    kind: "expense",
    amount: "56,13",
    description: "OpenAI",
    occurredOn: "2026-07-04",
    payment: "account:acct-1",
    responsible: "household",
  };

  it("parses a pt-BR amount into cents and decodes the payment", () => {
    const input = manualEntryFromFormData(form(base));
    expect(input.amountCents).toBe(5613);
    expect(input.payment).toEqual({ type: "account", accountId: "acct-1" });
    expect(input.kind).toBe("expense");
  });

  it("decodes a card payment", () => {
    const input = manualEntryFromFormData(
      form({ ...base, payment: "card:card-1" }),
    );
    expect(input.payment).toEqual({ type: "card", creditCardId: "card-1" });
  });

  it("rejects a non-positive or unparseable amount in pt-BR", () => {
    expect(() =>
      manualEntryFromFormData(form({ ...base, amount: "0" })),
    ).toThrow(/valor/i);
    expect(() =>
      manualEntryFromFormData(form({ ...base, amount: "abc" })),
    ).toThrow(/valor/i);
  });

  it("rejects income paid by card", () => {
    expect(() =>
      manualEntryFromFormData(
        form({ ...base, kind: "income", payment: "card:card-1" }),
      ),
    ).toThrow(/entrada.*conta/i);
  });

  it("maps responsible member and casa", () => {
    expect(manualEntryFromFormData(form(base)).responsible).toBe("household");
    expect(
      manualEntryFromFormData(form({ ...base, responsible: "user-karol" }))
        .responsible,
    ).toBe("user-karol");
  });
});

describe("transactionPatchFromFormData: amount + payment", () => {
  it("parses an edited amount (pt-BR) into amountCents", () => {
    const fd = new FormData();
    fd.set("amount", "45,90");
    expect(transactionPatchFromFormData(fd).amountCents).toBe(4590);
  });

  it("throws pt-BR on an unparseable amount", () => {
    const fd = new FormData();
    fd.set("amount", "quarenta");
    expect(() => transactionPatchFromFormData(fd)).toThrow(/valor/i);
  });

  it("decodes payment account:/card: values", () => {
    const fd = new FormData();
    fd.set("payment", "card:card-9");
    expect(transactionPatchFromFormData(fd).payment).toEqual({
      type: "card",
      creditCardId: "card-9",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Repositories on the fake store, driven the way the page drives them
// ---------------------------------------------------------------------------

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

/**
 * 60 transactions across two months: 55 in June 2026 (including 1 parcela and
 * 1 uncategorized "Farmácia" pending review) + 5 in May 2026.
 */
function seedStore(): FakeSupabaseStore {
  const june: Record<string, unknown>[] = [];
  // 52 categorized June filler rows, spread over days 01..26 (2 per day).
  for (let i = 0; i < 52; i += 1) {
    const day = String(Math.floor(i / 2) + 1).padStart(2, "0");
    june.push(
      tx({
        id: `tx-jun-${i}`,
        occurred_on: `2026-06-${day}`,
        description: `Compra ${i}`,
        amount_cents: 1000 + i,
        category_id: CAT_MERCADO,
        account_id: ACCOUNT,
      }),
    );
  }
  june.push(
    tx({
      id: "tx-farmacia",
      occurred_on: "2026-06-27",
      description: "Farmácia",
      amount_cents: 4500,
      credit_card_id: CARD,
    }),
    tx({
      id: "tx-parcela",
      occurred_on: "2026-06-28",
      description: "Geladeira 1/3",
      amount_cents: 33334,
      credit_card_id: CARD,
      installment_id: "inst-1",
    }),
    tx({
      id: "tx-mercado",
      occurred_on: "2026-06-29",
      description: "Mercado Pão de Açúcar",
      amount_cents: 25000,
      category_id: CAT_MERCADO,
      account_id: ACCOUNT,
      responsibility_scope: "user",
      responsible_user_id: ALVARO,
    }),
  );

  const may: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i += 1) {
    may.push(
      tx({
        id: `tx-mai-${i}`,
        occurred_on: `2026-05-${String(10 + i)}`,
        description: `Mercado de maio ${i}`,
        amount_cents: 2000 + i,
        category_id: CAT_MERCADO,
        account_id: ACCOUNT,
      }),
    );
  }

  const seed: FakeDatabaseSeed = {
    transactions: [...june, ...may],
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
        display_name: "Karol",
        telegram_user_id: null,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
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

describe("/transactions listing via findTransactionsFiltered", () => {
  it("June has 55 rows: page 1 holds 50, page 2 the remaining 5, total stable", async () => {
    const { filters, page } = parseTransactionsSearchParams(
      { month: "2026-06" },
      NOW,
    );
    const page1 = await findTransactionsFiltered(
      client,
      HOUSEHOLD,
      filters,
      page,
      PAGE_SIZE,
    );
    expect(page1.total).toBe(55);
    expect(page1.rows).toHaveLength(50);
    expect(page1.pageSize).toBe(50);
    // Newest first.
    expect(page1.rows[0]?.id).toBe("tx-mercado");

    const page2 = await findTransactionsFiltered(
      client,
      HOUSEHOLD,
      filters,
      2,
      PAGE_SIZE,
    );
    expect(page2.total).toBe(55);
    expect(page2.rows).toHaveLength(5);
  });

  it("May (via month stepper) has the other 5 rows", async () => {
    const previous = shiftMonth("2026-06", -1);
    const { filters } = parseTransactionsSearchParams(
      { month: previous },
      NOW,
    );
    const page = await findTransactionsFiltered(client, HOUSEHOLD, filters);
    expect(page.total).toBe(5);
  });

  it("pending=1 keeps only rows needing review (uncategorized non-transfers)", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06", pending: "1" },
      NOW,
    );
    const page = await findTransactionsFiltered(client, HOUSEHOLD, filters);
    expect(page.rows.map((r) => r.id).sort()).toEqual([
      "tx-farmacia",
      "tx-parcela",
    ]);
  });

  it("q= searches the description case-insensitively", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06", q: "mercado" },
      NOW,
    );
    const page = await findTransactionsFiltered(client, HOUSEHOLD, filters);
    expect(page.rows.map((r) => r.id)).toEqual(["tx-mercado"]);
  });

  it("list items expose what the table needs: responsibility + parcela link", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06", q: "geladeira" },
      NOW,
    );
    const page = await findTransactionsFiltered(client, HOUSEHOLD, filters);
    expect(page.rows[0]).toMatchObject({
      id: "tx-parcela",
      installmentId: "inst-1",
      responsibilityScope: "household",
      responsibleUserId: null,
    });
  });
});

describe("inline edit via transactionPatchFromFormData + updateTransaction", () => {
  it("persists a category + responsible edit exactly as the action applies it", async () => {
    const fd = new FormData();
    fd.set("categoryId", "cat-saude");
    fd.set("subcategoryId", "");
    fd.set("responsible", KAROL);
    await updateTransaction(
      client,
      HOUSEHOLD,
      "tx-farmacia",
      transactionPatchFromFormData(fd),
    );
    expect(
      store.table("transactions").find((r) => r.id === "tx-farmacia"),
    ).toMatchObject({
      category_id: "cat-saude",
      subcategory_id: null,
      responsibility_scope: "user",
      responsible_user_id: KAROL,
    });
  });

  it("rejects an emptied description with the repo's pt-BR message", async () => {
    const fd = new FormData();
    fd.set("description", "   ");
    await expect(
      updateTransaction(
        client,
        HOUSEHOLD,
        "tx-farmacia",
        transactionPatchFromFormData(fd),
      ),
    ).rejects.toThrow("A descrição não pode ficar vazia.");
  });
});

describe("guarded delete", () => {
  it("deletes a plain row but refuses the parcela with the pt-BR error", async () => {
    await deleteTransaction(client, HOUSEHOLD, "tx-farmacia");
    expect(
      store.table("transactions").some((r) => r.id === "tx-farmacia"),
    ).toBe(false);

    await expect(
      deleteTransaction(client, HOUSEHOLD, "tx-parcela"),
    ).rejects.toThrow(
      "Parcelas são gerenciadas pelo grupo do parcelamento — não dá para excluir uma parcela avulsa.",
    );
  });
});

describe("responsible options for the filter/select", () => {
  it("lists members with display names for the responsável labels", async () => {
    const members = await listHouseholdMembers(client, HOUSEHOLD);
    expect(members.map((m) => m.displayName)).toEqual(["Álvaro", "Karol"]);
  });
});
