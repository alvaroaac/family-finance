import {
  createTransactionDraft,
  brl,
  createInstallmentPlan,
} from "@family-finance/domain";
import {
  transactionInsertFromDraft,
  createInstallmentPurchase,
  listCreditCards,
  listAccounts,
  listAllCategories,
  listAllSubcategories,
  listHouseholdMembers,
} from "@family-finance/db";
import { entrySchema } from "@family-finance/mobile-contracts";
import { MobileError, type MobileContext } from "./context";
export async function saveMobileEntry(ctx: MobileContext, input: unknown) {
  const e = entrySchema.parse(input);
  const { client, householdId, userId } = ctx;
  const [accounts, cards, categories, subs, members] = await Promise.all([
    listAccounts(client, householdId),
    listCreditCards(client, householdId),
    listAllCategories(client, householdId),
    listAllSubcategories(client, householdId),
    listHouseholdMembers(client, householdId),
  ]);
  if (
    (e.accountId && !accounts.some((a) => a.id === e.accountId)) ||
    (e.creditCardId && !cards.some((c) => c.id === e.creditCardId)) ||
    (e.categoryId &&
      !categories.some((c) => c.id === e.categoryId && c.is_active)) ||
    (e.subcategoryId &&
      !subs.some(
        (s) =>
          s.id === e.subcategoryId &&
          s.category_id === e.categoryId &&
          s.is_active,
      )) ||
    (e.responsibleUserId &&
      !members.some((m) => m.userId === e.responsibleUserId && m.isActive))
  )
    throw new MobileError(
      422,
      "Revise conta, cartão, categoria e responsável.",
      "invalid_reference",
    );
  const category = e.categoryId
    ? {
        categoryId: e.categoryId,
        ...(e.subcategoryId ? { subcategoryId: e.subcategoryId } : {}),
      }
    : undefined;
  if (e.installmentCount > 1 && e.creditCardId) {
    const plan = createInstallmentPlan({
      householdId,
      creditCardId: e.creditCardId,
      description: e.description,
      totalAmount: brl(e.amountCents),
      installmentCount: e.installmentCount,
      purchasedOn: e.date,
      createdByUserId: userId,
      responsibleUserId: e.responsibleUserId ?? undefined,
      category,
      closingDay:
        cards.find((c) => c.id === e.creditCardId)?.closing_day ?? undefined,
    });
    if (!plan.ok)
      throw new MobileError(422, plan.errors.map((e) => e.message).join(" "));
    const result = await createInstallmentPurchase(client, plan.value, {
      idempotencyKey: `mobile:${userId}:${e.id}`,
    });
    return { ok: true, id: result.group.id, kind: "installment_group" };
  }
  const draft = createTransactionDraft({
    householdId,
    kind: e.kind,
    amount: brl(e.amountCents),
    occurredOn: e.date,
    description: e.description,
    createdByUserId: userId,
    responsibleUserId: e.responsibleUserId ?? undefined,
    category,
    payment: e.creditCardId
      ? { type: "card", creditCardId: e.creditCardId }
      : { type: "account", accountId: e.accountId! },
  });
  if (!draft.ok)
    throw new MobileError(422, draft.errors.map((e) => e.message).join(" "));
  const row = { ...transactionInsertFromDraft(draft.value), id: e.id };
  const { error } = await client.from("transactions").insert(row);
  if (error) {
    if (error.code !== "23505")
      throw new MobileError(
        503,
        "Não foi possível confirmar o lançamento. Você pode tentar novamente com o mesmo rascunho.",
      );
    const { data: existing, error: readError } = await client
      .from("transactions")
      .select("*")
      .eq("household_id", householdId)
      .eq("id", e.id)
      .single();
    if (
      readError ||
      !existing ||
      !Object.entries(row).every(
        ([k, v]) => (existing as unknown as Record<string, unknown>)[k] === v,
      )
    )
      throw new MobileError(
        409,
        "Este rascunho já foi usado com outros dados. Atualize a lista antes de continuar.",
        "idempotency_conflict",
      );
  }
  return { ok: true, id: e.id, kind: "transaction" };
}
