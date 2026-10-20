import { describe, expect, it } from "vitest";

import type { AppSupabaseClient } from "@family-finance/db";

import {
  createOrRestoreCategory,
  createOrRestoreSubcategory,
} from "../app/(app)/categories/category-creation.js";
import {
  createFakeSupabaseClient,
  FakeSupabaseStore,
} from "./fake-supabase.js";

const HOUSEHOLD = "house-1";

function catalog() {
  const store = new FakeSupabaseStore({
    categories: [
      {
        id: "cat-food",
        household_id: HOUSEHOLD,
        name: "Alimentação",
        kind: "expense",
        is_active: true,
      },
      {
        id: "cat-old",
        household_id: HOUSEHOLD,
        name: "Pets",
        is_active: false,
      },
    ],
    subcategories: [
      {
        id: "sub-old",
        household_id: HOUSEHOLD,
        category_id: "cat-food",
        name: "Café",
        is_active: false,
      },
    ],
  });
  return {
    store,
    client: createFakeSupabaseClient(store) as unknown as AppSupabaseClient,
  };
}

describe("category creation", () => {
  it("creates an income category with the selected kind", async () => {
    const { client, store } = catalog();
    const result = await createOrRestoreCategory(
      client,
      HOUSEHOLD,
      "Salário",
      "income",
    );

    expect(result.message).toBe("Categoria “Salário” criada.");
    expect(result.created).toBe(true);
    expect(store.table("categories")).toContainEqual(
      expect.objectContaining({
        id: result.id,
        name: "Salário",
        kind: "income",
        is_active: true,
      }),
    );
  });

  it("returns an active duplicate ignoring case and accents", async () => {
    const { client, store } = catalog();
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "alimentacao", "expense"),
    ).resolves.toEqual({
      id: "cat-food",
      message: "A categoria “Alimentação” já existe.",
      created: false,
    });
    expect(store.table("categories")).toHaveLength(2);
  });

  it("rejects a duplicate of the other kind", async () => {
    const { client } = catalog();
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "alimentacao", "income"),
    ).rejects.toThrow("“Alimentação” já existe como despesa.");
  });

  it("restores an archived category instead of duplicating it", async () => {
    const { client, store } = catalog();
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "pets", "expense"),
    ).resolves.toEqual({
      id: "cat-old",
      message: "Categoria “Pets” restaurada.",
      created: true,
    });

    expect(
      store.table("categories").find((row) => row.id === "cat-old")?.is_active,
    ).toBe(true);
    expect(
      store.table("categories").filter((row) => row.name === "Pets"),
    ).toHaveLength(1);
  });
});

describe("subcategory creation", () => {
  it("restores an archived duplicate under the selected parent", async () => {
    const { client, store } = catalog();
    await expect(
      createOrRestoreSubcategory(client, HOUSEHOLD, "cat-food", "cafe"),
    ).resolves.toEqual({
      id: "sub-old",
      message: "Subcategoria “Café” restaurada em Alimentação.",
      created: true,
    });

    expect(store.table("subcategories")[0]?.is_active).toBe(true);
  });

  it("rejects a missing or archived parent", async () => {
    const { client } = catalog();
    await expect(
      createOrRestoreSubcategory(client, HOUSEHOLD, "cat-old", "Veterinário"),
    ).rejects.toThrow("Escolha uma categoria ativa.");
  });
});
