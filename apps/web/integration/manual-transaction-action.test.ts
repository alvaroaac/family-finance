import { describe, expect, it, vi } from "vitest";

import type { AppSupabaseClient } from "@family-finance/db";

import { createManualTransactionAction } from "../app/(app)/transactions/actions.js";
import { loadDashboardData } from "../app/(app)/dashboard/queries.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const mockedSupabase = vi.hoisted(() => ({
  client: null as AppSupabaseClient | null,
}));

vi.mock("../lib/auth.js", () => ({
  requireAuthorizedUser: vi.fn(async () => undefined),
}));

vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => {
    if (mockedSupabase.client === null) {
      throw new Error("Fake Supabase client was not installed.");
    }
    return mockedSupabase.client;
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const USER = "11111111-1111-1111-1111-111111111111";
const CARD = "33333333-3333-3333-3333-333333333333";
const CATEGORY = "44444444-4444-4444-4444-444444444444";

function seed(): FakeDatabaseSeed {
  return {
    household_members: [
      {
        id: "member-1",
        household_id: HOUSEHOLD,
        user_id: USER,
        display_name: "Alvaro",
        is_active: true,
        role: "owner",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ],
    credit_cards: [
      {
        id: CARD,
        household_id: HOUSEHOLD,
        name: "Nubank",
        closing_day: 28,
        due_day: 5,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ],
    categories: [
      {
        id: CATEGORY,
        household_id: HOUSEHOLD,
        name: "Casa",
        is_active: true,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ],
    subcategories: [],
    transactions: [],
    installments: [],
    installment_groups: [],
    investment_buckets: [],
    obligations: [],
  };
}

function formData(): FormData {
  const form = new FormData();
  form.set("kind", "expense");
  form.set("amount", "120,00");
  form.set("description", "E2E API Parcelado");
  form.set("occurredOn", "2026-07-10");
  form.set("categoryId", CATEGORY);
  form.set("subcategoryId", "");
  form.set("payment", `card:${CARD}`);
  form.set("purchaseMode", "parcelado");
  form.set("installmentCount", "3");
  form.set("responsible", "household");
  return form;
}

describe("manual transaction server action: parcelado card expense", () => {
  it("persists installments and the dashboard reads them as card pressure", async () => {
    const store = new FakeSupabaseStore(seed());
    mockedSupabase.client = {
      ...createFakeSupabaseClient(store),
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: USER } },
          error: null,
        })),
      },
    } as unknown as AppSupabaseClient;

    const result = await createManualTransactionAction(formData());
    expect(result).toEqual({ ok: true });

    expect(store.table("transactions")).toHaveLength(0);
    expect(store.table("installment_groups")).toHaveLength(1);
    expect(store.table("installments")).toHaveLength(3);

    const dashboard = await loadDashboardData(new Date("2026-07-15T12:00:00Z"));
    expect(dashboard.loadError).toBeNull();
    expect(dashboard.cardPressure.directCents).toBe(0);
    expect(dashboard.cardPressure.installmentCents).toBe(4000);
    expect(dashboard.cardPressure.totalCents).toBe(4000);
    expect(dashboard.upcomingInstallments.map((item) => item.description)).toEqual([
      "E2E API Parcelado",
      "E2E API Parcelado",
      "E2E API Parcelado",
    ]);
  });
});
