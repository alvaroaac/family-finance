"use server";

import { revalidatePath } from "next/cache";

import { brl, createInstallmentPlan, createTransactionDraft } from "@family-finance/domain";
import {
  findHouseholdIdForCurrentUser,
  createCreditCard,
  updateCreditCard,
  deleteCreditCard,
  createInstallmentPurchase,
  createTransaction,
  listCreditCards,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";

/**
 * Server actions for the "Cartões" screen.
 *
 * CRUD for credit cards plus a card-purchase entry that supports à vista (single
 * charge) or parcelado (N installments). The installment math is owned by the
 * pure domain `createInstallmentPlan` — these actions only collect the form
 * input, run the domain contract, render a preview, and persist. No financial
 * rules live in the React component.
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

/**
 * Closing day usable for invoice timing (domain accepts 1–28; the DB allows up
 * to 31 for display). Out-of-range or unset days fall back to `undefined`,
 * which keeps the legacy "first parcel in the purchase month" behavior.
 */
function invoiceClosingDay(
  card: { closing_day: number | null } | undefined,
): number | undefined {
  const day = card?.closing_day;
  return day !== null && day !== undefined && day >= 1 && day <= 28
    ? day
    : undefined;
}

function optionalDay(formData: FormData, name: string): number | undefined {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const day = Number.parseInt(value, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`Dia inválido em "${name}" (use 1 a 31).`);
  }
  return day;
}

// --- Credit card CRUD ------------------------------------------------------

/** Create a credit card with optional closing/due days. */
export async function createCardAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const name = requireField(formData, "name");
  const closingDay = optionalDay(formData, "closingDay");
  const dueDay = optionalDay(formData, "dueDay");
  await createCreditCard(client, { householdId, name, closingDay, dueDay });
  revalidatePath("/cards");
}

/** Update a credit card's name and optional days. */
export async function updateCardAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const cardId = requireField(formData, "cardId");
  const name = requireField(formData, "name");
  const closingDay = optionalDay(formData, "closingDay");
  const dueDay = optionalDay(formData, "dueDay");
  await updateCreditCard(client, householdId, cardId, { name, closingDay, dueDay });
  revalidatePath("/cards");
}

/** Delete a credit card (blocked by FK restrict if it has purchases). */
export async function deleteCardAction(formData: FormData): Promise<void> {
  const { householdId, client } = await authedHousehold();
  const cardId = requireField(formData, "cardId");
  await deleteCreditCard(client, householdId, cardId);
  revalidatePath("/cards");
}

// --- Card purchase preview + save (à vista or parcelado) -------------------

/** One previewed parcel, money already formatted-friendly (integer cents). */
export type ParcelPreview = {
  number: number;
  installmentCount: number;
  amountCents: number;
  dueMonth: string;
};

export type PurchaseInput = {
  creditCardId: string;
  description: string;
  /** Total purchase amount in integer BRL cents (positive). */
  totalCents: number;
  /** Number of installments; 1 = à vista. */
  installmentCount: number;
  /** ISO purchase date (YYYY-MM-DD). */
  purchasedOn: string;
  categoryId?: string;
  subcategoryId?: string;
  responsibleUserId?: string;
};

export type PreviewResult =
  | { ok: true; parcels: ParcelPreview[]; totalCents: number }
  | { ok: false; message: string };

/**
 * Build the visible parcel breakdown for a card purchase WITHOUT persisting
 * anything. Runs the pure domain `createInstallmentPlan` so the parcels shown to
 * the user are exactly the ones that will be saved. This is what makes parcel
 * generation visible before the purchase is committed.
 */
export async function previewCardPurchase(
  input: PurchaseInput,
): Promise<PreviewResult> {
  try {
    // The card's closing day changes which invoice (dueMonth) the parcels land
    // on, so the preview must read it server-side to match what save persists.
    const { householdId, client } = await authedHousehold();
    const cards = await listCreditCards(client, householdId);
    const closingDay = invoiceClosingDay(
      cards.find((c) => c.id === input.creditCardId),
    );

    const planResult = createInstallmentPlan({
      // householdId/createdByUserId are not needed to compute the breakdown;
      // use stable placeholders so the pure domain validation can run. The real
      // ids are resolved server-side at save time.
      householdId: "preview",
      creditCardId: input.creditCardId || "preview-card",
      description: input.description,
      totalAmount: brl(input.totalCents),
      installmentCount: input.installmentCount,
      purchasedOn: input.purchasedOn,
      createdByUserId: "preview",
      closingDay,
      category:
        input.categoryId || input.subcategoryId
          ? { categoryId: input.categoryId, subcategoryId: input.subcategoryId }
          : undefined,
    });

    if (!planResult.ok) {
      return {
        ok: false,
        message: planResult.errors.map((e) => e.message).join(" "),
      };
    }

    return {
      ok: true,
      totalCents: input.totalCents,
      parcels: planResult.value.installments.map((p) => ({
        number: p.number,
        installmentCount: p.installmentCount,
        amountCents: p.amount.cents,
        dueMonth: p.dueMonth,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível gerar o preview das parcelas.",
    };
  }
}

export type SaveResult = { ok: boolean; message: string };

/**
 * Persist a card purchase. À vista (installmentCount === 1) is stored as a
 * single transaction on the card; parcelado is stored as an installment group +
 * month-attributed parcels (via the domain plan and the db repository). RLS
 * scopes every write to the household, and `created_by_user_id` is the
 * authenticated user (lançado por).
 */
export async function saveCardPurchase(
  input: PurchaseInput,
): Promise<SaveResult> {
  try {
    const { householdId, client } = await authedHousehold();

    if (typeof input.creditCardId !== "string" || input.creditCardId.length === 0) {
      return { ok: false, message: "Escolha o cartão antes de salvar." };
    }

    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      return { ok: false, message: "Sessão inválida. Faça login novamente." };
    }
    const createdByUserId = user.id;

    const category =
      input.categoryId || input.subcategoryId
        ? { categoryId: input.categoryId, subcategoryId: input.subcategoryId }
        : undefined;

    if (input.installmentCount === 1) {
      // À vista: a single card transaction in the purchase month.
      const draftResult = createTransactionDraft({
        householdId,
        kind: "expense",
        amount: brl(input.totalCents),
        occurredOn: input.purchasedOn,
        description: input.description,
        createdByUserId,
        payment: { type: "card", creditCardId: input.creditCardId },
        responsibleUserId: input.responsibleUserId,
        category,
      });
      if (!draftResult.ok) {
        return {
          ok: false,
          message: draftResult.errors.map((e) => e.message).join(" "),
        };
      }
      await createTransaction(client, draftResult.value);
      revalidatePath("/cards");
      revalidatePath("/dashboard");
      return {
        ok: true,
        message: "Compra à vista registrada no cartão.",
      };
    }

    // Parcelado: installment group + monthly parcels. The card's closing day
    // (when set) decides whether a post-closing purchase starts on the NEXT
    // month's invoice (spec §2.6) — read it server-side, never from the form.
    const cards = await listCreditCards(client, householdId);
    const closingDay = invoiceClosingDay(
      cards.find((c) => c.id === input.creditCardId),
    );
    const planResult = createInstallmentPlan({
      householdId,
      creditCardId: input.creditCardId,
      description: input.description,
      totalAmount: brl(input.totalCents),
      installmentCount: input.installmentCount,
      purchasedOn: input.purchasedOn,
      createdByUserId,
      responsibleUserId: input.responsibleUserId,
      category,
      closingDay,
    });
    if (!planResult.ok) {
      return {
        ok: false,
        message: planResult.errors.map((e) => e.message).join(" "),
      };
    }

    const { installments } = await createInstallmentPurchase(client, planResult.value);
    revalidatePath("/cards");
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `Compra parcelada registrada: ${installments.length} parcelas geradas.`,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a compra.",
    };
  }
}
