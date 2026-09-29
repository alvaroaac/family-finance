/**
 * Integration tests for caixinhas (investment buckets).
 *
 * All offline, against the in-memory fake store (./fake-supabase.ts):
 *  1. PURE helpers: `parseReaisToCents` (shared money input parsing) and
 *     `bucketsTotalCents` (dashboard caixinha totals).
 *  2. Balance update round-trip through the REAL repository.
 *  3. Free-form buckets: the create / rename / delete server actions, with the
 *     household taken from the session and the pt-BR messages the page shows.
 *  4. Server renders of /investments and /dashboard for a household that has
 *     no caixinha yet.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  updateInvestmentBucketBalance,
  listInvestmentBuckets,
  type AppSupabaseClient,
  type InvestmentBucketRow,
} from "@family-finance/db";

import { parseReaisToCents } from "../lib/format.js";
import { bucketsTotalCents } from "../app/(app)/dashboard/queries.js";
import DashboardPage from "../app/(app)/dashboard/page.js";
import InvestmentsPage from "../app/(app)/investments/page.js";
import {
  createBucketAction,
  renameBucketAction,
  deleteBucketAction,
} from "../app/(app)/investments/actions.js";
import { ToastProvider } from "../components/ui/toast.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const OTHER_HOUSEHOLD = "00000000-0000-0000-0000-000000000002";
const USER = "11111111-1111-1111-1111-111111111111";

const mockedSupabase = vi.hoisted(() => ({
  client: null as AppSupabaseClient | null,
}));
vi.mock("../lib/auth.js", () => ({
  requireAuthorizedUser: vi.fn(async () => ({
    email: "membro@example.test",
    householdId: "00000000-0000-0000-0000-000000000001",
  })),
}));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => {
    if (mockedSupabase.client === null)
      throw new Error("Fake Supabase client was not installed.");
    return mockedSupabase.client;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("parseReaisToCents", () => {
  it("parses pt-BR formatted amounts into integer cents", () => {
    expect(parseReaisToCents("1.234,56")).toBe(123456);
    expect(parseReaisToCents("12,30")).toBe(1230);
    expect(parseReaisToCents(" 45 ")).toBe(4500);
  });

  it("parses dot-decimal amounts too", () => {
    expect(parseReaisToCents("1234.56")).toBe(123456);
  });

  it("accepts zero (a caixinha can be emptied)", () => {
    expect(parseReaisToCents("0")).toBe(0);
    expect(parseReaisToCents("0,00")).toBe(0);
  });

  it("rejects blank, non-numeric and negative input with null", () => {
    expect(parseReaisToCents("")).toBeNull();
    expect(parseReaisToCents("   ")).toBeNull();
    expect(parseReaisToCents("abc")).toBeNull();
    expect(parseReaisToCents("-12,00")).toBeNull();
  });
});

describe("bucketsTotalCents", () => {
  const bucket = (id: string, balance_cents: number): InvestmentBucketRow => ({
    id,
    household_id: HOUSEHOLD,
    slug: id,
    name: id,
    balance_cents,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });

  it("sums balances across buckets", () => {
    expect(
      bucketsTotalCents([bucket("a", 1000), bucket("b", 250), bucket("c", 0)]),
    ).toBe(1250);
  });

  it("is zero for no buckets", () => {
    expect(bucketsTotalCents([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fake store wiring
// ---------------------------------------------------------------------------

function bucketRow(
  id: string,
  householdId: string,
  slug: string,
  name: string,
  balance_cents: number,
) {
  return {
    id,
    household_id: householdId,
    slug,
    name,
    balance_cents,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function seed(buckets = defaultBuckets()): FakeDatabaseSeed {
  return {
    household_members: [
      { household_id: HOUSEHOLD, user_id: USER, is_active: true },
    ],
    investment_buckets: buckets,
  };
}

function defaultBuckets() {
  return [
    bucketRow("bucket-filhos", HOUSEHOLD, "filhos", "Filhos", 0),
    bucketRow("bucket-reserva", HOUSEHOLD, "reserva", "Reserva", 50000),
    bucketRow(
      "bucket-outra-casa",
      OTHER_HOUSEHOLD,
      "casa",
      "Casa (outra família)",
      777,
    ),
  ];
}

function installStore(data: FakeDatabaseSeed = seed()): FakeSupabaseStore {
  const store = new FakeSupabaseStore(data);
  mockedSupabase.client = {
    ...createFakeSupabaseClient(store),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: USER, email: "membro@example.test" } },
        error: null,
      })),
    },
  } as unknown as AppSupabaseClient;
  return store;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function bucketsOf(store: FakeSupabaseStore, householdId: string) {
  return store
    .table("investment_buckets")
    .filter((row) => row.household_id === householdId);
}

// ---------------------------------------------------------------------------
// 2. Balance update round-trip on the fake store
// ---------------------------------------------------------------------------

describe("updateInvestmentBucketBalance round-trip", () => {
  let store: FakeSupabaseStore;
  let client: AppSupabaseClient;

  beforeEach(() => {
    store = new FakeSupabaseStore(seed());
    client = createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
  });

  it("persists the new balance and lists it back", async () => {
    await updateInvestmentBucketBalance(client, HOUSEHOLD, "bucket-filhos", 123456);
    const buckets = await listInvestmentBuckets(client, HOUSEHOLD);
    expect(buckets.find((b) => b.id === "bucket-filhos")?.balance_cents).toBe(
      123456,
    );
  });

  it("rejects a negative balance with a pt-BR error, before any write", async () => {
    await expect(
      updateInvestmentBucketBalance(client, HOUSEHOLD, "bucket-filhos", -100),
    ).rejects.toThrow(/saldo/);
    expect(
      store.table("investment_buckets").find((r) => r.id === "bucket-filhos")
        ?.balance_cents,
    ).toBe(0);
  });

  it("never touches another household's bucket", async () => {
    await updateInvestmentBucketBalance(
      client,
      HOUSEHOLD,
      "bucket-outra-casa",
      999999,
    );
    expect(
      store
        .table("investment_buckets")
        .find((r) => r.id === "bucket-outra-casa")?.balance_cents,
    ).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// 3. Free-form bucket actions
// ---------------------------------------------------------------------------

describe("createBucketAction", () => {
  let store: FakeSupabaseStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = installStore();
  });

  it("derives the slug from the name", async () => {
    const result = await createBucketAction(form({ name: "Viagem 2027" }));
    expect(result.ok).toBe(true);
    await createBucketAction(form({ name: "Independência Financeira" }));

    const created = bucketsOf(store, HOUSEHOLD).map((row) => [row.slug, row.name]);
    expect(created).toContainEqual(["viagem_2027", "Viagem 2027"]);
    expect(created).toContainEqual([
      "independencia_financeira",
      "Independência Financeira",
    ]);
  });

  it("creates in the session's household, never one sent by the form", async () => {
    await createBucketAction(
      form({ name: "Viagem 2027", householdId: OTHER_HOUSEHOLD }),
    );
    expect(
      bucketsOf(store, HOUSEHOLD).some((row) => row.slug === "viagem_2027"),
    ).toBe(true);
    expect(bucketsOf(store, OTHER_HOUSEHOLD)).toHaveLength(1);
  });

  it("rejects a slug that already exists in the household", async () => {
    expect(await createBucketAction(form({ name: "FILHOS" }))).toEqual({
      ok: false,
      message: "Já existe um objetivo com esse nome.",
    });
    expect(bucketsOf(store, HOUSEHOLD)).toHaveLength(2);
  });

  it("rejects a name that slugifies to an empty string", async () => {
    expect(await createBucketAction(form({ name: " !!! " }))).toEqual({
      ok: false,
      message: "Informe um nome para o objetivo.",
    });
    expect(bucketsOf(store, HOUSEHOLD)).toHaveLength(2);
  });

  it("allows a slug another household already uses", async () => {
    const result = await createBucketAction(form({ name: "Casa" }));
    expect(result.ok).toBe(true);
    expect(bucketsOf(store, HOUSEHOLD).map((row) => row.slug)).toContain("casa");
    expect(bucketsOf(store, OTHER_HOUSEHOLD).map((row) => row.slug)).toEqual([
      "casa",
    ]);
  });
});

describe("renameBucketAction", () => {
  let store: FakeSupabaseStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = installStore();
  });

  it("changes the name and keeps the slug", async () => {
    const result = await renameBucketAction(
      form({ bucketId: "bucket-filhos", name: "Educação das crianças" }),
    );
    expect(result.ok).toBe(true);
    const row = store
      .table("investment_buckets")
      .find((r) => r.id === "bucket-filhos");
    expect(row?.name).toBe("Educação das crianças");
    expect(row?.slug).toBe("filhos");
  });

  it("never renames another household's bucket", async () => {
    await renameBucketAction(
      form({ bucketId: "bucket-outra-casa", name: "Invadido" }),
    );
    expect(
      store.table("investment_buckets").find((r) => r.id === "bucket-outra-casa")
        ?.name,
    ).toBe("Casa (outra família)");
  });
});

describe("deleteBucketAction", () => {
  let store: FakeSupabaseStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = installStore();
  });

  it("refuses to delete a bucket with a non-zero balance", async () => {
    expect(await deleteBucketAction(form({ bucketId: "bucket-reserva" }))).toEqual(
      {
        ok: false,
        message: "Só é possível excluir um objetivo com saldo zerado.",
      },
    );
    expect(
      store.table("investment_buckets").some((r) => r.id === "bucket-reserva"),
    ).toBe(true);
  });

  it("removes a bucket with a zero balance", async () => {
    const result = await deleteBucketAction(form({ bucketId: "bucket-filhos" }));
    expect(result.ok).toBe(true);
    expect(
      store.table("investment_buckets").some((r) => r.id === "bucket-filhos"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Pages for a household without caixinhas
// ---------------------------------------------------------------------------

async function renderPage(page: () => Promise<ReactElement>) {
  const element = await page();
  return renderToStaticMarkup(createElement(ToastProvider, null, element));
}

describe("a household with no buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installStore(
      seed([
        bucketRow("bucket-outra", OTHER_HOUSEHOLD, "casa", "Outra família", 777),
      ]),
    );
  });

  it("sees an empty state with the create action on /investments", async () => {
    const html = await renderPage(InvestmentsPage);
    expect(html).toContain("Nenhuma caixinha ainda");
    expect(html).toContain('aria-label="Nome do objetivo"');
    expect(html).toContain("Criar caixinha");
    expect(html).not.toContain("Guardado no total");
    expect(html).not.toContain("Outra família");
  });

  it("renders the dashboard caixinhas panel without an error", async () => {
    const html = await renderPage(DashboardPage);
    expect(html).toContain("Nenhuma caixinha cadastrada.");
    expect(html).not.toContain('role="alert"');
  });
});
