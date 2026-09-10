import { z } from "zod";
import * as db from "@family-finance/db";
import { createCardBillSettlement } from "@family-finance/domain";
import type { MobileAction } from "@family-finance/mobile-contracts";
import { dateSchema, monthSchema } from "@family-finance/mobile-contracts";
import { memberPatchFromFormData } from "../../app/(app)/settings/helpers";
import { MobileError, type MobileContext } from "./context";
export async function validateActionReferences(
  ctx: MobileContext,
  input: MobileAction,
) {
  const fields = input.fields;
  const [
    accounts,
    cards,
    categories,
    subs,
    members,
    obligations,
    buckets,
    memory,
  ] = await Promise.all([
    db.listAccounts(ctx.client, ctx.householdId),
    db.listCreditCards(ctx.client, ctx.householdId),
    db.listAllCategories(ctx.client, ctx.householdId),
    db.listAllSubcategories(ctx.client, ctx.householdId),
    db.listHouseholdMembers(ctx.client, ctx.householdId),
    db.listObligations(ctx.client, ctx.householdId),
    db.listInvestmentBuckets(ctx.client, ctx.householdId),
    db.listCategorizationMemory(ctx.client, ctx.householdId),
  ]);
  const lists: Record<string, string[]> = {
    accountId: accounts.map((r) => r.id),
    creditCardId: cards.map((r) => r.id),
    cardId: cards.map((r) => r.id),
    categoryId: categories.map((r) => r.id),
    sourceCategoryId: categories.map((r) => r.id),
    targetCategoryId: categories.map((r) => r.id),
    subcategoryId: subs.map((r) => r.id),
    memberId: members.map((r) => r.id),
    responsible: members.map((r) => r.userId),
    obligationId: obligations.map((r) => r.id),
    bucketId: buckets.map((r) => r.id),
    memoryId: memory.map((r) => r.id),
  };
  for (const [key, ids] of Object.entries(lists)) {
    const value = fields[key];
    if (
      value &&
      !(key === "responsible" && value === "household") &&
      !ids.includes(String(value))
    )
      throw new MobileError(422, "Escolha um item desta casa.");
  }
  if (
    fields.subcategoryId &&
    fields.categoryId &&
    !subs.some(
      (s) =>
        s.id === fields.subcategoryId && s.category_id === fields.categoryId,
    )
  )
    throw new MobileError(
      422,
      "A subcategoria não pertence à categoria escolhida.",
    );
  if (fields.payment) {
    const [kind, id] = String(fields.payment).split(":");
    if (
      !id ||
      (kind === "account"
        ? !lists.accountId!.includes(id)
        : kind === "card"
          ? !lists.creditCardId!.includes(id)
          : true)
    )
      throw new MobileError(422, "Pagamento inválido.");
  }
}
export async function runExtraAction(
  ctx: MobileContext,
  input: MobileAction,
  form: FormData,
): Promise<boolean> {
  const name = () => z.string().trim().min(1).max(100).parse(input.fields.name);
  const { client, householdId } = ctx;
  if (input.action === "categories.create") {
    const value = name();
    const rows = await db.listAllCategories(client, householdId);
    const fold = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    if (rows.some((r) => fold(r.name) === fold(value)))
      throw new MobileError(
        422,
        "Esta categoria já existe. Restaure-a se estiver arquivada.",
      );
    await db.createCategory(client, householdId, value);
  } else if (input.action === "subcategories.create") {
    const value = name();
    const categoryId = z.string().uuid().parse(input.fields.categoryId);
    const rows = await db.listAllSubcategories(client, householdId);
    if (
      rows.some(
        (r) =>
          r.category_id === categoryId &&
          r.name.toLocaleLowerCase() === value.toLocaleLowerCase(),
      )
    )
      throw new MobileError(422, "Esta subcategoria já existe.");
    await db.createSubcategory(client, householdId, categoryId, value);
  } else if (input.action === "members.update")
    await db.updateHouseholdMember(
      client,
      householdId,
      z.string().uuid().parse(input.fields.memberId),
      memberPatchFromFormData(form),
    );
  else if (input.action === "cards.pay") {
    const draft = createCardBillSettlement({
      householdId,
      creditCardId: z.string().uuid().parse(input.fields.creditCardId),
      accountId: z.string().uuid().parse(input.fields.accountId),
      billMonth: monthSchema.parse(input.fields.billMonth),
      amountCents: z.coerce
        .number()
        .int()
        .positive()
        .parse(input.fields.amountCents),
      paidOn: dateSchema.parse(input.fields.paidOn),
      createdByUserId: ctx.userId,
    });
    if (!draft.ok)
      throw new MobileError(422, draft.errors.map((e) => e.message).join(" "));
    await db.settleCardBill(client, draft.value);
  } else return false;
  return true;
}
