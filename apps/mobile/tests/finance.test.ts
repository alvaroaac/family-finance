import { describe, expect, it } from "vitest";
import {
  parseMoney,
  parseQuickEntry,
  project,
  demoSnapshot,
  seedEntries,
  snapshotWithEntries,
  type Assumption,
  type Entry,
} from "../src/finance";
const assumption: Assumption = {
  id: "a",
  description: "Freela",
  amountCents: 250000,
  kind: "income",
  start: 1,
  months: 1,
  enabled: true,
};
describe("cashflow scratchpad", () => {
  it("starts from cash, then applies remaining flows, without replaying historical entries", () => {
    expect(snapshotWithEntries(seedEntries)).toEqual(demoSnapshot);
    expect(project(demoSnapshot, [])[0]?.baseline).toBe(1175000);
    expect(project(demoSnapshot, []).at(-1)?.baseline).toBe(1915000);
  });
  it("applies income only from its chosen month onward", () => {
    const points = project(demoSnapshot, [assumption]);
    expect(points[0]?.delta).toBe(0);
    expect(points[1]?.delta).toBe(250000);
    expect(points[5]?.delta).toBe(250000);
  });
  it("counts a per-month expense once per installment and stops at its term", () => {
    const points = project(demoSnapshot, [
      { ...assumption, kind: "expense", amountCents: 30000, months: 3 },
    ]);
    expect(points.map((p) => p.delta)).toEqual([
      0, -30000, -60000, -90000, -90000, -90000,
    ]);
  });
  it("excludes disabled possibilities and returns to baseline when discarded", () => {
    expect(project(demoSnapshot, [{ ...assumption, enabled: false }])).toEqual(
      project(demoSnapshot, []),
    );
  });
  it("does not mutate the baseline or scenario", () => {
    const snapshot = JSON.stringify(demoSnapshot),
      original = JSON.stringify(assumption);
    project(demoSnapshot, [assumption]);
    expect(JSON.stringify(demoSnapshot)).toBe(snapshot);
    expect(JSON.stringify(assumption)).toBe(original);
  });
  it("allows a negative projected balance instead of clamping it", () => {
    expect(
      project(demoSnapshot, [
        { ...assumption, start: 0, kind: "expense", amountCents: 2000000 },
      ])[0]?.simulated,
    ).toBeLessThan(0);
  });
  it("places a new card purchase in future payment, not cash twice", () => {
    const entry: Entry = { ...seedEntries[0]!, id: "new", amountCents: 10000 };
    const card = snapshotWithEntries([...seedEntries, entry]);
    const cash = snapshotWithEntries([
      ...seedEntries,
      { ...entry, payment: "Conta principal" },
    ]);
    expect(card.openingCashCents).toBe(demoSnapshot.openingCashCents);
    expect(cash.openingCashCents).toBe(demoSnapshot.openingCashCents - 10000);
    expect(project(card, [])[0]?.baseline).toBe(project(cash, [])[0]?.baseline);
  });
});
describe("quick capture", () => {
  it.each([
    ["180", 18000],
    ["24,90", 2490],
    ["1.234,56", 123456],
    ["R$ 2.500", 250000],
  ])("parses BRL %s into integer cents", (text, cents) =>
    expect(parseMoney(text)).toBe(cents),
  );
  it.each(["", "-10", "abc", "1,234", "1.5", "0", "10000000000000000000"])(
    "rejects invalid or non-positive input %s",
    (text) => expect(parseMoney(text)).toBeNull(),
  );
  it("suggests category and payment while preserving an editable draft", () =>
    expect(parseQuickEntry("Giassi 180 no Nubank")).toMatchObject({
      description: "Giassi",
      amountCents: 18000,
      category: "Alimentação",
      payment: "Nubank",
      kind: "expense",
    }));
  it("recognizes income", () =>
    expect(parseQuickEntry("Recebi freela 2500")).toMatchObject({
      kind: "income",
      category: "Receitas",
      amountCents: 250000,
    }));
  it("keeps ambiguous merchants uncategorized", () =>
    expect(parseQuickEntry("Mercado Livre 300")).toMatchObject({
      category: "Outros",
    }));
  it("does not invent a missing amount", () =>
    expect(parseQuickEntry("Giassi")).not.toHaveProperty("amountCents"));
});
