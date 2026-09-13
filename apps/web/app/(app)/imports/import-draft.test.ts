import { describe, it, expect } from "vitest";
import {
  draftKey,
  saveDraft,
  loadDraft,
  clearDraft,
  formatSavedAt,
} from "./import-draft";
import type { ImportDraft } from "./import-draft";

const owner = { userId: "user-1", householdId: "house-1" };
const other = { userId: "user-2", householdId: "house-1" };
const draft: Omit<ImportDraft, "savedAt"> = {
  rowCount: 2,
  mapping: { 0: { categoryId: "food", subcategoryId: "dining" } },
  learning: { 0: { merchant: true, sourceCategory: false, suppress: true } },
  excluded: [1],
  detached: [0],
  rowEdits: {
    0: {
      occurredOn: "2026-08-15",
      description: "Café",
      amountCents: 250,
      kind: "expense",
    },
  },
  groupEdits: {
    0: {
      totalAmountCents: 30000,
      installmentCount: 3,
      purchasedOn: "2026-08-01",
      skip: true,
      categoryId: "food",
    },
  },
};
const now = new Date("2026-09-13T17:32:00.000Z");
const saved = { ...draft, savedAt: now.toISOString() };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("import drafts", () => {
  it("round trips every field under the owner and fingerprint and clears only that draft", () => {
    const store = storage();
    expect(draftKey(owner, "abc")).toBe(
      "ff-import-draft:v2:house-1:user-1:abc",
    );
    expect(saveDraft(store, owner, "abc", draft, now)).toEqual(saved);
    saveDraft(store, owner, "other", draft, now);
    expect(store.getItem(draftKey(owner, "abc"))).toBe(JSON.stringify(saved));
    expect(loadDraft(store, owner, "abc", 2)).toEqual(saved);
    clearDraft(store, owner, "abc");
    expect(loadDraft(store, owner, "abc", 2)).toBeNull();
    expect(loadDraft(store, owner, "other", 2)).toEqual(saved);
    expect(draft).not.toHaveProperty("savedAt");
  });
  it("keeps drafts of different accounts apart", () => {
    const store = storage();
    saveDraft(store, owner, "abc", draft, now);
    expect(loadDraft(store, other, "abc", 2)).toBeNull();
    clearDraft(store, other, "abc");
    expect(loadDraft(store, owner, "abc", 2)).toEqual(saved);
  });
  it("reports a refused write and tolerates inaccessible storage", () => {
    const fail = () => {
      throw new Error("Storage unavailable");
    };
    expect(saveDraft({ setItem: fail }, owner, "abc", draft, now)).toBeNull();
    expect(loadDraft({ getItem: fail }, owner, "abc", 2)).toBeNull();
    expect(() => clearDraft({ removeItem: fail }, owner, "abc")).not.toThrow();
  });
  it.each([
    null,
    "{",
    "null",
    "5",
    '"text"',
    "[]",
    JSON.stringify({ ...saved, rowCount: 3 }),
    JSON.stringify({ ...saved, excluded: ["1"] }),
    JSON.stringify({ ...saved, detached: {} }),
    JSON.stringify({ ...saved, excluded: null }),
    JSON.stringify({ ...saved, detached: [null] }),
    JSON.stringify({ ...saved, mapping: [] }),
    JSON.stringify({ ...saved, learning: false }),
    JSON.stringify({ ...saved, rowEdits: "invalid" }),
    JSON.stringify({ ...saved, groupEdits: [] }),
  ])("rejects invalid or mismatched storage %s", (raw) => {
    expect(loadDraft({ getItem: () => raw }, owner, "abc", 2)).toBeNull();
  });
  it("defaults omitted maps", () => {
    expect(
      loadDraft(
        {
          getItem: () =>
            JSON.stringify({
              rowCount: 2,
              savedAt: saved.savedAt,
              excluded: [],
              detached: [],
            }),
        },
        owner,
        "abc",
        2,
      ),
    ).toEqual({
      rowCount: 2,
      savedAt: saved.savedAt,
      excluded: [],
      detached: [],
      mapping: {},
      learning: {},
      rowEdits: {},
      groupEdits: {},
    });
  });
  it.each([
    [14, 32, "14:32"],
    [0, 5, "00:05"],
  ])("formats local time %s:%s", (hour, minute, expected) => {
    expect(
      formatSavedAt(new Date(2026, 8, 13, hour, minute).toISOString()),
    ).toBe(expected);
  });
});
