/**
 * Dashboard data layer.
 *
 * Assembles the deliberately-simple monthly summary the dashboard renders:
 * current-month income / expense / estimated balance, card pressure + upcoming
 * installments, investment-bucket (caixinha) list, recent transactions, and
 * pending-review items. It builds on the household-scoped `@family-finance/db`
 * repositories; all reads are RLS-scoped to the authenticated user's household.
 *
 * Degrades gracefully: if the household cannot be resolved or the DB is
 * unreachable (e.g. placeholder secrets at build time), it returns a zeroed,
 * empty state instead of throwing, so the page always renders.
 */

import {
  findHouseholdIdForCurrentUser,
  getMonthlySummary,
  getCardPressure,
  findUpcomingInstallments,
  findRecentTransactions,
  findPendingReviewTransactions,
  listInvestmentBuckets,
  currentMonth,
  type MonthlySummary,
  type CardPressure,
  type UpcomingInstallment,
  type DashboardTransaction,
  type InvestmentBucketRow,
} from "@family-finance/db";

export type DashboardData = {
  month: string;
  summary: MonthlySummary;
  cardPressure: CardPressure;
  upcomingInstallments: UpcomingInstallment[];
  buckets: InvestmentBucketRow[];
  recent: DashboardTransaction[];
  pendingReview: DashboardTransaction[];
  /** Non-null when data could not be loaded; the page shows a zero state. */
  loadError: string | null;
};

/** The empty/zero dashboard state used when the DB is unreachable. */
function emptyDashboard(month: string, loadError: string | null): DashboardData {
  return {
    month,
    summary: { month, incomeCents: 0, expenseCents: 0, balanceCents: 0 },
    cardPressure: { month, directCents: 0, installmentCents: 0, totalCents: 0 },
    upcomingInstallments: [],
    buckets: [],
    recent: [],
    pendingReview: [],
    loadError,
  };
}

/**
 * Load the full dashboard dataset for the current month. Never throws: any
 * failure (no household, unreachable DB) collapses to the zero state with a
 * `loadError` message for the page to surface.
 */
export async function loadDashboardData(
  now: Date = new Date(),
): Promise<DashboardData> {
  const month = currentMonth(now);
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      // Authenticated but no household resolved yet: a clean zero state, no error.
      return emptyDashboard(month, null);
    }

    const [summary, cardPressure, upcomingInstallments, buckets, recent, pendingReview] =
      await Promise.all([
        getMonthlySummary(client, householdId, month),
        getCardPressure(client, householdId, month),
        findUpcomingInstallments(client, householdId, month),
        listInvestmentBuckets(client, householdId),
        findRecentTransactions(client, householdId),
        findPendingReviewTransactions(client, householdId),
      ]);

    return {
      month,
      summary,
      cardPressure,
      upcomingInstallments,
      buckets,
      recent,
      pendingReview,
      loadError: null,
    };
  } catch (error) {
    return emptyDashboard(
      month,
      error instanceof Error
        ? error.message
        : "Não foi possível carregar o resumo do mês.",
    );
  }
}
