import { describe, it, expect } from "vitest";
import {
  buildMerchantGroups,
  orderMerchantGroups,
  filterGroups,
  formatGroupDates,
  formatPeriod,
  countLabel,
} from "./merchant-groups";
import type { GroupableRow, PreviewFilter } from "./merchant-groups";

function row(
  description: string,
  occurredOn = "2026-08-15",
  cents = 100,
  kind: GroupableRow["kind"] = "expense",
): GroupableRow {
  return { description, occurredOn, amount: { cents }, kind };
}

describe("merchant groups", () => {
  it("groups normalized names, picks the shortest label, and preserves indices and net outflow", () => {
    const rows = [
      row("MP * IFOOD *IFD", "2026-08-19", 500),
      row("Other"),
      row("IFOOD *IFD", "2026-08-07", 200, "income"),
    ];
    const before = structuredClone(rows);
    expect(buildMerchantGroups(rows)[0]).toEqual({
      key: "IFOOD *IFD",
      label: "IFOOD *IFD",
      indices: [0, 2],
      totalCents: 300,
      firstDate: "2026-08-07",
      lastDate: "2026-08-19",
      dateCount: 2,
    });
    expect(rows).toEqual(before);
  });
  it("uses edited descriptions including empty overrides and falls back for empty normalized keys", () => {
    expect(
      buildMerchantGroups([row("old"), row("   "), row("MP *"), row("old")], {
        0: "Café",
        3: "",
      }),
    ).toEqual([
      {
        key: "CAFE",
        label: "Café",
        indices: [0],
        totalCents: 100,
        firstDate: "2026-08-15",
        lastDate: "2026-08-15",
        dateCount: 1,
      },
      {
        key: "—",
        label: "Sem descrição",
        indices: [1, 3],
        totalCents: 200,
        firstDate: "2026-08-15",
        lastDate: "2026-08-15",
        dateCount: 1,
      },
      {
        key: "MP *",
        label: "MP *",
        indices: [2],
        totalCents: 100,
        firstDate: "2026-08-15",
        lastDate: "2026-08-15",
        dateCount: 1,
      },
    ]);
    expect(buildMerchantGroups([])).toEqual([]);
  });
  it("orders by pending selections, row count, then Portuguese label without mutating input", () => {
    const groups = buildMerchantGroups([
      row("Zebra"),
      row("Zebra"),
      row("Banana"),
      row("Água"),
      row("Água"),
    ]);
    const input = groups.map((group) => ({
      group,
      uncategorizedSelected: group.label === "Banana" ? 1 : 0,
    }));
    expect(orderMerchantGroups(input).map((group) => group.label)).toEqual([
      "Banana",
      "Água",
      "Zebra",
    ]);
    expect(input.map(({ group }) => group.label)).toEqual([
      "Zebra",
      "Banana",
      "Água",
    ]);
  });
  it.each<[PreviewFilter, string[]]>([
    ["all", ["Café", "Other"]],
    ["uncategorized", ["Café"]],
    ["duplicates", ["Other"]],
    ["installments", ["Café"]],
  ])("filters %s while preserving membership", (filter, labels) => {
    const groups = buildMerchantGroups([
      row("MP * Café"),
      row("Café"),
      row("Other"),
    ]);
    const result = filterGroups(groups, {
      filter,
      search: "",
      isUncategorized: (i) => i === 1,
      isDuplicate: (i) => i === 2,
      isInstallment: (i) => i === 0,
    });
    expect(result.map((group) => group.label)).toEqual(labels);
    for (const group of result) expect(groups).toContain(group);
    expect(groups[0]!.indices).toEqual([0, 1]);
  });
  it("searches both label and key ignoring case and accents and combines with filters", () => {
    const group = {
      ...buildMerchantGroups([row("Café")])[0]!,
      key: "KEY ÉXAMPLE",
    };
    const opts = {
      filter: "all" as const,
      search: "CAFE",
      isUncategorized: () => false,
      isDuplicate: () => false,
      isInstallment: () => false,
    };
    expect(filterGroups([group], opts)).toEqual([group]);
    expect(filterGroups([group], { ...opts, search: "example" })).toEqual([
      group,
    ]);
    expect(filterGroups([group], { ...opts, filter: "duplicates" })).toEqual(
      [],
    );
    expect(filterGroups([group], { ...opts, search: "absent" })).toEqual([]);
  });
});

describe("date and count labels", () => {
  it("counts distinct dates so repeated days do not turn a pair into a range", () => {
    const [group] = buildMerchantGroups([
      row("A", "2026-08-07"),
      row("A", "2026-08-19"),
      row("A", "2026-08-07"),
    ]);
    expect(group?.dateCount).toBe(2);
  });
  it.each([
    ["2026-08-15", "2026-08-15", 1, "15 ago"],
    ["2026-08-07", "2026-08-19", 2, "07 e 19 ago"],
    ["2026-08-03", "2026-08-29", 3, "03 a 29 ago"],
    ["2026-08-28", "2026-09-02", 2, "28 ago a 02 set"],
    ["2025-12-28", "2026-01-02", 2, "28 dez a 02 jan"],
  ])("formats group dates %s..%s (%i dates) as %s", (first, last, count, expected) => {
    expect(formatGroupDates(first, last, count)).toBe(expected);
  });
  it.each([
    [[], ""],
    [["2026-08-15"], "15 ago"],
    [["2026-08-31", "2026-08-01", "2026-08-12"], "01 – 31 ago"],
    [["2026-09-02", "2026-08-28"], "28 ago – 02 set"],
  ])("formats a period from %j", (dates, expected) => {
    expect(formatPeriod(dates.map((occurredOn) => ({ occurredOn })))).toBe(
      expected,
    );
  });
  it.each([
    [0, "0 lançamentos"],
    [1, "1 lançamento"],
    [7, "7 lançamentos"],
  ])("formats count %s", (n, expected) => {
    expect(countLabel(n, "lançamento", "lançamentos")).toBe(expected);
  });
});
