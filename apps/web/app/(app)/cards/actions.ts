"use server";

import { revalidatePath } from "next/cache";

import {
  brl,
  createCardBillSettlement,
  createInstallmentPlan,
  createTransactionDraft,
  currentHouseholdDate,
} from "@family-finance/domain";
import {
  findHouseholdIdForCurrentUser,
  createCreditCard,
  updateCreditCard,
  deleteCreditCard,
  createInstallmentPurchase,
  createTransaction,
  listCreditCards,
  settleCardBill,
  deleteCardBillPayment,
  closeCardBill,
  reopenCardBill,
  setCardBillTotal,
  planWithOpenFaturas,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { parseReaisToCents } from "../../../lib/format";

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

// --- Fatura payments and closing ------------------------------------------

export type CardBillActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function cardBillMoneyCents(value: string): number | null {
  // The shared parser uses parseFloat; reject partial numeric strings before
  // parsing so malformed submissions cannot become a different payment.
  if (!/^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(value)) {
    return null;
  }
  const cents = parseReaisToCents(value);
  return cents !== null && Number.isSafeInteger(cents) ? cents : null;
}

function validPaymentDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

async function authedCardBill() {
  const { householdId, client } = await authedHousehold();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (user === null) throw new Error("Sessão inválida. Faça login novamente.");
  return { householdId, client, userId: user.id };
}

function revalidateCardBills(): void {
  revalidatePath("/cards");
  revalidatePath("/resumo");
  revalidatePath("/dashboard");
  revalidatePath("/transactions");
}

export async function payCardBillAction(
  _prev: CardBillActionState,
  formData: FormData,
): Promise<CardBillActionState> {
  const amountCents = cardBillMoneyCents(formField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    return { status: "error", message: "Informe um valor maior que zero." };
  }
  const accountId = formField(formData, "accountId");
  if (accountId === "") {
    return {
      status: "error",
      message: "Escolha a conta de onde saiu o pagamento.",
    };
  }
  const billMonth = formField(formData, "billMonth");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billMonth)) {
    return { status: "error", message: "Mês da fatura inválido." };
  }
  const paidOn = formField(formData, "paidOn");
  if (!validPaymentDate(paidOn)) {
    return {
      status: "error",
      message: "Não foi possível registrar o pagamento.",
    };
  }
  if (paidOn > currentHouseholdDate()) {
    return {
      status: "error",
      message: "A data do pagamento não pode ser no futuro.",
    };
  }
  try {
    const { householdId, client, userId } = await authedCardBill();
    const draft = createCardBillSettlement({
      householdId,
      creditCardId: formField(formData, "creditCardId"),
      accountId,
      billMonth,
      amountCents,
      paidOn,
      createdByUserId: userId,
      idempotencyKey: formField(formData, "idempotencyKey"),
    });
    if (!draft.ok) {
      return {
        status: "error",
        message: "Não foi possível registrar o pagamento.",
      };
    }
    await settleCardBill(client, draft.value);
    revalidateCardBills();
    return { status: "success", message: "Pagamento registrado." };
  } catch {
    return {
      status: "error",
      message: "Não foi possível registrar o pagamento.",
    };
  }
}

export async function undoCardBillPaymentAction(
  _prev: CardBillActionState,
  formData: FormData,
): Promise<CardBillActionState> {
  try {
    const { householdId, client } = await authedCardBill();
    await deleteCardBillPayment(
      client,
      householdId,
      requireField(formData, "transactionId"),
    );
    revalidateCardBills();
    return { status: "success", message: "Pagamento desfeito." };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message === "Pagamento não encontrado."
          ? error.message
          : "Não foi possível registrar o pagamento.",
    };
  }
}

async function updateCardBillFromForm(
  formData: FormData,
  operation: "close" | "reopen" | "total",
): Promise<CardBillActionState> {
  const month = formField(formData, "billMonth");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return { status: "error", message: "Mês da fatura inválido." };
  }
  const rawTotal = operation === "reopen" ? null : formData.get("total");
  if (rawTotal !== null && typeof rawTotal !== "string") {
    return {
      status: "error",
      message: "Informe um total válido (zero ou mais).",
    };
  }
  const total = rawTotal?.trim() ?? "";
  const totalOverrideCents = total === "" ? null : cardBillMoneyCents(total);
  if (total !== "" && totalOverrideCents === null) {
    return {
      status: "error",
      message: "Informe um total válido (zero ou mais).",
    };
  }
  try {
    const { householdId, client, userId } = await authedCardBill();
    const input = {
      householdId,
      creditCardId: requireField(formData, "creditCardId"),
      month,
      totalOverrideCents,
      userId,
    };
    let message: string;
    if (operation === "close") {
      await closeCardBill(client, input);
      message = "Fatura fechada.";
    } else if (operation === "reopen") {
      await reopenCardBill(client, input);
      message = "Fatura reaberta.";
    } else {
      await setCardBillTotal(client, input);
      message = "Total atualizado.";
    }
    revalidateCardBills();
    return { status: "success", message };
  } catch {
    return { status: "error", message: "Não foi possível atualizar a fatura." };
  }
}

export async function closeCardBillAction(
  _prev: CardBillActionState,
  formData: FormData,
): Promise<CardBillActionState> {
  return updateCardBillFromForm(formData, "close");
}

export async function reopenCardBillAction(
  _prev: CardBillActionState,
  formData: FormData,
): Promise<CardBillActionState> {
  return updateCardBillFromForm(formData, "reopen");
}

export async function setCardBillTotalAction(
  _prev: CardBillActionState,
  formData: FormData,
): Promise<CardBillActionState> {
  return updateCardBillFromForm(formData, "total");
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
  await updateCreditCard(client, householdId, cardId, {
    name,
    closingDay,
    dueDay,
  });
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
  | {
      ok: true;
      parcels: ParcelPreview[];
      totalCents: number;
      shiftedFrom: string | null;
    }
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

    const { plan, shiftedFrom } = await planWithOpenFaturas(
      client,
      householdId,
      planResult.value,
      currentHouseholdDate(),
    );

    return {
      ok: true,
      totalCents: input.totalCents,
      shiftedFrom,
      parcels: plan.installments.map((p) => ({
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

export type SaveResult =
  | { ok: true; message: string; shiftedFrom: string | null }
  | { ok: false; message: string; shiftedFrom?: null };

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

    if (
      typeof input.creditCardId !== "string" ||
      input.creditCardId.length === 0
    ) {
      return {
        ok: false,
        message: "Escolha o cartão antes de salvar.",
        shiftedFrom: null,
      };
    }

    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      return {
        ok: false,
        message: "Sessão inválida. Faça login novamente.",
        shiftedFrom: null,
      };
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
          shiftedFrom: null,
        };
      }
      await createTransaction(client, draftResult.value);
      revalidateCardBills();
      return {
        ok: true,
        message: "Compra à vista registrada no cartão.",
        shiftedFrom: null,
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
        shiftedFrom: null,
      };
    }

    const { plan, shiftedFrom } = await planWithOpenFaturas(
      client,
      householdId,
      planResult.value,
      currentHouseholdDate(),
    );
    const { installments } = await createInstallmentPurchase(client, plan);
    revalidateCardBills();
    return {
      ok: true,
      message: `Compra parcelada registrada: ${installments.length} parcelas geradas.`,
      shiftedFrom,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a compra.",
      shiftedFrom: null,
    };
  }
}
