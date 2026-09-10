"use server";

import { getMobileContext } from "../../../lib/mobile/context";

import { revalidatePath } from "next/cache";

import { createObligationDraft } from "@family-finance/domain";
import {
  cancelObligation,
  createObligation,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findHouseholdIdForCurrentUser,
  materializeObligationPayment,
  updateObligation,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { parseReaisToCents } from "../../../lib/format";
import {
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

async function authedHousehold(): Promise<{
  householdId: string;
  client: ServerSupabaseClient;
}> {
  const mobile = getMobileContext();
  if (mobile) return mobile;
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

/** Create an obligation template from the form. */
export async function createObligationAction(
  formData: FormData,
): Promise<void> {
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

  // Ownership: the FK checks on obligations run as the table owner (they
  // bypass RLS), so a submitted id pointing at ANOTHER household's account or
  // category would be accepted by the database. Verify both against the
  // caller's own household before inserting.
  const [accounts, categories] = await Promise.all([
    findAccountsByHousehold(client, householdId),
    findCategoriesByHousehold(client, householdId),
  ]);
  if (!accounts.some((account) => account.id === input.accountId)) {
    throw new Error("Conta de pagamento inválida.");
  }
  const categoryId = input.category?.categoryId;
  if (
    categoryId !== undefined &&
    !categories.some((category) => category.id === categoryId)
  ) {
    throw new Error("Categoria inválida.");
  }

  const result = createObligationDraft(input);
  if (!result.ok) {
    throw new Error(result.errors.map((e) => e.message).join(" "));
  }

  await createObligation(client, result.value);
  revalidateObligationPaths();
}

/** Edit an obligation's amount, due day, and description. */
export async function updateObligationAction(
  formData: FormData,
): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const obligationId = requireField(formData, "obligationId");

  const amountCents = parseReaisToCents(requireField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    throw new Error("Valor mensal inválido — use por exemplo 710,44.");
  }
  const dueDay = Number.parseInt(requireField(formData, "dueDay"), 10);

  await updateObligation(client, householdId, obligationId, {
    description: requireField(formData, "description"),
    amountCents,
    dueDay,
  });
  revalidateObligationPaths();
}

/** Cancel an obligation (soft: past payments are kept). */
export async function cancelObligationAction(
  formData: FormData,
): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const obligationId = requireField(formData, "obligationId");
  await cancelObligation(client, householdId, obligationId);
  revalidateObligationPaths();
}

/**
 * Mark an obligation month as paid — materialize one real transaction with
 * the amount confirmed in the modal. No `paidOn` is passed, so the RPC
 * defaults occurred_on to the month's due day. Idempotent: a repeat click is
 * a no-op (already_paid), never a second charge.
 */
export async function markObligationPaidAction(
  formData: FormData,
): Promise<void> {
  const { client } = await authedHousehold();
  const payment = obligationPaymentFromForm(formData);
  await materializeObligationPayment(client, payment);
  revalidateObligationPaths();
}
