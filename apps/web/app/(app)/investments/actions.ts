"use server";

import { revalidatePath } from "next/cache";

import {
  createInvestmentBucket,
  renameInvestmentBucket,
  updateInvestmentBucketBalance,
  deleteInvestmentBucket,
  BUCKET_USER_ERRORS,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { parseReaisToCents } from "../../../lib/format";

/**
 * Server actions for the "Investimentos" screen (caixinhas). Buckets are
 * free-form household goals. Each action is guarded, takes the household from
 * the session (never from the form), calls a household-scoped `packages/db`
 * repository, and revalidates the pages that show buckets.
 */

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

async function authedHousehold(): Promise<{
  householdId: string;
  client: ServerSupabaseClient;
}> {
  const { householdId } = await requireAuthorizedUser();
  const { createServerSupabaseClient } = await import("../../../lib/supabase");
  const client = await createServerSupabaseClient();
  return { householdId, client };
}

function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value.trim();
}

/** The raw bucket name; the repository validates it with a pt-BR message. */
function bucketName(formData: FormData): string {
  const value = formData.get("name");
  return typeof value === "string" ? value : "";
}

/** Outcome of a bucket action, shown to the household as a toast. */
export type BucketActionResult = {
  ok: boolean;
  message: string;
};

/** Run a bucket change, revalidate on success, and report the outcome. */
async function runBucketAction(
  change: () => Promise<unknown>,
  successMessage: string,
): Promise<BucketActionResult> {
  try {
    await change();
  } catch (error) {
    console.error("runBucketAction failed:", error);
    return {
      ok: false,
      message:
        error instanceof Error && BUCKET_USER_ERRORS.includes(error.message)
          ? error.message
          : "Não deu pra salvar a caixinha agora. Tenta de novo em instantes.",
    };
  }
  revalidatePath("/investments");
  revalidatePath("/dashboard");
  return { ok: true, message: successMessage };
}

/** Create a caixinha; its slug comes from the name. */
export async function createBucketAction(
  formData: FormData,
): Promise<BucketActionResult> {
  const { householdId, client } = await authedHousehold();
  return runBucketAction(
    () =>
      createInvestmentBucket(client, {
        householdId,
        name: bucketName(formData),
      }),
    "Caixinha criada.",
  );
}

/** Rename a caixinha and its derived slug. */
export async function renameBucketAction(
  formData: FormData,
): Promise<BucketActionResult> {
  const { householdId, client } = await authedHousehold();
  return runBucketAction(
    () =>
      renameInvestmentBucket(client, {
        householdId,
        bucketId: requireField(formData, "bucketId"),
        name: bucketName(formData),
      }),
    "Nome atualizado.",
  );
}

/** Delete a caixinha whose balance is zero. */
export async function deleteBucketAction(
  formData: FormData,
): Promise<BucketActionResult> {
  const { householdId, client } = await authedHousehold();
  return runBucketAction(
    () =>
      deleteInvestmentBucket(client, {
        householdId,
        bucketId: requireField(formData, "bucketId"),
      }),
    "Caixinha excluída.",
  );
}

/**
 * Set a caixinha's manual balance from the inline edit form. The "balance"
 * field is a reais string ("1.234,56" or "1234.56"); zero is allowed
 * (caixinha esvaziada), negatives are not.
 */
export async function updateBucketBalanceAction(
  formData: FormData,
): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const bucketId = requireField(formData, "bucketId");
  const balanceCents = parseReaisToCents(requireField(formData, "balance"));
  if (balanceCents === null) {
    throw new Error("Informe um saldo válido (não negativo), como 1.234,56.");
  }
  await updateInvestmentBucketBalance(
    client,
    householdId,
    bucketId,
    balanceCents,
  );
  revalidatePath("/investments");
  revalidatePath("/dashboard");
}
