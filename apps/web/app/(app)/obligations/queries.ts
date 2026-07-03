/**
 * Data layer for "/obligations" — recurring fixed obligations.
 *
 * Read-only composition over the household-scoped `@family-finance/db`
 * repositories plus the PURE domain projection engine: the active-obligation
 * listing (with remaining-term math), the current month's unpaid/paid split,
 * and a rolling 12-month projection timeline.
 *
 * Anti-double-count: paid `(obligation, month)` pairs are subtracted from the
 * projections (the actual owns the month), but a month's commitment TOTAL
 * stays constant — projected-unpaid + paid actuals.
 *
 * `buildObligationsData` is the composition tested against the fake store;
 * `loadObligationsData` wraps it with auth/household resolution and degrades
 * to a zeroed state instead of throwing (same pattern as resumo/dashboard).
 */

import {
  addMonthsYm,
  obligationEndMonth,
  paidKey,
  projectObligations,
  type ProjectedEntry,
} from "@family-finance/domain";
import {
  currentMonth,
  findHouseholdIdForCurrentUser,
  listObligationPayments,
  listObligations,
  mapObligationRow,
  type AppSupabaseClient,
  type PersistedObligation,
} from "@family-finance/db";

/** How many months the forward timeline covers (current month included). */
export const TIMELINE_MONTHS = 12;

export type ObligationListItem = PersistedObligation & {
  /** Last month due (derived), or null when indefinite. */
  endMonth: string | null;
  /** Months still to pay from the current month on, or null when indefinite. */
  remainingMonths: number | null;
};

export type TimelineMonth = {
  month: string;
  /** Projected (not yet paid) entries for the month. */
  entries: ProjectedEntry[];
  /** Sum of the month's already-materialized obligation payments. */
  paidCents: number;
  /** entries + paidCents — the month's full fixed-obligation commitment. */
  totalCents: number;
};

export type ObligationsData = {
  month: string;
  obligations: ObligationListItem[];
  thisMonth: {
    unpaid: ProjectedEntry[];
    paid: Array<{
      obligationId: string;
      description: string;
      amountCents: number;
    }>;
  };
  timeline: TimelineMonth[];
  /** Non-null when data could not be loaded; the page shows a zero state. */
  loadError: string | null;
};

/** Whole months between two `YYYY-MM` values (b - a). Pure. */
function monthDiffYm(a: string, b: string): number {
  const [ay, am] = a.split("-").map((p) => Number.parseInt(p, 10)) as [
    number,
    number,
  ];
  const [by, bm] = b.split("-").map((p) => Number.parseInt(p, 10)) as [
    number,
    number,
  ];
  return (by - ay) * 12 + (bm - am);
}

/**
 * Compose the obligations dataset from the repositories + domain projector.
 * Exported separately from `loadObligationsData` so the integration tests can
 * drive it against the fake store — the exact composition production uses.
 */
export async function buildObligationsData(
  client: AppSupabaseClient,
  householdId: string,
  now: Date = new Date(),
): Promise<ObligationsData> {
  const month = currentMonth(now);
  const lastMonth = addMonthsYm(month, TIMELINE_MONTHS - 1);

  const [rows, payments] = await Promise.all([
    listObligations(client, householdId),
    listObligationPayments(client, householdId, month, lastMonth),
  ]);
  const mapped = rows.map(mapObligationRow);
  const byId = new Map(mapped.map((o) => [o.id, o]));
  const paid = new Set(payments.map((p) => paidKey(p.obligationId, p.month)));

  const obligations: ObligationListItem[] = mapped.map((o) => {
    const endMonth = obligationEndMonth(o.startMonth, o.termMonths);
    let remainingMonths: number | null = null;
    if (endMonth !== null) {
      remainingMonths = Math.max(0, monthDiffYm(month, endMonth) + 1);
    }
    return { ...o, endMonth, remainingMonths };
  });

  const projected = projectObligations(mapped, {
    fromMonth: month,
    toMonth: lastMonth,
    paid,
  });

  // Paid amounts per month, from the payment keys joined with the templates.
  const paidByMonth = new Map<
    string,
    Array<{ obligationId: string; description: string; amountCents: number }>
  >();
  for (const payment of payments) {
    const obligation = byId.get(payment.obligationId);
    if (obligation === undefined) {
      continue; // Payment of a canceled/ended template — not listed here.
    }
    const list = paidByMonth.get(payment.month) ?? [];
    list.push({
      obligationId: obligation.id,
      description: obligation.description,
      amountCents: obligation.amountCents,
    });
    paidByMonth.set(payment.month, list);
  }

  const timeline: TimelineMonth[] = [];
  for (let offset = 0; offset < TIMELINE_MONTHS; offset += 1) {
    const m = addMonthsYm(month, offset);
    const entries = projected.filter((e) => e.month === m);
    const paidCents = (paidByMonth.get(m) ?? []).reduce(
      (sum, p) => sum + p.amountCents,
      0,
    );
    const projectedCents = entries.reduce((sum, e) => sum + e.amountCents, 0);
    timeline.push({
      month: m,
      entries,
      paidCents,
      totalCents: projectedCents + paidCents,
    });
  }

  return {
    month,
    obligations,
    thisMonth: {
      unpaid: timeline[0]?.entries ?? [],
      paid: paidByMonth.get(month) ?? [],
    },
    timeline,
    loadError: null,
  };
}

/** The empty/zero state used when the DB is unreachable. */
function emptyObligations(month: string, loadError: string | null): ObligationsData {
  return {
    month,
    obligations: [],
    thisMonth: { unpaid: [], paid: [] },
    timeline: [],
    loadError,
  };
}

/**
 * Load the obligations dataset. Never throws: any failure (no household,
 * unreachable DB) collapses to the zero state with a `loadError` message.
 */
export async function loadObligationsData(
  now: Date = new Date(),
): Promise<ObligationsData> {
  const month = currentMonth(now);
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return emptyObligations(month, null);
    }
    return await buildObligationsData(client, householdId, now);
  } catch (error) {
    return emptyObligations(
      month,
      error instanceof Error
        ? error.message
        : "Não foi possível carregar as obrigações.",
    );
  }
}
