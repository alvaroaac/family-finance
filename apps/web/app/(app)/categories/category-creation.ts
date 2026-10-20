import {
  createCategory,
  createSubcategory,
  listAllCategories,
  listAllSubcategories,
  restoreCategory,
  restoreSubcategory,
  type AppSupabaseClient,
  type CategoryKind,
} from "@family-finance/db";

const DIACRITICS_RE = /\p{Diacritic}/gu;

/**
 * The created, restored or already-active row, and the pt-BR outcome.
 * `created` is false only when an active row with that name already existed.
 */
export type CategoryCreation = { id: string; message: string; created: boolean };

function normalizedName(value: string): string {
  return value
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    .toLocaleLowerCase("pt-BR");
}

export async function createOrRestoreCategory(
  client: AppSupabaseClient,
  householdId: string,
  name: string,
  kind: CategoryKind,
): Promise<CategoryCreation> {
  const wanted = normalizedName(name);
  const categories = await listAllCategories(client, householdId);
  const existing = categories.find(
    (category) => normalizedName(category.name) === wanted,
  );

  if (existing) {
    const existingKind = existing.kind === "income" ? "income" : "expense";
    if (existingKind !== kind) {
      throw new Error(
        `“${existing.name}” já existe como ${existingKind === "income" ? "entrada" : "despesa"}.`,
      );
    }
    // Same name and kind: hand back the existing row, so a retry (or the
    // quick-capture sheet asking for a category that exists) gets its id.
    if (existing.is_active) {
      return {
        id: existing.id,
        message: `A categoria “${existing.name}” já existe.`,
        created: false,
      };
    }
    await restoreCategory(client, householdId, existing.id);
    return {
      id: existing.id,
      message: `Categoria “${existing.name}” restaurada.`,
      created: true,
    };
  }

  const created = await createCategory(client, householdId, name, kind);
  return {
    id: created.id,
    message: `Categoria “${name}” criada.`,
    created: true,
  };
}

export async function createOrRestoreSubcategory(
  client: AppSupabaseClient,
  householdId: string,
  categoryId: string,
  name: string,
): Promise<CategoryCreation> {
  const [categories, subcategories] = await Promise.all([
    listAllCategories(client, householdId),
    listAllSubcategories(client, householdId),
  ]);
  const parent = categories.find(
    (category) => category.id === categoryId && category.is_active,
  );
  if (!parent) {
    throw new Error("Escolha uma categoria ativa.");
  }

  const wanted = normalizedName(name);
  const existing = subcategories.find(
    (subcategory) =>
      subcategory.category_id === categoryId &&
      normalizedName(subcategory.name) === wanted,
  );

  if (existing) {
    if (existing.is_active) {
      throw new Error(
        `A subcategoria “${existing.name}” já existe em ${parent.name}.`,
      );
    }
    await restoreSubcategory(client, householdId, existing.id);
    return {
      id: existing.id,
      message: `Subcategoria “${existing.name}” restaurada em ${parent.name}.`,
      created: true,
    };
  }

  const created = await createSubcategory(
    client,
    householdId,
    categoryId,
    name,
  );
  return {
    id: created.id,
    message: `Subcategoria “${name}” criada em ${parent.name}.`,
    created: true,
  };
}
