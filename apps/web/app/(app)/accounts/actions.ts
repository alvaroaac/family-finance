"use server";

import { revalidatePath } from "next/cache";

import {
  findHouseholdIdForCurrentUser,
  createAccount,
  updateAccount,
  deleteAccount,
  type AccountKind,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the "Contas" screen (conta corrente + conta investimento).
 * Each action:
 *  - is guarded by `requireAuthorizedUser()` (redirects unauthorized callers),
 *  - resolves the caller's single household via RLS (no hardcoded id),
 *  - calls a household-scoped `packages/db` repository,
 *  - revalidates the page so the UI reflects the change.
 *
 * Account/transaction rules live in the domain + db layers; these actions only
 * translate form input and persist user decisions.
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

function parseAccountKind(value: string): AccountKind {
  if (value === "checking" || value === "investment") {
    return value;
  }
  throw new Error("Tipo de conta inválido.");
}

/** Create a checking or investment account. */
export async function createAccountAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const name = requireField(formData, "name");
  const kind = parseAccountKind(requireField(formData, "kind"));
  await createAccount(client, { householdId, kind, name });
  revalidatePath("/accounts");
}

/** Rename an existing account. */
export async function updateAccountAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const accountId = requireField(formData, "accountId");
  const name = requireField(formData, "name");
  await updateAccount(client, householdId, accountId, { name });
  revalidatePath("/accounts");
}

/** Delete an account (blocked by FK restrict if it still has transactions). */
export async function deleteAccountAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const accountId = requireField(formData, "accountId");
  await deleteAccount(client, householdId, accountId);
  revalidatePath("/accounts");
}
