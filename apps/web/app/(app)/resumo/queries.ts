/**
 * Data layer for "/resumo" — the 10-second daily summary.
 *
 * Read-only composition over the household-scoped `@family-finance/db`
 * repositories: this month's spending vs the previous month, the fatura pair
 * PER credit card (pending closed fatura + the open one), the pending-review
 * count and the last 5 lançamentos.
 *
 * `buildResumoData` is the pure(ish) composition tested against the fake
 * store; `loadResumoData` wraps it with auth/household resolution and, like
 * the dashboard, degrades to a zeroed state instead of throwing.
 */

import {
  findHouseholdIdForCurrentUser,
  getMonthlySummary,
  getCardPressure,
  getObligationsPressure,
  findRecentTransactions,
  findPendingReviewTransactions,
  getCardFaturaPairs,
  currentMonth,
  type AppSupabaseClient,
  type CardBillOverview,
  type DashboardTransaction,
} from "@family-finance/db";
import {
  cardBillBadge,
  currentHouseholdDate,
  type CardBillStatus,
} from "@family-finance/domain";

import { formatBrlCents, monthNamePtBr } from "../../../lib/format";
import { shiftMonth } from "../transactions/filters";

// Kept on this module's surface: /resumo already imports it here.
export { monthLabelPtBr } from "../../../lib/format";

/** One fatura as Resumo shows it; `badge` is the shared status copy. */
export type FaturaView = {
  month: string;
  closed: boolean;
  totalCents: number;
  status: CardBillStatus;
  badge: string;
};

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
  /**
   * Fatura pair per card (by `invoice_month`, so totals can differ from the
   * cartão spending above): the closed fatura still being paid, if any, and
   * the open one collecting new purchases.
   */
  cards: Array<{
    id: string;
    name: string;
    pending: FaturaView | null;
    open: FaturaView;
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

function faturaView(overview: CardBillOverview): FaturaView {
  return {
    month: overview.month,
    closed: overview.summary.closed,
    totalCents: overview.summary.totalCents,
    status: overview.summary.status,
    badge: cardBillBadge(overview.summary),
  };
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
    faturaPairs,
    obligationsPressure,
    pending,
    recent,
  ] = await Promise.all([
    getMonthlySummary(client, householdId, month),
    getMonthlySummary(client, householdId, previousMonth),
    getCardPressure(client, householdId, month),
    getCardPressure(client, householdId, previousMonth),
    getCardFaturaPairs(client, householdId, currentHouseholdDate(now)),
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
  ]);

  const cards = faturaPairs.map(({ card, pending, open }) => ({
    id: card.id,
    name: card.name,
    pending: pending === null ? null : faturaView(pending),
    open: faturaView(open),
  }));

  // Split without double counting: direct card purchases are already inside
  // expenseCents, so the conta side subtracts them and the cartão side owns
  // them (plus the parcelas due this month, which are not transactions).
  const accountSpentCents = Math.max(
    0,
    summary.expenseCents - pressure.directCents,
  );
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
export async function loadResumoData(
  now: Date = new Date(),
): Promise<ResumoData> {
  const month = currentMonth(now);
  try {
    const { createServerSupabaseClient } =
      await import("../../../lib/supabase");
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
