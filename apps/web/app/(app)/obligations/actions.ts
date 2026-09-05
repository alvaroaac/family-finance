"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { createObligationDraft } from "@family-finance/domain";
import {
  cancelObligation,
  createObligation,
  deleteObligationPayment,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findHouseholdIdForCurrentUser,
  materializeObligationPayment,
  updateObligation,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  obligationChangesFromForm,
  obligationInputFromForm,
  obligationPaymentFromForm,
  requireField,
} from "./form";

/**
 * Server actions for the "Obrigações" screen.
 *
 * Create/cancel recurring obligation templates and mark a month as paid
 * (materialize). Validation is owned by the pure domain
 * `createObligationDraft`; materialization is the atomic, idempotent
 * `materialize_obligation_payment` RPC — these actions only collect form
 * input and persist. No financial rules live in the React component.
 */

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

export type ObligationActionResult = { ok: boolean; error?: string };

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

function revalidateObligationPaths(): void {
  revalidatePath("/obligations");
  revalidatePath("/resumo");
  revalidatePath("/dashboard");
}

// Plain validation/refusal errors are public; only these established internal
// message shapes are hidden (domain validation may still be in English).
function isInternalErrorMessage(message: string): boolean {
  return (
    /^\w+ (lookup )?failed: /.test(message) ||
    message.startsWith("Missing required field") ||
    message.startsWith("No active household")
  );
}

function actionFailure(
  error: unknown,
  fallback = "Não foi possível salvar a obrigação.",
): ObligationActionResult {
  unstable_rethrow(error);
  return {
    ok: false,
    error:
      error instanceof Error && !isInternalErrorMessage(error.message)
        ? error.message
        : fallback,
  };
}

async function verifyAccountAndCategory(
  client: ServerSupabaseClient,
  householdId: string,
  accountId: string | undefined,
  categoryId: string | null | undefined,
): Promise<void> {
  // Foreign keys bypass RLS; validate submitted selections in this household.
  const [accounts, categories] = await Promise.all([
    accountId === undefined ? [] : findAccountsByHousehold(client, householdId),
    categoryId == null ? [] : findCategoriesByHousehold(client, householdId),
  ]);
  if (
    accountId !== undefined &&
    !accounts.some((account) => account.id === accountId)
  ) {
    throw new Error("Conta de pagamento inválida.");
  }
  if (
    categoryId != null &&
    !categories.some((category) => category.id === categoryId)
  ) {
    throw new Error("Categoria inválida.");
  }
}

/** Create an obligation template from the form. */
export async function createObligationAction(
  formData: FormData,
): Promise<ObligationActionResult> {
  try {
    const { householdId, client } = await authedHousehold();

    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      throw new Error("Sessão inválida. Faça login novamente.");
    }

    const input = obligationInputFromForm(formData, {
      householdId,
      createdByUserId: user.id,
    });

    await verifyAccountAndCategory(
      client,
      householdId,
      input.accountId,
      input.category?.categoryId,
    );

    const result = createObligationDraft(input);
    if (!result.ok) {
      throw new Error(result.errors.map((e) => e.message).join(" "));
    }

    await createObligation(client, result.value);
    revalidateObligationPaths();
    return { ok: true };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Edit an obligation's description, amount, due day, account, and category. */
export async function updateObligationAction(
  formData: FormData,
): Promise<ObligationActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const { obligationId, changes } = obligationChangesFromForm(formData);
    await verifyAccountAndCategory(
      client,
      householdId,
      changes.accountId,
      changes.categoryId,
    );
    await updateObligation(client, householdId, obligationId, changes);
    revalidateObligationPaths();
    return { ok: true };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Cancel an obligation (soft: past payments are kept). */
export async function cancelObligationAction(
  formData: FormData,
): Promise<ObligationActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const obligationId = requireField(formData, "obligationId");
    await cancelObligation(client, householdId, obligationId);
    revalidateObligationPaths();
    return { ok: true };
  } catch (error) {
    return actionFailure(error);
  }
}

/**
 * Mark an obligation month as paid — materialize one real transaction with
 * the amount confirmed in the modal. No `paidOn` is passed, so the RPC
 * defaults occurred_on to the month's due day. Idempotent: a repeat click is
 * a no-op (already_paid), never a second charge.
 */
export async function markObligationPaidAction(
  formData: FormData,
): Promise<ObligationActionResult> {
  try {
    const { client } = await authedHousehold();
    const payment = obligationPaymentFromForm(formData);
    await materializeObligationPayment(client, payment);
    revalidateObligationPaths();
    return { ok: true };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Undo a materialized payment and return errors to the caller. */
export async function undoObligationPaymentAction(
  formData: FormData,
): Promise<ObligationActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const transactionId = requireField(formData, "transactionId");
    await deleteObligationPayment(client, householdId, transactionId);
    revalidateObligationPaths();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "Não foi possível desfazer o pagamento.");
  }
}
