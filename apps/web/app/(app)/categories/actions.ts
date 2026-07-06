"use server";

import { revalidatePath } from "next/cache";

import {
  archiveCategory,
  restoreCategory,
  mergeCategory,
  createCategorizationMemory,
  setCategorizationMemoryActive,
  findHouseholdIdForCurrentUser,
  listAllCategories,
  listAllSubcategories,
  type CategorizationMemoryInsert,
} from "@family-finance/db";
import { describeMemory } from "@family-finance/categorization";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the "Categorias" cleanup screen. Each action:
 *  - is guarded by `requireAuthorizedUser()` (redirects unauthorized callers),
 *  - resolves the caller's single household via RLS (no hardcoded id),
 *  - calls a household-scoped `packages/db` repository,
 *  - revalidates the page so the UI reflects the change.
 *
 * Categorization rules live in `@family-finance/categorization`; these actions
 * only persist user decisions and never auto-create categories.
 */

async function authedHousehold(): Promise<{
  householdId: string;
  client: Awaited<ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>>;
}> {
  await requireAuthorizedUser();
  const { createServerSupabaseClient } = await import("../../../lib/supabase");
  const client = await createServerSupabaseClient();
  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) {
    throw new Error("No active household membership for the current user.");
  }
  return { householdId, client };
}

function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value.trim();
}

/** Archive (soft-delete) a macro category so it leaves active pickers. */
export async function archiveCategoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const categoryId = requireField(formData, "categoryId");
  await archiveCategory(client, householdId, categoryId);
  revalidatePath("/categories");
}

/** Restore a previously archived macro category. */
export async function restoreCategoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const categoryId = requireField(formData, "categoryId");
  await restoreCategory(client, householdId, categoryId);
  revalidatePath("/categories");
}

/**
 * Merge a source category into a target category. Re-points transactions,
 * installments, subcategories, and memory, then archives the source. This is
 * how the user consolidates a sprawled taxonomy without creating new buckets.
 */
export async function mergeCategoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const sourceCategoryId = requireField(formData, "sourceCategoryId");
  const targetCategoryId = requireField(formData, "targetCategoryId");
  if (sourceCategoryId === targetCategoryId) {
    throw new Error("Choose two different categories to merge.");
  }
  await mergeCategory(client, householdId, sourceCategoryId, targetCategoryId);
  revalidatePath("/categories");
}

/**
 * Create a categorization-memory pattern. Used to map an old/imported category
 * NAME (a free-text pattern matched against descriptions) onto a CURRENT macro
 * category (+ optional subcategory). The explanation is recomputed from live
 * category names so it stays accurate and auditable.
 */
export async function createMemoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();

  const pattern = requireField(formData, "pattern");
  const categoryId = requireField(formData, "categoryId");
  const subRaw = formData.get("subcategoryId");
  const subcategoryId =
    typeof subRaw === "string" && subRaw.trim().length > 0
      ? subRaw.trim()
      : null;

  // Recompute a human explanation from the current catalog names.
  const [categories, subcategories] = await Promise.all([
    listAllCategories(client, householdId),
    listAllSubcategories(client, householdId),
  ]);
  const explanation = describeMemory(
    {
      id: "",
      householdId,
      pattern,
      categoryId,
      subcategoryId,
      confidence: 0.95,
      explanation: "",
      isActive: true,
    },
    {
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      subcategories: subcategories.map((s) => ({
        id: s.id,
        categoryId: s.category_id,
        name: s.name,
      })),
    },
  );

  const payload: CategorizationMemoryInsert = {
    household_id: householdId,
    pattern,
    category_id: categoryId,
    subcategory_id: subcategoryId,
    confidence: 0.95,
    explanation,
  };
  await createCategorizationMemory(client, payload);
  revalidatePath("/categories");
}

/** Disable a memory pattern (kept for audit; stops influencing suggestions). */
export async function disableMemoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const memoryId = requireField(formData, "memoryId");
  await setCategorizationMemoryActive(client, householdId, memoryId, false);
  revalidatePath("/categories");
}

/** Re-enable a previously disabled memory pattern. */
export async function enableMemoryAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const memoryId = requireField(formData, "memoryId");
  await setCategorizationMemoryActive(client, householdId, memoryId, true);
  revalidatePath("/categories");
}
