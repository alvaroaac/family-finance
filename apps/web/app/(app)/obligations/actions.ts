"use server";

import { revalidatePath } from "next/cache";

import { createObligationDraft } from "@family-finance/domain";
import {
  cancelObligation,
  createObligation,
  findHouseholdIdForCurrentUser,
  materializeObligationPayment,
  updateObligation,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { parseReaisToCents } from "../../../lib/format";

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

function optionalField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

  const amountCents = parseReaisToCents(requireField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    throw new Error("Valor mensal inválido — use por exemplo 710,44.");
  }

  const termRaw = optionalField(formData, "termMonths");
  const termMonths =
    termRaw === undefined ? null : Number.parseInt(termRaw, 10);

  const dueDay = Number.parseInt(requireField(formData, "dueDay"), 10);
  const categoryId = optionalField(formData, "categoryId");

  const result = createObligationDraft({
    householdId,
    description: requireField(formData, "description"),
    amountCents,
    startMonth: requireField(formData, "startMonth"),
    termMonths,
    dueDay,
    accountId: requireField(formData, "accountId"),
    createdByUserId: user.id,
    category: categoryId !== undefined ? { categoryId } : undefined,
  });
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
 * Mark an obligation month as paid — materialize one real transaction. No
 * `paidOn` is passed, so the RPC defaults occurred_on to the month's due day.
 * Idempotent: a repeat click is a no-op (already_paid), never a second charge.
 */
export async function markObligationPaidAction(
  formData: FormData,
): Promise<void> {
  const { client } = await authedHousehold();
  const obligationId = requireField(formData, "obligationId");
  const month = requireField(formData, "month");
  await materializeObligationPayment(client, { obligationId, month });
  revalidateObligationPaths();
}
