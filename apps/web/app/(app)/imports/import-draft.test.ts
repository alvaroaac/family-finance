import { describe, it, expect } from "vitest";
import {
  draftKey,
  saveDraft,
  loadDraft,
  clearDraft,
  formatSavedAt,
} from "./import-draft";
import type { ImportDraft } from "./import-draft";

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
  it("round trips every field under the fingerprint and clears only that draft", () => {
    const store = storage();
    expect(draftKey("abc")).toBe("ff-import-draft:abc");
    expect(saveDraft(store, "abc", draft, now)).toEqual(saved);
    saveDraft(store, "other", draft, now);
    expect(store.getItem(draftKey("abc"))).toBe(JSON.stringify(saved));
    expect(loadDraft(store, "abc", 2)).toEqual(saved);
    clearDraft(store, "abc");
    expect(loadDraft(store, "abc", 2)).toBeNull();
    expect(loadDraft(store, "other", 2)).toEqual(saved);
    expect(draft).not.toHaveProperty("savedAt");
  });
  it("tolerates inaccessible storage", () => {
    const fail = () => {
      throw new Error("Storage unavailable");
    };
    expect(saveDraft({ setItem: fail }, "abc", draft, now)).toEqual(saved);
    expect(loadDraft({ getItem: fail }, "abc", 2)).toBeNull();
    expect(() => clearDraft({ removeItem: fail }, "abc")).not.toThrow();
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
  ])("rejects invalid or mismatched storage %s", (raw) => {
    expect(loadDraft({ getItem: () => raw }, "abc", 2)).toBeNull();
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
