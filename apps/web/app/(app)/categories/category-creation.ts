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
): Promise<string> {
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
    if (existing.is_active) {
      throw new Error(`A categoria “${existing.name}” já existe.`);
    }
    await restoreCategory(client, householdId, existing.id);
    return `Categoria “${existing.name}” restaurada.`;
  }

  await createCategory(client, householdId, name, kind);
  return `Categoria “${name}” criada.`;
}

export async function createOrRestoreSubcategory(
  client: AppSupabaseClient,
  householdId: string,
  categoryId: string,
  name: string,
): Promise<string> {
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
    return `Subcategoria “${existing.name}” restaurada em ${parent.name}.`;
  }

  await createSubcategory(client, householdId, categoryId, name);
  return `Subcategoria “${name}” criada em ${parent.name}.`;
}
