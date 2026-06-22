"use server";

import { revalidatePath } from "next/cache";

import {
  findHouseholdIdForCurrentUser,
  createInvestmentBucket,
  updateInvestmentBucket,
  deleteInvestmentBucket,
  type InvestmentBucketSlug,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the "Investimentos" screen (caixinhas). MVP buckets are
 * filhos, casa, and independencia_financeira/aposentadoria. Each action is
 * guarded, resolves the caller's household via RLS, calls a household-scoped
 * `packages/db` repository, and revalidates the page.
 */

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

async function authedHousehold(): Promise<{
  householdId: string;
  client: ServerSupabaseClient;
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

function parseBucketSlug(value: string): InvestmentBucketSlug {
  if (
    value === "filhos" ||
    value === "casa" ||
    value === "independencia_financeira"
  ) {
    return value;
  }
  throw new Error("Caixinha inválida.");
}

/** Create an investment bucket (caixinha). One per slug per household. */
export async function createBucketAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const name = requireField(formData, "name");
  const slug = parseBucketSlug(requireField(formData, "slug"));
  await createInvestmentBucket(client, { householdId, slug, name });
  revalidatePath("/investments");
}

/** Rename an investment bucket. */
export async function updateBucketAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const bucketId = requireField(formData, "bucketId");
  const name = requireField(formData, "name");
  await updateInvestmentBucket(client, householdId, bucketId, { name });
  revalidatePath("/investments");
}

/** Delete an investment bucket. */
export async function deleteBucketAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const bucketId = requireField(formData, "bucketId");
  await deleteInvestmentBucket(client, householdId, bucketId);
  revalidatePath("/investments");
}
