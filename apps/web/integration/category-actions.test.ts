import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSupabaseClient } from "@family-finance/db";

import {
  createCategoryAction,
  createSubcategoryAction,
} from "../app/(app)/categories/actions.js";
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

let store: FakeSupabaseStore;

beforeEach(() => {
  store = new FakeSupabaseStore({
    household_members: [
      {
        id: "member-1",
        household_id: HOUSEHOLD,
        user_id: "user-1",
        is_active: true,
        role: "owner",
      },
    ],
    categories: [
      {
        id: "cat-food",
        household_id: HOUSEHOLD,
        name: "Alimentação",
        kind: "expense",
        is_active: true,
      },
    ],
    subcategories: [],
  });
  mockedSupabase.client = createFakeSupabaseClient(
    store,
  ) as unknown as AppSupabaseClient;
});

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

describe("createCategoryAction", () => {
  it("returns the new category id", async () => {
    const result = await createCategoryAction(
      form({ name: "Pets", kind: "expense" }),
    );

    const created = store.table("categories").find((c) => c.name === "Pets");
    expect(result).toEqual({
      ok: true,
      message: "Categoria “Pets” criada.",
      id: created?.id,
      created: true,
    });
  });

  it("returns the same id when called twice with the same name", async () => {
    const first = await createCategoryAction(
      form({ name: "Pets", kind: "expense" }),
    );
    const second = await createCategoryAction(
      form({ name: "pets", kind: "expense" }),
    );

    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.id).toBe(first.ok && first.id);
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect(store.table("categories").filter((c) => c.name === "Pets")).toHaveLength(1);
  });

  it("keeps the failure shape", async () => {
    await expect(
      createCategoryAction(form({ name: "Alimentação", kind: "income" })),
    ).resolves.toEqual({
      ok: false,
      message: "“Alimentação” já existe como despesa.",
    });
  });
});

describe("createSubcategoryAction", () => {
  it("returns the new subcategory id", async () => {
    const result = await createSubcategoryAction(
      form({ name: "Feira", categoryId: "cat-food" }),
    );

    const created = store.table("subcategories").find((s) => s.name === "Feira");
    expect(result).toEqual({
      ok: true,
      message: "Subcategoria “Feira” criada em Alimentação.",
      id: created?.id,
      created: true,
    });
  });
});
