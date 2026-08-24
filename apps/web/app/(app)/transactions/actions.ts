"use server";

import { revalidatePath } from "next/cache";

import {
  findHouseholdIdForCurrentUser,
  updateTransaction,
  updateInstallmentGroup,
  deleteTransaction,
  createTransaction,
} from "@family-finance/db";
import { brl, createTransactionDraft } from "@family-finance/domain";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  transactionPatchFromFormData,
  installmentGroupPatchFromFormData,
  manualEntryFromFormData,
} from "./filters";
import { saveCardPurchase } from "../cards/actions";

/**
 * Server actions for the "Transações" screen (inline edit + guarded delete).
 *
 * Each action re-resolves the caller's household from the SESSION — the
 * client-sent form never carries (nor is trusted with) a household id — then
 * calls the household-scoped `packages/db` repository and revalidates the page.
 * Amount and payment source ARE editable via the inline patch; kind is not.
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
 * Apply an inline categorization edit (categoria/subcategoria) to a parcelado
 * purchase — the group row and all of its parcels, via the repository.
 */
export async function updateInstallmentGroupAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const installmentGroupId = requireField(formData, "installmentGroupId");
    const patch = installmentGroupPatchFromFormData(formData);
    await updateInstallmentGroup(client, householdId, installmentGroupId, patch);
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
 * Create one manual transaction (despesa ou entrada) from the "Novo
 * lançamento" form. Amount/date/description/payment-shape validation runs
 * through the shared domain `createTransactionDraft` — the exact same choke
 * point the bot and the import flow use. The income-needs-account rule is
 * NOT part of that domain validation; it is enforced server-side by
 * `manualEntryFromFormData` (see ./filters.ts), which rejects a card payment
 * on an income entry before the draft is even built.
 */
export async function createManualTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const input = manualEntryFromFormData(formData);

    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      return { ok: false, error: "Sessão inválida. Faça login novamente." };
    }

    if (
      input.kind === "expense" &&
      input.payment.type === "card" &&
      input.installmentCount > 1
    ) {
      const result = await saveCardPurchase({
        creditCardId: input.payment.creditCardId,
        description: input.description,
        totalCents: input.amountCents,
        installmentCount: input.installmentCount,
        purchasedOn: input.occurredOn,
        responsibleUserId:
          input.responsible === "household" ? undefined : input.responsible,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
      });
      revalidatePath("/transactions");
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.message };
    }

    const draftResult = createTransactionDraft({
      householdId,
      kind: input.kind,
      amount: brl(input.amountCents),
      occurredOn: input.occurredOn,
      description: input.description,
      createdByUserId: user.id,
      payment: input.payment,
      responsibleUserId:
        input.responsible === "household" ? undefined : input.responsible,
      category:
        input.categoryId !== undefined
          ? { categoryId: input.categoryId, subcategoryId: input.subcategoryId }
          : undefined,
    });
    if (!draftResult.ok) {
      return {
        ok: false,
        error: draftResult.errors.map((e) => e.message).join(" "),
      };
    }

    await createTransaction(client, draftResult.value);
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o lançamento.",
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
