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
  getCardPressureForCard,
  findRecentTransactions,
  findPendingReviewTransactions,
  listCreditCards,
  currentMonth,
  type AppSupabaseClient,
  type DashboardTransaction,
} from "@family-finance/db";

import { formatBrlCents } from "../../../lib/format";
import { shiftMonth } from "../transactions/filters";

export type ResumoData = {
  month: string;
  /** Current month's expenseCents. */
  spentCents: number;
  /** previous.expenseCents - current.expenseCents; positive = spending less. */
  deltaVsPreviousCents: number;
  /** Projected invoice per card this month (direct + parcelas due). */
  cards: Array<{ id: string; name: string; projectedCents: number }>;
  pendingCount: number;
  /** Last 5 lançamentos, newest first. */
  recent: DashboardTransaction[];
  /** Non-null when data could not be loaded; the page shows a zero state. */
  loadError: string | null;
};

const MONTH_NAMES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-07" -> "julho de 2026". Pure. */
export function monthLabelPtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  const name = MONTH_NAMES_PT[idx] ?? month;
  return `${name} de ${match[1]}`;
}

/** Just the month name, e.g. "2026-06" -> "junho". Pure. */
function monthNamePtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  return MONTH_NAMES_PT[Number.parseInt(match[2] as string, 10) - 1] ?? month;
}

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

  const [summary, previousSummary, creditCards, pending, recent] =
    await Promise.all([
      getMonthlySummary(client, householdId, month),
      getMonthlySummary(client, householdId, previousMonth),
      listCreditCards(client, householdId),
      findPendingReviewTransactions(client, householdId, PENDING_COUNT_LIMIT),
      findRecentTransactions(client, householdId, 5),
    ]);

  const cards = await Promise.all(
    creditCards.map(async (card) => {
      const pressure = await getCardPressureForCard(
        client,
        householdId,
        card.id,
        month,
      );
      return { id: card.id, name: card.name, projectedCents: pressure.totalCents };
    }),
  );

  return {
    month,
    spentCents: summary.expenseCents,
    deltaVsPreviousCents: previousSummary.expenseCents - summary.expenseCents,
    cards,
    pendingCount: pending.length,
    recent,
    loadError: null,
  };
}

/** The empty/zero resumo state used when the DB is unreachable. */
function emptyResumo(month: string, loadError: string | null): ResumoData {
  return {
    month,
    spentCents: 0,
    deltaVsPreviousCents: 0,
    cards: [],
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
