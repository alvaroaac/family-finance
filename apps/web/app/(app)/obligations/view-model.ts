import { addMonthsYm } from "@family-finance/domain";

import type {
  ObligationListItem,
  ObligationsData,
  TimelineMonth,
} from "./queries";

const MONTH_ABBR_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

/** "2026-10" -> "out/2026". */
export function monthAbbrPtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  return `${MONTH_ABBR_PT[idx] ?? month}/${match[1]}`;
}

/** Whole months between two `YYYY-MM` values (b - a). Pure. */
export function monthDiffYm(a: string, b: string): number {
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

export type TimelineChange =
  | { kind: "starts"; description: string; amountCents: number }
  | { kind: "last"; description: string }
  | { kind: "ended"; description: string; amountCents: number };

/**
 * Only months containing starts, final payments, or newly ended terms.
 * Callers pass active templates only (page.tsx feeds data.obligations).
 */
export function timelineChanges(
  obligations: ObligationListItem[],
  timeline: TimelineMonth[],
): Map<string, TimelineChange[]> {
  const result = new Map<string, TimelineChange[]>();
  const firstMonth = timeline[0]?.month;
  if (firstMonth === undefined) return result;

  for (const { month } of timeline) {
    const changes: TimelineChange[] = [];
    for (const item of obligations) {
      const { description, amountCents, endMonth } = item;
      if (item.startMonth === month && month > firstMonth) {
        changes.push({ kind: "starts", description, amountCents });
      }
      if (endMonth === month) {
        changes.push({ kind: "last", description });
      }
      if (endMonth !== null && addMonthsYm(endMonth, 1) === month) {
        changes.push({ kind: "ended", description, amountCents });
      }
    }
    if (changes.length > 0) result.set(month, changes);
  }
  return result;
}

/**
 * The first term ending in the window, even if relief begins just after it.
 * Callers pass active templates only (page.tsx feeds data.obligations).
 */
export function reliefNote(
  obligations: ObligationListItem[],
  timeline: TimelineMonth[],
): { fromMonth: string; amountCents: number } | null {
  const months = new Set(timeline.map((slot) => slot.month));
  let first: ObligationListItem | undefined;
  for (const item of obligations) {
    if (
      item.endMonth !== null &&
      months.has(item.endMonth) &&
      (first === undefined ||
        first.endMonth === null ||
        item.endMonth < first.endMonth)
    ) {
      first = item;
    }
  }
  return first === undefined || first.endMonth === null
    ? null
    : {
        fromMonth: addMonthsYm(first.endMonth, 1),
        amountCents: first.amountCents,
      };
}

export type DueStatus = {
  kind: "overdue" | "today" | "tomorrow" | "soon" | "later";
  daysUntil: number;
};

/** Calendar-day distance, independent of the process timezone and DST. */
export function dueStatus(
  month: string,
  dueDay: number,
  today: string,
): DueStatus {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const daysUntil =
    (Date.UTC(year, monthNumber - 1, dueDay) -
      Date.UTC(todayYear, todayMonth - 1, todayDay)) /
    86400000;
  const kind =
    daysUntil < 0
      ? "overdue"
      : daysUntil === 0
        ? "today"
        : daysUntil === 1
          ? "tomorrow"
          : daysUntil <= 3
            ? "soon"
            : "later";
  return { kind, daysUntil };
}

export function dueBadgeLabel(status: DueStatus): string | null {
  switch (status.kind) {
    case "overdue":
      return "atrasada";
    case "today":
      return "vence hoje";
    case "tomorrow":
      return "vence amanhã";
    case "soon":
      return `vence em ${status.daysUntil} dias`;
    case "later":
      return null;
  }
}

export type NextDue = {
  description: string;
  month: string;
  dueDay: number;
  status: DueStatus;
};

/** Upcoming unpaid entries this month take priority over overdue entries. */
export function nextDue(data: ObligationsData, today: string): NextDue | null {
  const day = Number(today.slice(8, 10));
  const current = [...data.thisMonth.unpaid].sort(
    (a, b) => a.dueDay - b.dueDay,
  );
  const upcoming = current.find((entry) => entry.dueDay >= day);
  const nextMonth = data.timeline.find(
    (slot) => slot.month === addMonthsYm(data.month, 1),
  );
  const entry =
    upcoming ??
    current[0] ??
    [...(nextMonth?.entries ?? [])].sort((a, b) => a.dueDay - b.dueDay)[0];
  if (entry === undefined) return null;
  const { description, month, dueDay } = entry;
  return {
    description,
    month,
    dueDay,
    status: dueStatus(month, dueDay, today),
  };
}

export function nextDueLabel(next: NextDue): string {
  switch (next.status.kind) {
    case "overdue":
      return `atrasada · dia ${next.dueDay}`;
    case "today":
      return "hoje";
    case "tomorrow":
      return "amanhã";
    case "soon":
    case "later":
      return `em ${next.status.daysUntil} dias`;
  }
}

export type Committed = {
  totalCents: number;
  activeCount: number;
  fromMonth: string | null;
};

export function isFinished(item: ObligationListItem, month: string): boolean {
  return item.endMonth !== null && item.endMonth < month;
}

/** Unfinished active totals include commitments that start in future months. */
export function committedPerMonth(
  obligations: ObligationListItem[],
  month: string,
): Committed {
  const result: Committed = { totalCents: 0, activeCount: 0, fromMonth: null };
  for (const item of obligations) {
    if (item.status !== "active" || isFinished(item, month)) continue;
    result.totalCents += item.amountCents;
    result.activeCount += 1;
    if (
      item.startMonth > month &&
      (result.fromMonth === null || item.startMonth > result.fromMonth)
    ) {
      result.fromMonth = item.startMonth;
    }
  }
  return result;
}

export type TermProgress =
  | { kind: "indefinite" }
  | { kind: "future"; startMonth: string; termMonths: number | null }
  | {
      kind: "running";
      elapsed: number;
      total: number;
      endMonth: string;
      remainingCents: number;
    };

/** Past months are assumed paid; the current month remains in the balance. */
export function termProgress(
  item: ObligationListItem,
  month: string,
): TermProgress {
  if (item.startMonth > month) {
    return {
      kind: "future",
      startMonth: item.startMonth,
      termMonths: item.termMonths,
    };
  }
  if (item.termMonths === null || item.endMonth === null)
    return { kind: "indefinite" };
  const total = item.termMonths;
  const elapsed = Math.min(
    total,
    Math.max(0, monthDiffYm(item.startMonth, month)),
  );
  return {
    kind: "running",
    elapsed,
    total,
    endMonth: item.endMonth,
    remainingCents: (total - elapsed) * item.amountCents,
  };
}

/** Which installment the current month is: 11 elapsed -> parcela 12. */
export function installmentNumber(elapsed: number, total: number): number {
  return Math.min(elapsed + 1, total);
}

/** Both slices use the same maximum so they share the timeline's scale. */
export function barWidths(
  slot: TimelineMonth,
  maxTotalCents: number,
): { totalPct: number; paidPct: number } {
  if (maxTotalCents === 0) return { totalPct: 0, paidPct: 0 };
  const percent = (cents: number): number =>
    Math.round(Math.min(100, Math.max(0, (cents / maxTotalCents) * 100)) * 10) /
    10;
  return {
    totalPct: percent(slot.totalCents),
    paidPct: percent(slot.paidCents),
  };
}
