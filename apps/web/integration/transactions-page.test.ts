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
  findTransactionLedgerFiltered,
  updateTransaction,
  deleteTransaction,
  listHouseholdMembers,
  type AppSupabaseClient,
  type TransactionLedgerItem,
  type TransactionListItem,
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
import { TransactionsTable } from "../app/(app)/transactions/transactions-table.js";
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
      createElement(
        ToastProvider,
        null,
        createElement(NewTransactionForm, formProps),
      ),
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

  it("shows à vista/parcelado controls when a card is selected", () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(NewTransactionForm, {
          ...formProps,
          accounts: [],
        }),
      ),
    );
    expect(html).toContain("À vista");
    expect(html).toContain("Parcelado");
    expect(html).toContain('name="purchaseMode"');
  });

  it("starts collapsed (button only) when initiallyOpen is false", () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(NewTransactionForm, {
          ...formProps,
          initiallyOpen: false,
        }),
      ),
    );
    expect(html).toContain("+ Lançamento");
    expect(html).not.toContain('name="amount"');
  });
});

// ---------------------------------------------------------------------------
// 0b. TransactionsTable: payment select + amount edit render tests
// ---------------------------------------------------------------------------

function renderTable(overrides: {
  installmentId: string | null;
  kind: "expense" | "income";
}): string {
  const row: TransactionListItem = {
    id: "tx-1",
    householdId: "00000000-0000-0000-0000-000000000001",
    description: "Mercado",
    occurredOn: "2026-07-04",
    amount: { currency: "BRL", cents: 5613 },
    kind: overrides.kind,
    categoryId: null,
    subcategoryId: null,
    createdByUserId: "11111111-1111-1111-1111-111111111111",
    responsibilityScope: "household",
    responsibleUserId: null,
    accountId: overrides.installmentId === null ? "acct-1" : null,
    creditCardId: overrides.installmentId === null ? null : "card-1",
    installmentId: overrides.installmentId,
  };
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(TransactionsTable, {
        rows: [row],
        categories: [],
        subcategories: [],
        responsibles: [{ value: "household", label: "Casa" }],
        accounts: [{ id: "acct-1", name: "Conta Corrente" }],
        cards: [{ id: "card-1", name: "Nubank" }],
      }),
    ),
  );
}

describe("TransactionsTable: payment select", () => {
  it("renders a payment select for a normal row with account and card options", () => {
    const html = renderTable({ installmentId: null, kind: "expense" });
    expect(html).toContain('aria-label="Pagamento"');
    expect(html).toContain('value="account:acct-1"');
    expect(html).toContain('value="card:card-1"');
  });

  it("shows plain text (no select) for a parcela row", () => {
    const html = renderTable({ installmentId: "inst-1", kind: "expense" });
    expect(html).not.toContain('aria-label="Pagamento"');
  });

  it("offers only accounts for an income row", () => {
    const html = renderTable({ installmentId: null, kind: "income" });
    expect(html).toContain('value="account:acct-1"');
    expect(html).not.toContain('value="card:card-1"');
  });

  it("shows plain text (no select) for a transfer row — card-bill payment, both instruments fixed", () => {
    const row: TransactionListItem = {
      id: "tx-transfer-1",
      householdId: "00000000-0000-0000-0000-000000000001",
      description: "Pagamento fatura Nubank",
      occurredOn: "2026-07-04",
      amount: { currency: "BRL", cents: 12000 },
      kind: "transfer",
      categoryId: null,
      subcategoryId: null,
      createdByUserId: "11111111-1111-1111-1111-111111111111",
      responsibilityScope: "household",
      responsibleUserId: null,
      accountId: "acct-1",
      creditCardId: "card-1",
      installmentId: null,
    };
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(TransactionsTable, {
          rows: [row],
          categories: [],
          subcategories: [],
          responsibles: [{ value: "household", label: "Casa" }],
          accounts: [{ id: "acct-1", name: "Conta Corrente" }],
          cards: [{ id: "card-1", name: "Nubank" }],
        }),
      ),
    );
    expect(html).not.toContain('aria-label="Pagamento"');
    expect(html).toContain("Nubank");
  });

  it("renders a parcelado purchase with editable categoria and read-only rest", () => {
    const row: TransactionLedgerItem = {
      itemType: "installment_purchase",
      id: "group-1",
      householdId: "00000000-0000-0000-0000-000000000001",
      description: "Sofá novo",
      purchasedOn: "2026-06-15",
      totalAmountCents: 120000,
      installmentCount: 6,
      creditCardId: "card-1",
      categoryId: "cat-1",
      subcategoryId: null,
      responsibilityScope: "household",
      responsibleUserId: null,
      createdByUserId: "11111111-1111-1111-1111-111111111111",
      firstDueMonth: "2026-06",
      lastDueMonth: "2026-11",
      firstInstallmentCents: 20000,
    };
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(TransactionsTable, {
          rows: [row],
          categories: [{ id: "cat-1", name: "Casa" }],
          subcategories: [],
          responsibles: [{ value: "household", label: "Casa" }],
          accounts: [{ id: "acct-1", name: "Conta Corrente" }],
          cards: [{ id: "card-1", name: "Nubank" }],
        }),
      ),
    );
    expect(html).toContain("Sofá novo");
    expect(html).toContain("parcelado");
    expect(html).toContain("6x");
    expect(html).toContain('aria-label="Categoria"');
    expect(html).toContain('aria-label="Subcategoria"');
    expect(html).not.toContain('aria-label="Pagamento"');
    expect(html).not.toContain('aria-label="Responsável"');
    expect(html).not.toContain("Excluir Sofá novo");
    expect(html).not.toContain("Editar Sofá novo");
  });
});

describe("TransactionsTable: amount edit", () => {
  it("renders a clickable amount trigger for a normal row, disabled for a parcela row", () => {
    const normal = renderTable({ installmentId: null, kind: "expense" });
    expect(normal).toContain("56,13");

    // For normal (non-parcela) row: assert button exists with correct title and is NOT disabled.
    const editableBtn =
      /<button[^>]*title="Clique para editar o valor"[^>]*>/.exec(
        normal,
      )?.[0] ?? "";
    expect(editableBtn).not.toBe("");
    expect(editableBtn).not.toContain("disabled");

    const parcela = renderTable({ installmentId: "inst-1", kind: "expense" });
    // For parcela row: assert button exists with correct title and IS disabled.
    const parcelaBtn =
      /<button[^>]*title="Valor de parcela — edite o parcelamento"[^>]*>/.exec(
        parcela,
      )?.[0] ?? "";
    expect(parcelaBtn).not.toBe("");
    expect(parcelaBtn).toContain("disabled");
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

  it("defaults to the Sao Paulo month near a UTC boundary", () => {
    const parsed = parseTransactionsSearchParams(
      {},
      new Date("2026-08-01T01:30:00Z"),
    );
    expect(parsed.month).toBe("2026-07");
    expect(parsed.filters).toEqual({ month: "2026-07" });
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
    expect(input.installmentCount).toBe(1);
  });

  it("decodes a card payment", () => {
    const input = manualEntryFromFormData(
      form({ ...base, payment: "card:card-1" }),
    );
    expect(input.payment).toEqual({ type: "card", creditCardId: "card-1" });
    expect(input.installmentCount).toBe(1);
  });

  it("parses installment count for a parcelado card expense", () => {
    const input = manualEntryFromFormData(
      form({
        ...base,
        payment: "card:card-1",
        purchaseMode: "parcelado",
        installmentCount: "6",
      }),
    );
    expect(input.payment).toEqual({ type: "card", creditCardId: "card-1" });
    expect(input.installmentCount).toBe(6);
  });

  it("rejects invalid parcel counts", () => {
    expect(() =>
      manualEntryFromFormData(
        form({
          ...base,
          payment: "card:card-1",
          purchaseMode: "parcelado",
          installmentCount: "1",
        }),
      ),
    ).toThrow(/parcelas/i);
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
    installment_groups: [
      {
        id: "group-sofa",
        household_id: HOUSEHOLD,
        credit_card_id: CARD,
        description: "Sofá novo",
        total_amount_cents: 120000,
        installment_count: 6,
        purchased_on: "2026-06-15",
        category_id: CAT_MERCADO,
        subcategory_id: null,
        responsibility_scope: "household",
        responsible_user_id: null,
        created_by_user_id: ALVARO,
        import_batch_id: null,
        created_at: "2026-06-15T13:00:00Z",
        updated_at: "2026-06-15T13:00:00Z",
      },
    ],
    installments: Array.from({ length: 6 }, (_, index) => ({
      id: `inst-sofa-${index + 1}`,
      household_id: HOUSEHOLD,
      installment_group_id: "group-sofa",
      credit_card_id: CARD,
      number: index + 1,
      installment_count: 6,
      amount_cents: 20000,
      due_month: `2026-${String(6 + index).padStart(2, "0")}`,
      description: `Sofá novo ${index + 1}/6`,
      category_id: CAT_MERCADO,
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: ALVARO,
      created_at: "2026-06-15T13:00:00Z",
      updated_at: "2026-06-15T13:00:00Z",
    })),
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
    const { filters } = parseTransactionsSearchParams({ month: previous }, NOW);
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

describe("/transactions ledger via findTransactionLedgerFiltered", () => {
  it("includes parcelado purchases bought in the selected month", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06", q: "sofá" },
      NOW,
    );
    const page = await findTransactionLedgerFiltered(
      client,
      HOUSEHOLD,
      filters,
      1,
      PAGE_SIZE,
    );
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      itemType: "installment_purchase",
      id: "group-sofa",
      description: "Sofá novo",
      purchasedOn: "2026-06-15",
      totalAmountCents: 120000,
      installmentCount: 6,
      firstDueMonth: "2026-06",
      lastDueMonth: "2026-11",
      firstInstallmentCents: 20000,
    });
  });

  it("counts transactions plus parcelado purchases in the month footnote total", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06" },
      NOW,
    );
    const page = await findTransactionLedgerFiltered(
      client,
      HOUSEHOLD,
      filters,
      1,
      PAGE_SIZE,
    );
    expect(page.total).toBe(56);
    expect(page.rows).toHaveLength(50);
  });

  it("keeps card filters applying to both transactions and parcelado purchases", async () => {
    const { filters } = parseTransactionsSearchParams(
      { month: "2026-06", card: CARD },
      NOW,
    );
    const page = await findTransactionLedgerFiltered(
      client,
      HOUSEHOLD,
      filters,
    );
    expect(page.rows.map((row) => row.id).sort()).toEqual([
      "group-sofa",
      "tx-farmacia",
      "tx-parcela",
    ]);
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
