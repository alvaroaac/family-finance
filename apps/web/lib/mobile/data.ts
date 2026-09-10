import * as db from "@family-finance/db";
import { currentHouseholdDate } from "@family-finance/domain";
import type {
  Catalog,
  MobileData,
  MobileEntry,
} from "@family-finance/mobile-contracts";
import { type MobileContext, MobileError } from "./context";
export async function loadMobileData(
  ctx: MobileContext,
  month?: string,
): Promise<MobileData> {
  const { client, householdId } = ctx;
  const today = currentHouseholdDate();
  const selectedMonth = month ?? today.slice(0, 7);
  const [
    accounts,
    cards,
    categories,
    subcategories,
    members,
    buckets,
    obligations,
    memory,
    household,
    summary,
  ] = await Promise.all([
    db.listAccounts(client, householdId),
    db.listCreditCards(client, householdId),
    db.listAllCategories(client, householdId),
    db.listAllSubcategories(client, householdId),
    db.listHouseholdMembers(client, householdId),
    db.listInvestmentBuckets(client, householdId),
    db.listObligations(client, householdId),
    db.listCategorizationMemory(client, householdId),
    client.from("households").select("name").eq("id", householdId).single(),
    db.getMonthlySummary(client, householdId, selectedMonth),
  ]);
  if (household.error)
    throw new MobileError(503, "Não foi possível carregar sua casa.");
  const catalog: Catalog = {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    cards: cards.map((c) => ({ id: c.id, name: c.name })),
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.is_active,
    })),
    subcategories: subcategories.map((s) => ({
      id: s.id,
      name: s.name,
      parentId: s.category_id,
      isActive: s.is_active,
    })),
    members: members.map((m) => ({
      id: m.userId,
      name: m.displayName ?? "Pessoa da casa",
      isActive: m.isActive,
    })),
  };
  const { start, end } = db.monthDateRange(selectedMonth);
  let rows: db.TransactionRow[] = [];
  let hasMore = false;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await client
      .from("transactions")
      .select("*")
      .eq("household_id", householdId)
      .gte("occurred_on", start)
      .lte("occurred_on", end)
      .order("occurred_on", { ascending: false })
      .order("id")
      .range(page * 500, page * 500 + 499);
    if (error)
      throw new MobileError(503, "Não foi possível carregar seus lançamentos.");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) break;
    if (page === 19) hasMore = true;
  }
  const groups = await db.listInstallmentGroupsByHousehold(client, householdId);
  const { data: parcels, error: parcelError } = await client
    .from("installments")
    .select("*")
    .eq("household_id", householdId)
    .eq("due_month", selectedMonth)
    .range(0, 9999);
  if (parcelError)
    throw new MobileError(503, "Não foi possível carregar as parcelas.");
  const entries: MobileEntry[] = rows.map((r) => ({
    id: r.id,
    description: r.description,
    amountCents: r.amount_cents,
    kind: r.kind,
    date: r.occurred_on,
    category:
      categories.find((c) => c.id === r.category_id)?.name ?? "Sem categoria",
    payment:
      accounts.find((a) => a.id === r.account_id)?.name ??
      cards.find((c) => c.id === r.credit_card_id)?.name ??
      "Sem conta",
    categoryId: r.category_id,
    subcategoryId: r.subcategory_id,
    accountId: r.account_id,
    creditCardId: r.credit_card_id,
    responsibleUserId: r.responsible_user_id,
    installmentId: r.installment_id,
  }));
  for (const p of parcels ?? []) {
    if (rows.some((r) => r.installment_id === p.id)) continue;
    const g = groups.find((g) => g.id === p.installment_group_id);
    if (!g) continue;
    entries.push({
      id: p.id,
      description: `${g.description} · ${p.number}/${g.installment_count}`,
      amountCents: p.amount_cents,
      kind: "expense",
      date: `${p.due_month}-01`,
      category:
        categories.find((c) => c.id === g.category_id)?.name ?? "Sem categoria",
      payment: cards.find((c) => c.id === g.credit_card_id)?.name ?? "Cartão",
      categoryId: g.category_id,
      subcategoryId: g.subcategory_id,
      creditCardId: g.credit_card_id,
      installmentId: p.id,
      installmentGroupId: g.id,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return {
    version: 1,
    householdId,
    householdName: household.data.name,
    today,
    month: selectedMonth,
    catalog,
    entries,
    hasMore,
    recordedIncomeCents: summary.incomeCents,
    spentCents: entries
      .filter((e) => e.kind === "expense")
      .reduce((s, e) => s + e.amountCents, 0),
    future: [],
    resources: {
      accounts,
      cards,
      categories,
      subcategories,
      members: members.map((m) => ({ ...m })),
      buckets,
      obligations: obligations.map((o) => ({
        ...o,
        paidThisMonth: rows.some(
          (r) =>
            r.obligation_id === o.id &&
            r.obligation_month === `${selectedMonth}-01`,
        ),
      })),
      memory,
    },
  };
}

export async function loadMobileProjection(
  ctx: MobileContext,
): Promise<MobileData["future"]> {
  const { client, householdId } = ctx;
  const today = currentHouseholdDate();
  const cards = await db.listCreditCards(client, householdId);
  return await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + index);
      const m = d.toISOString().slice(0, 7);
      const range = db.monthDateRange(m);
      const [pressure, settlements, cardPressure, receipts] = await Promise.all(
        [
          db.getObligationsPressure(client, householdId, m),
          db.findCardBillSettlements(client, householdId, m),
          Promise.all(
            cards.map((c) =>
              db.getCardPressureForCard(client, householdId, c.id, m),
            ),
          ),
          client
            .from("transactions")
            .select("amount_cents, kind, credit_card_id, obligation_id")
            .eq("household_id", householdId)
            .gt("occurred_on", today)
            .gte("occurred_on", range.start)
            .lte("occurred_on", range.end)
            .range(0, 9999),
        ],
      );
      if (receipts.error)
        throw new MobileError(
          503,
          "Não foi possível carregar as receitas previstas.",
        );
      return {
        month: m,
        label: new Intl.DateTimeFormat("pt-BR", {
          month: "short",
          timeZone: "UTC",
        })
          .format(d)
          .replace(".", ""),
        incomeCents: (receipts.data ?? [])
          .filter((r) => r.kind === "income")
          .reduce((s, r) => s + r.amount_cents, 0),
        outflowCents:
          pressure.projectedUnpaidCents +
          (receipts.data ?? [])
            .filter(
              (r) =>
                r.kind === "expense" && !r.credit_card_id && !r.obligation_id,
            )
            .reduce((s, r) => s + r.amount_cents, 0) +
          cardPressure.reduce(
            (s, p, i) =>
              s +
              (settlements.some((x) => x.creditCardId === cards[i]!.id)
                ? 0
                : p.totalCents),
            0,
          ),
      };
    }),
  );
}
