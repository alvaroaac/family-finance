/**
 * Data layer for "/resumo" — the 10-second daily summary.
 *
 * Read-only composition over the household-scoped `@family-finance/db`
 * repositories: this month's spending vs the previous month, the projected
 * invoice PER credit card (direct purchases + parcelas due in the month),
 * the pending-review count and the last 5 lançamentos.
 *
 * `buildResumoData` is the pure(ish) composition tested against the fake
 * store; `loadResumoData` wraps it with auth/household resolution and, like
 * the dashboard, degrades to a zeroed state instead of throwing.
 */

import {
  findHouseholdIdForCurrentUser,
  getMonthlySummary,
  getCardPressure,
  getCardPressureForCard,
  getObligationsPressure,
  findRecentTransactions,
  findPendingReviewTransactions,
  findCardBillSettlements,
  listCreditCards,
  currentMonth,
  type AppSupabaseClient,
  type DashboardTransaction,
} from "@family-finance/db";

import { formatBrlCents, monthNamePtBr } from "../../../lib/format";
import { shiftMonth } from "../transactions/filters";

// Kept on this module's surface: /resumo and /obligations already import it here.
export { monthLabelPtBr } from "../../../lib/format";

export type ResumoData = {
  month: string;
  /**
   * Gasto total do mês = conta + cartão. "Gasto é gasto": parcelas due this
   * month count as spending even though they are not `transactions` rows.
   */
  totalSpentCents: number;
  /** Expenses NOT on a credit card (débito/conta). */
  accountSpentCents: number;
  /** Card side: direct card purchases + parcelas due this month. */
  cardSpentCents: number;
  /** previous composite - current composite; positive = spending less. */
  deltaVsPreviousCents: number;
  /** Projected invoice per card this month (direct + parcelas due). */
  cards: Array<{
    id: string;
    name: string;
    projectedCents: number;
    /** True when a card-bill payment (kind='transfer') exists for this month. */
    settled: boolean;
  }>;
  /**
   * This month's fixed-obligation total: projected-unpaid + materialized
   * actuals. Display-only next to card pressure — paid obligation
   * transactions are already inside expenseCents, so this line is NEVER
   * added to totalSpentCents (that would double count).
   */
  obligationsCents: number;
  pendingCount: number;
  /** Last 5 lançamentos, newest first. */
  recent: DashboardTransaction[];
  /** Non-null when data could not be loaded; the page shows a zero state. */
  loadError: string | null;
};

/**
 * Friendly comparison against the previous month. Positive delta means the
 * family is spending LESS this month. Pure.
 */
export function spendingComparisonLabel(
  deltaCents: number,
  previousMonth: string,
): string {
  const name = monthNamePtBr(previousMonth);
  if (deltaCents === 0) {
    return `No mesmo ritmo de ${name}`;
  }
  if (deltaCents > 0) {
    return `${formatBrlCents(deltaCents)} a menos que ${name} 🌱`;
  }
  return `${formatBrlCents(-deltaCents)} a mais que ${name}`;
}

/** How many pending rows we count before capping (household scale: plenty). */
const PENDING_COUNT_LIMIT = 200;

/**
 * Compose the resumo dataset from the repositories. Exported separately from
 * `loadResumoData` so the integration tests can drive it against the fake
 * store — the exact composition production uses.
 */
export async function buildResumoData(
  client: AppSupabaseClient,
  householdId: string,
  now: Date = new Date(),
): Promise<ResumoData> {
  const month = currentMonth(now);
  const previousMonth = shiftMonth(month, -1);

  const [
    summary,
    previousSummary,
    pressure,
    previousPressure,
    creditCards,
    obligationsPressure,
    pending,
    recent,
    settlements,
  ] = await Promise.all([
    getMonthlySummary(client, householdId, month),
    getMonthlySummary(client, householdId, previousMonth),
    getCardPressure(client, householdId, month),
    getCardPressure(client, householdId, previousMonth),
    listCreditCards(client, householdId),
    // Resilient on purpose: the obligations schema arrives with migration
    // 0011, applied out-of-band. If the table/columns are missing (or this
    // one query fails), only THIS stat zeroes out — never the whole resumo.
    getObligationsPressure(client, householdId, month).catch(() => ({
      month,
      projectedUnpaidCents: 0,
      paidCents: 0,
      totalCents: 0,
    })),
    findPendingReviewTransactions(client, householdId, PENDING_COUNT_LIMIT),
    findRecentTransactions(client, householdId, 5),
    findCardBillSettlements(client, householdId, month),
  ]);

  const cards = await Promise.all(
    creditCards.map(async (card) => {
      const pressure = await getCardPressureForCard(
        client,
        householdId,
        card.id,
        month,
      );
      return {
        id: card.id,
        name: card.name,
        projectedCents: pressure.totalCents,
        settled: settlements.some((s) => s.creditCardId === card.id),
      };
    }),
  );

  // Split without double counting: direct card purchases are already inside
  // expenseCents, so the conta side subtracts them and the cartão side owns
  // them (plus the parcelas due this month, which are not transactions).
  const accountSpentCents = Math.max(0, summary.expenseCents - pressure.directCents);
  const cardSpentCents = pressure.totalCents;
  const totalSpentCents = accountSpentCents + cardSpentCents;
  const previousTotalCents =
    Math.max(0, previousSummary.expenseCents - previousPressure.directCents) +
    previousPressure.totalCents;

  return {
    month,
    totalSpentCents,
    accountSpentCents,
    cardSpentCents,
    deltaVsPreviousCents: previousTotalCents - totalSpentCents,
    cards,
    obligationsCents: obligationsPressure.totalCents,
    pendingCount: pending.length,
    recent,
    loadError: null,
  };
}

/** The empty/zero resumo state used when the DB is unreachable. */
function emptyResumo(month: string, loadError: string | null): ResumoData {
  return {
    month,
    totalSpentCents: 0,
    accountSpentCents: 0,
    cardSpentCents: 0,
    deltaVsPreviousCents: 0,
    cards: [],
    obligationsCents: 0,
    pendingCount: 0,
    recent: [],
    loadError,
  };
}

/**
 * Load the resumo dataset for the current month. Never throws: any failure
 * (no household, unreachable DB) collapses to the zero state with a
 * `loadError` message for the page to surface.
 */
export async function loadResumoData(now: Date = new Date()): Promise<ResumoData> {
  const month = currentMonth(now);
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      // Authenticated but no household resolved yet: clean zero state.
      return emptyResumo(month, null);
    }
    return await buildResumoData(client, householdId, now);
  } catch (error) {
    return emptyResumo(
      month,
      error instanceof Error
        ? error.message
        : "Não foi possível carregar o resumo de hoje.",
    );
  }
}
