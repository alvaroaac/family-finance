import { describe, it, expect } from "vitest";

import type { ProjectedEntry } from "@family-finance/domain";
import type {
  ObligationListItem,
  ObligationsData,
  TimelineMonth,
} from "../app/(app)/obligations/queries.js";
import {
  monthAbbrPtBr,
  monthDiffYm,
  timelineChanges,
  reliefNote,
  dueStatus,
  dueBadgeLabel,
  nextDue,
  nextDueLabel,
  committedPerMonth,
  termProgress,
  barWidths,
} from "../app/(app)/obligations/view-model.js";

function item(patch: Partial<ObligationListItem> = {}): ObligationListItem {
  return {
    id: "solar",
    householdId: "household",
    description: "Parcela solar",
    amountCents: 10000,
    startMonth: "2026-07",
    termMonths: 4,
    dueDay: 10,
    accountId: "account",
    status: "active",
    categoryId: null,
    subcategoryId: null,
    responsibilityScope: "household",
    responsibleUserId: null,
    createdByUserId: "user",
    endMonth: "2026-10",
    remainingMonths: 2,
    ...patch,
  };
}

function slot(
  month: string,
  patch: Partial<TimelineMonth> = {},
): TimelineMonth {
  return { month, entries: [], paidCents: 0, totalCents: 0, ...patch };
}

function entry(
  description: string,
  dueDay: number,
  month = "2026-09",
): ProjectedEntry {
  return {
    obligationId: description,
    description,
    dueDay,
    month,
    amountCents: 10000,
    accountId: "account",
  };
}

function data(
  unpaid: ProjectedEntry[],
  timeline: TimelineMonth[] = [],
): ObligationsData {
  return {
    month: "2026-09",
    obligations: [],
    ended: [],
    thisMonth: { unpaid, paid: [] },
    timeline,
    loadError: null,
  };
}

const timelineWindow = [
  "2026-09",
  "2026-10",
  "2026-11",
  "2026-12",
  "2027-01",
].map((month) => slot(month));

describe("obligations view-model", () => {
  it("formats month abbreviations and signed month distances", () => {
    expect(monthAbbrPtBr("2026-10")).toBe("out/2026");
    expect(monthAbbrPtBr("2027-01")).toBe("jan/2027");
    expect(monthAbbrPtBr("invalid")).toBe("invalid");
    expect(monthDiffYm("2026-12", "2027-02")).toBe(2);
    expect(monthDiffYm("2027-02", "2026-12")).toBe(-2);
    expect(monthDiffYm("2026-09", "2026-09")).toBe(0);
  });

  it("timelineChanges marks only changing months and does not mark a current-month start", () => {
    const obligations = [
      item(),
      item({
        description: "Internet",
        startMonth: "2026-12",
        termMonths: null,
        endMonth: null,
      }),
      item({
        description: "Aluguel",
        startMonth: "2026-09",
        termMonths: null,
        endMonth: null,
      }),
    ];
    expect(timelineChanges(obligations, timelineWindow)).toEqual(
      new Map([
        ["2026-10", [{ kind: "last", description: "Parcela solar" }]],
        [
          "2026-11",
          [{ kind: "ended", description: "Parcela solar", amountCents: 10000 }],
        ],
        [
          "2026-12",
          [{ kind: "starts", description: "Internet", amountCents: 10000 }],
        ],
      ]),
    );
    expect(timelineChanges(obligations, [])).toEqual(new Map());
    expect(timelineChanges([], timelineWindow)).toEqual(new Map());
    expect(
      timelineChanges(
        [item({ startMonth: "2026-12", termMonths: 1, endMonth: "2026-12" })],
        timelineWindow,
      ).get("2026-12"),
    ).toEqual([
      { kind: "starts", description: "Parcela solar", amountCents: 10000 },
      { kind: "last", description: "Parcela solar" },
    ]);
  });

  it("reliefNote returns the month after the first term end and null for ends outside the window", () => {
    expect(
      reliefNote([item({ endMonth: "2026-12" }), item()], timelineWindow),
    ).toEqual({ fromMonth: "2026-11", amountCents: 10000 });
    expect(
      reliefNote(
        [
          item({ endMonth: "2026-08" }),
          item({ endMonth: "2027-02" }),
          item({ termMonths: null, endMonth: null }),
        ],
        timelineWindow,
      ),
    ).toBeNull();
    expect(reliefNote([item({ endMonth: "2027-01" })], timelineWindow)).toEqual(
      {
        fromMonth: "2027-02",
        amountCents: 10000,
      },
    );
    expect(reliefNote([item()], [])).toBeNull();
  });

  it.each([
    ["2026-09", 14, "2026-09-15", "overdue", -1, "atrasada"],
    ["2026-09", 15, "2026-09-15", "today", 0, "vence hoje"],
    ["2026-09", 16, "2026-09-15", "tomorrow", 1, "vence amanhã"],
    ["2026-09", 17, "2026-09-15", "soon", 2, "vence em 2 dias"],
    ["2026-09", 18, "2026-09-15", "soon", 3, "vence em 3 dias"],
    ["2026-09", 19, "2026-09-15", "later", 4, null],
    ["2026-10", 1, "2026-09-29", "soon", 2, "vence em 2 dias"],
    ["2027-01", 1, "2026-12-31", "tomorrow", 1, "vence amanhã"],
    ["2028-03", 1, "2028-02-28", "soon", 2, "vence em 2 dias"],
    ["2026-10", 15, "2026-09-15", "later", 30, null],
  ] as const)(
    "dueStatus uses real day math: %s day %i from %s",
    (month, day, today, kind, daysUntil, label) => {
      const status = dueStatus(month, day, today);
      expect(status).toEqual({ kind, daysUntil });
      expect(dueBadgeLabel(status)).toBe(label);
    },
  );

  it("nextDue prefers upcoming this month, then overdue, then next month, then null", () => {
    const unpaid = [
      entry("Mais tarde", 25),
      entry("Atrasada", 2),
      entry("Próxima", 16),
    ];
    const timeline = [
      slot("2026-10", {
        entries: [
          entry("Depois", 8, "2026-10"),
          entry("Outubro", 1, "2026-10"),
        ],
      }),
    ];
    const snapshot = structuredClone(unpaid);
    expect(nextDue(data(unpaid, timeline), "2026-09-15")).toEqual({
      description: "Próxima",
      month: "2026-09",
      dueDay: 16,
      status: { kind: "tomorrow", daysUntil: 1 },
    });
    expect(unpaid).toEqual(snapshot);
    expect(
      nextDue(data([entry("Hoje", 15), ...unpaid]), "2026-09-15")?.description,
    ).toBe("Hoje");
    expect(
      nextDue(
        data([entry("Dia dez", 10), entry("Dia dois", 2)], timeline),
        "2026-09-15",
      )?.description,
    ).toBe("Dia dois");
    expect(nextDue(data([], timeline), "2026-09-15")).toEqual({
      description: "Outubro",
      month: "2026-10",
      dueDay: 1,
      status: { kind: "later", daysUntil: 16 },
    });
    expect(nextDue(data([]), "2026-09-15")).toBeNull();
    expect(
      nextDue(
        data(
          [],
          [slot("2026-11", { entries: [entry("Novembro", 1, "2026-11")] })],
        ),
        "2026-09-15",
      ),
    ).toBeNull();
  });

  it.each([
    ["overdue", -3, "atrasada · dia 10"],
    ["today", 0, "hoje"],
    ["tomorrow", 1, "amanhã"],
    ["soon", 3, "em 3 dias"],
    ["later", 20, "em 20 dias"],
  ] as const)("nextDueLabel formats %s", (kind, daysUntil, label) => {
    expect(
      nextDueLabel({
        description: "Parcela solar",
        month: "2026-09",
        dueDay: 10,
        status: { kind, daysUntil },
      }),
    ).toBe(label);
  });

  it("committedPerMonth sums all active templates and reports the latest future start", () => {
    expect(
      committedPerMonth(
        [
          item(),
          item({ startMonth: "2027-02", amountCents: 20000 }),
          item({ startMonth: "2026-12" }),
          item({ status: "canceled", startMonth: "2028-01" }),
          item({ status: "ended" }),
        ],
        "2026-09",
      ),
    ).toEqual({ totalCents: 40000, activeCount: 3, fromMonth: "2027-02" });
    expect(committedPerMonth([item()], "2026-09")).toEqual({
      totalCents: 10000,
      activeCount: 1,
      fromMonth: null,
    });
    expect(committedPerMonth([], "2026-09")).toEqual({
      totalCents: 0,
      activeCount: 0,
      fromMonth: null,
    });
  });

  it("committedPerMonth excludes finished active templates and keeps current and future commitments", () => {
    const finished = item({
      startMonth: "2025-07",
      endMonth: "2025-10",
      remainingMonths: 0,
    });
    expect(committedPerMonth([finished], "2026-09")).toEqual({
      totalCents: 0,
      activeCount: 0,
      fromMonth: null,
    });
    expect(
      committedPerMonth(
        [
          finished,
          item({ startMonth: "2026-06", endMonth: "2026-09" }),
          item({ termMonths: null, endMonth: null }),
          item({ startMonth: "2026-12", endMonth: "2027-03" }),
        ],
        "2026-09",
      ),
    ).toEqual({ totalCents: 30000, activeCount: 3, fromMonth: "2026-12" });
  });

  it("termProgress covers indefinite, future, running, last month, and completed terms", () => {
    expect(
      termProgress(item({ termMonths: null, endMonth: null }), "2026-09"),
    ).toEqual({ kind: "indefinite" });
    expect(termProgress(item(), "2026-06")).toEqual({
      kind: "future",
      startMonth: "2026-07",
      termMonths: 4,
    });
    expect(
      termProgress(item({ termMonths: null, endMonth: null }), "2026-06"),
    ).toEqual({ kind: "future", startMonth: "2026-07", termMonths: null });
    for (const [month, elapsed, remainingCents] of [
      ["2026-07", 0, 40000],
      ["2026-09", 2, 20000],
      ["2026-10", 3, 10000],
      ["2027-01", 4, 0],
    ] as const) {
      expect(termProgress(item(), month)).toEqual({
        kind: "running",
        elapsed,
        total: 4,
        endMonth: "2026-10",
        remainingCents,
      });
    }
  });

  it("barWidths scales to the largest month and splits the paid slice", () => {
    expect(
      barWidths(
        slot("2026-09", { totalCents: 60000, paidCents: 20000 }),
        120000,
      ),
    ).toEqual({ totalPct: 50, paidPct: 16.7 });
    expect(
      barWidths(
        slot("2026-09", { totalCents: 120000, paidCents: 120000 }),
        120000,
      ),
    ).toEqual({ totalPct: 100, paidPct: 100 });
    expect(barWidths(slot("2026-09"), 0)).toEqual({ totalPct: 0, paidPct: 0 });
    expect(barWidths(slot("2026-09"), 120000)).toEqual({
      totalPct: 0,
      paidPct: 0,
    });
  });
});
