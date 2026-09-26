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
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "Salário", "income"),
    ).resolves.toBe("Categoria “Salário” criada.");

    expect(store.table("categories")).toContainEqual(
      expect.objectContaining({
        name: "Salário",
        kind: "income",
        is_active: true,
      }),
    );
  });

  it("rejects an active duplicate ignoring case and accents", async () => {
    const { client } = catalog();
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "alimentacao", "expense"),
    ).rejects.toThrow("A categoria “Alimentação” já existe.");
  });

  it("restores an archived category instead of duplicating it", async () => {
    const { client, store } = catalog();
    await expect(
      createOrRestoreCategory(client, HOUSEHOLD, "pets", "expense"),
    ).resolves.toBe("Categoria “Pets” restaurada.");

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
    ).resolves.toBe("Subcategoria “Café” restaurada em Alimentação.");

    expect(store.table("subcategories")[0]?.is_active).toBe(true);
  });

  it("rejects a missing or archived parent", async () => {
    const { client } = catalog();
    await expect(
      createOrRestoreSubcategory(client, HOUSEHOLD, "cat-old", "Veterinário"),
    ).rejects.toThrow("Escolha uma categoria ativa.");
  });
});
