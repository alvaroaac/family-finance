"use server";

import { revalidatePath } from "next/cache";

import {
  findHouseholdIdForCurrentUser,
  updateTransaction,
  deleteTransaction,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { transactionPatchFromFormData } from "./filters";

/**
 * Server actions for the "Transações" screen (inline edit + guarded delete).
 *
 * Each action re-resolves the caller's household from the SESSION — the
 * client-sent form never carries (nor is trusted with) a household id — then
 * calls the household-scoped `packages/db` repository and revalidates the page.
 * Amount, kind and payment source are NOT editable here by design.
 */

export type TransactionActionResult = { ok: boolean; error?: string };

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
    throw new Error("Nenhuma casa ativa para o usuário atual.");
  }
  return { householdId, client };
}

function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Campo obrigatório ausente: ${name}`);
  }
  return value.trim();
}

/**
 * Apply an inline edit (description, category/subcategory, responsável or
 * data) to one transaction. Only the keys present in the form are patched.
 */
export async function updateTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const transactionId = requireField(formData, "transactionId");
    const patch = transactionPatchFromFormData(formData);
    await updateTransaction(client, householdId, transactionId, patch);
    revalidatePath("/transactions");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a alteração.",
    };
  }
}

/**
 * Delete one transaction. Parcela rows are refused by the repository with a
 * pt-BR message that is surfaced to the household as-is.
 */
export async function deleteTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const transactionId = requireField(formData, "transactionId");
    await deleteTransaction(client, householdId, transactionId);
    revalidatePath("/transactions");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível excluir o lançamento.",
    };
  }
}
