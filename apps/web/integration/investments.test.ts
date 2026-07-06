/**
 * Integration tests for caixinha manual balances — v1.0 Task 7.
 *
 * Two layers, both offline:
 *  1. PURE helpers: `parseReaisToCents` (shared money input parsing, moved to
 *     lib/format so the cards purchase form and the caixinha balance edit use
 *     one parser) and `bucketsTotalCents` (dashboard caixinha totals).
 *  2. Balance update round-trip: the REAL `updateInvestmentBucketBalance`
 *     repository running against the in-memory fake store (./fake-supabase.ts),
 *     exactly like the server action composes it — including the negative
 *     balance rejection with a pt-BR message.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  updateInvestmentBucketBalance,
  listInvestmentBuckets,
  type AppSupabaseClient,
  type InvestmentBucketRow,
} from "@family-finance/db";

import { parseReaisToCents } from "../lib/format.js";
import { bucketsTotalCents } from "../app/(app)/dashboard/queries.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const OTHER_HOUSEHOLD = "00000000-0000-0000-0000-000000000002";

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
  const bucket = (id: string, balance_cents: number): InvestmentBucketRow =>
    ({
      id,
      household_id: HOUSEHOLD,
      slug: "filhos",
      name: id,
      balance_cents,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }) as InvestmentBucketRow;

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
// 2. Balance update round-trip on the fake store
// ---------------------------------------------------------------------------

function seed(): FakeDatabaseSeed {
  return {
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
      {
        id: "bucket-outra-casa",
        household_id: OTHER_HOUSEHOLD,
        slug: "casa",
        name: "Casa (outra família)",
        balance_cents: 777,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

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
