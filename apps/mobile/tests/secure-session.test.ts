import { describe, it, expect } from "vitest";
import { chunkedSessionStorage } from "../src/secureSessionStorage";
function setup() {
  const values = new Map<string, string>();
  let id = 0;
  let fail = false;
  const store = chunkedSessionStorage(
    {
      getItem: async (k) => values.get(k) ?? null,
      setItem: async (k, v) => {
        if (fail && k !== "session") throw new Error("Keychain failed");
        expect(v.length).toBeLessThanOrEqual(512);
        values.set(k, v);
      },
      removeItem: async (k) => {
        values.delete(k);
      },
    },
    () => `generation-${++id}`,
  );
  return {
    store,
    values,
    fail: () => {
      fail = true;
    },
  };
}
describe("encrypted native session chunks", () => {
  it("round trips a session larger than a Keychain item", async () => {
    const { store } = setup();
    const value = "token-value-".repeat(700);
    await store.setItem("session", value);
    expect(await store.getItem("session")).toBe(value);
  });
  it("keeps the last session readable if the next write fails", async () => {
    const { store, fail } = setup();
    await store.setItem("session", "old-token");
    fail();
    await expect(store.setItem("session", "new-token")).rejects.toThrow();
    expect(await store.getItem("session")).toBe("old-token");
  });
  it("removes old chunks on refresh and all chunks on sign-out", async () => {
    const { store, values } = setup();
    await store.setItem("session", "a".repeat(4000));
    await store.setItem("session", "b");
    expect(values.size).toBe(2);
    await store.removeItem("session");
    expect(values.size).toBe(0);
    expect(await store.getItem("session")).toBeNull();
  });
  it("fails closed when a chunk is missing", async () => {
    const { store, values } = setup();
    await store.setItem("session", "token");
    values.delete("session.generation-1.0");
    expect(await store.getItem("session")).toBeNull();
  });
});
